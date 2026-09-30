"""
The perceived state blob -- what the decision model actually reads.

One rule governs this entire file, and it is the fix for the worst bug the codebase
audit found:

    A FIELD IS EITHER PRESENT WITH A MEASURED CONFIDENCE, OR ABSENT AND NAMED IN
    `unreadable`. There is no third option, no sentinel, and no guess.

Why it matters. In the white-box version, an empty `vars` made every invariant's
`applies()` gate return False, so the invariant suite returned zero findings and
looked exactly like a clean build. Reporting "no bugs" because you could not see
anything is far worse than reporting an error, because nobody investigates a pass.

So there are two distinct non-values, and they behave differently:

    UNCHANGED   present, source="cached", measured_at_step < current step.
                Oracles may use it. We looked, and it is the same as before.
    UNKNOWN     absent from the blob, listed in `unreadable` with a reason.
                Oracles must skip, and the report says what went unchecked.

This generalises a discipline the TypeScript side already got right for exactly one
field: `UiElement.textWidth` is left undefined rather than guessed, and the overflow
oracle skips undefined rather than treating it as "fits".
"""

from dataclasses import dataclass, field
from typing import Any, Dict, Generic, List, Optional, TypeVar

T = TypeVar("T")

# Where a field came from. Ordered roughly by trustworthiness.
SOURCE_ENGINE = "engine"       # read from the game's own scene tree via injection
SOURCE_TEMPLATE = "template"   # matched against a known UI template
SOURCE_OCR = "ocr"             # read off the screen
SOURCE_VLM = "vlm"             # described by a vision model
SOURCE_CACHED = "cached"       # measured earlier, unchanged since
SOURCE_DERIVED = "derived"     # computed from other fields

# Reasons a field can be missing. Each one reads differently in a report.
WHY_NO_SOURCE = "no_source"          # nothing can produce this field on this target
WHY_LOW_CONFIDENCE = "low_confidence"
WHY_OCCLUDED = "occluded"            # covered by a dialog, cutscene, overlay
WHY_BUDGET = "budget"                # we chose not to spend the call


@dataclass
class Observed(Generic[T]):
    """A value plus how much it should be trusted and where it came from."""

    value: T
    confidence: float
    source: str
    measured_at_step: int

    @property
    def is_cached(self) -> bool:
        return self.source == SOURCE_CACHED

    def age(self, current_step: int) -> int:
        return max(0, current_step - self.measured_at_step)

    def __repr__(self) -> str:
        return "Observed(%r, %.2f, %s@%d)" % (
            self.value, self.confidence, self.source, self.measured_at_step)


def known(o: Optional[Observed], min_confidence: float = 0.6) -> Optional[Any]:
    """The ONLY legal way an oracle or an `applies()` gate reads a field.

    Returns None for absent and for under-confident alike, so a caller cannot
    accidentally act on a value it should not trust. Call sites read as:

        gold = known(state.var("gold"))
        if gold is None:
            return          # skip, and the blob's `unreadable` explains why
    """
    if o is None:
        return None
    if o.confidence < min_confidence:
        return None
    return o.value


@dataclass
class Unreadable:
    field: str
    reason: str
    detail: str = ""

    def __str__(self) -> str:
        return "%s (%s)%s" % (self.field, self.reason, ": " + self.detail if self.detail else "")


@dataclass
class TextRegion:
    text: str
    bbox: "tuple"           # (x, y, w, h) in physical pixels, client-relative
    confidence: float
    role: Optional[str] = None      # title | button | body | hud | objective


@dataclass
class FrameInfo:
    phash: int
    tiles: List[int]
    d_prev: int                     # hamming distance to the previous frame
    d_nearest_cluster: int
    uniformity: float               # near-uniform pixel share: fades, letterboxing
    information: float              # structural content: 0 = blank, 1 = busy
    motion: float                   # mean per-tile change over a short window


@dataclass
class PerceptionStats:
    rungs_run: List[str] = field(default_factory=list)
    vlm_calls: int = 0
    ocr_ms: float = 0.0
    total_ms: float = 0.0

    @property
    def completeness(self) -> float:
        """Share of the blob that came from a confident source. Reported alongside
        every finding, because a finding derived from a 30%-complete observation
        deserves less weight than one from a 95%-complete observation."""
        return self._completeness

    _completeness: float = 1.0


@dataclass
class PerceivedState:
    """What one observation looks like to the agent."""

    step: int
    ts: float
    screen_id: str                                  # cluster identity, e.g. "cluster:17"
    frame: FrameInfo
    mode: Optional[Observed] = None                 # world|menu|dialogue|cutscene|loading|combat
    screen_label: Optional[Observed] = None         # "Inventory" -- a bonus, never required
    text: List[TextRegion] = field(default_factory=list)
    controls: List[Dict[str, Any]] = field(default_factory=list)
    vars: Dict[str, Observed] = field(default_factory=dict)
    unreadable: List[Unreadable] = field(default_factory=list)
    perception: PerceptionStats = field(default_factory=PerceptionStats)
    errors: List[str] = field(default_factory=list)

    # -- reading ------------------------------------------------------------

    def var(self, name: str) -> Optional[Observed]:
        return self.vars.get(name)

    def mode_value(self, min_confidence: float = 0.6) -> Optional[str]:
        return known(self.mode, min_confidence)

    def is_unknown(self, name: str) -> bool:
        return any(u.field == name for u in self.unreadable)

    # -- writing ------------------------------------------------------------

    def observe(self, name: str, value: Any, confidence: float, source: str) -> None:
        """Record a measured field. Use this, never direct dict assignment, so that
        a field can never enter the blob without a confidence and a source."""
        self.vars[name] = Observed(value, confidence, source, self.step)
        self.unreadable = [u for u in self.unreadable if u.field != name]

    def carry_forward(self, name: str, previous: "PerceivedState") -> bool:
        """Mark a field as unchanged since a previous observation.

        This is the UNCHANGED case: the value stays readable, but its source becomes
        `cached` and `measured_at_step` keeps pointing at when it was really seen, so
        staleness is always visible to anything that cares.
        """
        prev = previous.vars.get(name)
        if prev is None:
            return False
        self.vars[name] = Observed(prev.value, prev.confidence, SOURCE_CACHED, prev.measured_at_step)
        return True

    def mark_unreadable(self, name: str, reason: str, detail: str = "") -> None:
        """The UNKNOWN case. The field is removed, not zeroed."""
        self.vars.pop(name, None)
        if not self.is_unknown(name):
            self.unreadable.append(Unreadable(name, reason, detail))

    def compute_completeness(self, expected_fields: List[str]) -> float:
        """Share of the fields we hoped for that we actually have confidently."""
        if not expected_fields:
            self.perception._completeness = 1.0
            return 1.0
        have = sum(1 for f in expected_fields if known(self.vars.get(f)) is not None)
        c = have / len(expected_fields)
        self.perception._completeness = c
        return c

    def summary(self) -> str:
        bits = ["step=%d" % self.step, "screen=%s" % self.screen_id]
        m = self.mode_value()
        bits.append("mode=%s" % (m if m else "?"))
        bits.append("vars=%d" % len(self.vars))
        if self.unreadable:
            bits.append("unreadable=%d" % len(self.unreadable))
        bits.append("complete=%.0f%%" % (self.perception.completeness * 100))
        return " ".join(bits)


def to_soc_blob(s: PerceivedState, max_text: int = 14) -> Dict[str, Any]:
    """Flatten into the JSON the System One model actually receives.

    Deliberately lean. Token budget spent on decoration is budget not spent on
    option representation, which is the scarce resource -- and `unreadable` is
    included on purpose so the model can see what we could not read, rather than
    inferring from silence that everything is fine.
    """
    out: Dict[str, Any] = {
        "screen": s.screen_id,
        "mode": s.mode_value() or "unknown",
    }
    if s.screen_label is not None and known(s.screen_label) is not None:
        out["screenLabel"] = s.screen_label.value
    if s.text:
        out["text"] = [t.text for t in s.text[:max_text]]
    if s.controls:
        out["controls"] = [
            {"id": c.get("id"), "label": c.get("label"), "enabled": c.get("enabled", True)}
            for c in s.controls[:max_text]
        ]
    vals = {k: o.value for k, o in s.vars.items() if known(o) is not None}
    if vals:
        out["vars"] = vals
    if s.unreadable:
        out["unreadable"] = [u.field for u in s.unreadable]
    if s.errors:
        out["errorCount"] = len(s.errors)
    return out
