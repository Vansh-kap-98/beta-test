"""
Phase 0b gate: does the screen-cluster library plateau, or fragment?

The gate. If cluster count plateaus, a VLM labels each screen once and the cost
model holds. If it grows linearly with time, the VLM fires on every frame and the
whole economic argument for a System One architecture collapses.

Expected result, and the reason both strategies are measured side by side:
  menu / dialogue / cutscene  -> should plateau under BOTH strategies
  world (moving viewport)     -> should fragment under "global" and be rescued by
                                 "masked", which identifies a screen by its stable
                                 HUD tiles rather than by the churning viewport

A "global" strategy that fragments on world content is not a failure -- it is the
measurement that justifies the masked strategy existing.
"""

import sys
import time

from frame import FrameSource, capture_digest, DEFAULT_CAPTURE
from clusters import ClusterLibrary


def growth_verdict(series):
    """Compare cluster growth in the second half of the run against the first."""
    if len(series) < 8:
        return "inconclusive", 0.0
    mid = len(series) // 2
    first = series[mid] - series[0]
    second = series[-1] - series[mid]
    if first <= 0:
        return ("plateau" if second <= 1 else "growing"), 0.0
    ratio = second / first
    if ratio <= 0.25:
        return "plateau", ratio
    if ratio <= 0.6:
        return "slowing", ratio
    return "linear", ratio


def run(seconds, region=None, size=DEFAULT_CAPTURE, hz=20):
    src = FrameSource(region=region, size=size)
    libs = {
        "global": ClusterLibrary(strategy="global"),
        "masked": ClusterLibrary(strategy="masked"),
    }
    series = {k: [] for k in libs}
    frames = 0
    changed = 0
    prev = None
    interval = 1.0 / hz

    t_end = time.perf_counter() + seconds
    next_tick = time.perf_counter()
    while time.perf_counter() < t_end:
        now = time.perf_counter()
        if now < next_tick:
            time.sleep(max(0.0, next_tick - now))
        next_tick += interval

        d, _ = capture_digest(src)
        frames += 1
        if prev is not None and d.distance(prev) > 0:
            changed += 1
        prev = d
        for name, lib in libs.items():
            lib.assign(d)
            series[name].append(len(lib.clusters))
    src.close()
    return libs, series, frames, changed


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 20.0
    label = sys.argv[2] if len(sys.argv) > 2 else "unlabelled"

    print("Cluster stability: %s (%.0fs)" % (label, seconds))
    libs, series, frames, changed = run(seconds)
    print("  frames %d, changed %d (%.0f%%)" % (frames, changed, 100.0 * changed / max(frames, 1)))
    print()
    print("  %-10s %9s %10s %9s %11s %9s" % ("strategy", "clusters", "novel/fr", "largest", "world-like", "verdict"))
    print("  " + "-" * 64)

    results = {}
    for name, lib in libs.items():
        s = lib.summary()
        verdict, ratio = growth_verdict(series[name])
        results[name] = (s, verdict, ratio)
        print(
            "  %-10s %9d %10.3f %9d %11d %9s"
            % (name, s["clusters"], s["novel_rate"], s["largest"], s["world_like"], verdict)
        )

    print()
    # Sparkline of cluster growth so the shape is visible, not just the endpoint.
    for name in libs:
        vals = series[name]
        if not vals:
            continue
        step = max(1, len(vals) // 40)
        sampled = vals[::step]
        peak = max(sampled) or 1
        bars = "".join(" .:-=+*#@"[min(8, int(8 * v / peak))] for v in sampled)
        print("  %-8s %s  (0..%d)" % (name, bars, peak))

    print()
    g_verdict = results["global"][1]
    m_verdict = results["masked"][1]
    if m_verdict == "plateau":
        print("  PASS - masked strategy plateaus.")
        if g_verdict != "plateau":
            print("  The masked strategy rescued content the global strategy could not cluster,")
            print("  which is exactly the case it exists for.")
    elif m_verdict == "slowing":
        print("  MARGINAL - still growing but decelerating. Longer run needed.")
    else:
        print("  FAIL - clusters grow linearly under both strategies.")
        print("  A VLM would fire on nearly every frame here; the cost model does not hold")
        print("  for this content type and it needs a dedicated non-clustering mode.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
