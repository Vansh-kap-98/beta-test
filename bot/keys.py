"""
Synthetic keyboard and mouse via Win32 SendInput.

Three things here are not optional, and each one fails silently rather than loudly:

  1. SCANCODES, NOT VIRTUAL-KEY CODES. Games reading DirectInput see scancodes and
     ignore VK-based injection entirely. Sending VK codes works perfectly in Notepad
     and does nothing at all in a game, which is the worst possible failure shape.

  2. KEYEVENTF_SCANCODE MUST BE OR'ED INTO THE KEY-UP TOO. Omit it and the up-event
     is interpreted as a VK event, the game never sees the release, and the key
     sticks down forever -- the character walks into a wall for the rest of the run.

  3. EXTENDED-KEY FLAG for arrows, navigation cluster, right-side modifiers and
     numpad enter. Without it the arrow keys are indistinguishable from numpad keys.

Games using RawInput may still ignore all of this; that is what the virtual gamepad
in pad.py is for. `probe.py` determines which path a given game accepts.
"""

import ctypes
import ctypes.wintypes as wt
import time
from typing import Iterable, Optional, Tuple

user32 = ctypes.WinDLL("user32", use_last_error=True)

INPUT_MOUSE, INPUT_KEYBOARD = 0, 1

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN = 76, 77
SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN = 78, 79

MAPVK_VK_TO_VSC_EX = 4


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wt.LONG), ("dy", wt.LONG), ("mouseData", wt.DWORD),
        ("dwFlags", wt.DWORD), ("time", wt.DWORD),
        ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
        ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
    ]


class _INPUTunion(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _INPUTunion)]


# Scancodes (set 1). Named by the US-layout legend, but a scancode is a PHYSICAL key
# position -- "scan_w" is the key where W sits on a US keyboard regardless of the
# user's layout, which is exactly right for games that bind by position (WASD stays
# WASD on AZERTY hardware).
SCAN = {
    "escape": 0x01, "1": 0x02, "2": 0x03, "3": 0x04, "4": 0x05, "5": 0x06,
    "6": 0x07, "7": 0x08, "8": 0x09, "9": 0x0A, "0": 0x0B, "minus": 0x0C,
    "equals": 0x0D, "backspace": 0x0E, "tab": 0x0F,
    "q": 0x10, "w": 0x11, "e": 0x12, "r": 0x13, "t": 0x14, "y": 0x15,
    "u": 0x16, "i": 0x17, "o": 0x18, "p": 0x19,
    "enter": 0x1C, "ctrl": 0x1D,
    "a": 0x1E, "s": 0x1F, "d": 0x20, "f": 0x21, "g": 0x22, "h": 0x23,
    "j": 0x24, "k": 0x25, "l": 0x26,
    "shift": 0x2A, "backslash": 0x2B,
    "z": 0x2C, "x": 0x2D, "c": 0x2E, "v": 0x2F, "b": 0x30, "n": 0x31, "m": 0x32,
    "comma": 0x33, "period": 0x34, "slash": 0x35, "rshift": 0x36,
    "alt": 0x38, "space": 0x39, "capslock": 0x3A,
    "f1": 0x3B, "f2": 0x3C, "f3": 0x3D, "f4": 0x3E, "f5": 0x3F, "f6": 0x40,
    "f7": 0x41, "f8": 0x42, "f9": 0x43, "f10": 0x44, "f11": 0x57, "f12": 0x58,
    # Extended keys -- these REQUIRE KEYEVENTF_EXTENDEDKEY.
    "up": 0xC8, "left": 0xCB, "right": 0xCD, "down": 0xD0,
    "home": 0xC7, "end": 0xCF, "pageup": 0xC9, "pagedown": 0xD1,
    "insert": 0xD2, "delete": 0xD3,
    "rctrl": 0x9D, "ralt": 0xB8,
}

EXTENDED = {
    "up", "left", "right", "down", "home", "end", "pageup", "pagedown",
    "insert", "delete", "rctrl", "ralt",
}


def _send(*inputs: INPUT) -> int:
    n = len(inputs)
    arr = (INPUT * n)(*inputs)
    sent = user32.SendInput(n, arr, ctypes.sizeof(INPUT))
    if sent != n:
        raise OSError("SendInput sent %d of %d (err %d)" % (sent, n, ctypes.get_last_error()))
    return sent


def _key_input(scan: int, up: bool, extended: bool) -> INPUT:
    flags = KEYEVENTF_SCANCODE
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if up:
        # Must keep KEYEVENTF_SCANCODE here, or the key sticks down forever.
        flags |= KEYEVENTF_KEYUP
    return INPUT(type=INPUT_KEYBOARD,
                 u=_INPUTunion(ki=KEYBDINPUT(wVk=0, wScan=scan & 0xFF, dwFlags=flags,
                                             time=0, dwExtraInfo=None)))


def resolve(key: str) -> Tuple[int, bool]:
    k = key.lower()
    if k not in SCAN:
        raise KeyError("unknown key %r (known: %s...)" % (key, ", ".join(sorted(SCAN)[:8])))
    return SCAN[k], k in EXTENDED


def key_down(key: str) -> None:
    scan, ext = resolve(key)
    _send(_key_input(scan, up=False, extended=ext))


def key_up(key: str) -> None:
    scan, ext = resolve(key)
    _send(_key_input(scan, up=True, extended=ext))


def tap(key: str, hold_ms: float = 30.0) -> None:
    """A press short enough to read as a tap but long enough for a game polling at
    60Hz to observe it. Below ~16ms a press can fall entirely between two polls."""
    key_down(key)
    time.sleep(hold_ms / 1000.0)
    key_up(key)


def hold(key: str, ms: float) -> None:
    key_down(key)
    try:
        time.sleep(ms / 1000.0)
    finally:
        key_up(key)          # released even if interrupted; a stuck key ruins a run


def release_all(keys: Optional[Iterable[str]] = None) -> None:
    """Safety net. Called on shutdown and after any aborted macro."""
    for k in (keys if keys is not None else SCAN.keys()):
        try:
            key_up(k)
        except Exception:
            pass


# --------------------------------------------------------------------------- mouse

def _virtual_screen() -> Tuple[int, int, int, int]:
    return (
        user32.GetSystemMetrics(SM_XVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_YVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CXVIRTUALSCREEN),
        user32.GetSystemMetrics(SM_CYVIRTUALSCREEN),
    )


def move_to(x: int, y: int) -> None:
    """Absolute move in physical screen pixels. Normalised across the whole virtual
    desktop, so it is correct on multi-monitor setups rather than only the primary."""
    vx, vy, vw, vh = _virtual_screen()
    nx = int(round((x - vx) * 65535 / max(vw - 1, 1)))
    ny = int(round((y - vy) * 65535 / max(vh - 1, 1)))
    mi = MOUSEINPUT(dx=nx, dy=ny, mouseData=0,
                    dwFlags=MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
                    time=0, dwExtraInfo=None)
    _send(INPUT(type=INPUT_MOUSE, u=_INPUTunion(mi=mi)))


def move_rel(dx: int, dy: int) -> None:
    """Relative move. What a 3D game's camera actually consumes -- an absolute move
    is clamped at the screen edge, so mouselook must be relative."""
    mi = MOUSEINPUT(dx=int(dx), dy=int(dy), mouseData=0, dwFlags=MOUSEEVENTF_MOVE,
                    time=0, dwExtraInfo=None)
    _send(INPUT(type=INPUT_MOUSE, u=_INPUTunion(mi=mi)))


_BTN = {
    "left": (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
    "right": (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    "middle": (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
}


def click(button: str = "left", hold_ms: float = 30.0) -> None:
    down, up = _BTN[button]
    _send(INPUT(type=INPUT_MOUSE, u=_INPUTunion(
        mi=MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=down, time=0, dwExtraInfo=None))))
    time.sleep(hold_ms / 1000.0)
    _send(INPUT(type=INPUT_MOUSE, u=_INPUTunion(
        mi=MOUSEINPUT(dx=0, dy=0, mouseData=0, dwFlags=up, time=0, dwExtraInfo=None))))


def click_at(x: int, y: int, button: str = "left") -> None:
    move_to(x, y)
    time.sleep(0.012)        # let the game process the move before the button event
    click(button)


def scroll(clicks: int) -> None:
    mi = MOUSEINPUT(dx=0, dy=0, mouseData=int(clicks * 120), dwFlags=MOUSEEVENTF_WHEEL,
                    time=0, dwExtraInfo=None)
    _send(INPUT(type=INPUT_MOUSE, u=_INPUTunion(mi=mi)))
