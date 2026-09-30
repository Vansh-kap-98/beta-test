# Beta-Test Bot — Overnight Build Plan

## What this is

An autonomous game beta-testing bot. A **System One** decision model (Jev or Laya)
plays the game and evaluates a live invariant suite at play speed; a slower LLM is
woken only when the fast model is uncertain. Findings come out as deterministic,
one-click-reproducible bug reports.

## The core thesis

Conventional LLM game bots fail for two reasons: a generative model is too slow to
play (1-3 s/decision) and too expensive to assert with (you pay per assertion, per
step). System One models remove both limits:

- **Latency**: 33-500 ms typed decisions => the model can be in the play loop.
- **Cost**: Jev is $0.042/M input with *free output*; Laya is open weights, run local.
  => you can evaluate dozens of assertions every single step for ~nothing.

So: the fast model plays and asserts continuously, the LLM thinks only on escalation.

## Tier model

| Tier | Engine | Cadence | Job |
|---|---|---|---|
| 0 | Plain code | every frame | crash, console error, NaN, FPS, heap, bbox overlap, state-hash softlock |
| 1 | Jev / Laya | every action | actuation (`choice`), invariant suite (`noul`), balance telemetry (`score`) |
| 2 | LLM | on escalation only | planning, novel situations, ambiguous judgment, writing the report |

**The escalation gate is the calibrated probability.** Tier-1 confidence below a
threshold (set from measured calibration, not guessed) wakes Tier 2. Tier-1
absorption rate is the single metric that determines whether an overnight run costs
cents or hundreds of dollars. Every design choice is judged against it.

## Primitive mapping

- `noul` (calibrated yes/no) -> **oracles**. Dozens per step, one parallel pass.
- `choice` (option from a set) -> **actuation** + screen classification.
- `score` (ordered rubric) -> **balance telemetry**, aggregated across runs, never
  trusted per-episode.

## Known hazards (designed around, not discovered later)

1. **Laya's option ceiling.** ~192-256 tokens shared across all candidate options;
   past ~20 options each gets a few tokens. Mitigation: Tier-0 deterministic
   shortlisting to <=15 candidates, plus hierarchical choice (region -> element).
2. **Calibration is load-bearing.** If confidence is overconfident on our
   distribution, escalation silently stops and quality collapses with no error.
   Mitigation: calibration harness + reliability diagram from day one.
3. **State serialization quality dominates everything.** A typed model is only as
   good as the state it is handed. This is the highest-leverage code in the repo.
4. **Repro or it didn't happen.** A finding a dev cannot reproduce in one click gets
   ignored, and a tool whose findings get ignored dies. Seeded deterministic replay
   is a day-one requirement, not a polish item.

## Build order

0. Skeleton, types, toolchain.                                    [stack locked]
1. **Reference game** - headless, seeded, deterministic, with *planted* bugs.
   Built first because without a system-under-test nothing else can be validated.
2. System One client interface + `mock` backend (deterministic, offline).
3. Tier 0 oracles.
4. Agent play loop + escalation gate.
5. Trace recorder + deterministic replay + markdown reports.
6. Calibration harness.
7. Real backends (Laya local, Jev HTTP) behind the same interface.

## Non-goals for tonight

- Judging "fun".
- A browser/OS-level adapter for third-party binaries. The adapter interface is kept
  narrow enough that one can be added, but white-box is where the value is.
- Any real API key usage. Backends are written and unit-tested against fixtures;
  they are not called live.

---

## Build log

- **Stack**: TS on Node 22 native type-stripping, zero runtime deps. No build step.
- **Fixture first**: reference game + 7 planted bugs across all 4 bug classes, 22
  contract tests green. A clean build is provably silent over 1500 random steps,
  which is what makes false-positive rate measurable.
- **Fixture flaw found and fixed**: `potionCrashAtZero` was unreachable (the game
  switches to the gameover screen the instant hp hits 0, and the potion button is
  not rendered there). Replaced with `potionCrashAtFullHp`, an overheal crash that
  a bot actually encounters. Lesson kept: an unreachable planted bug validates
  nothing and silently inflates your miss rate.
- **Fixture widened**: shop expanded to 20 items / 45 elements / 20 interactable,
  so the option-ceiling mitigation is exercised rather than assumed.
