# Phase 0 results — both gates PASS

The two experiments that decide whether the real-time black-box architecture is
viable at all. Nothing else was built until these passed.

Run on: Windows 11, RTX 3050 6GB laptop. Reproduce with the commands below.

---

## Gate 0a — fast-loop latency

**Question:** does the perception path leave enough of the 80ms budget for the
decision model?

```bash
cd perception && python bench_loop.py 10
```

| Stage | p50 | p90 | p99 |
|---|---|---|---|
| capture (R0) | 15.4 ms | 21.1 ms | 24.2 ms |
| digest (R1) | 3.5 ms | 5.5 ms | 6.1 ms |
| **perception total** | **19.2 ms** | **26.3 ms** | **29.9 ms** |

- Sustained **53.7 fps**
- Non-model cost (p90 + 1ms input): **27.3 ms**
- **Headroom for the model: 52.7 ms** against Laya's quoted 33 ms

**PASS.** Real-time genres are viable on this machine.

### How the capture backend was chosen

Pillow's `ImageGrab` was measured first and is far too slow — 34 ms p50 at 1280×720.
`mss` replaced it. Then `bench_scaling.py` asked whether cost is fixed overhead or
proportional to area, because the answer dictates the strategy:

| region | p50 | ms per Mpx |
|---|---|---|
| 160×90 | 8.34 ms | 578.9 |
| 320×180 | 8.30 ms | 144.1 |
| 640×360 | 8.35 ms | 36.2 |
| 960×540 | 17.71 ms | 34.2 |
| 1920×1080 | 26.65 ms | 12.9 |

**~8.3 ms fixed per-call floor**, flat up to ~640×360, area-bound above it. So the
fast loop captures at 640×360 and pays the floor once; full-resolution grabs for OCR
belong on the slow loop, off the critical path. Capturing *smaller* than 640×360 buys
nothing, so there is no reason to lose detail.

Worth noting: capture p90 rises from 9.6 ms in isolation to 21.1 ms inside a
continuous loop. Benchmarking the call rather than the loop would have understated
this by more than half.

---

## Gate 0b — screen-cluster stability

**Question:** does the cluster library plateau, or fragment? If it fragments, a VLM
fires on nearly every frame and the entire cost argument for a System One
architecture collapses.

```bash
npm run demo:web            # serves the mode simulator
cd perception && python run_0b.py 15
```

Measured against a simulator reproducing the *statistical properties* of each genre
mode — how much of the frame changes, how often, and whether any region stays fixed.

| mode | global strategy | masked strategy | |
|---|---|---|---|
| menu | 3 clusters / plateau | 3 clusters / plateau | PASS |
| dialogue | 3 clusters / plateau | 3 clusters / plateau | PASS |
| cutscene | 38 clusters / slowing | **10 clusters / plateau** | PASS |
| world | 46 clusters / linear | **2 clusters / plateau** | PASS |

**PASS, 4 of 4.**

The headline result is `world`: a continuously moving viewport with a fixed HUD
produces **46 clusters under whole-frame hashing and 2 under the tile-volatility
mask**. That is the mechanism the cost model depends on, and it works — the HUD
identifies the screen, the churning viewport is excluded from its identity.

---

## Two bugs this phase found

### 1. A false PASS from a blank capture

The first 0b run reported a clean 4/4. It was measuring nothing. Three of four
captures were flat grey — `std 0.0`, every pixel identical — because all four modes
shared one Chrome `--user-data-dir`, so the singleton lock silently refused to open
windows 2-4 and the capture read whatever was underneath.

A window that never opened clusters to exactly one cluster with a perfect plateau. It
is a *very* convincing false pass.

Fixed with a fresh profile per mode and a `wait_for_content` guard that refuses to
measure until the region provably contains rendered content (`MIN_CONTENT_STD`). The
only reason this was caught is that `--save` wrote the frames to disk and they were
actually looked at.

### 2. The volatility mask was inverted at cold start

On the first valid run, cutscene came back **worse** under masking than without it —
235 clusters versus 38.

Cause: a fresh cluster has `members = 1` and zero recorded tile changes, so
`volatility()` is all zeros and `stable_tiles()` reports **all 16 tiles stable**. The
mask is therefore at its most *strict* exactly when it has no evidence, so every frame
misses and mints a new cluster, which does the same again.

Two fixes:

- `MIN_MEMBERS_FOR_MASK = 5` — a cluster must earn its mask; below that it is scored
  on the global hash.
- **Continuous-motion collapse** — when ~70% of tiles change on ~70% of recent frames
  there is no screen identity to find, so frames collapse into a single catch-all
  cluster instead of one per frame. A VLM is never asked to label a cutscene frame.

Result: cutscene 235 → 10, and world improved from an already-good 2.

---

## What this does and does not establish

**Establishes:** the capture and digest path fits the latency budget with room for the
model; and the cluster library plateaus across all four content classes, so screen
labelling is paid once per screen rather than once per frame.

**Does not establish:** behaviour against real games. The mode simulator reproduces the
statistical properties that matter for clustering — change rate, change extent, and
whether any region is fixed — but a real game will have loading transitions, resolution
changes, post-processing and UI animation that it does not. Gate 0b should be re-run
against one real title per genre before Phase 2 depends on these numbers.

Also unmeasured: **Laya's actual latency on this GPU**. The 33 ms figure is the
vendor's. The 52.7 ms headroom is comfortable enough that a 50% miss still passes, but
it is an assumption until measured — and measuring it needs the GPU work that is
flagged for Phase 3.

---

## Files

| File | Purpose |
|---|---|
| `perception/frame.py` | Capture + perceptual digest (rungs R0, R1) |
| `perception/clusters.py` | Screen-cluster library with volatility mask (rung R2) |
| `perception/bench_capture.py` | Backend comparison — why `mss` over Pillow |
| `perception/bench_scaling.py` | Fixed-overhead vs area characterisation |
| `perception/bench_loop.py` | Gate 0a |
| `perception/bench_clusters.py` | Cluster growth measurement + verdict |
| `perception/run_0b.py` | Gate 0b across all four genre modes |
| `demo/web/modes.html` | Genre mode simulator |
