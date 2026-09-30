# Decisions

Every choice below was made without you, per your instruction. Each one lists what
I picked, why, and what it would cost to reverse — so you can overrule any of them
cheaply.

---

## D1. TypeScript on Node 22, zero runtime dependencies

No build step, no bundler, no transpiler: Node 22's native type-stripping runs
`.ts` directly. Dev dependencies are `typescript` (typecheck only) and
`@types/node`.

*Why:* nothing to break unattended, and the whole repo runs from a clean checkout
with one `npm install`. The System One models take JSON, the likely real targets
are JS/TS game runtimes, and the test runner ships with Node.

*Reversing:* trivial. Adding a bundler later changes nothing above the file level.

## D2. Fixture first — a reference game with deliberately planted bugs

I built the system-under-test before any detector, with seven bugs across all four
bug classes you asked for, plus a provably clean build.

*Why:* without a build whose defects are known, "the bot found 4 bugs" is
unfalsifiable, and — more importantly — the **false-positive rate cannot be
measured at all**. False positives turned out to be the dominant risk, and they
are invisible without a clean baseline to test against.

*Reversing:* keep it. It costs nothing and it is the only reason any number in the
README can be trusted.

## D3. The mock model is deliberately wrong, and deliberately mis-calibratable

`MockSystemOne` draws a confidence, then is correct with probability f(confidence).
`good` gives perfect calibration; `overconfident` makes reported confidence exceed
real accuracy.

*Why:* I had no Jev key and no Laya weights. A mock that is always right would make
every downstream test pass while proving nothing. This one lets the escalation gate
and the calibration harness be *measured* against ground truth offline.

*The caveat, stated plainly:* the absorption and accuracy figures are properties of
the architecture under a simulated model, not measurements of Jev or Laya.

*Reversing:* swap the client. The interface is unchanged.

## D4. Default to Laya for the play loop, keep both behind one interface

Both vendors converged on the same wire contract, so `HttpSystemOne` serves both
and the difference is a base URL and an auth header.

*Why I lean Laya for the hot loop:* open weights mean local inference, so no
network round-trip per decision (decisive at tens of decisions per second), no
rate limits on unattended overnight runs, no per-call cost, and the option to
fine-tune on your state schema. Jev's managed API wins if you would rather not host
GPUs, and at $0.042/M input with free output it is genuinely cheap.

*What I did NOT do:* choose based on the published benchmarks. Laya's 83.8% vs
Jev's 67.8% and the 7.8x latency claim are from Laya's own model card. Decide this
with a calibration bake-off on your own state schema — the harness for it is built.

## D5. Report on evidence, not on a single answer

An invariant violation is reported only when it recurs across genuinely different
states AND its violation rate's Wilson lower bound clears the model's measured
error rate.

*Why:* this is the gate that took a clean build from hundreds of false positives to
zero. See [JOURNAL.md](JOURNAL.md) for the three weaker gates that preceded it and
why each failed.

*Tunable:* `confirmations`, `minOpportunities`, `expectedErrorRate` on
`InvariantChecker`. Loosen for recall, tighten for precision. I biased hard toward
precision, because a tool developers stop trusting is worth nothing.

## D6. Balance is instrumented, never judged per-episode

The model's 1–5 `score` is recorded but never acted on alone — the rubric
saturates, so deep floors all read 5 and a real spike hides inside a wall of 5s.
Objective telemetry (turns, health lost, death rate) is aggregated across runs and
compared against the *preceding* floors, and a floor is reported only when two
independent measures agree.

*Why:* difficulty is a distribution, and a single hard fight is not evidence.

*Reversing:* thresholds are parameters on `detectAnomalies`.

## D7. Recovery is on by default

On a blocking defect the run rewinds to a snapshot and bans the edge that led in —
permanently for the exact state, temporarily with exponential backoff for the
screen.

*Why:* without it one softlock costs the entire run (coverage 8 vs 406).

*Why the two-level ban:* a permanent screen-level ban was too blunt and banned
`descend` forever, amputating the game's only progression path. The exact-state ban
keeps the precise known-bad edge closed; the screen-level ban generalises but
expires.

*Reversing:* `recover: false` in `SessionOptions`.

## D8. Exploration is the policy's job, not the model's

15% of decisions go to the least-visited control instead of the model's choice.

*Why:* a policy asked only "what is the progressing move?" answers `descend`
forever, never returns to the menu, and never tests the shop — so the planted
economy bug was literally invisible. The first `shopFree` run came back
byte-identical to the clean run.

*Note:* exploratory steps cost no model call, so this is free in both senses.

*Reversing:* `exploreEpsilon: 0`.

## D9. No git repository

I did not `git init` or commit anything.

*Why:* you did not ask, and committing on someone's behalf is a choice they should
make. Everything is on disk and ready.

*If you want it:* `git init && git add -A && git commit`.

## D10. Added a second, deliberately dissimilar game

After the plan was complete I built a checkout wizard as a second system-under-test
rather than polishing the first.

*Why:* the central claim — that the core is game-agnostic and adding a target is
one registry entry — was completely untested, because everything had been written
against a single RPG. That is the claim the whole project rests on when you point
it at your real game.

*What it cost:* about an hour, and it found six real defects in the core, one of
them a genuine statistical correctness bug that was producing confident false
positives. See [JOURNAL.md](JOURNAL.md).

*Reversing:* delete `src/games/checkout/` and its registry entry. I would not: it
is now the regression test that keeps the core honest, and the next engine-specific
adapter will be written against a core that has been generalised twice rather than
once.

---

## Things I deliberately did NOT do

- **Call any paid API.** No Jev key was used; nothing was billed.
- **Choose a game engine for you.** The question I asked before you left —
  which engine, and do you have source access — is still open, and it determines
  the adapter. Everything above the adapter is engine-agnostic, so this is the one
  decision I could not make on your behalf without risking throwing work away.
- **Build a browser or OS-level adapter.** White-box is where the value is, and a
  black-box vision adapter is a much larger project. The `GameAdapter` interface is
  narrow enough that one can be added without touching the agent, oracles or
  reporting.
- **Judge "fun".** Out of scope and not credibly automatable.
