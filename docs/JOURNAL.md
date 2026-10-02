# Build journal

Running notes, including the wrong turns. Kept because the failures carry more
design information than the successes.

---

## The false-positive blowout (and what it actually means)

First end-to-end Tier-1 run, clean build, 800 steps. Expected silence. Got:

    [high/flow/tier1] Health left its legal range (x50)
    [high/flow/tier1] Currency went negative (x21)
    [critical/softlock/tier1] Screen has no exit (x45)

All false. The mechanism is worth stating plainly because it generalises well
beyond this toy:

> **An always-applicable invariant, evaluated by an imperfect model at play speed,
> produces false positives at a rate of `steps x error_rate`.**

At 75% accuracy over 800 steps that is ~200 bogus bug reports. Even at 95%
accuracy, an overnight 10,000-step run yields ~500. No developer opens the
501st report; in fact no developer opens the 6th. This single dynamic is
enough to kill the product, and it is invisible until you measure against a
build you *know* is clean. Hence the fixture-first decision.

Three fixes, in order of importance:

**1. Do not ask a model what plain code can decide.** `currency >= 0` and
`0 <= hp <= maxHp` are arithmetic. They were in the invariant list because they
read like design rules, but a Tier-0 bounds check answers them exactly, for free,
and cannot be wrong. Moved. This is the Tier-0 principle I wrote down and then
immediately violated - the pull toward "the model can just handle it" is strong
and needs an explicit rule to resist.

**2. Require persistence before reporting.** A real defect recurs; a model error
does not.

   A false start here: my first instinct was to re-ask the same question two more
   times and require unanimity. That is wrong for this class of model. Jev and Laya
   are *deterministic* given the same input - re-asking an identical question over
   identical state returns an identical answer, so the "samples" are perfectly
   correlated and unanimity buys nothing at all. Confirmation has to come from
   genuinely new evidence, which means *a later step where the invariant applies
   again*. So: report only after N violations of the same invariant inside a window.
   A real economy bug fails on every purchase; a one-off model error needs to
   misfire N times on the same invariant to survive.

**3. Only ask when relevant.** Tight `applies` gates cut both cost and noise.

The recall cost of persistence is small and the arithmetic is worth writing out:
at 75% per-step accuracy, requiring 3 violations drops per-opportunity detection
to ~0.42, but a genuine bug presents on every opportunity, so over 10 chances
detection is 1 - 0.58^10 = 99.6%. Precision rises sharply, recall barely moves.
That asymmetry is the whole argument for the design.

## The tunnelling policy

The `shopFree` run came back *byte-identical* to the clean run. The shop had never
been visited. A policy asked only "what is the progressing move?" answers
`descend` forever and never re-enters the menu, so every optional system - shop,
purchases, the entire economy - goes untested.

A beta-test bot optimising for progress is optimising for the wrong thing. It
needs explicit exploration pressure, and coverage is the objective, not depth.

## Absorption was 50%, which would be ruinous

Escalating half of all decisions defeats the point. Partly an artefact of the mock
drawing confidence uniformly on [0.5, 1] against a 0.75 gate; real System One
models concentrate confidence much closer to 1. The mock's confidence
distribution is now skewed high so that absorption figures mean something - but
the general lesson stands: **absorption rate must be measured, never assumed**,
because it is the entire cost model.

---

## Getting to zero false positives

Three successive gates, each one added because the previous one was measurably
insufficient on a build known to be clean:

| Gate | Clean-build false positives | Why it was not enough |
|---|---|---|
| none | ~hundreds | every wrong answer became a bug report |
| Tier-0 move + persistence (count >= 2) | 4 | a count cannot separate a defect from noise on an invariant asked hundreds of times |
| + violation *rate* >= 50% | 1 | rate is meaningless when the denominator is 2 |
| + Wilson lower bound > model error rate | **0** | - |

The last gate is the one worth keeping in mind. A raw rate of 2/2 looks like a
100% failure rate and is nearly worthless as evidence; its 95% Wilson lower bound
is ~34%. Requiring the *lower bound* to clear the model's measured error rate
refuses to call a defect until the evidence can carry it, and it is the gate that
took the clean run to silence.

It also closes a loop that was otherwise decorative: the calibration harness
measures the model's real error rate on this workload, and that number is
literally the threshold the reporting gate uses. Calibration stops being a report
nobody reads and becomes load-bearing.

Final state on the reference game, 800 steps, mock at ~87% accuracy:

    clean build         findings: NONE
    shopFree            Purchase did not deduct currency        (tier1, x15)
    settingsSoftlock    Softlock on screen 'settings'           (tier0, x687)
                        Screen has no exit                      (tier1, x617)

The settings case is the nice one: Tier 0 finds it structurally (every control
tried, nothing changed) and Tier 1 finds it semantically (no control on this
screen means "leave"), independently. Two different kinds of evidence for one
defect raises confidence far more than either alone.

## The bug the bot found in its own fixture

Worth recording. A careless `sed` rename earlier in the night matched two sites
instead of one and rewrote the combat death check from `if (hp <= 0)` to
`if (hp >= maxHp)`. The player then died at full health and could never die from
damage, so HP ran negative indefinitely.

All 52 tests still passed - none of them asserted HP bounds. The Tier-0 bounds
oracle caught it on the next run, on a build labelled "clean", and I spent several
minutes assuming the *oracle* was broken before checking the game. It was not.

Two things to take from it. The obvious one: this is exactly the class of
regression the tool is built to find, and it found it unprompted. The less obvious
one: my first instinct on seeing a finding was to distrust the tool. That instinct
is what every user will have on day one, and it is why false positives are fatal
and why every finding ships with a one-click reproduction.

---

## Recovery: the feature I kept citing and had not built

For most of the night I explained bug masking as a known limitation and pointed at
snapshot/restore as the answer without implementing it. Running `--variant all`
made the cost concrete: coverage 8, four defects, because the settings softlock
trapped the bot in the first few hundred steps and everything behind it was
invisible.

Building it took three attempts, and the first two failed in instructive ways.

**Attempt 1 - recover when a blocking finding appears.** Almost no effect.
Findings are *deduplicated*, so the second visit to a known trap reports nothing
new, and the run recovered exactly once before settling back into the trap
permanently. Fix: recover on the *condition* (is this state a known trap?), never
on the arrival of a fresh finding.

**Attempt 2 - ban the (state, action) edge that entered the trap.** Also almost no
effect, for a different reason: a state hash includes every game variable, so the
bot came back with one more gold, hashed differently, and walked through a
numerically different door into the same room. Fix: generalise the ban to
(screen, action).

**Attempt 3 - ban (screen, action) permanently.** This worked, and then broke the
game. Descending to floor 3 hits the infinite-load trap, so "never press Descend in
the dungeon" got banned forever - and Descend is the only progression path in the
game. The bot wandered the menus for the rest of the run, and absorption fell to
13% because it kept asking questions with no good answer available.

**What shipped** is two-level: the exact (state, action) edge is banned
permanently, because that edge is genuinely known-bad; the generalised
(screen, action) ban is temporary with exponential backoff, so a core mechanic is
suppressed rather than amputated.

Result: coverage 8 -> 406, four defects -> ten, absorption back to 81%.

The pattern across all three attempts is the same: each fix was correct about the
problem it addressed and wrong about a constraint it had not met yet, and only
running it revealed which. None of the three failures would have shown up in a
design review.

## Final state

    variant               defects                        balance
    clean                 0                              0      <- silence
    all                   10 (6 critical)                0
    shopFree              1  (tier1 only)                0
    settingsSoftlock      3  (tier0 + tier1)             0
    potionCrashAtFullHp   1  critical                    0
    infiniteLoad          1  critical                    0
    textOverflow          1                              0
    difficultySpike       0                              1      <- correctly a
    memLeak               2  (leak + fps)                0         design signal,
                                                                   not a defect

127 tests. The detection matrix above is itself a test, so a regression in any tier
fails the build rather than quietly degrading the reports.

## What I would tell someone starting this again

1. **Build the clean baseline before any detector.** Not the buggy fixture - the
   *clean* one. Precision is the hard property and it is unmeasurable without it.
2. **Every threshold should come from a measurement.** Three of the numbers in this
   repo started as taste and were wrong: a heap-leak ratio that stopped firing as
   the leak grew, a balance threshold that missed a real spike by 0.07, and an
   escalation gate that was meaningless until calibration was measured.
3. **Distrust a single confident answer, including your own.** Everything that
   works here works because it requires corroboration: repeated observation, a
   statistical lower bound, or two independent detectors agreeing.

---

## The second game, which was the real test

Everything above was built against one RPG. The central claim - that the core is
game-agnostic and adding a target is one registry entry - was therefore completely
unverified. So I added a deliberately unlike second game: a four-step checkout
wizard with text input, validation states, a linear flow, no combat and no
difficulty curve.

It found **six real defects in the core** within an hour. None of them were
findable with one game.

**1. The agent could not type.** `Tier1Policy` filtered candidate actions to
`type === "tap"`. That worked only because the RPG had nothing but buttons. The bot
could not fill a form, so it never reached payment and never tested anything
downstream of it. Options are now built from actions, not from buttons.

**2. The serializer hid the form.** `controls` filtered to `kind === "button"`, so
text fields were invisible to the model - and an invariant about invalid input had
no way to tell which screen the input even lived on.

**3. Deduplication was hard-coded to per-screen.** A wrong basket total is ONE bug,
but it was reported five times, once per screen that displayed it. Invariants now
declare whether they are screen-scoped or global.

**4. The statistical gate pooled evidence across contexts.** This was the worst
one, and a genuine correctness bug. The evidence window was keyed by invariant id
while the finding was keyed by invariant *and screen*. So violations accumulated on
a screen where the invariant was genuinely violated dragged the measured rate up
everywhere, and one stray answer on a healthy screen then cleared the gate on
borrowed evidence. It produced confident false positives on two screens that were
completely fine. Evidence is now scoped exactly as the finding is.

**5. Exploration had an anti-repetition bias.** Least-visited exploration
systematically avoids doing the same thing twice - and an entire bug class lives
behind repetition: double-submit, stacking, quantity handling. The checkout's
quantity-pricing bug was violated **zero times in 1,500 steps** because the bot
never added the same item twice. A minority of purely uniform picks fixed it.

**6. Recovery checkpointed inside traps.** Snapshots were taken on a fixed step
interval regardless of state, so once the bot was stuck in a payment spinner the
checkpoint ring filled with trapped states and every later rewind landed straight
back in. Recovery fired once and then sat in the spinner for 1,400 steps.

Two planted bugs also turned out to be unreachable and had to be fixed in the
fixture - the double-charge sat behind a screen with no way back, and the quantity
bug needed a quantity of two that the bot had no reason to create. That is the
third and fourth time tonight an "obviously fine" planted bug turned out to be
untriggerable. It is a much easier mistake to make than it looks.

**What I would take from this:** an abstraction validated against one instance is
not validated. The second instance is where the assumptions become visible, and it
is worth reaching for much earlier than feels necessary.

## Honest limitation: masking is real and not fully solved

On the checkout's all-bugs build the bot finds two defects, not five. The payment
step hangs, and payment is on the only path to the review and confirmation steps,
so the bugs behind it are genuinely unreachable. Recovery rewinds and re-routes,
but it cannot route around a blocked step in a linear flow.

This is honest behaviour rather than a detector failure - a human tester would
report the hang and wait for a fix before testing checkout completion - but it does
mean **finding count is a bad quality metric on a badly broken build**, and that a
single blocking defect still costs real coverage. Coverage and screens-reached are
reported next to the findings for exactly this reason.

---

## Browser validation

The DOM adapter was the last thing with an untested claim attached: unit-tested
against a fake DOM, never run against a real one. Fake DOMs are exactly where an
adapter looks correct and isn't — layout, computed visibility and event dispatch
are the parts a stub cannot reproduce.

Closing it turned out to be cheap, because the adapter only ever imports *types*
from the core. Type-stripping therefore yields standalone browser-loadable JS, so
`tsc` emits it directly with no bundler and no dependency. The page then imports
the real compiled adapter rather than a reimplementation, which is the only version
of this test worth running.

All three planted bugs were observable through it with genuine browser layout:

    text overflow   buy-elixir: scrollWidth 320 in a clientWidth 117 box
    economy bug     gold 50 -> 50 while potions 0 -> 1
    softlock        settings offers one control; exercising it changes nothing

Two details worth keeping. The `interactiveSelector` had to be scoped to
`.screen.active [data-testid]` — without it the adapter offers controls on
`display:none` screens, which are invisible to a player and would have produced
nonsense actions. And `canSnapshot` correctly reported false for a live page, so
the session disabled recovery instead of faking a rewind. That guard was added an
hour earlier for exactly this case and it fired on its first real target.

## Running the whole agent in the page

The remaining gap was that the tiers were still Node-side. Closing it needed one
trick: the repo uses `.ts` import specifiers so Node can run sources directly with
no build step, and a browser cannot resolve those. Copying the sources with
specifiers rewritten to `.js` and letting `tsc` emit plain ESM produces a
browser-loadable agent with no bundler and no new dependency.

The result finds every planted bug from inside the page:

    [critical/flow/tier1]     Purchase did not deduct currency     repro: 15 actions
    [critical/softlock/tier1] Screen has no exit                   repro: 106 actions
    [critical/softlock/tier0] Softlock on screen 'settings'        repro: 110 actions
    [low/ui/tier0]            Text overflows its box: buy-elixir   repro: 1 action

Two things worth recording.

First, the run initially found only three of them. The economy bug was invisible
because the demo's scripted player always *left* the shop rather than buying, so
the purchase invariant had no opportunities at all. This is the third distinct time
tonight that a real bug was undetectable purely because the policy never created
the conditions for it - after the RPG's tunnelling policy and the checkout's
quantity bug. **The recurring failure is not detection, it is reachability**, and
it is far easier to miss than a broken detector because nothing looks wrong: the
run completes, the report is clean, and the bug is simply never exercised.

Second, the `canSnapshot` guard added an hour earlier fired correctly on its first
real target: a live page cannot be snapshotted, so the session disabled recovery
instead of faking a rewind.


## Real model in the loop (Phase 4)

Replaced `MockSystemOne` with real Laya 0.3.23 on the GPU and pointed the whole tier
stack at a new headless match-3 fixture. Result: **5/5 planted bugs found, clean build
silent, tier-1 absorption 97-100%**. Full write-up in `PHASE4-MODEL.md`.

The headline is not the score, it is how much had to be wrong first. Two findings
account for almost all of it:

- **The model cannot read JSON.** Same model, same questions, same facts: JSON state
  scored 0.652 accuracy and missed 6 of 8 bugs; prose scored 0.957 and missed 1. One
  question came back at exactly p=0.500 with the answer sitting in the blob as
  `producedChange: true`. Prose is also faster, being fewer tokens.
- **Choice confidence was on the wrong scale.** `probabilities[chosen]` depends on the
  option count, so on a 12-option screen a confident pick scores ~0.25 and a 0.75 gate
  is unreachable. The first real run absorbed **0%** of decisions. Switching to
  `top/(top+second)` -- scale-free, and commensurable with a noul's `max(p,1-p)` --
  took absorption to 97%.

Both were invisible while the mock answered from ground truth instead of reading state.
That is the lesson about the mock: it validates a pipeline and tells you nothing about
whether a model can do the job.

Three smaller things worth keeping:

- Defect-positive phrasing matters (6 of 8 missed -> 1 of 8), and such a question must
  ASK rather than assert its premise, or a yes-biased model just agrees with it.
- The `applies` predicate is the denominator. A real bug firing 15 times in 237
  opportunities is a 6% violation rate that the Wilson gate correctly refuses to
  report. Narrowing the gate, not loosening the threshold, is the fix.
- Arithmetic belongs in Tier 0. The file said so already; I wrote three invariants that
  asked the model to compare two numbers and each produced a false positive on a clean
  build with the answer in the prose in front of it.

The agent also turned out not to be playing the game at all: `match3BestControl`
matched `shuffle` before anything else, and `shuffle_board` is on every board screen,
so it pressed Shuffle 200 times a run and never swapped a candy. Absorption stayed at
90%, the clean build stayed silent, and one bug was still "detected" -- because the bot
was stuck on the inert control. Nothing in the output looked wrong.

Pointing the real model at the system also found a missing Pause control in our own
fixture: asked whether the player could leave the board, it said no on every variant
including clean, and it was right.
