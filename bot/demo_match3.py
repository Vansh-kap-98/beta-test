"""
The full execution chain, end to end, on the match-3 fixture.

Demonstrates exactly what happens between "the model decides" and "the game moves":

    capture -> detect grid -> read board -> enumerate legal swaps
            -> [DECISION]   <- a stub stands in for Laya here; no GPU needed
            -> look up the chosen sig -> run its macro -> SendInput
            -> wait for the cascade to settle -> verify the board changed

The decision step is deliberately the smallest part. Swapping the stub for Laya is
one function call, and nothing else in this file changes -- which is the point.

    npm run demo:web          # in another terminal
    python demo_match3.py [moves]
"""

import os
import subprocess
import sys
import tempfile
import time

import numpy as np

import keys
import match3
import ocr as ocr_mod
import window
from frame import FrameSource, digest_gray
from macros import MacroExecutor

URL = "http://localhost:8177/match3.html?seed=7"
WIN_SIZE = (1000, 760)
CHROME = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def browser():
    for p in CHROME:
        if os.path.exists(p):
            return p
    return None


def pick_move(swaps):
    """STUB for the decision model.

    Laya will answer a `choice` question over these same candidates, returning one
    sig plus a calibrated probability. Until then, take the highest-clearing move.
    Note what the stub does NOT do: it cannot invent a move, because the candidate
    list was computed from the board before any decision was made.
    """
    return swaps[0], 1.0, "stub: highest-clearing"


def main():
    n_moves = int(sys.argv[1]) if len(sys.argv) > 1 else 4
    b = browser()
    if not b:
        print("no browser found")
        return 1

    prof = tempfile.mkdtemp(prefix="m3-")
    proc = subprocess.Popen(
        [b, "--app=" + URL, "--window-position=0,0",
         "--window-size=%d,%d" % WIN_SIZE, "--user-data-dir=" + prof,
         "--no-first-run", "--no-default-browser-check"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        time.sleep(3.5)
        win = window.find_window("Sugar Cascade")
        if not win:
            print("fixture window not found -- is `npm run demo:web` running?")
            return 2
        print("target: %s" % win)
        if not window.focus(win.hwnd):
            print("could not focus the window")
            return 3
        time.sleep(0.4)

        src = FrameSource(region=win.region)
        ex = MacroExecutor()
        settle = match3.SettleDetector()

        # Dismiss the tutorial by reading it, rather than by knowing where it is.
        frame = src.grab_gray()
        res = ocr_mod.recognize(frame)
        print("tutorial text read: %r" % res.text[:70])
        got = [r for r in res.regions if "got it" in r.text.lower()]
        if got:
            bx, by, bw, bh = got[0].bbox
            keys.click_at(win.left + bx + bw // 2, win.top + by + bh // 2)
            print("dismissed tutorial by clicking the OCR'd button")
            time.sleep(0.6)

        # --- perception -----------------------------------------------------
        bgr = src.grab_bgr()
        grid = match3.detect_grid(bgr)
        if grid is None:
            print("FAIL: no grid detected")
            return 4
        print()
        print("grid detected: %s" % grid)

        board, conf = match3.read_board(bgr, grid)
        print("board read (confidence %.2f):" % conf)
        for row in board:
            print("   " + " ".join("%2d" % v for v in row))

        # --- the loop -------------------------------------------------------
        print()
        for move_no in range(1, n_moves + 1):
            bgr = src.grab_bgr()
            grid = match3.detect_grid(bgr) or grid
            board, conf = match3.read_board(bgr, grid)

            swaps = match3.valid_swaps(board)
            if not swaps:
                print("move %d: no legal swaps -- board is dead" % move_no)
                break

            macros = match3.swap_macros(grid, swaps, win.left, win.top)
            by_sig = {m.sig: m for m in macros}

            chosen, p, why = pick_move(swaps)
            macro = by_sig[chosen.sig]

            print("move %d: %d legal swaps; chose %-22s (clears %d, p=%.2f) [%s]"
                  % (move_no, len(swaps), chosen.sig, chosen.cleared, p, why))
            print("        macro script: %s"
                  % " -> ".join(s.kind + (("@%d,%d" % (s.x, s.y)) if s.kind == "mouseTo" else "")
                                for s in macro.script))

            before_hash = digest_gray(src.grab_gray()).phash
            ex.run(macro, max_ms=3000)

            # Wait for the cascade to stop before looking again.
            settle.reset()
            t0 = time.perf_counter()
            while time.perf_counter() - t0 < 4.0:
                if settle.update(digest_gray(src.grab_gray())):
                    break
                time.sleep(0.05)
            settled_ms = (time.perf_counter() - t0) * 1000

            after_hash = digest_gray(src.grab_gray()).phash
            changed = bin(before_hash ^ after_hash).count("1")
            print("        executed; board settled in %.0f ms; frame changed %d bits %s"
                  % (settled_ms, changed, "OK" if changed > 0 else "NO EFFECT"))

        # --- read the HUD back ---------------------------------------------
        print()
        hud = ocr_mod.recognize(src.grab_gray()[0:60, :])
        print("HUD after play: %r" % hud.text[:80])
        src.close()
        return 0
    finally:
        keys.release_all(["w", "a", "s", "d"])
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    sys.exit(main())
