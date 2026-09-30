"""
Phase 0b: run the cluster-stability gate across all four genre modes.

Launches the mode simulator in its own browser window at a known screen position so
the capture region is deterministic -- the same problem a real harness has when it
attaches to a game window, solved the same way.

Usage:
    python run_0b.py [seconds_per_mode] [--save]

--save writes one PNG per mode so the capture alignment can be eyeballed; worth
doing once, because a misaligned capture would silently measure the desktop
wallpaper and report a beautiful plateau.
"""

import os
import subprocess
import sys
import tempfile
import time

import numpy as np
from PIL import Image

from frame import FrameSource, capture_digest
from clusters import ClusterLibrary
from bench_clusters import growth_verdict

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]

MODES = ["menu", "dialogue", "cutscene", "world"]

# Window placed at the top-left; the capture region sits inside its content area,
# clear of the window frame.
WIN_POS = (0, 0)
WIN_SIZE = (720, 480)
CAPTURE_REGION = {"left": 10, "top": 60, "width": 640, "height": 360}

HZ = 20


def find_browser():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def launch(browser, url, profile_dir):
    args = [
        browser,
        "--app=" + url,
        "--window-position=%d,%d" % WIN_POS,
        "--window-size=%d,%d" % WIN_SIZE,
        "--user-data-dir=" + profile_dir,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-features=Translate",
        "--autoplay-policy=no-user-gesture-required",
    ]
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def kill(proc):
    try:
        subprocess.run(
            ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        proc.kill()


# A capture of a window that never opened is a flat grey, and it clusters to
# exactly one cluster with a perfect plateau -- an extremely convincing false PASS.
# Nothing is measured until the region provably contains rendered content.
MIN_CONTENT_STD = 12.0


def wait_for_content(src, timeout=8.0):
    """Block until the capture region shows real content. Returns the std seen."""
    t_end = time.perf_counter() + timeout
    best = 0.0
    while time.perf_counter() < t_end:
        gray = src.grab_gray()
        std = float(gray.std())
        best = max(best, std)
        if std >= MIN_CONTENT_STD:
            return std
        time.sleep(0.25)
    return best


def measure(seconds, save_png=None):
    src = FrameSource(region=CAPTURE_REGION)
    libs = {"global": ClusterLibrary(strategy="global"), "masked": ClusterLibrary(strategy="masked")}
    series = {k: [] for k in libs}
    frames, changed = 0, 0
    prev = None
    interval = 1.0 / HZ
    next_tick = time.perf_counter()
    t_end = time.perf_counter() + seconds

    saved = False
    while time.perf_counter() < t_end:
        now = time.perf_counter()
        if now < next_tick:
            time.sleep(max(0.0, next_tick - now))
        next_tick += interval

        if save_png and not saved:
            gray = src.grab_gray()
            Image.fromarray(gray).save(save_png)
            saved = True

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
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else 20.0
    save = "--save" in sys.argv

    browser = find_browser()
    if not browser:
        print("No Chrome or Edge found.")
        return 1

    print("Phase 0b: cluster stability across genre modes (%.0fs each)" % seconds)
    print("capture region %(width)dx%(height)d at (%(left)d,%(top)d)" % CAPTURE_REGION)
    print()

    results = {}

    for mode in MODES:
        url = "http://localhost:8177/modes.html?mode=" + mode
        # A FRESH profile per mode. Sharing one lets Chrome's singleton lock
        # silently refuse to open the second window, and the capture then reads
        # whatever is underneath -- which is how this script first reported a
        # clean 4/4 PASS while measuring nothing at all.
        profile = tempfile.mkdtemp(prefix="betatest-chrome-%s-" % mode)
        proc = launch(browser, url, profile)

        probe = FrameSource(region=CAPTURE_REGION)
        std = wait_for_content(probe)
        probe.close()
        if std < MIN_CONTENT_STD:
            kill(proc)
            print("  %-9s ABORT - capture region is blank (std %.1f)." % (mode, std))
            print("            The window did not open, or is not at the expected position.")
            return 2
        print("  %-9s window ready (content std %.1f)" % (mode, std))

        png = ("capture_%s.png" % mode) if save else None
        try:
            libs, series, frames, changed = measure(seconds, save_png=png)
        finally:
            kill(proc)
            time.sleep(1.5)

        row = {}
        for name, lib in libs.items():
            s = lib.summary()
            verdict, ratio = growth_verdict(series[name])
            row[name] = (s, verdict, series[name])
        results[mode] = (row, frames, changed)

        print("  %-9s frames %3d  changed %3d (%3.0f%%)" % (mode, frames, changed, 100.0 * changed / max(frames, 1)))
        for name in ("global", "masked"):
            s, verdict, ser = row[name]
            peak = max(ser) if ser else 0
            step = max(1, len(ser) // 34)
            bars = "".join(" .:-=+*#@"[min(8, int(8 * v / max(peak, 1)))] for v in ser[::step])
            print(
                "      %-7s clusters %4d  novel/fr %.3f  world-like %d  %-8s %s"
                % (name, s["clusters"], s["novel_rate"], s["world_like"], verdict, bars)
            )
        print()

    print("=" * 72)
    print("  %-10s %-22s %-22s" % ("mode", "global", "masked"))
    print("  " + "-" * 60)
    passes = 0
    for mode in MODES:
        row, _, _ = results[mode]
        g = "%d clusters / %s" % (row["global"][0]["clusters"], row["global"][1])
        m = "%d clusters / %s" % (row["masked"][0]["clusters"], row["masked"][1])
        ok = row["masked"][1] in ("plateau", "slowing")
        passes += 1 if ok else 0
        print("  %-10s %-22s %-22s %s" % (mode, g, m, "PASS" if ok else "FAIL"))

    print()
    print("  GATE: masked strategy plateaus in %d of %d modes" % (passes, len(MODES)))
    if passes >= 3:
        print("  PASS - the cost model holds; a VLM labels each screen once.")
    else:
        print("  FAIL - clusters fragment; a VLM would fire per frame.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
