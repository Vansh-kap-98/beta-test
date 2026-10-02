"""
How accurately do we read the HUD off the screen?

This is the dual-pipeline ground-truth check the plan proposes for real games, with
the fixture standing in for an injected scene tree: the page publishes its true score
and move count into the window title, and we compare what OCR predicted against what
the game actually had.

It exists because the economy oracles started producing confident findings on a CLEAN
build through the live pipeline -- "work done with no reward" on a build whose only
planted bug was elsewhere. Those oracles compare two numbers across two steps, so they
inherit the full error rate of reading those numbers twice, and a single stale or
misread score manufactures a defect out of nothing.

The question is not "is OCR good" but "is it good enough to support a claim about the
game's economy", and that needs a number rather than an impression.

Run the fixture with the ground-truth channel on:
  http://127.0.0.1:8177/match3.html?expose=title
"""
import sys
import time

import json
import urllib.request

import keys
import window
from frame import FrameSource
import ocr as ocr_mod
import hud as hud_mod


TRUTH_URL = "http://127.0.0.1:8177/truth"


def fetch_truth():
    """The out-of-band ground-truth channel.

    Read over HTTP rather than from the window title, because the title is VISIBLE to
    the screen capture in a chromeless window and the perception pipeline could
    otherwise read the answer it is being scored against.
    """
    try:
        with urllib.request.urlopen(TRUTH_URL, timeout=1.0) as r:
            d = json.loads(r.read().decode("utf-8"))
        if not d:
            return None
        return {"variant": d["variant"], "score": float(d["score"]),
                "moves": float(d["moves"]), "overlay": d.get("overlay")}
    except Exception:
        return None


def main():
    samples = int(sys.argv[1]) if len(sys.argv) > 1 else 40
    window.set_dpi_aware()

    if fetch_truth() is None:
        print("no ground truth at " + TRUTH_URL)
        print("open http://127.0.0.1:8177/match3.html?expose=post first")
        return 2
    cands = window.find_windows("Sugar Cascade")
    if not cands:
        print("no fixture window found")
        return 2
    w = cands[0]
    print("reading %s (%dx%d)\n" % (w.process, w.width, w.height))

    src = FrameSource(region=w.region)

    # The HUD is behind the tutorial overlay at start, so dismiss it: measuring OCR
    # on a screen where the numbers are not visible reports zero reads and says
    # nothing about whether the numbers can be read.
    window.focus(w.hwnd)
    t0 = fetch_truth()
    if t0 and t0.get("overlay") == "ovTutorial":
        for r in ocr_mod.recognize(src.grab_gray()).regions:
            if "got it" in r.text.lower():
                cx = w.left + r.bbox[0] + r.bbox[2] // 2
                cy = w.top + r.bbox[1] + r.bbox[3] // 2
                keys.move_to(cx, cy)
                time.sleep(0.05)
                keys.click()
                time.sleep(0.4)
                break

    stats = {}
    n = 0
    while n < samples:
        title_truth = fetch_truth()
        if title_truth is None or title_truth.get("overlay"):
            # An overlay covers the HUD; nothing to measure this frame.
            time.sleep(0.2)
            continue
        gray = src.grab_gray()
        regions = ocr_mod.recognize(gray).regions
        vals = hud_mod.parse_hud(regions)
        n += 1

        for field in ("score", "moves"):
            s = stats.setdefault(field, {"read": 0, "exact": 0, "missing": 0, "wrong": []})
            got = vals.get(field)
            if got is None or got.confidence < 0.6:
                s["missing"] += 1
                continue
            s["read"] += 1
            if abs(got.value - title_truth[field]) < 0.5:
                s["exact"] += 1
            else:
                s["wrong"].append((title_truth[field], got.value, round(got.confidence, 2)))
        time.sleep(0.25)

    print("field    samples  read   exact-when-read   missing")
    for field, s in stats.items():
        read = s["read"]
        acc = (s["exact"] / read) if read else 0.0
        print("  %-6s %7d  %4d   %15.3f   %7d" % (field, n, read, acc, s["missing"]))
        for truth, got, conf in s["wrong"][:6]:
            print("        misread: truth %.0f -> read %.0f (confidence %.2f)" % (truth, got, conf))

    # The number that actually matters for the economy oracles. They need the value
    # right on BOTH sides of an action, so two independent reads must both be correct.
    print("")
    for field, s in stats.items():
        read = s["read"]
        if not read:
            continue
        per_read = s["exact"] / read
        coverage = read / n
        print("%s: single read %.3f correct, %.3f covered -> a before/after PAIR is "
              "usable about %.3f of the time" % (field, per_read, coverage,
                                                 (per_read * coverage) ** 2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
