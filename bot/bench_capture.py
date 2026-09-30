"""
Phase 0a, step 1: how much of the latency budget does frame capture cost?

The plan allows ~40-65ms end to end for the fast loop, of which the decision model
(Laya, local) is expected to take ~33ms. That leaves roughly 30ms for everything
else -- capture, hashing, and input actuation combined. So capture needs to come in
well under 15ms or the real-time genres are out before any intelligence is added.

This benchmarks the capture backends available without installing anything, so we
know whether a dependency is even warranted.
"""

import sys
import time
import statistics


def percentiles(samples):
    s = sorted(samples)
    n = len(s)
    return {
        "min": s[0],
        "p50": s[n // 2],
        "p90": s[int(n * 0.90)],
        "p99": s[int(n * 0.99)],
        "max": s[-1],
        "mean": statistics.mean(s),
    }


def fmt(name, p, note=""):
    print(
        "  %-22s min %5.1f  p50 %5.1f  p90 %5.1f  p99 %5.1f  max %6.1f  %s"
        % (name, p["min"], p["p50"], p["p90"], p["p99"], p["max"], note)
    )


def bench_pillow_fullscreen(n=60):
    from PIL import ImageGrab

    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        img = ImageGrab.grab()
        times.append((time.perf_counter() - t0) * 1000.0)
    return times, img.size


def bench_pillow_region(n=60, box=(0, 0, 1280, 720)):
    from PIL import ImageGrab

    times = []
    for _ in range(n):
        t0 = time.perf_counter()
        img = ImageGrab.grab(bbox=box)
        times.append((time.perf_counter() - t0) * 1000.0)
    return times, img.size


def bench_mss_fullscreen(n=60):
    import mss

    with mss.mss() as sct:
        mon = sct.monitors[1]
        times = []
        for _ in range(n):
            t0 = time.perf_counter()
            raw = sct.grab(mon)
            times.append((time.perf_counter() - t0) * 1000.0)
        return times, (raw.width, raw.height)


def bench_mss_region(n=60):
    import mss

    with mss.mss() as sct:
        mon = sct.monitors[1]
        region = {
            "left": mon["left"],
            "top": mon["top"],
            "width": min(1280, mon["width"]),
            "height": min(720, mon["height"]),
        }
        times = []
        for _ in range(n):
            t0 = time.perf_counter()
            raw = sct.grab(region)
            times.append((time.perf_counter() - t0) * 1000.0)
        return times, (raw.width, raw.height)


BACKENDS = [
    ("pillow fullscreen", bench_pillow_fullscreen),
    ("pillow 1280x720", bench_pillow_region),
    ("mss fullscreen", bench_mss_fullscreen),
    ("mss 1280x720", bench_mss_region),
]


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 60
    print("Frame capture benchmark (%d samples each)" % n)
    print("Budget: capture + hash + input must fit ~30ms, so capture wants to be <15ms")
    print()

    results = {}
    for name, fn in BACKENDS:
        try:
            times, size = fn(n)
        except ImportError as e:
            print("  %-22s unavailable (%s)" % (name, e.name))
            continue
        except Exception as e:
            print("  %-22s failed: %s" % (name, e))
            continue
        p = percentiles(times)
        results[name] = p
        verdict = "OK" if p["p90"] < 15 else ("marginal" if p["p90"] < 30 else "TOO SLOW")
        fmt(name, p, "%dx%d  %s" % (size[0], size[1], verdict))

    print()
    if not results:
        print("No capture backend available at all.")
        return 1

    best = min(results.items(), key=lambda kv: kv[1]["p90"])
    print("Fastest: %s at p90 %.1f ms" % (best[0], best[1]["p90"]))
    if best[1]["p90"] >= 15:
        print("WARNING: no backend is comfortably inside budget on this machine.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
