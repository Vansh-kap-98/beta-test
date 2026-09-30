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
from dataclasses import dataclass
from typing import Dict, List, Optional

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


def find_window(match: str, exact: bool = False) -> Optional[WindowInfo]:
    """Find a window by title or process name. Largest match wins, on the assumption
    that a game's main window is bigger than its launcher or splash screen."""
    m = match.lower()
    cands = []
    for w in list_windows():
        hay_title, hay_proc = w.title.lower(), w.process.lower()
        hit = (hay_title == m or hay_proc == m) if exact else (m in hay_title or m in hay_proc)
        if hit:
            cands.append(w)
    if not cands:
        return None
    return max(cands, key=lambda w: w.width * w.height)


def foreground() -> Optional[WindowInfo]:
    set_dpi_aware()
    hwnd = user32.GetForegroundWindow()
    return _info(hwnd) if hwnd else None


def is_foreground(hwnd: int) -> bool:
    return user32.GetForegroundWindow() == hwnd


def focus(hwnd: int) -> bool:
    """Bring a window to the front.

    Windows deliberately makes this unreliable -- a background process cannot steal
    focus. The AttachThreadInput dance below is the standard workaround; it usually
    works, and callers must check `is_foreground` rather than assume success, because
    input sent to an unfocused game goes nowhere.
    """
    set_dpi_aware()
    SW_RESTORE = 9
    if user32.IsIconic(wt.HWND(hwnd)):
        user32.ShowWindow(wt.HWND(hwnd), SW_RESTORE)
    if user32.SetForegroundWindow(wt.HWND(hwnd)):
        return True
    cur = kernel32.GetCurrentThreadId()
    target = user32.GetWindowThreadProcessId(wt.HWND(hwnd), None)
    if target and target != cur:
        user32.AttachThreadInput(cur, target, True)
        try:
            user32.BringWindowToTop(wt.HWND(hwnd))
            user32.SetForegroundWindow(wt.HWND(hwnd))
        finally:
            user32.AttachThreadInput(cur, target, False)
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
