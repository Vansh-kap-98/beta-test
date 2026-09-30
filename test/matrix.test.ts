import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { getGame } from "../src/games/registry.ts";
import { runSession } from "../src/core/agent/session.ts";
import { Tier1Policy } from "../src/core/agent/tier1Policy.ts";
import { OraclePlanner } from "../src/core/agent/planner.ts";
import { MockSystemOne } from "../src/core/soc/backends/mock.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../src/core/oracles/tier0.ts";
import { aggregate, detectAnomalies } from "../src/core/calibration/balance.ts";
import type { Finding } from "../src/core/types.ts";

/**
 * The headline claim, as an executable assertion.
 *
 * Each planted bug must produce its own signature and nothing else, and a clean
 * build must produce silence. This is the test that would catch a regression in
 * any tier at once: a detector that stops firing, a gate that starts leaking false
 * positives, or a change that makes one bug mask another.
 */

const game = getGame("refgame");
const ORACLES = [...TIER0_ORACLES, makeBoundsOracle(game.bounds)];

async function sweep(variant: string, seeds = 4, steps = 1000) {
  const findings = new Map<string, Finding>();
  const encounters = [];
  const scores: Array<{ floor: number; score: number }> = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const client = new MockSystemOne(game.mockTruth!(), { seed });
    const policy = new Tier1Policy(client, {
      invariants: game.invariants,
      planner: new OraclePlanner(game.plannerTruth!),
    });
    const r = await runSession(game.makeAdapter(variant), policy, { seed, steps, oracles: ORACLES });
    for (const f of r.findings) if (!findings.has(f.dedupeKey)) findings.set(f.dedupeKey, f);
    encounters.push(...policy.balance.encounters);
    scores.push(...policy.difficulty.map((d) => ({ floor: d.floor, score: d.score })));
  }
  const anomalies = detectAnomalies(aggregate(encounters, scores));
  return { findings: [...findings.values()], anomalies };
}

const titles = (fs: Finding[]) => fs.map((f) => f.title).sort();

describe("detection matrix", () => {
  test("clean build: complete silence", async () => {
    const { findings, anomalies } = await sweep("clean");
    assert.deepEqual(titles(findings), [], "no defects");
    assert.deepEqual(anomalies, [], "no balance anomalies");
  });

  test("potionCrashAtFullHp -> exactly one critical crash", async () => {
    const { findings } = await sweep("potionCrashAtFullHp");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.bugClass, "crash");
    assert.equal(findings[0]!.severity, "critical");
  });

  test("infiniteLoad -> a stuck-loading softlock", async () => {
    const { findings } = await sweep("infiniteLoad");
    assert.ok(findings.some((f) => f.title.startsWith("Stuck loading")));
    assert.ok(findings.every((f) => f.bugClass === "softlock"));
  });

  test("settingsSoftlock -> found structurally AND semantically", async () => {
    const { findings } = await sweep("settingsSoftlock");
    assert.ok(
      findings.some((f) => f.source === "tier0" && f.bugClass === "softlock"),
      "tier0 should exhaust the controls",
    );
    assert.ok(
      findings.some((f) => f.source === "tier1" && f.title.includes("no exit")),
      "tier1 should understand the controls have no exit",
    );
  });

  test("textOverflow -> exactly one low-severity ui defect", async () => {
    const { findings } = await sweep("textOverflow");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.bugClass, "ui");
    assert.match(findings[0]!.title, /buy_elixir/);
  });

  test("memLeak -> the leak, and the fps collapse it causes", async () => {
    const { findings } = await sweep("memLeak");
    assert.ok(findings.some((f) => f.title.includes("MB/step")));
    assert.ok(findings.some((f) => f.title.includes("Frame rate")));
    assert.ok(findings.every((f) => f.bugClass === "perf"));
  });

  test("shopFree -> one flow defect, found by a model tier", async () => {
    const { findings } = await sweep("shopFree");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.bugClass, "flow");
    // Either tier-1 directly or tier-2 on escalation; what matters is that it is
    // NOT tier-0, which has no way to know a purchase ought to cost something.
    assert.notEqual(
      findings[0]!.source,
      "tier0",
      "tier0 cannot reason about what a purchase means",
    );
  });

  test("difficultySpike -> a balance anomaly, NOT a defect", async () => {
    // The distinction matters. A hard floor is not a bug report; it is a design
    // signal, and it is only credible in aggregate across runs.
    const { findings, anomalies } = await sweep("difficultySpike", 8);
    assert.deepEqual(titles(findings), [], "should not be reported as a defect");
    assert.ok(anomalies.some((a) => a.floor === 7), "should surface as a balance anomaly");
  });

  test("all bugs at once -> every class represented, and coverage survives", async () => {
    const { findings } = await sweep("all", 6, 1500);
    const classes = new Set(findings.map((f) => f.bugClass));
    for (const expected of ["crash", "softlock", "ui", "perf"]) {
      assert.ok(classes.has(expected as never), "missing " + expected + " in " + [...classes]);
    }
    assert.ok(findings.length >= 6, "found only " + findings.length + " with seven bugs planted");
  });
});

/**
 * The same matrix for the second game.
 *
 * This exists to keep the core honest about being game-agnostic. The checkout flow
 * has text input, validation states, a linear path, no combat and no difficulty
 * curve - adding it exposed six real defects in the core that the RPG alone could
 * never have revealed (see docs/JOURNAL.md).
 */
const checkout = getGame("checkout");
const CO_ORACLES = [...TIER0_ORACLES, makeBoundsOracle(checkout.bounds)];

async function sweepCheckout(variant: string, seeds = 6, steps = 1200) {
  const findings = new Map<string, Finding>();
  for (let seed = 1; seed <= seeds; seed++) {
    const client = new MockSystemOne(checkout.mockTruth!(), { seed });
    const policy = new Tier1Policy(client, {
      invariants: checkout.invariants,
      planner: new OraclePlanner(checkout.plannerTruth!),
    });
    const r = await runSession(checkout.makeAdapter(variant), policy, {
      seed,
      steps,
      oracles: CO_ORACLES,
    });
    for (const f of r.findings) if (!findings.has(f.dedupeKey)) findings.set(f.dedupeKey, f);
  }
  return [...findings.values()];
}

describe("detection matrix: second game (checkout)", () => {
  test("clean build: complete silence", async () => {
    assert.deepEqual(titles(await sweepCheckout("clean")), []);
  });

  test("clean build stays silent with a larger budget too", async () => {
    assert.deepEqual(titles(await sweepCheckout("clean", 8, 2000)), []);
  });

  test("totalIgnoresQuantity -> one critical pricing defect", async () => {
    const f = await sweepCheckout("totalIgnoresQuantity", 8);
    assert.equal(f.length, 1, JSON.stringify(titles(f)));
    assert.equal(f[0]!.severity, "critical");
    assert.match(f[0]!.title, /total/i);
  });

  test("backLosesData -> data loss reported once, not once per screen", async () => {
    const f = await sweepCheckout("backLosesData");
    assert.equal(f.length, 1, "a global property must not report per screen: " + JSON.stringify(titles(f)));
    assert.match(f[0]!.title, /back/i);
  });

  test("validationBypass -> validation defect", async () => {
    const f = await sweepCheckout("validationBypass");
    assert.ok(f.some((x) => /validation/i.test(x.title)), JSON.stringify(titles(f)));
  });

  test("doubleCharge -> caught by BOTH a bounds check and an invariant", async () => {
    // Tier 0 knows an order count above one is impossible; Tier 1 knows the
    // customer was charged more than they agreed to. Different evidence, same bug.
    const f = await sweepCheckout("doubleCharge");
    assert.ok(f.some((x) => x.source === "tier0"), "bounds check: " + JSON.stringify(titles(f)));
    assert.ok(f.some((x) => x.source !== "tier0"), "invariant: " + JSON.stringify(titles(f)));
  });

  test("stuckSpinner -> a stuck-loading softlock and nothing spurious", async () => {
    const f = await sweepCheckout("stuckSpinner");
    assert.ok(f.some((x) => x.title.startsWith("Stuck loading")));
    assert.ok(
      f.every((x) => x.bugClass === "softlock"),
      "a hung payment step must not manufacture unrelated findings: " + JSON.stringify(titles(f)),
    );
  });

  test("form input is exercised at all", async () => {
    // Guards the generalisation that made this game testable: if the policy ever
    // regresses to tap-only, the bot can never fill the form, never reach payment,
    // and this stops being reachable.
    const client = new MockSystemOne(checkout.mockTruth!(), { seed: 1 });
    const policy = new Tier1Policy(client, {
      invariants: checkout.invariants,
      planner: new OraclePlanner(checkout.plannerTruth!),
    });
    const r = await runSession(checkout.makeAdapter("clean"), policy, {
      seed: 1,
      steps: 600,
      oracles: CO_ORACLES,
    });
    assert.ok(
      r.actionLog.some((a) => a.type === "input"),
      "the bot never typed anything",
    );
    assert.ok(
      r.screensVisited.includes("done"),
      "should complete a purchase: " + r.screensVisited.join(", "),
    );
  });
});
