"""
Phase 1 self-test: does synthetic input actually reach an application?

SendInput returns success whether or not the target consumes the event, so calling
it proves nothing. This closes the loop: inject with SendInput, then read the result
back through GetWindowTextW. The injection path and the verification path share no
code, so a pass means a real event reached a real application.

De-risked against a browser window before any game, exactly as the plan requires.

    npm run demo:web        # in another terminal
    python test_input.py
"""

import os
import subprocess
import sys
import tempfile
import time

import keys
import window

URL = "http://localhost:8177/keytest.html"
WIN_POS = (0, 0)
WIN_SIZE = (760, 520)

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
]


def find_browser():
    for p in CHROME_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


def launch(browser, profile):
    return subprocess.Popen(
        [browser, "--app=" + URL,
         "--window-position=%d,%d" % WIN_POS, "--window-size=%d,%d" % WIN_SIZE,
         "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def kill(proc):
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def title_of(hwnd):
    import ctypes
    import ctypes.wintypes as wt
    n = window.user32.GetWindowTextLengthW(wt.HWND(hwnd))
    buf = ctypes.create_unicode_buffer(n + 1)
    window.user32.GetWindowTextW(wt.HWND(hwnd), buf, n + 1)
    return buf.value


def wait_title(hwnd, predicate, timeout=2.0):
    """Poll the title until it satisfies `predicate`. The browser updates the title
    asynchronously, so a fixed sleep would be flaky in both directions."""
    end = time.perf_counter() + timeout
    last = ""
    while time.perf_counter() < end:
        last = title_of(hwnd)
        if predicate(last):
            return True, last
        time.sleep(0.03)
    return False, last


class Results:
    def __init__(self):
        self.rows = []

    def add(self, name, ok, detail=""):
        self.rows.append((name, ok, detail))
        print("  %-38s %s  %s" % (name, "PASS" if ok else "FAIL", detail))

    def summary(self):
        ok = sum(1 for _, o, _ in self.rows if o)
        print()
        print("  %d/%d passed" % (ok, len(self.rows)))
        return ok == len(self.rows)


def main():
    browser = find_browser()
    if not browser:
        print("No Chrome or Edge found.")
        return 1

    print("Phase 1 self-test: synthetic input reaching an application")
    print("DPI awareness:", window.set_dpi_aware())
    print()

    profile = tempfile.mkdtemp(prefix="betatest-input-")
    proc = launch(browser, profile)
    r = Results()
    try:
        time.sleep(3.0)
        win = window.find_window("keytest")
        if not win:
            print("  probe window not found -- is `npm run demo:web` running?")
            return 2
        print("  target:", win)
        print()

        ok = window.focus(win.hwnd)
        r.add("window can be focused", ok, "" if ok else "input will go nowhere")
        if not ok:
            return 3
        time.sleep(0.3)

        # 1. A letter key by scancode.
        keys.tap("w")
        hit, t = wait_title(win.hwnd, lambda s: "KeyW" in s)
        r.add("scancode letter key (w)", hit, t[-46:] if not hit else "")

        # 2. Key-up must arrive too. A missing release is the classic stuck-key bug
        #    and would leave the character walking into a wall for the whole run.
        hit, t = wait_title(win.hwnd, lambda s: "up:KeyW" in s)
        r.add("key release observed (no stuck key)", hit, t[-46:] if not hit else "")

        # 3. An extended key -- needs KEYEVENTF_EXTENDEDKEY or it reads as numpad.
        keys.tap("left")
        hit, t = wait_title(win.hwnd, lambda s: "ArrowLeft" in s)
        r.add("extended key (left arrow)", hit, t[-46:] if not hit else "")

        # 4. A held key, which is how movement macros work.
        t0 = time.perf_counter()
        keys.hold("d", 220)
        held_ms = (time.perf_counter() - t0) * 1000
        hit, t = wait_title(win.hwnd, lambda s: "up:KeyD" in s)
        r.add("held key press+release (220ms)", hit and 200 < held_ms < 320,
              "actual %.0fms" % held_ms)

        # 5. Absolute mouse click at a known point inside the client area.
        cx, cy = win.client_to_screen(win.width // 2, win.height // 2)
        keys.click_at(cx, cy)
        hit, t = wait_title(win.hwnd, lambda s: "mdown:0@" in s)
        r.add("mouse click at client coordinate", hit, t[-46:] if not hit else "")

        # 6. The click must land where we aimed. This is what catches a DPI or
        #    client-vs-window-rect mistake, which otherwise silently offsets every
        #    click -- by the border width, or by the display scale factor.
        #
        #    The page reports physical pixels (clientX * devicePixelRatio) because
        #    the bot works in physical pixels end to end: screen capture produces
        #    them, so detected UI coordinates are in them, so clicks must be too.
        if hit:
            seg = [p for p in t.split(",") if "mdown:0@" in p]
            got_x = int(seg[-1].split("@")[1]) if seg else -1
            expect_x = win.width // 2
            close = abs(got_x - expect_x) <= max(8, win.width * 0.03)
            r.add("click landed where aimed", close,
                  "aimed x=%d, got x=%d (physical px)" % (expect_x, got_x))

        # 7. Scroll wheel.
        keys.scroll(-1)
        hit, t = wait_title(win.hwnd, lambda s: "wheel:" in s)
        r.add("scroll wheel", hit, t[-46:] if not hit else "")

        print()
        all_ok = r.summary()
        if all_ok:
            print()
            print("  Synthetic input works against a normal windowed application.")
            print("  This does NOT yet prove it works against a game: titles reading")
            print("  RawInput may ignore all of it. Run probe_game.py against a real")
            print("  game to find out, and fall back to a virtual gamepad if needed.")
        return 0 if all_ok else 1
    finally:
        keys.release_all(["w", "a", "s", "d", "left", "right", "up", "down", "shift", "ctrl"])
        kill(proc)


if __name__ == "__main__":
    sys.exit(main())
