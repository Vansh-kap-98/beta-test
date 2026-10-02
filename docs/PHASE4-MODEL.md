# A real System One model in the loop

Up to this point every decision was made by `MockSystemOne`, which answers by
consulting ground truth. That measured the pipeline and said nothing about whether a
model can read our state. This phase replaced it with the real thing.

## What is running

| | |
|---|---|
| Model | `laya` 0.3.23 (Convai Innovations, Apache-2.0), `convaiinnovations/laya` |
| Served as | `POST /v1/systemone` on `127.0.0.1:8231` — **the same wire contract as Jev** |
| Device | RTX 3050 6GB, CUDA via torch 2.5.1+cu121 |
| Python | 3.12 (the repo's default 3.8 cannot run it; laya needs ≥3.10) |

The plan claimed "Jev + Laya share a wire contract, so the choice is a deployment
decision, not an architectural one." That is now verified rather than assumed:
`laya.serve` exposes the identical endpoint path and response shape that
`backends/http.ts` was already written and unit-tested against. Swapping to Jev is a
base URL and an API key.

**Nothing was trained.** The GPU is used for inference only.

## Latency, measured

| questions per call | median | per question |
|---|---|---|
| 1 | **30.7 ms** | 30.7 ms |
| 2 | 44.8 ms | 22.4 ms |
| 6 | 66.4 ms | 11.1 ms |
| 12 | 106.3 ms | 8.9 ms |

Roughly 24 ms of fixed overhead plus 7 ms per question, so batching is strongly
sublinear. CPU is **13× slower** (1353 ms for the six-question batch) and unusable for
anything real-time.

This confirms the dual-loop split and corrects the plan's budget. A fast loop asking
**one** choice lands at 33 ms, as advertised. The six-question invariant batch at 66 ms
does **not** fit a 60Hz loop and belongs in the slow loop — the plan's 40–65 ms
end-to-end figure assumed Laya cost ~33 ms regardless of batch size, which is wrong.

## The result

Against the headless match-3 (`npm run sim`), 150 steps × 3 seeds per variant:

| variant | outcome | found by |
|---|---|---|
| clean | **silent** | — |
| scoreCascade | detected | `reward-consistency` (Tier 0) |
| tutorialVague | detected | `instructions_are_actionable` → Tier 2 |
| stuckNoShuffle | detected | stagnation oracle + `action_has_effect` |
| ghostMove | detected | `wasted-cost` (Tier 0) |
| winNoAdvance | detected | stagnation oracle + `action_has_effect` |

**5/5 planted bugs, clean build silent, tier-1 absorption 97–100%, 12–26 Tier-2 calls
per 450 steps.**

Read that table honestly: two of the five are found by deterministic Tier-0 oracles
and one is found by Tier 2 after Laya declined to judge. Laya itself contributes the
dead-control detection and, crucially, the *absorption* — it answers ~98% of decisions
cheaply so the expensive tiers are only asked about the remaining 2%. That is the
architecture working as designed, not a disappointment, but it is not "the small model
found five bugs".

## What had to change, and what each thing cost

### 1. The model cannot read JSON

The single most consequential finding. Same model, same questions, same facts:

| state rendering | accuracy | bugs missed | latency |
|---|---|---|---|
| JSON blob | 0.652 | **6 of 8** | 72 ms |
| prose sentences | 0.957 | **1 of 8** | 64 ms |

Handed a dict, it answered one question at exactly `p=0.500` while the answer sat in
the blob as `producedChange: true`. A non-autoregressive model reads language, and
`{"vars":{...}}` is not language. Prose is also *faster*, being fewer tokens.

This was invisible for an entire phase because the mock consulted ground truth instead
of reading the state. **`src/core/soc/prose.ts` is now load-bearing**, and
`backends/http.ts` renders prose by default.

### 2. Question polarity decides whether bugs are found at all

The model leans toward answering "yes". Every invariant was phrased so `true` = healthy,
which pointed that bias directly at under-reporting — a tool that cannot say "no" and
therefore calls a broken build fine.

| rendering | polarity | accuracy | bugs missed |
|---|---|---|---|
| JSON | healthy-positive | 0.652 | 6 of 8 |
| JSON | defect-positive | 0.783 | 3 of 8 |
| prose | healthy-positive | 0.609 | 6 of 8 |
| **prose** | **defect-positive** | **0.957** | **1 of 8** |

`Invariant.polarity` now declares this and `check()` normalises in one place.

### 3. A defect-positive question must ASK, not ASSERT

First attempt phrased them as "This screen offers no way to leave. Is the player
trapped?" — and the model agreed with the premise, reporting a clean board as having no
exit while a Pause control sat in the list. Rewritten as plain questions ("Is the player
trapped on this screen, with no control that leaves it?"), the labelled bench went to
**0 of 8 missed and 0 confident-wrong**.

### 4. Choice confidence was on the wrong scale — absorption 0% → 97%

The first real-model run absorbed **0%** of decisions. Every choice escalated, which
destroys the entire cost argument.

The cause was a threshold, not the model. `probabilities[chosen]` depends on how many
options were offered: on a 12-option board a confident pick still scores ~0.25, so a
0.75 gate is unreachable by construction. Measured over 200 real decisions:

| confidence measure | best gate | absorbed | accuracy |
|---|---|---|---|
| `probabilities[chosen]` | 0.25 | 30.5% | 0.885 |
| **`top / (top + second)`** | **0.55** | **63.5%** | 0.819 |
| `top × n` (lift over chance) | 3.00 | 29.5% | 0.881 |

`top/(top+second)` asks "am I sure it is this one rather than the runner-up", is
independent of option count, and puts choice confidence on the **same scale** as a
noul's `max(p, 1-p)` — so one threshold can honestly govern both. In the full agent
this took absorption from 0% to 97–100%.

### 5. Arithmetic belongs in Tier 0 — learned three times

`invariants.ts` already said so: *"asking a model to evaluate arithmetic every step is
how the first version of this system produced hundreds of false positives on a clean
build."* I then wrote three invariants that did exactly that, and each produced a false
positive on a clean build with the answer sitting in the prose:

- "Is the player stuck with no legal move?" → yes, with `legal moves is 15` in the blob
- "Did the player clear tiles without the score increasing?" → yes, with `Change: +60`
- "Was a move taken even though the swap did nothing?" → no usable opinion at all

All three now live in deterministic oracles (`oracles/reward.ts`), and the Tier-1
versions `applies` **only when the number cannot be read** — which is the common case
on a real game, and the reason they still exist.

### 6. The `applies` predicate is the denominator

`move_not_wasted` fired 15 times in 237 opportunities — a true 6% violation rate, which
the Wilson gate correctly refused to report because it cannot be distinguished from a
5% model error rate. The defect was real, detected, and statistically invisible.

Narrowing `applies` to only the opportunities where the question is meaningful (a move
spent **and** nothing cleared) took the denominator from every move to just the
suspicious ones and the violation rate to ~100%. Loosening the gate instead would have
brought back the false positives the gate exists to stop.

### 7. Single-visit screens: corroborate by paraphrase, and escalate a shrug

A tutorial is seen once. Repetition evidence cannot accumulate, so detection
probability collapses to the model's per-question accuracy — the vague tutorial was
missed on seed 1 and found across six seeds purely on a coin flip.

Two additions, both in `invariants.ts`:

- **`Invariant.paraphrases`** — the same property asked several ways in the same call
  (marginal cost ~7 ms each). Different wordings are only weakly correlated, unlike
  re-asking an identical prompt of a deterministic model. This also cut false
  escalations on healthy screens from 16 to 9.
- **A split or uncertain vote escalates.** Against the real model the comprehension
  question returned 0.51, 0.51, 0.52, 0.55 — on *both* the clear and the vague
  tutorial. That is not a wrong answer, it is no answer, and Laya's own README predicts
  it (0.362 zero-shot vs 0.766 fine-tuned on typed decisions). Reading "no opinion,
  leaning fine" as "fine" is how a usability tool goes silent on precisely the screens
  it exists to examine.

Cost is bounded by distinct *screens*, not steps, because adjudication is memoised per
invariant and screen.

### 8. The opening screen was never judged

The invariant suite ran from `onResult`, which only ever sees post-action states. The
title screen and the tutorial — every player's first two screens and the richest source
of comprehension findings — were evaluated **zero times**. `Policy.onStart` now gives
the first observation its look.

## Bugs in our own code that the model exposed

Pointing a real model at the system found faults in the harness faster than any test:

- **The agent was not playing the game.** `match3BestControl` preferred anything
  matching `shuffle`, and `shuffle_board` is offered on every board screen — so it
  pressed Shuffle on all 200 steps of every run and never swapped a candy. Three
  invariants could not apply even in principle, two bugs were unreachable, and one bug
  was "detected" only *because* the bot was stuck on the inert control. Absorption
  stayed at 90% and the clean build stayed silent throughout.
- **The prose contradicted itself.** "The action had no effect at all" two lines above
  "produced change is yes", because the renderer asserted no-change from numeric deltas
  alone. Dismissing a tutorial changes the whole screen and no variable.
- **It described actions that never happened.** On the first observation, with
  `lastAction: none`, it still asserted the action had no effect.
- **Eight identical control captions drowned the exit.** The board listed "swap two
  candies" ten times with Pause last; the model reported no way out. Identical captions
  are now collapsed with a count.
- **The action list was non-deterministic.** `labels()` called `availableActions()`,
  which advanced the RNG, so two calls in the same state returned different lists.
  Action identity is what dedup, bans, visit counts and the shortlist are keyed on.
- **Ambiguous window attach.** `find_window` took the largest match, so two windows of
  the same size were a coin flip. A clean run and a planted-bug run returned
  byte-identical output because both attached to the same window. Attach now refuses
  and names the candidates; the fixture puts its variant in its title; `--expect`
  asserts what was attached.
- **The fixture had no exit from the board.** Asked whether the player could leave,
  Laya said no on every variant including clean — and it was right. A pause control was
  missing. The model found a defect in the test fixture.
- **`progress_is_possible` was removed.** It asked about progress "recently" but was
  evaluated on a single state, duplicated the Tier-0 stagnation oracle, and produced a
  false positive on a clean build — because the agent deliberately probes invalid moves,
  and a rejected swap correctly changes nothing. The tool's own testing strategy was
  manufacturing evidence for its own finding.

## Honest limitations

- **23 decisions is a small labelled bench.** 0.957 accuracy there has a Wilson lower
  bound near 0.79.
- **The model is phrasing-sensitive.** A prose template change is a behavioural change
  and needs re-measuring. `bot/bench_prose.py` exists for that.
- **The checkpoint ships uncalibrated temperatures** for some entries and says so in a
  runtime warning. Confidence from affected entries is not trustworthy, which matters
  because the Wilson gate assumes calibration.
- **Tier 2 is still an oracle, not an LLM.** `OraclePlanner` answers from ground truth,
  deliberately modelling a perfect Tier 2 to isolate "how often must we escalate" from
  "how good is a given LLM". The comprehension finding currently depends on it.
- **Zero-shot comprehension judgment does not work.** The fine-tuned checkpoint scores
  0.766 against 0.362 for the base, and this is the clearest candidate for fine-tuning.
- **This is a fixture.** Detection rates here assume a perfect view of the game. The
  gap between these numbers and the same bench through the live screen pipeline is
  exactly the cost of perception, and measuring it is the next step.

## Running it

```bash
LAYA_HOST=127.0.0.1 LAYA_PORT=8231 LAYA_DEVICE=cuda py -3.12 -m laya.serve
```

```bash
npm run sim -- --backend laya --steps 150 --seeds 3
```

```bash
npm run gatebench -- --n=200
```
