"""
Window targeting -- how the bot attaches to a running game.

Pure ctypes against user32/kernel32; no pywin32, no build step. Two details matter
more than the rest of this file:

  1. DPI AWARENESS. Without it, Windows lies about coordinates on any scaled
     display: GetWindowRect returns logical pixels while the screen capture reads
     physical ones. On a 150% display that is a 1.5x mismatch, so every click lands
     in the wrong place and every capture frames the wrong region -- and neither
     failure announces itself, they just silently misbehave.

  2. CLIENT RECT, not window rect. The window rect includes the title bar and
     borders; the game renders into the client area. Capturing the window rect puts
     chrome in the frame and shifts every coordinate by the border width.
"""

import ctypes
import ctypes.wintypes as wt
import time
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

# Per-monitor-v2: correct coordinates even when the app spans displays with
# different scale factors.
DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)

_dpi_set = False


def set_dpi_aware() -> str:
    """Must be called before any coordinate or capture work. Idempotent."""
    global _dpi_set
    if _dpi_set:
        return "already"
    try:
        if user32.SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2):
            _dpi_set = True
            return "per-monitor-v2"
    except AttributeError:
        pass
    try:
        # Windows 8.1 fallback: 2 == PROCESS_PER_MONITOR_DPI_AWARE
        shcore = ctypes.WinDLL("shcore", use_last_error=True)
        if shcore.SetProcessDpiAwareness(2) == 0:
            _dpi_set = True
            return "per-monitor"
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
        _dpi_set = True
        return "system"
    except Exception:
        return "FAILED"


@dataclass
class WindowInfo:
    hwnd: int
    title: str
    process: str
    pid: int
    # Client area in PHYSICAL screen pixels -- what mss wants and where clicks go.
    left: int
    top: int
    width: int
    height: int

    @property
    def region(self) -> Dict[str, int]:
        """Capture region for FrameSource."""
        return {"left": self.left, "top": self.top, "width": self.width, "height": self.height}

    def client_to_screen(self, x: int, y: int) -> "tuple[int, int]":
        """Map a point inside the client area to absolute screen coordinates."""
        return self.left + x, self.top + y

    def __str__(self) -> str:
        return "%s [%s] %dx%d at (%d,%d)" % (
            self.title or "(untitled)", self.process, self.width, self.height, self.left, self.top
        )


def _process_name(pid: int) -> str:
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return "?"
    try:
        buf = ctypes.create_unicode_buffer(512)
        size = wt.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return buf.value.rsplit("\\", 1)[-1]
        return "?"
    finally:
        kernel32.CloseHandle(h)


def _client_rect_on_screen(hwnd: int):
    rect = wt.RECT()
    if not user32.GetClientRect(wt.HWND(hwnd), ctypes.byref(rect)):
        return None
    pt = wt.POINT(0, 0)
    if not user32.ClientToScreen(wt.HWND(hwnd), ctypes.byref(pt)):
        return None
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None
    return pt.x, pt.y, w, h


def _info(hwnd: int) -> Optional[WindowInfo]:
    r = _client_rect_on_screen(hwnd)
    if r is None:
        return None
    length = user32.GetWindowTextLengthW(wt.HWND(hwnd))
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(wt.HWND(hwnd), buf, length + 1)
    pid = wt.DWORD()
    user32.GetWindowThreadProcessId(wt.HWND(hwnd), ctypes.byref(pid))
    return WindowInfo(
        hwnd=hwnd, title=buf.value, process=_process_name(pid.value), pid=pid.value,
        left=r[0], top=r[1], width=r[2], height=r[3],
    )


ENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)


def list_windows(min_area: int = 200 * 200) -> List[WindowInfo]:
    """Visible top-level windows large enough to plausibly be a game."""
    set_dpi_aware()
    out: List[WindowInfo] = []

    def cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        info = _info(hwnd)
        if info and info.width * info.height >= min_area and info.title:
            out.append(info)
        return True

    user32.EnumWindows(ENUMPROC(cb), 0)
    return out


def find_windows(match: str, exact: bool = False) -> List[WindowInfo]:
    """All windows matching by title or process name, largest first."""
    m = match.lower()
    cands = []
    for w in list_windows():
        hay_title, hay_proc = w.title.lower(), w.process.lower()
        hit = (hay_title == m or hay_proc == m) if exact else (m in hay_title or m in hay_proc)
        if hit:
            cands.append(w)
    return sorted(cands, key=lambda w: w.width * w.height, reverse=True)


# Two windows of nearly the same size are not a launcher and a game -- they are two
# instances, and picking the bigger one is a coin flip.
AMBIGUOUS_AREA_RATIO = 0.95


def ambiguous(cands: Sequence[WindowInfo]) -> bool:
    """Is the match too close to call?

    "Largest wins" is a good heuristic for a launcher next to a game window, and a
    silent disaster for two copies of the same game: a run attaches to whichever
    instance Windows happened to enumerate larger, and a test of build B can measure
    build A while reporting success. Observed exactly that -- a clean run and a
    planted-bug run returned byte-identical output because both attached to the same
    window.
    """
    if len(cands) < 2:
        return False
    a0 = cands[0].width * cands[0].height
    a1 = cands[1].width * cands[1].height
    return a0 > 0 and (a1 / a0) >= AMBIGUOUS_AREA_RATIO


def find_window(match: str, exact: bool = False) -> Optional[WindowInfo]:
    """Find a window by title or process name. Largest match wins, on the assumption
    that a game's main window is bigger than its launcher or splash screen."""
    cands = find_windows(match, exact)
    return cands[0] if cands else None



def is_window(hwnd: int) -> bool:
    """Does this window still exist? A closed game leaves a stale handle behind."""
    return bool(user32.IsWindow(wt.HWND(hwnd)))


def is_minimized(hwnd: int) -> bool:
    return bool(user32.IsIconic(wt.HWND(hwnd)))


def foreground_info() -> Optional[WindowInfo]:
    """Whatever currently has focus, so an error can name what stole it."""
    h = user32.GetForegroundWindow()
    if not h:
        return None
    return _info(h)


# A window whose client area changed by more than this many pixels in either
# dimension has been resized, which invalidates any cached geometry derived from it
# (a detected board grid, a remembered control box). A couple of pixels of drift is
# not worth re-detecting for.
RESIZE_TOLERANCE = 4


class TargetGuard:
    """Is it still safe to send input to the window we attached to?

    This is a safety device, not a correctness one. Synthetic input goes to whichever
    window has FOCUS, not to the window we captured -- so the moment the target is
    minimised, closed, or pushed behind something else, every click and keystroke the
    bot sends lands in whatever the user happens to have in front: their editor, their
    browser, their files. A test run that does not notice becomes a program typing
    randomly into someone's desktop.

    It is also a correctness disaster, in a way that hides itself. Captures of a
    minimised window return stale or blank pixels, so the agent reads an unchanging
    screen, concludes that nothing it does has any effect, and reports a confident
    softlock for every screen it "visited". Plausible output, entirely fictional --
    the same failure mode as the locked-session case, which is why that check already
    exists next to this one.

    So the check runs before every observation AND immediately before every action,
    and between the steps of a multi-step macro, because a macro can take seconds and
    focus can move in the middle of one.
    """

    def __init__(self, hwnd: int, width: int, height: int, title: str = ""):
        self.hwnd = hwnd
        self.width = width
        self.height = height
        self.title = title
        self.last_reason: Optional[str] = None
        self.last_detail: str = ""

    def check(self) -> Optional[str]:
        """None when safe, otherwise a short machine-readable reason."""
        locked = session_locked()
        if locked:
            self._set("session_locked", "%s holds the screen" % locked)
            return "session_locked"

        if not is_window(self.hwnd):
            self._set("closed", "the window no longer exists; the game was closed")
            return "closed"

        if is_minimized(self.hwnd):
            self._set("minimized",
                      "the target window is minimised, so input would go to whatever "
                      "is in front of it and captures would be stale")
            return "minimized"

        if not user32.IsWindowVisible(wt.HWND(self.hwnd)):
            self._set("hidden", "the target window is no longer visible")
            return "hidden"

        if not is_foreground(self.hwnd):
            fg = foreground_info()
            self._set("not_foreground",
                      "focus moved to %s" % (("%s [%s]" % (fg.title or "(untitled)", fg.process))
                                             if fg else "another window"))
            return "not_foreground"

        r = _client_rect_on_screen(self.hwnd)
        if r is None:
            self._set("no_client_rect", "the window reports no client area")
            return "no_client_rect"
        if (abs(r[2] - self.width) > RESIZE_TOLERANCE or
                abs(r[3] - self.height) > RESIZE_TOLERANCE):
            self._set("resized", "the window was resized from %dx%d to %dx%d; cached "
                                 "geometry is no longer valid"
                                 % (self.width, self.height, r[2], r[3]))
            return "resized"

        self.last_reason = None
        self.last_detail = ""
        return None

    def _set(self, reason: str, detail: str) -> None:
        self.last_reason = reason
        self.last_detail = detail

    def safe(self) -> bool:
        return self.check() is None

    def accept_resize(self) -> Optional[WindowInfo]:
        """Adopt the window's new size after a resize, returning fresh info."""
        info = _info(self.hwnd)
        if info is None:
            return None
        self.width, self.height = info.width, info.height
        return info


# Processes that own the screen when the session is locked or the secure desktop is
# up. Nothing can be captured or clicked behind them.
LOCK_PROCESSES = {"lockapp.exe", "logonui.exe", "consent.exe", "credentialuibroker.exe"}

ES_CONTINUOUS = 0x80000000
ES_SYSTEM_REQUIRED = 0x00000001
ES_DISPLAY_REQUIRED = 0x00000002


def keep_awake(enable: bool = True) -> bool:
    """Ask Windows not to sleep or blank the display during a run.

    Plain user-space SetThreadExecutionState -- the same call a video player makes.
    It prevents the display sleeping; it does NOT and cannot defeat a lock policy,
    so `session_locked()` still has to be checked.
    """
    flags = ES_CONTINUOUS | (ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED if enable else 0)
    return bool(kernel32.SetThreadExecutionState(ctypes.c_uint(flags)))


def session_locked() -> Optional[str]:
    """Name the process holding the screen if the session is locked, else None.

    Worth checking before every run and periodically during one. A locked session
    captures as the lock screen and swallows all input, so a bot that does not notice
    produces a full report of confident nonsense -- every screen "unreadable", every
    action "no effect", every stagnation detector firing. Silence about this would be
    the worst kind of failure: plausible output, entirely meaningless.
    """
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        # NOT a lock. Windows reports no foreground window transiently -- during a
        # window transition, while the desktop itself has focus, in the moment after
        # a window is created or minimised. This used to return "unknown", which the
        # target guard then treated as a locked session and aborted healthy runs on,
        # including one where the window was perfectly visible and in front.
        #
        # The unsafety of having no foreground window is real but is already covered:
        # the guard separately requires that OUR window is the foreground one, so it
        # stops for the accurate reason instead of inventing a lock.
        return None
    info = _info(hwnd)
    if info and info.process.lower() in LOCK_PROCESSES:
        return info.process
    return None


def foreground() -> Optional[WindowInfo]:
    set_dpi_aware()
    hwnd = user32.GetForegroundWindow()
    return _info(hwnd) if hwnd else None


def is_foreground(hwnd: int) -> bool:
    return user32.GetForegroundWindow() == hwnd


def _nudge_input() -> None:
    """Emit one harmless keystroke so this process becomes the last input source.

    Windows refuses SetForegroundWindow from a process that did not produce the most
    recent input -- that is the anti-focus-stealing rule. A process that HAS just
    produced input is permitted, so tapping a modifier that does nothing on its own
    buys the right to raise a window. This is the documented, non-kernel way; it uses
    the same SendInput path as everything else rather than any privileged API.
    """
    try:
        import keys
        keys.key_down("ctrl")
        keys.key_up("ctrl")
    except Exception:
        pass


def focus(hwnd: int, attempts: int = 3) -> bool:
    """Bring a window to the front.

    Windows deliberately makes this unreliable -- a background process cannot steal
    focus. Three escalating tactics, checked rather than assumed, because input sent
    to an unfocused game goes nowhere and every downstream oracle would then report
    a softlock that is really a focus failure.
    """
    set_dpi_aware()
    SW_RESTORE = 9
    if user32.IsIconic(wt.HWND(hwnd)):
        user32.ShowWindow(wt.HWND(hwnd), SW_RESTORE)

    for attempt in range(attempts):
        if is_foreground(hwnd):
            return True

        # 1. Plain request.
        user32.SetForegroundWindow(wt.HWND(hwnd))
        if is_foreground(hwnd):
            return True

        # 2. Become the last input source, then ask again.
        _nudge_input()
        user32.SetForegroundWindow(wt.HWND(hwnd))
        if is_foreground(hwnd):
            return True

        # 3. Borrow the target thread's input queue.
        cur = kernel32.GetCurrentThreadId()
        target = user32.GetWindowThreadProcessId(wt.HWND(hwnd), None)
        if target and target != cur:
            user32.AttachThreadInput(cur, target, True)
            try:
                user32.BringWindowToTop(wt.HWND(hwnd))
                user32.SetForegroundWindow(wt.HWND(hwnd))
            finally:
                user32.AttachThreadInput(cur, target, False)
        if is_foreground(hwnd):
            return True
        time.sleep(0.25 * (attempt + 1))
    return is_foreground(hwnd)


if __name__ == "__main__":
    import sys

    print("DPI awareness:", set_dpi_aware())
    print()
    if len(sys.argv) > 1:
        w = find_window(sys.argv[1])
        print("match:", w if w else "NOT FOUND")
    else:
        wins = sorted(list_windows(), key=lambda w: -w.width * w.height)
        print("%-42s %-24s %s" % ("title", "process", "client rect"))
        print("-" * 100)
        for w in wins[:25]:
            print("%-42s %-24s %dx%d at (%d,%d)" % (
                w.title[:41], w.process[:23], w.width, w.height, w.left, w.top))
