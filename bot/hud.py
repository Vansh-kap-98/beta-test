"""
Typed game variables, read off the HUD.

The codebase audit's worst finding was that an empty `vars` makes every invariant's
gate return False, so the suite reports zero findings and looks exactly like a clean
build. Black-box targets have no scene tree to read numbers from -- but almost every
game prints its own state on screen, and that text is already being OCR'd.

"Score 1240", "Moves 22", "Lives 3", "Gold: 150", "12/20" -- this is the same
label-then-number shape everywhere, so parsing it needs no knowledge of any
particular game. It turns the most valuable class of invariant ("did buying that
item reduce my currency?") from impossible into merely imprecise.

Imprecise matters, and is handled rather than hidden: OCR misreads "0" as "O" and
"1" as "l" constantly, so every extracted value carries a confidence and the caller
decides whether to trust it. A misread score is worse than no score, because a
spurious change looks exactly like an economy bug.
"""

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Sequence, Tuple

# Digits that OCR routinely confuses with letters. Applied only inside a token that
# is already mostly numeric, so "Goal" is never rewritten to "G0al".
_DIGIT_FIXES = str.maketrans({"O": "0", "o": "0", "l": "1", "I": "1", "S": "5", "B": "8"})

# label then number, e.g. "Score 1240", "Gold: 150"
#
# The number part must contain at least one REAL digit. Without that, the
# confusable letters make a word's own tail look like a number: "Goal: 1000"
# matched as label "Goa" + number "l", swallowed the colon, and the actual 1000 was
# never seen. Every label ending in l, I, O, S or B had the same problem -- "Level 1"
# parsed as "Leve" = "l".
_NUM = r"[0-9OolISB]*[0-9][0-9OolISB,\.]*"
_LABELLED = re.compile(r"([A-Za-z][A-Za-z ]{1,18}?)\s*[:=]?\s*(" + _NUM + r")\b")
# fraction, e.g. "12/20" -- progress counters
_FRACTION = re.compile(r"\b(" + _NUM + r")\s*/\s*(" + _NUM + r")\b")


# A LONE digit-confusable letter, surrounded by spaces, is a misread digit.
#
# "Score 0 Moves 22" comes back from OCR as "Score O Moves 22", and the label pattern
# then greedily swallows the O: the result was a variable called `score_o_moves`
# holding 22 -- the MOVES value under a nonsense name -- and no score at all. The
# economy oracles need the score above all else, so this single misread removed the
# most valuable HUD field entirely.
#
# Requiring whitespace on both sides is what makes this safe. It is why "Goal" is
# never rewritten: there is no space inside the word, so its trailing "l" is not a
# lone token. That was the original failure this pattern replaced, where "Goal: 1000"
# parsed as label "Goa" plus number "l" and the actual 1000 was never seen.
_LONE_CONFUSABLE = re.compile(r"(?<=\s)([OolISB])(?=\s)")


def repair_lone_digits(text: str) -> str:
    return _LONE_CONFUSABLE.sub(lambda m: m.group(1).translate(_DIGIT_FIXES), " " + text + " ").strip()


@dataclass
class HudValue:
    name: str
    value: float
    confidence: float
    raw: str


# A game HUD does not show a sixty-digit number. Anything longer than this is text
# that merely looks numeric, and accepting it is how a window title full of
# ground-truth board state became the variable `vtutoria = 1.13e+65`. A nonsense
# variable is worse than a missing one: it is offered to the invariant suite and to
# the economy oracles as if it meant something.
MAX_DIGITS = 9
MAX_VALUE = 1e9


def _to_number(tok: str) -> Optional[float]:
    """Parse a token that should be numeric, repairing common OCR confusions."""
    t = tok.replace(",", "").strip()
    if not t or len(t) > MAX_DIGITS:
        return None
    digits = sum(1 for c in t if c.isdigit())
    # Only repair when the token is ALREADY mostly numeric; otherwise a word like
    # "Solo" would become "5010".
    if digits < max(1, len(t) - 2):
        return None
    t = t.translate(_DIGIT_FIXES)
    try:
        v = float(t)
    except ValueError:
        return None
    if abs(v) > MAX_VALUE:
        return None
    return v


def _clean_name(raw: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", raw.strip().lower()).strip("_")


def parse_hud(regions: Sequence, max_vars: int = 12) -> Dict[str, HudValue]:
    """Extract labelled numbers from OCR'd text regions.

    `regions` are TextRegion-shaped: `.text` and `.confidence`.
    """
    out: Dict[str, HudValue] = {}
    for r in regions:
        text = repair_lone_digits(getattr(r, "text", "") or "")
        base_conf = float(getattr(r, "confidence", 0.5))

        for label, num in _LABELLED.findall(text):
            name = _clean_name(label)
            if not name or len(name) < 2:
                continue
            v = _to_number(num)
            if v is None:
                continue
            # Repaired characters are less trustworthy than clean digits.
            repaired = sum(1 for c in num if c in "OolISB")
            conf = base_conf * (1.0 - 0.18 * min(repaired, 3))
            prev = out.get(name)
            if prev is None or conf > prev.confidence:
                out[name] = HudValue(name, v, round(max(0.0, min(1.0, conf)), 3), num)
            if len(out) >= max_vars:
                return out

        for a, b in _FRACTION.findall(text):
            va, vb = _to_number(a), _to_number(b)
            if va is None or vb is None:
                continue
            out.setdefault("progress_num", HudValue("progress_num", va, base_conf * 0.9, a))
            out.setdefault("progress_den", HudValue("progress_den", vb, base_conf * 0.9, b))

    return out


def diff(before: Dict[str, HudValue], after: Dict[str, HudValue],
         min_confidence: float = 0.6) -> Dict[str, float]:
    """Signed changes for variables confidently read on BOTH sides.

    A value read confidently once and poorly the next time is omitted rather than
    reported as a change -- that asymmetry is where a misread turns into a phantom
    economy bug.
    """
    out: Dict[str, float] = {}
    for name, a in after.items():
        b = before.get(name)
        if b is None:
            continue
        if a.confidence < min_confidence or b.confidence < min_confidence:
            continue
        if a.value != b.value:
            out[name] = round(a.value - b.value, 4)
    return out


# Confidence granted to a field that read identically at two independent scales.
#
# The derived whole-line confidence is pessimistic about HUD text, and correctly so
# for a general line: "Score 0 Moves 22 Goal 1000 Level 1" mixes cases and digits, so
# plausibility and casing-consistency both mark it down, and it scored 0.36 to 0.46 --
# under the 0.6 gate the economy oracles need, even when every number in it was right.
#
# Resampling is the signal that actually separates a correct read from a confident
# mangle, and it is already how ocr.py derives confidence for a line. Applied PER
# FIELD it is stronger still: two independent resamplings agreeing on the same number
# is hard to achieve by accident, and the fields that disagree are dropped rather than
# averaged.
AGREED_CONFIDENCE = 0.9


def read_hud(gray, band=None, scales=(2.0, 3.0), primary_regions=None):
    """Read HUD numbers from a luma frame, keeping only fields that agree across scales.

    `band` optionally restricts reading to a region -- the HUD strip.

    `primary_regions` is an already-computed pass at the FIRST scale. The caller
    usually has one, because a whole-frame OCR has just been done for the control
    list, and a full pass costs around 550ms: reusing it halves the price of
    cross-scale verification from about 1100ms to 550ms. The slow loop runs at
    0.2-2Hz, so this is the difference between affordable and not.
    """
    import ocr as _ocr

    per_scale = []
    for i, sc in enumerate(scales):
        if i == 0 and primary_regions is not None:
            per_scale.append(parse_hud(primary_regions))
            continue
        if band is None:
            regions = _ocr.recognize(gray, scale=sc).regions
        else:
            regions = _ocr.recognize_rois(gray, [band], scale=sc).regions
        per_scale.append(parse_hud(regions))

    if not per_scale:
        return {}
    first = per_scale[0]
    if len(per_scale) == 1:
        return first

    out: Dict[str, HudValue] = {}
    for name, v in first.items():
        others = [p.get(name) for p in per_scale[1:]]
        if any(o is None or abs(o.value - v.value) > 1e-9 for o in others):
            continue          # the scales disagree: drop it rather than guess
        out[name] = HudValue(name, v.value,
                             max(v.confidence, AGREED_CONFIDENCE), v.raw)
    return out
