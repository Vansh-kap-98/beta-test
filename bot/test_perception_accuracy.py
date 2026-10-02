"""
Perception accuracy against ground truth.

The fixture publishes its real board into the window title; the vision pipeline
predicts the same board from pixels. Comparing them gives a labelled accuracy
measurement with no hand-annotation -- which is exactly the dual-pipeline harness
the plan proposes for real games, where an injected scene tree labels what the
screen reading guessed. The fixture stands in for the injection.

Symbol IDs are arbitrary on both sides (the clusterer numbers colours in the order
it meets them), so the comparison solves for the best label permutation first.
"""
import ctypes, ctypes.wintypes as wt, subprocess, sys, tempfile, time
import numpy as np
import keys, match3, ocr as ocr_mod, window
from frame import FrameSource

CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
URL = "http://localhost:8177/match3.html?seed=11&expose=title"


def title(hwnd):
    n = window.user32.GetWindowTextLengthW(wt.HWND(hwnd))
    b = ctypes.create_unicode_buffer(n + 1)
    window.user32.GetWindowTextW(wt.HWND(hwnd), b, n + 1)
    return b.value


def best_permutation_accuracy(pred, truth):
    """Match predicted cluster ids to true ids by majority vote, then score."""
    pred, truth = pred.flatten(), truth.flatten()
    mapping = {}
    for pc in set(pred.tolist()):
        votes = truth[pred == pc]
        if votes.size:
            mapping[pc] = np.bincount(votes).argmax()
    mapped = np.array([mapping.get(p, -1) for p in pred])
    return float((mapped == truth).mean()), mapping


def main():
    prof = tempfile.mkdtemp(prefix="m3acc-")
    proc = subprocess.Popen([CHROME, "--app=" + URL, "--window-position=0,0",
        "--window-size=1000,760", "--user-data-dir=" + prof,
        "--no-first-run", "--no-default-browser-check"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        time.sleep(3.5)
        w = window.find_window("M3|")
        if not w:
            print("fixture window not found"); return 2
        window.focus(w.hwnd); time.sleep(0.4)
        src = FrameSource(region=w.region)

        res = ocr_mod.recognize(src.grab_gray())
        got = [r for r in res.regions if "got it" in r.text.lower()]
        if got:
            bx, by, bw, bh = got[0].bbox
            keys.click_at(w.left + bx + bw // 2, w.top + by + bh // 2)
            time.sleep(0.8)

        print("  %-6s %-9s %-9s %8s %10s" % ("trial", "grid", "kinds", "cellAcc", "swapMatch"))
        print("  " + "-" * 52)
        accs, swap_ok, n = [], 0, 0

        for trial in range(6):
            bgr = src.grab_bgr()
            t = title(w.hwnd)
            if not t.startswith("M3|"):
                print("  title channel not live:", t[:40]); break
            _, variant, score, moves, overlay, gridstr = t.split("|", 5)
            truth = np.array([int(c) if c != "." else -1 for c in gridstr]).reshape(8, 8)

            g = match3.detect_grid(bgr)
            if g is None:
                print("  trial %d: NO GRID DETECTED" % trial); continue
            pred, conf = match3.read_board(bgr, g)
            if pred.shape != truth.shape:
                print("  trial %d: shape %s != truth %s" % (trial, pred.shape, truth.shape)); continue

            acc, _ = best_permutation_accuracy(pred, truth)
            accs.append(acc)

            # Do the legal moves we computed match the ones the game agrees exist?
            mine = match3.valid_swaps(pred)
            theirs = match3.valid_swaps(truth)
            same = len(mine) == len(theirs)
            swap_ok += 1 if same else 0
            n += 1
            print("  %-6d %-9s %-9d %7.1f%% %10s" % (
                trial, "%dx%d" % (g.cols, g.rows), len(set(pred.flatten())),
                acc * 100, "%d/%d %s" % (len(mine), len(theirs), "OK" if same else "DIFF")))

            # Make a move so the next trial sees a different board.
            if mine:
                macros = match3.swap_macros(g, mine, w.left, w.top)
                from macros import MacroExecutor
                MacroExecutor().run(macros[0], max_ms=2500)
                time.sleep(1.4)

        print()
        if accs:
            print("  mean cell accuracy   %.1f%%" % (100 * np.mean(accs)))
            print("  legal-move agreement %d/%d trials" % (swap_ok, n))
        src.close()
        return 0
    finally:
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == "__main__":
    sys.exit(main())
