import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { MockSystemOne } from "../src/core/soc/backends/mock.ts";
import { calibrate, renderReliabilityDiagram } from "../src/core/calibration/harness.ts";
import { aggregate, detectAnomalies, BalanceRecorder } from "../src/core/calibration/balance.ts";
import type { FloorStats } from "../src/core/calibration/balance.ts";
import { RefGameAdapter } from "../src/games/refgame/adapter.ts";
import { NO_BUGS, only } from "../src/games/refgame/bugs.ts";
import { runSession } from "../src/core/agent/session.ts";
import { Tier1Policy } from "../src/core/agent/tier1Policy.ts";
import { OraclePlanner } from "../src/core/agent/planner.ts";
import { makeRefgameTruth, bestControl } from "../src/games/refgame/truth.ts";
import {
  refgameInvariantTruth,
  REFGAME_INVARIANTS,
  REFGAME_BOUNDS,
} from "../src/games/refgame/invariants.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../src/core/oracles/tier0.ts";
import type { BugFlags } from "../src/games/refgame/bugs.ts";

const ORACLES = [...TIER0_ORACLES, makeBoundsOracle(REFGAME_BOUNDS)];
const truthAdapter = { bestControl, invariantHolds: refgameInvariantTruth };

async function collect(cal: "good" | "overconfident", seeds = 4, steps = 500) {
  const samples: Array<{ reported: number; correct: boolean }> = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const client = new MockSystemOne(makeRefgameTruth(), { calibration: cal, seed });
    const policy = new Tier1Policy(client, {
      invariants: REFGAME_INVARIANTS,
      planner: new OraclePlanner(truthAdapter),
    });
    await runSession(new RefGameAdapter(NO_BUGS), policy, { seed, steps, oracles: ORACLES });
    for (const l of client.log) {
      if (l.correct !== null) samples.push({ reported: l.reported, correct: l.correct });
    }
  }
  return samples;
}

describe("calibration harness", () => {
  test("certifies a well-calibrated model", async () => {
    const r = calibrate(await collect("good"));
    assert.ok(r.n > 1000, "need a real sample");
    assert.ok(r.ece < 0.05, "ECE was " + r.ece.toFixed(4));
    assert.equal(r.overconfident, false);
    assert.ok(Math.abs(r.meanConfidence - r.accuracy) < 0.03);
  });

  test("detects an overconfident model - the silent failure mode", async () => {
    // This is the property the whole harness exists for. An overconfident model
    // reports high confidence on wrong answers, escalation stops firing, and
    // nothing anywhere raises an error.
    const r = calibrate(await collect("overconfident"));
    assert.equal(r.overconfident, true, "miscalibration must not pass silently");
    assert.ok(
      r.meanConfidence - r.accuracy > 0.1,
      "gap was " + (r.meanConfidence - r.accuracy).toFixed(3),
    );
    assert.ok(r.ece > 0.1, "ECE was " + r.ece.toFixed(4));
  });

  test("recommends a gate that actually delivers the target accuracy", async () => {
    const samples = await collect("good");
    const r = calibrate(samples, { targetAccuracy: 0.95 });
    assert.notEqual(r.recommendedGate, null, "no usable gate found");
    const kept = samples.filter((s) => s.reported >= r.recommendedGate!);
    const acc = kept.filter((s) => s.correct).length / kept.length;
    assert.ok(acc >= 0.94, "gate " + r.recommendedGate + " delivered only " + acc.toFixed(3));
  });

  test("refuses to recommend a gate when no threshold can reach the target", async () => {
    const r = calibrate(await collect("overconfident"), { targetAccuracy: 0.99 });
    assert.equal(r.recommendedGate, null, "should admit the target is unreachable");
  });

  test("reliability diagram states a verdict a human can act on", async () => {
    const text = renderReliabilityDiagram(calibrate(await collect("overconfident")));
    assert.match(text, /OVERCONFIDENT/);
    assert.match(text, /escalation will under-fire/);
  });

  test("handles an empty sample without throwing", () => {
    const r = calibrate([]);
    assert.equal(r.n, 0);
    assert.equal(r.recommendedGate, null);
  });
});

describe("balance analysis", () => {
  async function study(bugs: BugFlags, seeds = 8, steps = 900) {
    const rec = new BalanceRecorder();
    const scores: Array<{ floor: number; score: number }> = [];
    for (let seed = 1; seed <= seeds; seed++) {
      const client = new MockSystemOne(makeRefgameTruth(), { seed });
      const policy = new Tier1Policy(client, {
        invariants: REFGAME_INVARIANTS,
        planner: new OraclePlanner(truthAdapter),
      });
      await runSession(new RefGameAdapter(bugs), policy, { seed, steps, oracles: ORACLES });
      rec.encounters.push(...policy.balance.encounters);
      scores.push(...policy.difficulty.map((d) => ({ floor: d.floor, score: d.score })));
    }
    return { stats: aggregate(rec.encounters, scores), encounters: rec.encounters };
  }

  test("a well-balanced build reports no anomalies", async () => {
    const { stats } = await study(NO_BUGS);
    const anomalies = detectAnomalies(stats.filter((s) => s.floor <= 12));
    assert.deepEqual(
      anomalies.map((a) => a.floor),
      [],
      "natural difficulty ramp must not be reported as a defect",
    );
  });

  test("finds the planted floor-7 spike", async () => {
    const { stats } = await study(only("difficultySpike"));
    const anomalies = detectAnomalies(stats.filter((s) => s.floor <= 12));
    const seven = anomalies.find((a) => a.floor === 7);
    assert.ok(seven, "expected floor 7, got " + JSON.stringify(anomalies.map((a) => a.floor)));
    assert.ok(seven!.signals.length >= 2, "should be corroborated by independent metrics");
    assert.match(seven!.detail, /health|death/i);
  });

  test("corroboration is what separates the spike from a natural wall", () => {
    // Hand-built curve: floor 5 has a death-rate jump only (a natural wall),
    // floor 8 breaks two measures at once (a real spike).
    const stats: FloorStats[] = [
      { floor: 1, n: 50, meanTurns: 1.0, meanHpLost: 4, deathRate: 0.0, meanScore: 1 },
      { floor: 2, n: 50, meanTurns: 1.1, meanHpLost: 5, deathRate: 0.0, meanScore: 1 },
      { floor: 3, n: 50, meanTurns: 1.2, meanHpLost: 5, deathRate: 0.0, meanScore: 2 },
      { floor: 4, n: 50, meanTurns: 1.3, meanHpLost: 6, deathRate: 0.02, meanScore: 2 },
      { floor: 5, n: 50, meanTurns: 1.4, meanHpLost: 7, deathRate: 0.3, meanScore: 3 },
      { floor: 6, n: 50, meanTurns: 1.5, meanHpLost: 7, deathRate: 0.32, meanScore: 3 },
      { floor: 7, n: 50, meanTurns: 1.5, meanHpLost: 7, deathRate: 0.33, meanScore: 3 },
      { floor: 8, n: 50, meanTurns: 4.0, meanHpLost: 24, deathRate: 0.8, meanScore: 5 },
    ];
    const anomalies = detectAnomalies(stats);
    assert.deepEqual(anomalies.map((a) => a.floor), [8], "only the corroborated floor should report");
  });

  test("ignores floors with too few samples to judge", () => {
    const stats: FloorStats[] = [
      { floor: 1, n: 40, meanTurns: 1, meanHpLost: 5, deathRate: 0, meanScore: 1 },
      { floor: 2, n: 40, meanTurns: 1, meanHpLost: 5, deathRate: 0, meanScore: 1 },
      { floor: 3, n: 1, meanTurns: 90, meanHpLost: 900, deathRate: 1, meanScore: 5 },
    ];
    assert.deepEqual(detectAnomalies(stats), [], "n=1 is not evidence");
  });
});

describe("balance recorder", () => {
  test("classifies won, died and fled outcomes", async () => {
    const rec = new BalanceRecorder();
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(4);
    let prev = a.observe();
    const play = (id: string) => {
      const before = prev;
      a.act({ type: "tap", targetId: id });
      const after = a.observe();
      rec.observe(before, { type: "tap", targetId: id }, after);
      prev = after;
    };
    play("start");
    play("go_dungeon");
    play("descend");
    play("wait" as string);
    for (let i = 0; i < 40; i++) play("attack");
    assert.ok(rec.encounters.length > 0, "should have recorded encounters");
    assert.ok(rec.encounters.every((e) => e.floor >= 2));
    assert.ok(rec.encounters.some((e) => e.result === "won"));
  });
});
