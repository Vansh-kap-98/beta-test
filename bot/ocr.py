"""
Rung R3: local OCR via the Windows OCR engine.

Reached through `winsdk`, so there is no .NET SDK, no C# sidecar and no Tesseract
binary -- the engine ships with Windows and the projection is a pip install.

The important gap: WinRT returns `OcrWord` with text and a bounding rect but **no
confidence**. A reading with no confidence cannot be used, because the whole state
blob depends on distinguishing "read it, trust it" from "read it, don't trust it"
from "couldn't read it". So confidence is DERIVED here, from three signals:

  1. Plausibility -- does this look like UI text, or like OCR noise? Game text is
     short and mostly alphabetic; "C0nt1nue" and "|_|" score badly.
  2. Polarity agreement -- game text is light-on-dark about as often as the reverse,
     so every region is read twice, normally and inverted. Agreement between the two
     is strong evidence; disagreement is strong doubt.
  3. Upscale agreement -- small text reads differently at 1x and 2x. Agreement means
     the reading is stable rather than an artefact of one particular resampling.

None of these is a real confidence score. They are a proxy, they are calibrated
against nothing yet, and the honest position is that they should be validated against
injection-derived ground truth (the dual-pipeline harness) before being trusted. What
matters for now is that a *number* exists, so `known()` can gate on it rather than
every reading being implicitly trusted.
"""

import asyncio
import re
import time
from dataclasses import dataclass
from typing import List, Optional, Sequence, Tuple

import numpy as np
from PIL import Image

from winsdk.windows.graphics.imaging import BitmapPixelFormat, SoftwareBitmap
from winsdk.windows.media.ocr import OcrEngine
from winsdk.windows.storage.streams import Buffer

from state import TextRegion

# Common UI vocabulary. Not a dictionary -- just enough to recognise that a reading
# looks like a menu rather than like noise.
UI_WORDS = {
    "start", "new", "game", "continue", "load", "save", "options", "settings",
    "quit", "exit", "back", "cancel", "ok", "yes", "no", "apply", "next", "play",
    "resume", "pause", "menu", "inventory", "map", "close", "confirm", "accept",
    "language", "audio", "video", "graphics", "controls", "credits", "profile",
    "buy", "sell", "equip", "use", "drop", "gold", "coins", "level", "health",
    "press", "any", "key", "select", "difficulty", "easy", "normal", "hard",
}

_engine = None


def engine():
    global _engine
    if _engine is None:
        _engine = OcrEngine.try_create_from_user_profile_languages()
        if _engine is None:
            raise RuntimeError("no OCR engine available for the user's languages")
    return _engine


def _to_bitmap(gray: np.ndarray) -> SoftwareBitmap:
    h, w = gray.shape
    bgra = np.dstack([gray, gray, gray, np.full_like(gray, 255)]).tobytes()
    buf = Buffer(len(bgra))
    buf.length = len(bgra)
    memoryview(buf)[:] = bgra
    return SoftwareBitmap.create_copy_from_buffer(buf, BitmapPixelFormat.BGRA8, w, h)


async def _recognize_async(gray: np.ndarray):
    return await engine().recognize_async(_to_bitmap(gray))


def _run(gray: np.ndarray):
    try:
        return asyncio.run(_recognize_async(gray))
    except RuntimeError:
        # Already inside a loop (rare here, but the agent may be async later).
        loop = asyncio.new_event_loop()
        try:
            return loop.run_until_complete(_recognize_async(gray))
        finally:
            loop.close()


def plausibility(text: str) -> float:
    """How much does this look like real UI text rather than OCR noise?"""
    t = text.strip()
    if not t:
        return 0.0
    letters = sum(1 for c in t if c.isalpha())
    digits = sum(1 for c in t if c.isdigit())
    junk = sum(1 for c in t if not (c.isalnum() or c.isspace() or c in ".,:;!?'-/%$()"))
    n = len(t)

    score = 0.35
    score += 0.35 * (letters / n)                    # mostly letters is good
    score += 0.10 * min(digits / n, 0.3) / 0.3       # a few digits is normal
    score -= 0.55 * (junk / n)                       # junk characters are damning

    words = [w for w in re.split(r"\s+", t.lower()) if w]
    if words:
        clean = [re.sub(r"[^a-z]", "", w) for w in words]
        hits = sum(1 for w in clean if w in UI_WORDS)
        score += 0.30 * (hits / len(words))
        # Single stray characters are usually noise, not a control label.
        if len(words) == 1 and len(clean[0]) <= 1:
            score -= 0.30
    return max(0.0, min(1.0, score))


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def casing_consistency(text: str) -> float:
    """Real UI lines are cased consistently -- ALL CAPS, Title Case, or lower.

    Mangled OCR is not: "START 'dw GAVE" mixes an all-caps word, a lowercase
    fragment and another all-caps word in one line. That mixture is a much stronger
    mangling signal than character classes alone, which is why a reading like that
    scored 0.93 on plausibility while being almost entirely wrong.
    """
    words = [w for w in re.split(r"\s+", text.strip()) if any(c.isalpha() for c in w)]
    if len(words) < 2:
        return 1.0
    def shape(w):
        letters = [c for c in w if c.isalpha()]
        if not letters:
            return "x"
        if all(c.isupper() for c in letters):
            return "U"
        if all(c.islower() for c in letters):
            return "l"
        if letters[0].isupper() and all(c.islower() for c in letters[1:]):
            return "T"
        return "m"                      # mixed inside a word: usually mangled
    shapes = [shape(w) for w in words]
    if "m" in shapes:
        return 0.45
    distinct = len(set(shapes))
    if distinct == 1:
        return 1.0
    if distinct == 2 and set(shapes) <= {"T", "l"}:
        return 0.9                      # "Load Game to continue" is normal prose
    return 0.55


@dataclass
class OcrResult:
    regions: List[TextRegion]
    ms: float
    variants_run: int

    @property
    def text(self) -> str:
        return " ".join(r.text for r in self.regions)


def _read_variant(gray: np.ndarray, scale: float, invert: bool) -> List[Tuple[str, tuple]]:
    img = Image.fromarray(gray)
    if scale != 1.0:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))),
                         Image.LANCZOS)
    arr = np.asarray(img)
    if invert:
        arr = 255 - arr
    res = _run(np.ascontiguousarray(arr))
    out = []
    for line in res.lines:
        if not line.words:
            continue
        xs = [wd.bounding_rect.x for wd in line.words]
        ys = [wd.bounding_rect.y for wd in line.words]
        rs = [wd.bounding_rect.x + wd.bounding_rect.width for wd in line.words]
        bs = [wd.bounding_rect.y + wd.bounding_rect.height for wd in line.words]
        bbox = (int(min(xs) / scale), int(min(ys) / scale),
                int((max(rs) - min(xs)) / scale), int((max(bs) - min(ys)) / scale))
        out.append((line.text, bbox))
    return out


def recognize(
    gray: np.ndarray,
    scale: float = 2.0,
    alt_scale: float = 3.0,
    try_invert: bool = True,
    min_confidence: float = 0.35,
) -> OcrResult:
    """Read text from a luma image, with a derived per-region confidence.

    Three signals combine, and the second is the one that earns its cost:

      plausibility      does this look like UI text at all
      SCALE AGREEMENT   does it read the same at a different resampling
      casing            is the line cased consistently

    Scale agreement is what catches a *confidently wrong* reading. Blurred text
    produces mangled output, but the mangling differs between resamplings -- so
    "START NEW GAME" misread as "START 'dw GAVE" at 2x reads as something else
    again at 3x, and the disagreement exposes it. Without this, that reading scored
    0.93 and would have been acted on.
    """
    t0 = time.perf_counter()
    primary = _read_variant(gray, scale, invert=False)
    variants = 1

    alt = _read_variant(gray, alt_scale, invert=False)
    variants += 1
    alt_norm = {_norm(t) for t, _ in alt}

    inverted: List[Tuple[str, tuple]] = []
    # Only pay for the inverted read when the normal one found little -- on
    # light-on-dark UI (the common case) the first read already succeeded.
    if try_invert and len(primary) < 2:
        inverted = _read_variant(gray, scale, invert=True)
        variants += 1
    inv_norm = {_norm(t) for t, _ in inverted}

    regions: List[TextRegion] = []
    seen = set()
    for text, bbox in primary + inverted:
        key = _norm(text)
        if not key or key in seen:
            continue
        seen.add(key)

        p = plausibility(text)
        c = casing_consistency(text)
        scale_agrees = key in alt_norm
        polarity_agrees = key in inv_norm and any(_norm(t) == key for t, _ in primary)

        conf = p * c
        conf *= 1.0 if scale_agrees else 0.55     # the discriminating factor
        conf += 0.10 if polarity_agrees else 0.0
        conf = max(0.0, min(1.0, conf))

        if conf < min_confidence:
            continue
        regions.append(TextRegion(text=text.strip(), bbox=bbox, confidence=round(conf, 3)))

    regions.sort(key=lambda r: (r.bbox[1], r.bbox[0]))
    return OcrResult(regions=regions, ms=(time.perf_counter() - t0) * 1000.0, variants_run=variants)


def recognize_rois(
    gray: np.ndarray,
    rois: Sequence[Tuple[int, int, int, int]],
    scale: float = 2.0,
) -> OcrResult:
    """Read only specific regions.

    This is how OCR stays inside budget on the slow loop: the cluster library records
    which regions of a known screen actually contain text, so revisits read a handful
    of small boxes instead of the whole frame.
    """
    t0 = time.perf_counter()
    out: List[TextRegion] = []
    variants = 0
    for (x, y, w, h) in rois:
        x, y = max(0, x), max(0, y)
        sub = gray[y:y + h, x:x + w]
        if sub.size == 0:
            continue
        r = recognize(sub, scale=scale)
        variants += r.variants_run
        for reg in r.regions:
            bx, by, bw, bh = reg.bbox
            out.append(TextRegion(reg.text, (x + bx, y + by, bw, bh), reg.confidence, reg.role))
    return OcrResult(regions=out, ms=(time.perf_counter() - t0) * 1000.0, variants_run=variants)
