# Phase 1 — input and macro execution

## Built

| File | Purpose |
|---|---|
| `bot/window.py` | Attach to a game window: enumerate, match, client rect, focus |
| `bot/keys.py` | Synthetic keyboard/mouse via SendInput, scancode-based |
| `bot/macros.py` | Macro actions, executor, default vocabulary |
| `bot/test_input.py` | Closed-loop self-test (8/8 passing) |
| `bot/probe_game.py` | **One command to answer "is this game testable?"** |

## Self-test: 8/8

Input is injected with `SendInput`, then read back through `GetWindowTextW` from a
page that echoes events into its own window title. The injection and verification
paths share no code, so a pass means a real event reached a real application —
`SendInput` returns success even when the target ignores the event entirely, so
calling it proves nothing on its own.

Covered: scancode letter keys, key release (no stuck keys), extended keys (arrows),
held presses, absolute mouse clicks, click accuracy, scroll.

## Three things that fail silently, now handled

**1. Scancodes, not virtual-key codes.** VK injection works perfectly in Notepad and
does nothing at all in a DirectInput game — the worst possible failure shape.

**2. `KEYEVENTF_SCANCODE` must be OR'd into the key-**up** too.** Omit it and the
release is read as a VK event, the game never sees it, and the key sticks down for
the rest of the run. The character walks into a wall and every downstream oracle
reports a softlock.

**3. Display scaling.** The self-test initially failed with "aimed x=466, got x=372"
— a ratio of exactly 1.25, this machine's display scale. The click was correct; the
comparison wasn't. **At any non-100% scale, naive coordinate handling puts every
click 25% off-target**, silently. The bot now works in physical pixels end to end,
which is what screen capture produces, so detected coordinates and click coordinates
share one space.

Window targeting also sets per-monitor-v2 DPI awareness before any coordinate work,
for the same reason: without it `GetWindowRect` returns logical pixels while capture
reads physical ones.

## Correction to the Phase 0a number

Phase 0a measured **52.7 ms of model headroom** against a mostly static desktop.
Re-measured against an animated window via `probe_game.py`:

| condition | perception p90 | headroom |
|---|---|---|
| static desktop, 640×360 | 26.3 ms | 52.7 ms |
| animated window, 1107×741 | 44.0 ms | **35.0 ms** |

Capture competes with the desktop compositor, so a busy game costs more than a quiet
desktop. The gate still passes — 35 ms against Laya's quoted 33 ms — but the margin
is much thinner than first reported, and a fullscreen 1080p game may be thinner still.

Mitigations if it becomes a problem, in order of preference:
1. Capture the HUD strip and a small centre region on most frames, the full frame
   rarely — fits the existing tile design.
2. Drop the fast loop to 20 Hz, still inside the target band.
3. GPU-side capture with scaling (Windows Graphics Capture) — needs a native addon.

## Macro actions

Identity is separate from parameters, which is the property everything downstream
relies on:

```
sig     "ui_point:continue"   stable; never contains a duration or a coordinate
script  move → sleep → click  the concrete input program, free to vary per run
```

Verified: `"Continue"`, `"Continue "` and `"Continue 2"` observed at three different
screen positions all produce the sig `ui_point:continue`. Without that normalisation
each OCR wobble becomes a separate action identity, visit counts never accumulate,
and the bot retries the same dead control forever.

Default vocabulary is 14 macros — inside the model's ~15-option budget before any
mode-based narrowing.

## Not done: virtual gamepad (ViGEm)

**Blocked on a decision, not on work.** ViGEm is a kernel-mode driver and installing
it is a system change that needs explicit approval.

It matters for games that read RawInput and ignore `SendInput` entirely. `probe_game.py
--input` determines whether a given game needs it: if no key produces visible change,
that game needs the pad.

## Using it

```bash
python bot/probe_game.py                  # list candidate windows
python bot/probe_game.py silksong         # attach, measure capture + clustering
python bot/probe_game.py silksong --input # also test whether input reaches it
```

`--input` sends only movement and arrow keys — never Enter, Escape or mouse clicks,
which can confirm dialogs, quit to menu or overwrite a save.
