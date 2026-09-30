"""
Frame capture and perceptual digest -- the fast loop's entire perception rung R0+R1.

Two measured facts from perception/bench_scaling.py drive the design here:

  1. Capture has a ~8.3ms FIXED per-call cost on this machine, independent of region
     size, and only becomes area-bound above roughly 640x360. So the fast loop grabs
     at <=640x360 and pays the floor once; larger grabs for OCR belong on the slow
     loop, off the critical path.
  2. Shrinking below 640x360 buys nothing, so there is no reason to capture smaller
     and lose detail we might want for template matching.

The digest is deliberately cheap: two downscales and some numpy comparisons, no DCT
and no third-party imaging beyond Pillow's resize. Anything more expensive belongs
on the slow loop.
"""

import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image

# Grid of tile hashes. Tiles are what make the digest useful in a 3D world, where
# the viewport churns every frame but the HUD does not: a per-tile hash lets us see
# "the HUD is unchanged" even while the scene behind it is entirely different.
TILE_COLS = 4
TILE_ROWS = 4

# Each tile is resized to 9x8 so that horizontal adjacent-pixel comparison yields
# exactly 8x8 = 64 bits (dHash). The whole frame is downscaled once to
# (TILE_COLS*9) x (TILE_ROWS*8) and sliced, rather than resizing 16 times.
TILE_W, TILE_H = 9, 8
GRID_W, GRID_H = TILE_COLS * TILE_W, TILE_ROWS * TILE_H

DEFAULT_CAPTURE = (640, 360)


@dataclass
class FrameDigest:
    """A frame reduced to what the fast loop actually reasons about."""

    ts: float
    phash: int                      # 64-bit global dHash
    tiles: List[int]                # TILE_COLS*TILE_ROWS 64-bit tile dHashes
    uniformity: float               # share of near-uniform pixels: fades, letterboxing
    information: float              # structural content: 0 = blank, 1 = busy
    mean_luma: float
    width: int
    height: int

    def distance(self, other: "FrameDigest") -> int:
        """Hamming distance between global hashes."""
        return bin(self.phash ^ other.phash).count("1")

    def tile_distances(self, other: "FrameDigest") -> List[int]:
        return [bin(a ^ b).count("1") for a, b in zip(self.tiles, other.tiles)]

    def changed_tiles(self, other: "FrameDigest", threshold: int = 8) -> List[int]:
        """Indices of tiles that moved more than `threshold` bits."""
        return [i for i, d in enumerate(self.tile_distances(other)) if d > threshold]


def _dhash_from_gray(a: np.ndarray) -> int:
    """dHash: compare each pixel to its right neighbour. Input must be (h, w+1)."""
    diff = a[:, 1:] > a[:, :-1]
    bits = 0
    for v in diff.flatten():
        bits = (bits << 1) | int(v)
    return bits


def _dhash_packed(a: np.ndarray) -> int:
    """Same as _dhash_from_gray but via packbits -- ~10x faster than a Python loop."""
    diff = (a[:, 1:] > a[:, :-1]).astype(np.uint8).flatten()
    packed = np.packbits(diff)
    out = 0
    for byte in packed:
        out = (out << 8) | int(byte)
    return out


class FrameSource:
    """Wraps an mss instance and a target region. Reused across grabs -- creating a
    new mss instance per frame costs several milliseconds."""

    def __init__(self, region: Optional[Dict[str, int]] = None, size: Tuple[int, int] = DEFAULT_CAPTURE):
        import mss

        self._sct = mss.mss()
        mon = self._sct.monitors[1]
        self.size = size
        if region is None:
            region = {
                "left": mon["left"],
                "top": mon["top"],
                "width": min(size[0], mon["width"]),
                "height": min(size[1], mon["height"]),
            }
        self.region = region
        # Warm up: the first grab allocates and is not representative.
        self._sct.grab(self.region)

    def close(self):
        try:
            self._sct.close()
        except Exception:
            pass

    def grab_gray(self) -> np.ndarray:
        """Capture and return a 2D uint8 luma array."""
        raw = self._sct.grab(self.region)
        arr = np.frombuffer(raw.bgra, dtype=np.uint8).reshape(raw.height, raw.width, 4)
        # Rec.601 luma on the BGR channels, integer math, no float conversion.
        b = arr[..., 0].astype(np.uint16)
        g = arr[..., 1].astype(np.uint16)
        r = arr[..., 2].astype(np.uint16)
        return ((r * 77 + g * 150 + b * 29) >> 8).astype(np.uint8)


def digest_gray(gray: np.ndarray, ts: Optional[float] = None) -> FrameDigest:
    """Reduce a luma frame to a FrameDigest. This is rung R1."""
    h, w = gray.shape
    img = Image.fromarray(gray)

    # One downscale for the tile grid; slice it rather than resizing 16 times.
    grid = np.asarray(img.resize((GRID_W, GRID_H), Image.BILINEAR), dtype=np.int16)
    tiles = []
    for r in range(TILE_ROWS):
        for c in range(TILE_COLS):
            tile = grid[r * TILE_H : (r + 1) * TILE_H, c * TILE_W : (c + 1) * TILE_W]
            tiles.append(_dhash_packed(tile))

    # Separate small downscale for the global hash.
    small = np.asarray(img.resize((TILE_W, TILE_H), Image.BILINEAR), dtype=np.int16)
    phash = _dhash_packed(small)

    # Uniformity: how much of the frame sits near a single value. High during fades,
    # letterboxed cutscenes, and loading screens -- a cheap `busyShare` input.
    hist = np.bincount(gray.ravel(), minlength=256)
    uniformity = float(hist.max()) / float(gray.size)

    # Information: is there STRUCTURE, independent of brightness?
    #
    # Uniformity alone cannot tell a loading screen from a dark menu -- both are
    # mostly one pixel value, and classifying on uniformity labelled a static menu
    # "loading". A blank tile's dHash is all-zeros or all-ones; a tile containing
    # text or buttons has a balanced mix. Popcount distance from the extremes is
    # therefore a free structure detector, reusing hashes already computed.
    def _balance(h):
        pc = bin(h).count("1")
        return min(pc, 64 - pc) / 32.0
    information = float(np.mean([_balance(t) for t in tiles])) if tiles else 0.0

    return FrameDigest(
        ts=ts if ts is not None else time.perf_counter(),
        phash=phash,
        tiles=tiles,
        uniformity=uniformity,
        information=information,
        mean_luma=float(gray.mean()),
        width=w,
        height=h,
    )


@dataclass
class StageTimings:
    capture_ms: float = 0.0
    digest_ms: float = 0.0

    @property
    def total_ms(self) -> float:
        return self.capture_ms + self.digest_ms


def capture_digest(src: FrameSource) -> Tuple[FrameDigest, StageTimings]:
    """One full R0+R1 pass, instrumented."""
    t = StageTimings()
    t0 = time.perf_counter()
    gray = src.grab_gray()
    t1 = time.perf_counter()
    d = digest_gray(gray, ts=t1)
    t2 = time.perf_counter()
    t.capture_ms = (t1 - t0) * 1000.0
    t.digest_ms = (t2 - t1) * 1000.0
    return d, t
