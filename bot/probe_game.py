"""
Is this game testable? Run this with a game open.

    python probe_game.py                 # list candidate windows
    python probe_game.py silksong        # attach and probe (observation only)
    python probe_game.py silksong --input # also test whether input reaches it

Answers four questions that decide everything downstream:

  1. Can we attach to the window and read its client area?
  2. Does capture work on it, and at what latency?   (gate 0a, on a real target)
  3. Does the screen-cluster library plateau on it?  (gate 0b, on a real target)
  4. Does synthetic input actually reach it?         (the Phase 1 unknown)

Question 4 has no title to read back, so it is answered behaviourally: send an
input, and see whether the frame changes more than it does on its own. That is the
same "did the action produce observable change" proxy the agent uses to tell a
working action from a dead one.

SAFETY. --input sends only movement and arrow keys, never Enter, Escape, or any
mouse click, because those can confirm dialogs, quit to menu, or overwrite a save.
It cannot meaningfully alter game state beyond moving a character a short distance.
"""

import sys
import time

import numpy as np

import keys
import window
from frame import FrameSource, capture_digest
from clusters import ClusterLibrary
from bench_clusters import growth_verdict

# Non-destructive across essentially every game: movement and menu navigation.
SAFE_KEYS = ["left", "right", "up", "down", "w", "a", "s", "d"]

HZ = 20


def pct(vals, p):
    s = sorted(vals)
    return s[min(int(len(s) * p), len(s) - 1)] if s else 0.0


def list_candidates():
    wins = sorted(window.list_windows(), key=lambda w: -w.width * w.height)
    print("%-44s %-22s %s" % ("title", "process", "client rect"))
    print("-" * 96)
    for w in wins[:20]:
        print("%-44s %-22s %dx%d at (%d,%d)" % (
            w.title[:43], w.process[:21], w.width, w.height, w.left, w.top))
    print()
    print("Run:  python probe_game.py <part of the title or process name>")


def observe(src, seconds, hz=HZ):
    """Collect digests at a fixed rate. Returns (digests, timings)."""
    digs, times = [], []
    interval = 1.0 / hz
    next_tick = time.perf_counter()
    end = time.perf_counter() + seconds
    while time.perf_counter() < end:
        now = time.perf_counter()
        if now < next_tick:
            time.sleep(max(0.0, next_tick - now))
        next_tick += interval
        d, t = capture_digest(src)
        digs.append(d)
        times.append(t.total_ms)
    return digs, times


def churn(digests):
    """Mean frame-to-frame hash distance -- the target's own visual noise floor."""
    if len(digests) < 2:
        return 0.0
    return float(np.mean([digests[i].distance(digests[i - 1]) for i in range(1, len(digests))]))


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    do_input = "--input" in sys.argv
    seconds = 20.0

    window.set_dpi_aware()
    if not args:
        list_candidates()
        return 0

    win = window.find_window(args[0])
    if not win:
        print("No window matching %r." % args[0])
        print()
        list_candidates()
        return 1

    print("Probing: %s" % win)
    print("DPI awareness: %s" % window.set_dpi_aware())
    print()

    src = FrameSource(region=win.region)

    # --- 1. capture health ------------------------------------------------------
    gray = src.grab_gray()
    std = float(gray.std())
    print("  capture region      %dx%d at (%d,%d)" % (win.width, win.height, win.left, win.top))
    print("  content std         %.1f %s" % (std, "OK" if std >= 12 else "SUSPICIOUS - blank?"))
    if std < 12:
        print()
        print("  The capture looks blank. Common causes:")
        print("   - the game is exclusive-fullscreen (try borderless windowed)")
        print("   - it is minimised or behind another window")
        print("   - it uses a protected swapchain that blocks desktop duplication")
        src.close()
        return 2

    # --- 2. latency (gate 0a on a real target) ---------------------------------
    print()
    print("  measuring latency and cluster stability for %.0fs..." % seconds)
    digests, times = observe(src, seconds)
    p50, p90 = pct(times, .5), pct(times, .9)
    fps = len(digests) / seconds
    noise = churn(digests)

    print()
    print("  perception p50      %.1f ms" % p50)
    print("  perception p90      %.1f ms" % p90)
    print("  sustained           %.1f fps" % fps)
    headroom = 80.0 - (p90 + 1.0)
    print("  headroom for model  %.1f ms %s" % (headroom, "OK" if headroom >= 33 else "TIGHT"))
    print("  visual noise floor  %.1f bits/frame" % noise)

    # --- 3. cluster stability (gate 0b on a real target) -----------------------
    libs = {"global": ClusterLibrary(strategy="global"), "masked": ClusterLibrary(strategy="masked")}
    series = {k: [] for k in libs}
    for d in digests:
        for name, lib in libs.items():
            lib.assign(d)
            series[name].append(len(lib.clusters))

    print()
    print("  %-9s %9s %9s  %s" % ("strategy", "clusters", "verdict", "growth"))
    for name, lib in libs.items():
        ser = series[name]
        verdict, _ = growth_verdict(ser)
        peak = max(ser) if ser else 1
        step = max(1, len(ser) // 30)
        bars = "".join(" .:-=+*#@"[min(8, int(8 * v / max(peak, 1)))] for v in ser[::step])
        print("  %-9s %9d %9s  %s" % (name, len(lib.clusters), verdict, bars))

    # --- 4. does input reach it? ----------------------------------------------
    if do_input:
        print()
        print("  --- input responsiveness ---")
        if not window.focus(win.hwnd):
            print("  could not focus the window; input would go nowhere.")
            src.close()
            return 3
        time.sleep(0.4)

        # Re-measure the noise floor with the window focused and nothing pressed,
        # so an idle animation is not mistaken for a response to our input.
        base_digs, _ = observe(src, 2.0)
        base = churn(base_digs)
        print("  idle churn (focused)  %.1f bits/frame" % base)
        threshold = max(base * 2.0, 3.0)
        print("  response threshold    %.1f bits/frame" % threshold)
        print()

        responded = 0
        for k in SAFE_KEYS:
            before, _ = observe(src, 0.4)
            keys.key_down(k)
            during, _ = observe(src, 0.7)
            keys.key_up(k)
            time.sleep(0.25)
            c = churn(during)
            hit = c >= threshold
            responded += 1 if hit else 0
            print("    %-6s churn %6.1f  %s" % (k, c, "RESPONDS" if hit else "no change"))

        print()
        if responded >= 2:
            print("  PASS - synthetic keyboard input reaches this game (%d/%d keys)." % (
                responded, len(SAFE_KEYS)))
        elif responded == 1:
            print("  WEAK - only one key produced change; could be coincidence.")
            print("  Re-run, or the game may need a virtual gamepad instead.")
        else:
            print("  FAIL - no key produced any visible change.")
            print("  Either the game ignores SendInput (RawInput -- needs ViGEm virtual")
            print("  pad), or it was on a screen where these keys legitimately do nothing.")
            print("  Try again on a screen where arrow keys should move a selection.")
    else:
        print()
        print("  (observation only -- pass --input to test whether input reaches the game)")

    src.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
