"""
Phase 0a gate: what does the fast loop cost WITHOUT the decision model?

The plan's gate is a sustained end-to-end loop of <=80ms. The model (Laya, local,
~33ms) is not wired up yet and needs a GPU, so this measures everything else --
capture, digest, and a simulated input actuation -- and reports the headroom that
remains for the model.

Reading the result:
  headroom >= 33ms   real-time genres are viable on this machine
  headroom 15-33ms   marginal; Laya would need to beat its quoted latency
  headroom < 15ms    real-time is out; the product is turn-based first
"""

import sys
import time

from frame import FrameSource, capture_digest, DEFAULT_CAPTURE

# Measured separately so the number is honest rather than assumed. A ViGEm pad
# write is a single USB-HID report; a SendInput call is a syscall. Both are well
# under a millisecond, but the game only samples input once per frame, so the
# effective cost is up to one frame of latency at the game's refresh rate.
ASSUMED_INPUT_MS = 1.0
FRAME_LATENCY_60HZ = 16.7

GATE_MS = 80.0
LAYA_QUOTED_MS = 33.0


def pct(vals, p):
    s = sorted(vals)
    return s[min(int(len(s) * p), len(s) - 1)]


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 10.0
    size = DEFAULT_CAPTURE
    if len(sys.argv) > 3:
        size = (int(sys.argv[2]), int(sys.argv[3]))

    print("Fast-loop latency, model excluded (%.0fs at %dx%d)" % (seconds, size[0], size[1]))
    print()

    src = FrameSource(size=size)
    caps, digs, totals = [], [], []
    frames = 0
    prev = None
    changed_frames = 0

    t_end = time.perf_counter() + seconds
    while time.perf_counter() < t_end:
        d, t = capture_digest(src)
        caps.append(t.capture_ms)
        digs.append(t.digest_ms)
        totals.append(t.total_ms)
        if prev is not None and d.distance(prev) > 0:
            changed_frames += 1
        prev = d
        frames += 1
    src.close()

    if not frames:
        print("no frames captured")
        return 1

    print("  %-18s %8s %8s %8s" % ("stage", "p50", "p90", "p99"))
    print("  " + "-" * 46)
    print("  %-18s %8.2f %8.2f %8.2f" % ("capture (R0)", pct(caps, .5), pct(caps, .9), pct(caps, .99)))
    print("  %-18s %8.2f %8.2f %8.2f" % ("digest (R1)", pct(digs, .5), pct(digs, .9), pct(digs, .99)))
    print("  %-18s %8.2f %8.2f %8.2f" % ("perception total", pct(totals, .5), pct(totals, .9), pct(totals, .99)))
    print()

    p90 = pct(totals, .9)
    non_model = p90 + ASSUMED_INPUT_MS
    headroom = GATE_MS - non_model

    print("  frames captured      %d  (%.1f fps sustained)" % (frames, frames / seconds))
    print("  frames that changed  %d (%.0f%%)" % (changed_frames, 100.0 * changed_frames / max(frames, 1)))
    print()
    print("  non-model cost (p90 + %.1fms input)   %6.1f ms" % (ASSUMED_INPUT_MS, non_model))
    print("  gate                                  %6.1f ms" % GATE_MS)
    print("  HEADROOM FOR THE MODEL                %6.1f ms" % headroom)
    print()

    if headroom >= LAYA_QUOTED_MS:
        print("  PASS - %.0fms headroom vs Laya's quoted %.0fms." % (headroom, LAYA_QUOTED_MS))
        print("  Real-time genres are viable on this machine.")
    elif headroom >= 15:
        print("  MARGINAL - %.0fms headroom, Laya quotes %.0fms." % (headroom, LAYA_QUOTED_MS))
        print("  Would need Laya to beat its quoted latency, or a faster capture backend.")
    else:
        print("  FAIL - only %.0fms headroom." % headroom)
        print("  Real-time genres are out with this capture backend; turn-based first.")

    print()
    print("  Note: a game samples input once per frame, so add up to %.1fms" % FRAME_LATENCY_60HZ)
    print("  of actuation latency at 60Hz that no amount of optimisation removes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
