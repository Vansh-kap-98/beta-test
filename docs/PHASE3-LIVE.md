# Live targets — the sidecar bridge

The join between the two halves of the system. Everything above the adapter is the
code built and tested against in-process fixtures; only the adapter is new.

## Why two languages

| Python (`bot/`) | TypeScript (`src/`) |
|---|---|
| screen capture, perceptual hashing | invariant engine + Wilson reporting gate |
| Windows OCR | deduplication, severity ranking |
| Win32 synthetic input | escalation, calibration |
| grid detection, board reading | reporting, replay |

Image processing, Win32 and the Windows OCR engine belong in Python. The invariant
engine and its statistical gate are the hardest-won part of the system and already
exist in TypeScript — porting them would duplicate exactly the code that must never
be duplicated. So they talk over newline-delimited JSON on stdio.

**Only sigs cross the boundary.** The sidecar detected the grid, so the sidecar owns
the cell-to-pixel mapping. The agent sees `"swap:1_2__2_2"` and never a coordinate,
which is also why an action's identity survives the window being moved.

A sig travels as a `tap` targetId. That looks like a shortcut and is deliberate: the
agent already keys dedup, bans, visit counts and choice options off `tap:<targetId>`,
so macros slot into all of it with no change to `Action`, `actionSig` or
`shortlistOptions`.

## Match-3 perception, validated against ground truth

The fixture publishes its true board into the window title; the vision pipeline
predicts the same board from pixels. Comparing them is the dual-pipeline harness the
plan proposes for real games, with the fixture standing in for an injected scene tree.

```
trial  grid   kinds   cellAcc   legal-move agreement
0      8x8    6       100.0%    16/16
1      8x8    6       100.0%    13/13
...
mean cell accuracy 100.0%,  agreement 6/6 trials
```

The bot made its own moves between trials, so it was reading boards it had changed.

### Four bugs found getting there

**1. Grid detection found *a* lattice, not *the* board.** First result: an 8×10 grid
anchored at (0,0), on top of the window chrome, yielding 142 "legal" moves. Profiles
computed over the whole frame pick up the title bar, the HUD and the empty background,
all of which contribute their own periodicity. Fixed by finding the period by
autocorrelation, the phase by comb correlation, and then the **extent** — the longest
run of lattice lines that actually shows an edge.

**2. Phase locked onto the gap lattice.** A board has two strong edges per cell, its
own boundary and the gap between tiles, so an 8×8 board was detected as 7×8 starting
one cell in. Fixed by growing and trimming against *cell content* rather than edges:
a row is board-like if its cells are internally uniform **and** differ from each other.
Uniformity alone would annex the empty background, which is perfectly uniform.

**3. Sampling measured the icon, not the tile.** Cell colour was read as the mean of a
centre patch — exactly where the candy glyph sits. That collapsed six candy types into
five and produced phantom matches. The **median** of the cell interior recovers all six,
because the glyph is a minority of the tile's area.

**4. Cluster labels were not stable between reads.** Each read numbered colours in
encounter order, so the same candy got a different symbol each frame. A move that truly
changed 3–5 cells appeared to change 20–43, because most of the "difference" was
relabelling. Since before/after comparison is what distinguishes a working action from
a dead one, the palette now persists across reads.

| detector | on a real move | verdict |
|---|---|---|
| global pHash | 0–2 bits | **useless** — too coarse for UI-scale change |
| tile hashes | 6–16 bits | works; the generic signal |
| board diff, persistent palette | exactly matches truth | exact, match-3 only |

## Telling a button from a label

Every readable text region is offered as a candidate, because from a screenshot
`"Shuffle Board"` and `"Score 0"` are both just text. Clicking the label does nothing —
and the `action_has_effect` invariant correctly reported that as a defect on a **clean**
build.

Gating on provenance (OCR vs computed) does not work: every on-screen button is
OCR-derived, so that rule throws away real softlock bugs along with the noise.

What separates them is visual, and it generalises because it is a property of how UIs
are drawn rather than of this game:

| signal | button | label |
|---|---|---|
| fill distinct from page background | yes | no |
| fill uniform | yes | inherits scenery |
| edge close around the text | yes | no |
| **fill bounded** | stops just past the caption | panel extends far beyond |
| caption length | short | body copy runs long |

Fill-boundedness is the decisive one. Without it, a dialog's heading and body text
score as buttons, because panel background and button background are identical by
every other measure.

Measured on the fixture's tutorial modal:

```
Got it                                     0.93  BUTTON   <- the only real control
x  (window close)                          0.55  BUTTON   <- also genuinely a button
Welcome!                                   0.47  label
Swap two candies to make a line of three.  0.38  label
Score 0  Moves 22  Goal 1000  Level 1      0.23  label
```

A text region is still *offered* either way — trying it is how you find out — but only
a confident control supports the claim that it is **broken**. That is the
perception-failure-versus-real-defect attribution problem from the plan, in miniature.

The harness also learns: a candidate that produces no change three times is withdrawn
from the option list entirely, since option budget is the scarce resource and an inert
control wastes a slot every step.

## Never clicking a window we are not testing

Synthetic input goes to whichever window has **focus**, not to the window that was
captured. So the instant the target is minimised, closed, or pushed behind something
else, every click and keystroke lands in whatever the user has in front of them --
their editor, their browser, their files. Verified during development by stealing
focus mid-run: without the guard the next action would have gone to the Claude Code
window.

It is also a silent correctness disaster. Captures of a hidden window return stale
pixels, so the agent reads an unchanging screen, concludes nothing it does has any
effect, and reports a confident softlock for every screen it "visited" -- plausible
output, entirely fictional. The same shape as the locked-session failure below.

`window.TargetGuard` checks, in this order:

| reason | meaning |
|---|---|
| `session_locked` | a lock process holds the screen |
| `closed` | the handle is stale; the game exited |
| `minimized` | `IsIconic`; input would go elsewhere and captures are stale |
| `hidden` | no longer visible |
| `not_foreground` | something else has focus -- the error names what |
| `resized` | client area changed; cached geometry is stale |

Three properties earn their keep:

**It runs before every observation, before every action, and between the steps of a
macro.** A macro can take seconds -- a hold, a drag, a settle wait -- and focus can
move halfway through one. Stopping between steps is the difference between a
half-finished click on the game and the rest of a drag performed across whatever just
took focus. The guard check precedes even the macro lookup, because with the lookup
first a lost target reported "unknown sig" instead of the real reason.

**A loss is sticky, and a reset does not clear it.** Silently recovering focus would
produce a run whose first half tested the game and whose second half tested a
notification popup, reported as one clean result -- and re-grabbing focus would be
fighting the person whose machine it is. A `resize` is the one exception: it endangers
nobody, so the new size is adopted and the derived geometry (grid, macros) dropped.

**A truncated run says so.** `SessionResult.stoppedEarly` flows into the report header
and `npm run live` exits **4** rather than 0. "No defects found" on a run that stopped
after twelve steps reads as a clean bill of health for a game that was never played,
which is the most dangerous output this system can produce.

One bug found while testing this, worth recording because it would have aborted every
healthy run: `session_locked()` returned `"unknown"` whenever `GetForegroundWindow()`
returned 0. That happens transiently -- during window transitions, when the desktop
has focus, right after a window is minimised -- and the guard read it as a locked
session. No-foreground is not a lock, and its real unsafety is already covered by the
`not_foreground` check, which stops for the accurate reason.

## An operational hazard worth more than it sounds

Mid-session, focus started failing. The cause was not code: **the Windows session had
locked**, and `LockApp.exe` held the screen.

This matters far beyond one failed run. A locked session captures as the lock screen
and swallows all input, so a bot that does not notice produces a full report of
confident nonsense — every screen unreadable, every action ineffective, every
stagnation detector firing. Plausible output, entirely meaningless.

The sidecar now checks for it at attach **and on every observation**, and fails loudly.
It also asks Windows not to sleep the display (`SetThreadExecutionState`, the same call
a video player makes — user space, not kernel), which cannot defeat a lock policy and
so does not replace the check.

## Running it

```bash
npm run demo:web                                   # serve the fixture
npm run live -- --match "Sugar Cascade" --profile match3 --steps 45
```

The game must already be running and visible. **The bot never touches credentials** —
you launch and sign in; it attaches to a window you already have open.
