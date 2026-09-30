"""
Phase 0a, step 2: is capture cost fixed overhead, or proportional to pixels?

This decides the whole capture strategy. If cost scales with area, we capture a
smaller region and the budget problem disappears -- the fast loop only ever needs a
32x32 luma image for hashing plus a handful of small ROIs for OCR, never a full
1080p frame. If instead it is fixed per-call overhead, no amount of shrinking helps
and we need a different backend (Windows Graphics Capture via a native addon).
"""

import sys
import time
import statistics

import mss
import numpy as np


SIZES = [
    (160, 90),
    (320, 180),
    (640, 360),
    (960, 540),
    (1280, 720),
    (1920, 1080),
]


def bench(sct, mon, w, h, n, convert):
    region = {"left": mon["left"], "top": mon["top"], "width": w, "height": h}
    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        raw = sct.grab(region)
        if convert:
            # What the pipeline actually needs: a numpy view for hashing.
            arr = np.frombuffer(raw.bgra, dtype=np.uint8).reshape(raw.height, raw.width, 4)
            _ = arr[..., :3]
        times.append((time.perf_counter() - t0) * 1000.0)
    times.sort()
    return times[len(times) // 2], times[int(len(times) * 0.9)]


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 50
    print("Capture cost vs region area (%d samples each)" % n)
    print()
    print("  %-14s %10s %10s %10s %12s" % ("region", "px (k)", "p50 ms", "p90 ms", "ms per Mpx"))
    print("  " + "-" * 60)

    rows = []
    with mss.mss() as sct:
        mon = sct.monitors[1]
        # Warm up: the first grab allocates buffers and is not representative.
        sct.grab({"left": mon["left"], "top": mon["top"], "width": 640, "height": 360})
        for w, h in SIZES:
            if w > mon["width"] or h > mon["height"]:
                continue
            p50, p90 = bench(sct, mon, w, h, n, convert=True)
            mpx = (w * h) / 1_000_000.0
            rows.append((w, h, p50, p90, mpx))
            print(
                "  %-14s %10.0f %10.2f %10.2f %12.1f"
                % ("%dx%d" % (w, h), w * h / 1000.0, p50, p90, p50 / mpx)
            )

    print()
    if len(rows) >= 2:
        small = rows[0]
        large = rows[-1]
        area_ratio = (large[0] * large[1]) / (small[0] * small[1])
        time_ratio = large[2] / max(small[2], 0.001)
        print("Area ratio smallest->largest: %.0fx,  time ratio: %.1fx" % (area_ratio, time_ratio))
        if time_ratio < area_ratio * 0.25:
            print("VERDICT: dominated by FIXED per-call overhead.")
            print("  Shrinking the capture will not help. Need a different backend.")
        else:
            print("VERDICT: cost scales with AREA.")
            print("  Capturing a smaller region solves the budget problem.")
        fixed = small[2]
        print()
        print("Floor (smallest region p50): %.2f ms -- this is the per-call overhead." % fixed)
    return 0


if __name__ == "__main__":
    sys.exit(main())
