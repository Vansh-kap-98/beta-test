"""
Rung R2: the screen-cluster library.

This is the component the whole cost model rests on. A VLM labels a screen ONCE and
the label is stored against a cluster; every later visit to that screen is a cache
hit costing microseconds. If clustering works, a first hour costs ~40 VLM calls. If
clusters fragment -- a new cluster every frame -- the VLM fires constantly and the
economics collapse.

The hard case is a 3D world, where the viewport is genuinely different every frame.
The mitigation is a per-tile volatility mask learned online: the HUD and chrome
identify a screen, the viewport does not. This module implements both the naive
whole-frame strategy and the masked one so the two can be measured against each
other rather than assumed.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from frame import FrameDigest, TILE_COLS, TILE_ROWS

N_TILES = TILE_COLS * TILE_ROWS

# Hamming radius on a 64-bit dHash. ~10 is the usual starting point: tight enough to
# separate distinct screens, loose enough to absorb animation and antialiasing.
DEFAULT_RADIUS = 10

# A tile changing in more than this share of observations within a cluster is treated
# as volatile and dropped from that cluster's identity.
VOLATILITY_THRESHOLD = 0.35

# Below this many stable tiles there is no reliable identity left -- that is the
# signature of a 3D world view, and we stop trying to cluster it.
MIN_STABLE_TILES = 3

# A fresh cluster has seen one frame and recorded zero changes, so every tile looks
# perfectly stable and the mask becomes maximally STRICT exactly when it has no
# evidence. Measured consequence: on a fully-animating cutscene the masked strategy
# produced 235 clusters against the global strategy's 42 -- five times worse than
# doing nothing. A cluster must earn its mask.
MIN_MEMBERS_FOR_MASK = 5

# Continuous-motion detection. When nearly every tile changes on nearly every frame
# there is no screen identity to find -- a cutscene or a moving 3D viewport. Making
# a new cluster per frame is worse than useless, so they collapse into one catch-all.
MOTION_WINDOW = 20
MOTION_TILE_FRACTION = 0.7      # share of tiles changing...
MOTION_FRAME_FRACTION = 0.7     # ...on this share of recent frames


def hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


@dataclass
class ScreenCluster:
    id: int
    phash: int
    tiles: List[int]
    members: int = 1
    first_seen: float = 0.0
    last_seen: float = 0.0
    # Per-tile count of observations where the tile differed from the centroid.
    tile_changes: List[int] = field(default_factory=lambda: [0] * N_TILES)
    label: Optional[str] = None          # filled by the VLM, once
    mode: Optional[str] = None

    def volatility(self) -> List[float]:
        return [c / max(self.members, 1) for c in self.tile_changes]

    def stable_tiles(self, threshold: float = VOLATILITY_THRESHOLD) -> List[int]:
        return [i for i, v in enumerate(self.volatility()) if v <= threshold]

    def is_world_like(self) -> bool:
        """Too few stable tiles to have an identity -- a moving 3D viewport."""
        return self.members >= 8 and len(self.stable_tiles()) < MIN_STABLE_TILES


@dataclass
class Assignment:
    cluster_id: int
    novel: bool
    distance: int
    strategy: str


class ClusterLibrary:
    """
    strategy:
      "global" -- match on the whole-frame hash. Simple; fragments on any animation.
      "masked" -- match on the tiles a cluster has found stable. Costs nothing extra
                  and is the only thing that can survive a moving viewport.
    """

    def __init__(self, radius: int = DEFAULT_RADIUS, strategy: str = "masked"):
        self.radius = radius
        self.strategy = strategy
        self.clusters: List[ScreenCluster] = []
        self._next_id = 0
        self.assignments = 0
        self.novel_count = 0
        self._prev: Optional[FrameDigest] = None
        self._motion_history: List[float] = []
        self._motion_cluster: Optional[ScreenCluster] = None
        self.motion_frames = 0

    def _update_motion(self, d: FrameDigest) -> bool:
        """Track how much of the frame is churning. True = continuous motion."""
        if self._prev is not None:
            changed = len(d.changed_tiles(self._prev))
            self._motion_history.append(changed / N_TILES)
            if len(self._motion_history) > MOTION_WINDOW:
                self._motion_history.pop(0)
        self._prev = d
        if len(self._motion_history) < MOTION_WINDOW:
            return False
        busy = sum(1 for f in self._motion_history if f >= MOTION_TILE_FRACTION)
        return (busy / len(self._motion_history)) >= MOTION_FRAME_FRACTION

    def _score_global(self, c: ScreenCluster, d: FrameDigest) -> int:
        return hamming(c.phash, d.phash)

    def _score_masked(self, c: ScreenCluster, d: FrameDigest) -> int:
        """Mean per-tile distance over the cluster's stable tiles only."""
        if c.members < MIN_MEMBERS_FOR_MASK:
            # Not enough observations to know which tiles are stable. Trusting the
            # empty volatility record here is what caused the cutscene blow-up.
            return self._score_global(c, d)
        stable = c.stable_tiles()
        if len(stable) < MIN_STABLE_TILES:
            # No stable identity yet (or a world view): fall back to the global hash
            # rather than matching everything to everything.
            return self._score_global(c, d)
        total = sum(hamming(c.tiles[i], d.tiles[i]) for i in stable)
        return int(round(total / len(stable)))

    def _score(self, c: ScreenCluster, d: FrameDigest) -> int:
        return self._score_masked(c, d) if self.strategy == "masked" else self._score_global(c, d)

    def assign(self, d: FrameDigest) -> Assignment:
        self.assignments += 1
        in_motion = self._update_motion(d)

        if in_motion and self.strategy == "masked":
            # No stable identity exists in this content. Collapse it into a single
            # catch-all rather than minting a cluster per frame. The agent still
            # sees the frames; it simply stops pretending they are distinct screens,
            # and a VLM is never asked to label a cutscene frame.
            self.motion_frames += 1
            if self._motion_cluster is None:
                self._motion_cluster = ScreenCluster(
                    id=self._next_id, phash=d.phash, tiles=list(d.tiles),
                    first_seen=d.ts, last_seen=d.ts, mode="motion",
                )
                self._next_id += 1
                self.clusters.append(self._motion_cluster)
                self.novel_count += 1
                return Assignment(self._motion_cluster.id, True, -1, "motion")
            self._motion_cluster.members += 1
            self._motion_cluster.last_seen = d.ts
            return Assignment(self._motion_cluster.id, False, 0, "motion")

        best: Optional[ScreenCluster] = None
        best_score = 1 << 30
        for c in self.clusters:
            s = self._score(c, d)
            if s < best_score:
                best_score, best = s, c

        if best is not None and best_score <= self.radius:
            # Update volatility BEFORE the centroid, so we measure movement against
            # the identity we matched on rather than against an already-updated one.
            for i in range(N_TILES):
                if hamming(best.tiles[i], d.tiles[i]) > 8:
                    best.tile_changes[i] += 1
            best.members += 1
            best.last_seen = d.ts
            return Assignment(best.id, False, best_score, self.strategy)

        c = ScreenCluster(
            id=self._next_id,
            phash=d.phash,
            tiles=list(d.tiles),
            first_seen=d.ts,
            last_seen=d.ts,
        )
        self._next_id += 1
        self.novel_count += 1
        self.clusters.append(c)
        return Assignment(c.id, True, best_score if best is not None else -1, self.strategy)

    def world_like_clusters(self) -> List[ScreenCluster]:
        return [c for c in self.clusters if c.is_world_like()]

    def summary(self) -> Dict[str, float]:
        return {
            "clusters": len(self.clusters),
            "assignments": self.assignments,
            "novel_rate": self.novel_count / max(self.assignments, 1),
            "world_like": len(self.world_like_clusters()),
            "largest": max((c.members for c in self.clusters), default=0),
            "motion_frames": self.motion_frames,
        }
