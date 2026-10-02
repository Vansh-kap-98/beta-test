"""
Does this text look like a BUTTON, or like a label?

From a screenshot the two are identical as text: "Shuffle Board" and "Score 0" are
both readable regions. But the distinction matters enormously, because "this control
does nothing" is a defect claim, and making it about a HUD label is a false positive
while suppressing it on a real button hides a genuine softlock.

Gating on where the text came from (OCR vs computed) does not work -- every on-screen
button is OCR-derived, so that rule throws away the real bugs with the noise.

What actually separates them is VISUAL: a button is drawn as a distinct filled block
with its own background, clearly different from the page behind it. A label sits
directly on the page background. That is a property of how UIs are drawn, not of this
game, so it generalises.

Three measurements, all cheap:

  1. Background distinctness -- how different is the area around the text from the
     page's dominant colour?
  2. Background uniformity  -- a button's fill is flat; a label inherits whatever
     scenery is behind it.
  3. Edge containment       -- a button has a border or a fill boundary close around
     its text; a label does not.
  4. Fill BOUNDEDNESS       -- the decisive one. A button's fill stops just past its
     caption; a modal panel's fill extends far beyond the text sitting on it. Without
     this, heading and body text inside a dialog score as buttons, because panel
     background and button background are identical by every other measure.
"""

from typing import Optional, Tuple

import numpy as np

# Below this, treat the region as a label and do not claim it is a broken control.
BUTTON_THRESHOLD = 0.55


def page_background(bgr: np.ndarray, sample_step: int = 7) -> np.ndarray:
    """The frame's dominant colour, approximated by a coarse median."""
    small = bgr[::sample_step, ::sample_step].reshape(-1, 3)
    return np.median(small, axis=0)


# Button captions are short -- "Got it", "Next Level", "Shuffle Board". A forty
# character line is body copy. This is a regularity of UI writing rather than of any
# one game, and it is what separates a dialog's explanatory sentence (which scored
# 0.68 on the visual signals alone, sitting on the same panel fill as the button
# below it) from the button itself.
CAPTION_FREE_CHARS = 18         # no penalty at or below this
CAPTION_ZERO_CHARS = 52         # fully discounted by here


def caption_prior(text: Optional[str]) -> float:
    if not text:
        return 1.0
    n = len(text.strip())
    if n <= CAPTION_FREE_CHARS:
        return 1.0
    if n >= CAPTION_ZERO_CHARS:
        return 0.35
    span = CAPTION_ZERO_CHARS - CAPTION_FREE_CHARS
    return 1.0 - 0.65 * ((n - CAPTION_FREE_CHARS) / span)


def button_likeness(bgr: np.ndarray, bbox: Tuple[int, int, int, int],
                    page_bg: Optional[np.ndarray] = None,
                    text: Optional[str] = None) -> float:
    """Score 0..1 that this text region is an interactive control rather than a label."""
    x, y, w, h = bbox
    H, W = bgr.shape[:2]
    if w <= 0 or h <= 0:
        return 0.0

    # Pad outward to capture the control's fill around its caption.
    pad_x = max(6, int(w * 0.18))
    pad_y = max(5, int(h * 0.45))
    x0, y0 = max(0, x - pad_x), max(0, y - pad_y)
    x1, y1 = min(W, x + w + pad_x), min(H, y + h + pad_y)
    if x1 - x0 < 6 or y1 - y0 < 6:
        return 0.0

    region = bgr[y0:y1, x0:x1].astype(np.float32)
    if page_bg is None:
        page_bg = page_background(bgr)

    # The control's own fill: sample the padded margin, which is background around
    # the glyphs rather than the glyphs themselves.
    top = region[: pad_y, :].reshape(-1, 3)
    bottom = region[-pad_y:, :].reshape(-1, 3)
    left = region[:, : pad_x].reshape(-1, 3)
    right = region[:, -pad_x:].reshape(-1, 3)
    margin = np.concatenate([top, bottom, left, right])
    if margin.size == 0:
        return 0.0
    fill = np.median(margin, axis=0)

    # 1. Distinct from the page background.
    distinct = float(np.linalg.norm(fill - page_bg))
    s_distinct = min(1.0, distinct / 90.0)

    # 2. Flat fill. A button's background is a solid colour; a label sits on whatever
    #    happens to be behind it, which is usually more varied.
    spread = float(np.mean(np.std(margin, axis=0)))
    s_uniform = max(0.0, 1.0 - spread / 55.0)

    # 3. A boundary just outside the region -- the button's edge. Compared against the
    #    interior, so a busy background does not score as a border.
    ox0, oy0 = max(0, x0 - 4), max(0, y0 - 4)
    ox1, oy1 = min(W, x1 + 4), min(H, y1 + 4)
    outer = bgr[oy0:oy1, ox0:ox1].astype(np.float32)
    if outer.shape[0] > 8 and outer.shape[1] > 8:
        edge_energy = float(np.abs(np.diff(outer, axis=1)).mean())
        inner_energy = float(np.abs(np.diff(region, axis=1)).mean()) + 1e-6
        s_edge = min(1.0, edge_energy / (inner_energy * 1.4))
    else:
        s_edge = 0.3

    # 4. Is the fill BOUNDED? Sample a ring much further out than the button's own
    #    padding. On a real button that ring lands on whatever the button sits on --
    #    a different colour. On a heading inside a dialog it lands on more of the
    #    same panel, which is what marks it as text rather than a control.
    far_x = max(pad_x * 4, int(w * 0.9) + 14)
    far_y = max(pad_y * 4, int(h * 2.2) + 10)
    fx0, fy0 = max(0, x - far_x), max(0, y - far_y)
    fx1, fy1 = min(W, x + w + far_x), min(H, y + h + far_y)
    far = bgr[fy0:fy1, fx0:fx1].astype(np.float32)
    if far.shape[0] > (y1 - y0) + 4 and far.shape[1] > (x1 - x0) + 4:
        band = np.concatenate([
            far[: max(2, far_y // 2), :].reshape(-1, 3),
            far[-max(2, far_y // 2):, :].reshape(-1, 3),
        ])
        outside = np.median(band, axis=0)
        bounded = float(np.linalg.norm(fill - outside))
        s_bounded = min(1.0, bounded / 55.0)
    else:
        s_bounded = 0.4

    score = (0.24 * s_distinct + 0.18 * s_uniform + 0.13 * s_edge + 0.45 * s_bounded)
    score *= caption_prior(text)
    return round(max(0.0, min(1.0, score)), 3)


def is_button(bgr: np.ndarray, bbox: Tuple[int, int, int, int],
              page_bg: Optional[np.ndarray] = None,
              threshold: float = BUTTON_THRESHOLD,
              text: Optional[str] = None) -> bool:
    return button_likeness(bgr, bbox, page_bg, text) >= threshold
