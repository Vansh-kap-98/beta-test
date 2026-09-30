# beta-test-bot

An autonomous game beta tester. A **System One** decision model (Jev or Laya) plays
the game and evaluates a live invariant suite at play speed; a slower LLM is woken
only when the fast model is uncertain. Findings come out as deterministic,
one-click-reproducible bug reports.

Built overnight as a working proof of the architecture, against two deliberately
different games with twelve planted bugs between them.

---

## The thesis

LLM-driven game test bots usually fail for two reasons that have nothing to do with
how smart the model is:

- **Too slow to play.** 1–3 s per decision means it cannot handle anything with
  timing, and a 10,000-step run takes all night per episode.
- **Too expensive to assert with.** You pay per assertion, per step, so continuous
  checking is unaffordable and the bot ends up checking almost nothing.

System One models remove both limits. They take a state plus *typed* questions and
return typed answers with calibrated probabilities in a single parallel forward
pass — 33–500 ms, and Jev bills input only at $0.042/M with free output. So the
fast model can play *and* assert continuously, and the LLM becomes a rare
escalation rather than the main loop.

| Tier | Engine | Cadence | Job |
|---|---|---|---|
| 0 | plain code | every step | crash, softlock, stuck loading, text overflow, overlap, fps, heap, variable bounds |
| 1 | Jev / Laya | every step | actuation (`choice`), invariant suite (`noul`), balance telemetry (`score`) |
| 2 | LLM | on escalation | planning, novel situations, ambiguous judgement, writing the report |

**The escalation gate is the calibrated probability, and it is the whole cost
model.** Tier-1 absorption — the share of decisions resolved without waking Tier 2
— is the number to watch. It runs at **~80%** across every build variant of both
games.

## Results

### Game 1 — a small RPG

Seven planted bugs spanning all four bug classes. Eight runs × 1500 steps, ~0.4 s.

| Build | Defects found | False positives | Absorption |
|---|---|---|---|
| clean | 0 | **0** | 79.9% |
| all bugs | 8 (4 critical) | 0 | 80.3% |
| shopFree only | 1 (the economy bug) | 0 | 79.8% |
| settingsSoftlock only | 2 (one structural, one semantic) | 0 | 80.4% |

Every planted bug is found, and a clean build is **completely silent** — over
16,000 steps across eight seeds. That silence is the hardest property to get and
the easiest to lose; see [docs/JOURNAL.md](docs/JOURNAL.md) for how many attempts
it took.

Notable individual results:

- **The economy bug is invisible to Tier 0 and found by Tier 1.** No arithmetic
  check can know that `buy_elixir` *ought* to cost something; a natural-language
  invariant read by a model can.
- **The softlock is found twice, independently** — Tier 0 by exhausting every
  control and seeing nothing change, Tier 1 by understanding that no control on
  the screen means "leave". Two kinds of evidence for one defect.
- **The difficulty spike is found by cross-run aggregation**, never by a
  per-episode judgement, and only when two independent measures agree.
- **Minimal repros.** The crash is found deep in a 1500-step run and reported as a
  **3-action** reproduction.

### Game 2 — a checkout wizard

Added specifically to test whether the core is really game-agnostic, and built to
be unlike the RPG in every way that might have quietly leaked into it: text input,
validation states, a linear flow, no combat, no difficulty curve.

| Build | Result |
|---|---|
| clean | **0 defects** (also at 8 seeds × 2000 steps) |
| totalIgnoresQuantity | 1 critical pricing defect |
| backLosesData | 1 defect, reported once rather than once per screen |
| validationBypass | 1 validation defect |
| doubleCharge | 2 — a Tier-0 bounds check *and* a Tier-1 invariant, independently |
| stuckSpinner | 1 critical softlock, nothing spurious |

**It found six real defects in the core within an hour**, none of which were
findable with one game: the agent could not type, the serializer hid form fields,
deduplication was hard-coded per-screen, exploration had an anti-repetition bias
that made a whole bug class unreachable, recovery checkpointed inside traps, and —
worst — the statistical gate **pooled evidence across unrelated screens**, which
produced confident false positives on screens that were completely fine.

The lesson is in [docs/JOURNAL.md](docs/JOURNAL.md): an abstraction validated
against one instance is not validated.

## Quick start

No build step, no runtime dependencies. Node 22.6+.

```bash
npm install
npm test
```

Run the bot against the reference game:

```bash
npm run play -- --variant all --seeds 6 --steps 1500
npm run play -- --game checkout --variant all --seeds 8
```

Reproduce any finding the report lists:

```bash
npm run replay -- artifacts/<run>/replays/<finding>.json
```

Measure whether the model's confidence can be trusted:

```bash
npm run calibrate -- --compare
```

Useful `refgame` variants: `clean`, `all`, or any comma-separated bug flags —
`shopFree`, `settingsSoftlock`, `potionCrashAtFullHp`, `infiniteLoad`,
`textOverflow`, `difficultySpike`, `memLeak`. For `--game checkout`:
`totalIgnoresQuantity`, `backLosesData`, `validationBypass`, `doubleCharge`,
`stuckSpinner`. `--policy fuzz` runs the monkey-tester baseline instead of the
model, for comparison.

## What is real and what is simulated

Worth being precise about, because the distinction matters for judging the results.

**Real and exercised:** the tier architecture, all Tier-0 oracles, the invariant
engine with its statistical reporting gate, the option-ceiling router, state
serialization, the escalation gate, snapshot recovery, balance aggregation, the
calibration harness, reporting and deterministic replay — across two structurally
different games. 137 tests, including a detection matrix per game that asserts the
exact result table above.

**Real, and browser-validated end to end:** the DOM adapter and the entire tier
stack. The agent is compiled to ESM and **runs inside a real browser page** against
a small web game with three planted bugs ([demo/](demo/README.md)) — same oracles,
same gates, same reporting, nothing reimplemented. It finds all three, with the
softlock caught twice by independent routes, and produces a 1-action reproduction
for the overflow.

**Real but not called live:** the Jev and Laya HTTP backends
([src/core/soc/backends/http.ts](src/core/soc/backends/http.ts)). Both vendors
converged on the same wire contract — `POST /v1/systemone`, a `state` blob plus a
`questions` map — so one client serves both. It is unit-tested against fixture
payloads taken from the published API docs, but no API key was used, so the wire
mapping is verified against documentation rather than against a live server.

**Simulated:** the model itself. `MockSystemOne` is a decision source with
*controllable* accuracy and calibration, so the escalation gate and the calibration
harness can be measured against a known ground truth offline. A mock that was
always right at p=1.0 would make every test pass while proving nothing; this one is
deliberately wrong ~12% of the time and can be made overconfident on demand — and
the calibration harness detects that, which is the safety property the whole design
rests on.

The honest consequence: **the absorption and accuracy figures above are properties
of the architecture under a simulated model, not measurements of Jev or Laya.**
Swapping in a real client is a one-line change; re-measuring on real traffic is the
first thing to do next.

## Architecture

```
src/core/
  types.ts              Shared vocabulary: GameState, Action, Finding, GameAdapter
  soc/                  System One client
    types.ts            choice / score / noul questions and answers
    serialize.ts        Game state -> the compact blob handed to the model
    router.ts           Option-ceiling defences: shortlisting + hierarchical choice
    backends/mock.ts    Offline simulator with controllable calibration
    backends/http.ts    Jev and Laya (same wire contract)
  oracles/
    tier0.ts            Deterministic oracles + declarative bounds checks
    invariants.ts       Natural-language invariants + the statistical reporting gate
    runner.ts           Rolling window and defect deduplication
  agent/
    session.ts          Play loop, snapshot recovery, deterministic replay
    tier1Policy.ts      The model-driven policy
    planner.ts          Tier 2: the escalation target
    randomPolicy.ts     Fuzz baselines
  calibration/
    harness.ts          Reliability diagram, ECE, recommended gate
    balance.ts          Encounter telemetry and difficulty-curve anomalies
  trace/report.ts       Markdown reports with runnable reproductions
src/adapters/dom/       Generic DOM adapter - the path for any web game
src/games/refgame/      System under test 1: an RPG, seven planted bugs
src/games/checkout/     System under test 2: a checkout wizard, five planted bugs
src/games/registry.ts   One entry per game - this is the whole integration surface
src/cli/                play, replay, calibrate
```

### Four design decisions that carried the most weight

**1. Never ask a model what plain code can decide.** The first end-to-end run put
`currency >= 0` and `0 <= hp <= maxHp` into the model's invariant suite. They were
asked every step, and every wrong answer became a bug report — hundreds across a
clean build. They are arithmetic: they belong in Tier 0, where they are free and
cannot be wrong.

**2. Evidence, not a single answer.** A violation is reported only when it recurs
across genuinely different states *and* its violation rate's **Wilson lower bound**
clears the model's measured error rate. A raw 2-of-2 failure looks like 100% and is
worth almost nothing (lower bound ~34%). This gate is what took a clean run from
four false positives to zero — and it consumes the calibration harness's output,
which is what makes calibration load-bearing rather than decorative.

Re-asking the same question is *not* a second opinion: Jev and Laya are
deterministic, so identical input returns an identical answer and the extra
"samples" are perfectly correlated.

**3. Corroboration.** A defect confirmed by two independent routes is worth far
more than one asserted confidently by a single route. Death rate alone cannot
distinguish a planted difficulty spike from a game's natural late-game wall —
measured on the reference game those are numerically identical. Requiring a second
independent measure to agree separates them cleanly.

**4. A blocking bug must not cost the run.** Without recovery, the settings
softlock trapped the bot at coverage 8 and hid every bug behind it. With snapshot
rewind plus a two-level ban on the edge that led in, the same run reaches coverage
406 and finds 10 defects.

## Where this goes next

In rough priority order:

1. **Point it at a real game.** Write one `GameAdapter` and one registry entry —
   [docs/ADAPTERS.md](docs/ADAPTERS.md) is the guide, including a worked example
   for canvas engines. For a web game, `src/adapters/dom/` already does most of it.
   Everything above the adapter is game-agnostic, and that claim has now been
   tested against a second, deliberately dissimilar target rather than asserted.
2. **Re-measure with a real model.** Run the calibration harness against live Jev
   and local Laya on the same workload and set the gates from those numbers. The
   architecture's cost model stands or falls on the real absorption rate.
3. **A real Tier 2.** `LlmPlanner` takes a completion function and is ready; it has
   not been run against a live model.
4. **Coverage-directed exploration.** Current exploration is ε-greedy over
   least-visited controls, which is cheap and measurably better than nothing
   (+13% over uniform random) but far from a planner that sets goals.
5. **Screenshots for the genuinely visual bugs.** The semantic tree cannot see a
   mis-rendered sprite or a z-order error. Those need pixels, and a vision check is
   worth running *only* on frames the cheap tiers flag as suspicious.

## Try the browser demo

```bash
npm run build:web && npm run demo:web    # then open http://127.0.0.1:8177
```

A small web game with three planted bugs, with the whole agent running inside the
page. Press **Run the bot**. See [demo/README.md](demo/README.md).

## Documents

- [docs/ADAPTERS.md](docs/ADAPTERS.md) — how to point this at your game
- [docs/PLAN.md](docs/PLAN.md) — the plan this was built against
- [docs/JOURNAL.md](docs/JOURNAL.md) — the build log, including the wrong turns,
  which carry more design information than the successes
- [docs/DECISIONS.md](docs/DECISIONS.md) — decisions taken and why
