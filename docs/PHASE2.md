# Phase 2 — the perception ladder

## Built

| File | Purpose |
|---|---|
| `bot/state.py` | `Observed<T>`, `PerceivedState`, the unreadable discipline |
| `bot/ocr.py` | Rung R3 — Windows OCR with derived confidence |
| `bot/perceive.py` | The ladder assembled: R0→R1→R2→R3, fast and slow paths |
| `bot/test_ocr.py` | Accuracy and cost measurement |

## Windows OCR works from Python directly

`winsdk` projects the Windows OCR engine into Python, so there is **no .NET SDK, no
C# sidecar and no Tesseract binary** — the plan assumed a sidecar would be needed and
it isn't. `en-GB` and `en-US` available.

**Accuracy: 100% across six cases** — light-on-dark, dark-on-light, low contrast,
9px text, noisy background, and text over a busy gradient. Zero hallucinated regions
on a blank image.

**Important limitation:** those are synthetic renders in system fonts. Real game text
has stylised faces, outlines, drop shadows and transparency, and will be harder. This
number should not be quoted as a real-game accuracy.

## Confidence had to be derived, and the first attempt was dangerous

WinRT returns `OcrWord` with text and a bounding rect but **no confidence**. Without
one, every reading is implicitly trusted.

The first derivation scored plausibility — character classes plus a small UI word
list. Testing it against degraded input produced this:

```
gaussian blur r=2.0    confidence 0.93    "START 'dw GAVE"
```

Mangled text at 0.93 confidence. That is the worst possible failure: the dangerous
quadrant of the friction 2×2, confidently acting on a misread.

Two signals fixed it:

- **Scale agreement** — read at 2× and 3×. Blur artefacts mangle text *differently*
  at different resamplings, so disagreement exposes them. This is the one that does
  the work.
- **Casing consistency** — real UI lines are cased consistently; `"START 'dw GAVE"`
  mixes all-caps, lowercase and all-caps in one line.

After: that reading scores **0.00 and is rejected**, while every genuinely good
reading survives at 0.90–1.00. It now fails closed rather than confidently wrong.

| condition | before | after |
|---|---|---|
| clean | 1.00 ✓ | 0.97 ✓ |
| blur r=1.0 | 1.00 ✓ | 0.97 ✓ |
| **blur r=2.0** | **0.93, wrong text** | **0.00, rejected** |
| contrast Δ30 | 1.00 ✓ | 0.97 ✓ |
| 9px font | 1.00 ✓ | 0.97 ✓ |
| heavy noise | 0.00 ✓ | 0.00 ✓ |

Cost roughly doubled for the extra variant, which makes ROI reading essential:

| region | cost |
|---|---|
| 320×90 | 14 ms |
| 640×360 | 83 ms |
| 1280×720 | 383 ms |

A 27× spread. The cluster library records which regions of a known screen contain
text, so revisits read a few small boxes instead of the whole frame.

## The unreadable discipline

The rule, and the fix for the worst bug the audit found:

> A field is either **present with a measured confidence**, or **absent and named in
> `unreadable`**. No sentinel, no guess, no third option.

Two distinct non-values that behave differently:

- **unchanged** — present, `source="cached"`, `measured_at_step` still pointing at
  when it was really seen. Oracles may use it; staleness stays visible.
- **unknown** — absent, listed in `unreadable` with a reason. Oracles must skip, and
  the report states what went unchecked.

Without this, an empty `vars` made every invariant gate return False, the suite
returned zero findings, and it looked exactly like a clean build. Reporting "no bugs"
because you could not see anything is worse than reporting an error, because nobody
investigates a pass.

## A bug this caught, and what it changed

The mode classifier called a static menu `loading`, because it keyed on uniformity
and a dark-background menu is mostly one pixel value — same as a fade.

Fixed by adding an **information** metric: a blank tile's dHash is all-zeros or
all-ones, while a tile containing text has a balanced mix, so popcount distance from
the extremes is a free structure detector reusing hashes already computed.

| content | uniformity | information |
|---|---|---|
| blank / fade | 1.00 | 0.00 |
| dark menu | 0.85 | 0.13 |
| busy scene | 0.28 | 0.69 |

Thresholds are now fitted to measured values from the mode simulator — but that is
**three data points**, which is nowhere near enough to trust. So the classifier
reports at confidence ≤0.55, *below* the default `known()` gate of 0.6, and therefore
reads as **unknown** until the model confirms it.

That is the confidence wrapper doing its job: a hand-fitted guess cannot masquerade
as a measurement. The intended path is for the slow loop to ask the System One model
"what kind of screen is this?" and cache the answer per cluster — a question the model
answers far better than a threshold, and pays for once per screen.

## Measured pipeline behaviour

Against a static menu, 80 fast-loop observations:

```
fast loop    ~45 ms/observation (excluding deliberate pacing)
reuse        99%          <- R1 short-circuit; 99 of 100 skip everything downstream
clusters     1
ocr_runs     0            <- OCR never runs on the fast loop
slow enrich  302 ms       <- full-frame first read; ROI revisits are ~14 ms
```

## Not built: R4, the VLM

Needs an API decision. Until then a screen with no label is **visibly** unlabelled —
the blob carries `unreadable: ["screenLabel"]` rather than silently anonymous.
