"""
The perception ladder, assembled.

Rungs R0-R3 wired into a single pipeline producing a `PerceivedState`. The whole
point is that the expensive rungs almost never run:

    R0  capture              every fast-loop tick        ~8-21 ms
    R1  hash + tiles         every fast-loop tick        ~4-6 ms
        --> if the frame is unchanged, RETURN THE PREVIOUS BLOB and stop.
    R2  cluster assignment   every tick, microseconds
        --> on a known screen, reuse its recorded layout and skip R4 entirely.
    R3  OCR                  slow loop only              ~14 ms per small ROI
    R4  VLM                  novel screens only          NOT IMPLEMENTED

Two loops share this. The fast loop calls `observe()`, which never runs OCR or a
VLM. The slow loop calls `enrich()` on the latest state, which may.

The `Observed`/`unreadable` discipline from state.py is enforced at every write:
nothing enters the blob without a source and a confidence, and a field we could not
read is REMOVED and named, never defaulted.
"""

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np

import ocr as ocr_mod
from clusters import ClusterLibrary, N_TILES
from frame import FrameDigest, FrameSource, capture_digest, digest_gray
from state import (
    SOURCE_CACHED, SOURCE_OCR, SOURCE_VLM, WHY_BUDGET, WHY_LOW_CONFIDENCE,
    WHY_NO_SOURCE, FrameInfo, Observed, PerceivedState, PerceptionStats, TextRegion,
)

# Frames whose global hash differs by less than this are treated as the same view.
SAME_FRAME_BITS = 2

# Coarse mode classification from cheap signals only. Deliberately not a model call:
# it runs on the fast loop and gates how many macros are even offered.
# Coarse mode classification from cheap signals only, so it can run on the fast loop
# and gate how many macros are even offered.
#
# Thresholds fitted to MEASURED values on the mode simulator:
#
#     mode       uniformity  information  motion
#     menu             0.85         0.13    0.00
#     cutscene         0.22         0.60    0.62
#     world            0.41         0.23    0.14
#
# That is three data points from a simulator, which is nowhere near enough to trust.
# So this reports LOW confidence by design, and the intended path is for the slow
# loop to ask the System One model ("what kind of screen is this?") and cache the
# answer against the cluster -- a question the model answers far better than a
# hand-fitted threshold ever will, and one it only pays for once per screen.
# The heuristic exists so the fast loop is never blocked waiting for that answer.
UNIFORMITY_FLAT = 0.70          # mostly one background value: a menu or a fade
INFORMATION_BLANK = 0.06        # ...and no structure at all. A dark menu scores 0.13,
                                # so this separates a true blank from a dark UI --
                                # uniformity alone called a static menu "loading".
MOTION_CHURN = 0.45             # most tiles changing: cutscene or live viewport


@dataclass
class ScreenLayout:
    """What we have learned about a screen, stored against its cluster."""

    label: Optional[str] = None
    text_rois: List[Tuple[int, int, int, int]] = field(default_factory=list)
    controls: List[Dict] = field(default_factory=list)
    ocr_step: int = -1                       # when its text was last actually read


class Perceiver:
    def __init__(self, src: FrameSource, ocr_every: int = 15):
        self.src = src
        self.lib = ClusterLibrary(strategy="masked")
        self.layouts: Dict[int, ScreenLayout] = {}
        self.ocr_every = ocr_every

        self.step = 0
        self.prev_digest: Optional[FrameDigest] = None
        self.prev_state: Optional[PerceivedState] = None
        self.last_gray: Optional[np.ndarray] = None

        self.stats = {"observes": 0, "reused": 0, "ocr_runs": 0, "vlm_runs": 0}

    # ------------------------------------------------------------------ fast loop

    def observe(self) -> PerceivedState:
        """One fast-loop observation. Never runs OCR or a VLM."""
        t0 = time.perf_counter()
        self.step += 1
        self.stats["observes"] += 1

        gray = self.src.grab_gray()
        d = digest_gray(gray)
        self.last_gray = gray

        d_prev = d.distance(self.prev_digest) if self.prev_digest else 99

        # R1 short-circuit: the frame is the same, so the blob is too. This is the
        # single biggest cost saving in the system -- menus and dialogue are static
        # for most of their duration.
        if self.prev_state is not None and d_prev <= SAME_FRAME_BITS:
            self.stats["reused"] += 1
            s = self._carry_forward(self.prev_state, d, d_prev, t0)
            self.prev_digest = d
            self.prev_state = s
            return s

        assign = self.lib.assign(d)
        layout = self.layouts.setdefault(assign.cluster_id, ScreenLayout())

        s = PerceivedState(
            step=self.step,
            ts=d.ts,
            screen_id="cluster:%d" % assign.cluster_id,
            frame=FrameInfo(
                phash=d.phash, tiles=list(d.tiles), d_prev=d_prev,
                d_nearest_cluster=assign.distance, uniformity=d.uniformity,
                information=d.information, motion=self._motion(d),
            ),
        )
        s.perception.rungs_run = ["R0", "R1", "R2"]
        s.mode = self._classify_mode(s, assign.strategy)

        if layout.label:
            s.screen_label = Observed(layout.label, 0.8, SOURCE_VLM, layout.ocr_step)
        if layout.controls:
            s.controls = list(layout.controls)

        # Text is carried forward from the last real read of THIS screen, marked
        # cached so its age stays visible; if we have never read it, it is unknown.
        if layout.text_rois and self.prev_state and self.prev_state.screen_id == s.screen_id:
            s.text = list(self.prev_state.text)
        elif not layout.text_rois:
            s.mark_unreadable("text", WHY_BUDGET, "not read on the fast loop")

        s.perception.total_ms = (time.perf_counter() - t0) * 1000.0
        s.compute_completeness(["mode"])
        self.prev_digest = d
        self.prev_state = s
        return s

    def _carry_forward(self, prev: PerceivedState, d: FrameDigest, d_prev: int, t0: float
                       ) -> PerceivedState:
        s = PerceivedState(
            step=self.step, ts=d.ts, screen_id=prev.screen_id,
            frame=FrameInfo(phash=d.phash, tiles=list(d.tiles), d_prev=d_prev,
                            d_nearest_cluster=0, uniformity=d.uniformity,
                            information=d.information, motion=self._motion(d)),
        )
        s.perception.rungs_run = ["R0", "R1", "cached"]
        # Everything reusable keeps its ORIGINAL measured_at_step, so staleness is
        # always visible rather than being laundered into a fresh-looking value.
        if prev.mode is not None:
            s.mode = Observed(prev.mode.value, prev.mode.confidence, SOURCE_CACHED,
                              prev.mode.measured_at_step)
        if prev.screen_label is not None:
            s.screen_label = Observed(prev.screen_label.value, prev.screen_label.confidence,
                                      SOURCE_CACHED, prev.screen_label.measured_at_step)
        s.text = list(prev.text)
        s.controls = list(prev.controls)
        for name in prev.vars:
            s.carry_forward(name, prev)
        s.unreadable = list(prev.unreadable)
        s.perception.total_ms = (time.perf_counter() - t0) * 1000.0
        s.compute_completeness(["mode"])
        return s

    def _motion(self, d: FrameDigest) -> float:
        if self.prev_digest is None:
            return 0.0
        return len(d.changed_tiles(self.prev_digest)) / float(N_TILES)

    def _classify_mode(self, s: PerceivedState, strategy: str) -> Observed:
        """Coarse mode from cheap signals.

        Confidence is capped at 0.55 on purpose: these thresholds are fitted to three
        samples from a simulator, and reporting them at high confidence would let a
        guess masquerade as a measurement. `known()` at the default 0.6 gate therefore
        treats this as unknown until the model confirms it -- which is the correct
        default, and the reason the confidence wrapper exists.
        """
        f = s.frame
        if f.uniformity >= UNIFORMITY_FLAT and f.information < INFORMATION_BLANK and f.motion < 0.2:
            return Observed("loading", 0.55, "derived", self.step)
        if strategy == "motion" or f.motion >= MOTION_CHURN:
            # Continuous churn: a live viewport or a cutscene. Separating those two
            # needs letterbox detection, which belongs on the slow loop.
            return Observed("cutscene", 0.45, "derived", self.step)
        if f.uniformity >= UNIFORMITY_FLAT:
            return Observed("menu", 0.5, "derived", self.step)
        return Observed("world", 0.45, "derived", self.step)

    # ------------------------------------------------------------------ slow loop

    def enrich(self, s: PerceivedState, force: bool = False) -> PerceivedState:
        """Slow-loop enrichment: OCR, and eventually a VLM.

        Mutates and returns the state. Only reads text when the screen has not been
        read recently, so revisiting a known menu costs nothing.
        """
        if self.last_gray is None:
            return s
        cid = int(s.screen_id.split(":")[1])
        layout = self.layouts.setdefault(cid, ScreenLayout())

        if not force and layout.ocr_step >= 0 and (self.step - layout.ocr_step) < self.ocr_every:
            return s

        t0 = time.perf_counter()
        if layout.text_rois:
            # Known screen: read only the regions that actually contained text.
            res = ocr_mod.recognize_rois(self.last_gray, layout.text_rois)
        else:
            res = ocr_mod.recognize(self.last_gray)
            layout.text_rois = [r.bbox for r in res.regions]

        self.stats["ocr_runs"] += 1
        layout.ocr_step = self.step
        s.text = res.regions
        s.perception.rungs_run.append("R3")
        s.perception.ocr_ms = res.ms
        s.perception.total_ms += (time.perf_counter() - t0) * 1000.0

        if res.regions:
            s.unreadable = [u for u in s.unreadable if u.field != "text"]
        else:
            s.mark_unreadable("text", WHY_LOW_CONFIDENCE, "no region cleared the threshold")

        # R4 is not built. Saying so in the blob is the point: a screen with no label
        # must be visibly unlabelled rather than silently anonymous.
        if layout.label is None:
            s.mark_unreadable("screenLabel", WHY_NO_SOURCE, "no VLM configured")

        s.compute_completeness(["mode", "text"])
        return s

    def summary(self) -> str:
        o = self.stats["observes"]
        reuse = 100.0 * self.stats["reused"] / max(o, 1)
        return ("observes=%d reused=%.0f%% clusters=%d ocr_runs=%d vlm_runs=%d"
                % (o, reuse, len(self.lib.clusters), self.stats["ocr_runs"], self.stats["vlm_runs"]))
