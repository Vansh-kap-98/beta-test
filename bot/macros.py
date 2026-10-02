"""
Macro actions -- the replacement for an enumerable control list.

A platformer has continuous input, so "the set of available actions" does not exist
in the form the original agent assumed. A macro is a named, parameterised intent
("walk left", "press confirm") whose IDENTITY is separate from its PARAMETERS.

That separation is the whole design:

    sig     "move:left"     stable, never contains a duration or a coordinate.
                            The only thing that reaches a dedupe key, a ban key,
                            a visit counter, or a model choice option.
    script  hold A for 1500ms   the concrete input program, free to differ between
                                two executions of the same sig.

If durations or pixel coordinates leaked into the sig, every execution would mint a
new identity, and deduplication, trap-avoidance and exploration would all silently
stop working -- the failure the Phase 1 gate (sig cardinality must plateau) exists
to catch.

Execution supports early abort, which is where the step budget is saved: "walk left
until something changes" is ONE agent step, not thirty.
"""

import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence

import keys

MacroVerb = str  # move | look | jump | interact | attack | ui_* | wait


@dataclass
class InputStep:
    kind: str                       # keyTap|keyHold|keyDown|keyUp|mouseTo|mouseRel|click|scroll|sleep
    key: Optional[str] = None
    ms: float = 0.0
    x: int = 0
    y: int = 0
    button: str = "left"
    clicks: int = 0


@dataclass
class MacroAction:
    sig: str
    verb: MacroVerb
    label: str
    script: List[InputStep] = field(default_factory=list)
    origin: str = "static"          # engine|template|ocr|vlm|static
    affordance_confidence: Optional[float] = None   # None = not measured, never guessed

    def __str__(self) -> str:
        return "%s (%s)" % (self.sig, self.label)


@dataclass
class ExecResult:
    sig: str
    elapsed_ms: float
    aborted_early: bool
    steps_run: int


# Poll interval while a key is held. 10ms is well inside a 60Hz frame, so an abort
# lands within a frame or two of the condition becoming true.
ABORT_POLL_MS = 10.0


class MacroExecutor:
    """Runs a macro's input script against the focused window.

    `abort_when` is polled during holds and sleeps. Returning True stops the macro
    immediately and releases anything held -- which is how "move until the screen
    changes" collapses into a single step.
    """

    def __init__(self, on_release_all: Optional[Callable[[], None]] = None):
        self._held: List[str] = []
        self._on_release_all = on_release_all

    def release_all(self) -> None:
        """Release everything this executor is holding. Must run on every exit path:
        a key left down makes the character walk into a wall for the rest of the run,
        and nothing downstream would report it as anything but a softlock."""
        for k in list(self._held):
            try:
                keys.key_up(k)
            except Exception:
                pass
        self._held.clear()
        if self._on_release_all:
            self._on_release_all()

    def _sleep_abortable(self, ms: float, abort_when: Optional[Callable[[], bool]]) -> bool:
        """Sleep, polling the abort condition. Returns True if aborted."""
        if abort_when is None:
            time.sleep(ms / 1000.0)
            return False
        end = time.perf_counter() + ms / 1000.0
        while time.perf_counter() < end:
            if abort_when():
                return True
            time.sleep(min(ABORT_POLL_MS, max(0.0, (end - time.perf_counter()) * 1000.0)) / 1000.0)
        return False

    def run(
        self,
        macro: MacroAction,
        abort_when: Optional[Callable[[], bool]] = None,
        max_ms: float = 4000.0,
    ) -> ExecResult:
        t0 = time.perf_counter()
        aborted = False
        steps_run = 0

        try:
            for step in macro.script:
                if (time.perf_counter() - t0) * 1000.0 > max_ms:
                    aborted = True
                    break
                # Checked before EVERY step, not only during sleeps.
                #
                # A macro can run for seconds -- a hold, a drag, a settle wait -- and
                # focus can move in the middle of one. Stopping between steps is the
                # difference between a half-finished click on the game and the rest
                # of a drag being performed across whatever window just took focus.
                if abort_when is not None and abort_when():
                    aborted = True
                    break
                steps_run += 1

                if step.kind == "keyTap":
                    keys.tap(step.key, hold_ms=step.ms or 30.0)
                elif step.kind == "keyDown":
                    keys.key_down(step.key)
                    self._held.append(step.key)
                elif step.kind == "keyUp":
                    keys.key_up(step.key)
                    if step.key in self._held:
                        self._held.remove(step.key)
                elif step.kind == "keyHold":
                    keys.key_down(step.key)
                    self._held.append(step.key)
                    aborted = self._sleep_abortable(step.ms, abort_when)
                    keys.key_up(step.key)
                    if step.key in self._held:
                        self._held.remove(step.key)
                    if aborted:
                        break
                elif step.kind == "mouseTo":
                    keys.move_to(step.x, step.y)
                elif step.kind == "mouseRel":
                    keys.move_rel(step.x, step.y)
                elif step.kind == "click":
                    keys.click(step.button, hold_ms=step.ms or 30.0)
                elif step.kind == "scroll":
                    keys.scroll(step.clicks)
                elif step.kind == "sleep":
                    aborted = self._sleep_abortable(step.ms, abort_when)
                    if aborted:
                        break
                else:
                    raise ValueError("unknown input step kind %r" % step.kind)
        finally:
            # Always, on every path including an exception.
            self.release_all()

        return ExecResult(
            sig=macro.sig,
            elapsed_ms=(time.perf_counter() - t0) * 1000.0,
            aborted_early=aborted,
            steps_run=steps_run,
        )


# --------------------------------------------------------------------------------
# A default macro vocabulary.
#
# Deliberately small. The model picks from at most ~15 options, and the mode-based
# selection in the agent narrows further -- a loading screen offers one macro, which
# the existing forced-move path then takes for free.
# --------------------------------------------------------------------------------

MOVE_MS = 1500.0        # long, because abort-on-change ends it as soon as anything happens
NUDGE_MS = 280.0        # short, emitted only when oscillation is detected
LOOK_PX = 220


def _m(sig, verb, label, script, origin="static"):
    return MacroAction(sig=sig, verb=verb, label=label, script=script, origin=origin)


def movement_macros(keymap: Optional[Dict[str, str]] = None) -> List[MacroAction]:
    """Directional movement. `keymap` lets an injection adapter substitute the game's
    own bindings when it can read them -- far better than assuming WASD."""
    km = {"left": "a", "right": "d", "up": "w", "down": "s", "jump": "space"}
    if keymap:
        km.update(keymap)
    out = []
    for d in ("left", "right", "up", "down"):
        out.append(_m("move:" + d, "move", "walk " + d,
                      [InputStep(kind="keyHold", key=km[d], ms=MOVE_MS)]))
    out.append(_m("jump", "jump", "jump", [InputStep(kind="keyTap", key=km["jump"])]))
    return out


def nudge_macros(keymap: Optional[Dict[str, str]] = None) -> List[MacroAction]:
    """Short movements, offered only after oscillation is detected -- when the bot is
    crossing back and forth over the same two states, a smaller step may break it."""
    km = {"left": "a", "right": "d"}
    if keymap:
        km.update(keymap)
    return [
        _m("move:%s:nudge" % d, "move", "small step " + d,
           [InputStep(kind="keyHold", key=km[d], ms=NUDGE_MS)])
        for d in ("left", "right")
    ]


def look_macros() -> List[MacroAction]:
    """Camera. Relative mouse motion, because an absolute move is clamped at the
    screen edge and mouselook would stop at the border."""
    return [
        _m("look:left", "look", "turn camera left", [InputStep(kind="mouseRel", x=-LOOK_PX, y=0)]),
        _m("look:right", "look", "turn camera right", [InputStep(kind="mouseRel", x=LOOK_PX, y=0)]),
    ]


def ui_macros() -> List[MacroAction]:
    """Navigation. `ui_confirm` and `ui_cancel` are ALWAYS offered and always pinned
    in shortlisting -- dropping the exit from a screen's option list was measured to
    collapse tier-1 absorption from 81% to 28%."""
    return [
        _m("ui_confirm", "ui_confirm", "confirm / accept", [InputStep(kind="keyTap", key="enter")]),
        _m("ui_cancel", "ui_cancel", "back / cancel", [InputStep(kind="keyTap", key="escape")]),
        _m("ui_nav:up", "ui_nav", "move selection up", [InputStep(kind="keyTap", key="up")]),
        _m("ui_nav:down", "ui_nav", "move selection down", [InputStep(kind="keyTap", key="down")]),
        _m("ui_nav:left", "ui_nav", "move selection left", [InputStep(kind="keyTap", key="left")]),
        _m("ui_nav:right", "ui_nav", "move selection right", [InputStep(kind="keyTap", key="right")]),
    ]


def wait_macro(ms: float = 500.0) -> MacroAction:
    return _m("wait", "wait", "wait and observe", [InputStep(kind="sleep", ms=ms)])


def point_macro(slug: str, caption: str, screen_x: int, screen_y: int,
                origin: str = "ocr", confidence: Optional[float] = None) -> MacroAction:
    """Click a detected on-screen control.

    The sig carries the control's SLUG, never its coordinates: the same button moves
    a few pixels between frames, and coordinates in the sig would make each position
    a different action.
    """
    m = _m("ui_point:" + slug, "ui_point", caption,
           [InputStep(kind="mouseTo", x=screen_x, y=screen_y),
            InputStep(kind="sleep", ms=12),
            InputStep(kind="click")],
           origin=origin)
    m.affordance_confidence = confidence
    return m


def slugify(text: str, max_words: int = 3) -> str:
    """Normalise detected text into a stable sig component.

    Aggressive on purpose. OCR returns "Continue", "Continue ", "Contlnue" and
    "Continue 2" for the same button across frames; without normalisation each
    becomes its own action identity and visit counts never accumulate, so the bot
    retries the same dead control forever. Same discipline the crash oracle already
    applies to its dedupe key.
    """
    import re
    t = re.sub(r"[^a-z0-9\s]", " ", (text or "").lower())
    t = re.sub(r"\d+", "", t)
    words = [w for w in t.split() if w][:max_words]
    return "_".join(words) or "unknown"
