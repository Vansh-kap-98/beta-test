import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RefGameAdapter } from "../src/games/refgame/adapter.ts";
import type { BugFlags } from "../src/games/refgame/bugs.ts";
import { NO_BUGS, only } from "../src/games/refgame/bugs.ts";
import { runSession } from "../src/core/agent/session.ts";
import { Tier1Policy } from "../src/core/agent/tier1Policy.ts";
import { OraclePlanner, LlmPlanner } from "../src/core/agent/planner.ts";
import { MockSystemOne } from "../src/core/soc/backends/mock.ts";
import { makeRefgameTruth, bestControl, resolveGroup } from "../src/games/refgame/truth.ts";
import {
  refgameInvariantTruth,
  REFGAME_INVARIANTS,
  REFGAME_BOUNDS,
} from "../src/games/refgame/invariants.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../src/core/oracles/tier0.ts";
import { hierarchicalChoice, shortlist } from "../src/core/soc/router.ts";
import { MAX_SAFE_OPTIONS } from "../src/core/soc/types.ts";
import { serialize } from "../src/core/soc/serialize.ts";
import { wilsonLowerBound, InvariantChecker } from "../src/core/oracles/invariants.ts";

const ORACLES = [...TIER0_ORACLES, makeBoundsOracle(REFGAME_BOUNDS)];

/** A realistic serialized state, so router tests exercise the real shape. */
function socState(screen: string, controls: string[]) {
  return {
    screen,
    loading: false,
    vars: { gold: 100, hp: 50, maxHp: 50, potions: 1, floor: 1, enemyHp: 0, dead: false },
    deltas: {},
    changed: [],
    lastAction: "none",
    controls: controls.map((id) => ({ id, text: id, enabled: true })),
    recentScreens: [screen],
    errorCount: 0,
  };
}
const truthAdapter = { bestControl, invariantHolds: refgameInvariantTruth };

function makePolicy(seed: number, calibration: "good" | "overconfident" = "good") {
  const client = new MockSystemOne(makeRefgameTruth(), { calibration, seed });
  const policy = new Tier1Policy(client, {
    invariants: REFGAME_INVARIANTS,
    planner: new OraclePlanner(truthAdapter),
  });
  return { client, policy };
}

async function run(bugs: BugFlags, seed = 5, steps = 800) {
  const { client, policy } = makePolicy(seed);
  const r = await runSession(new RefGameAdapter(bugs), policy, { seed, steps, oracles: ORACLES });
  return { r, policy, client };
}

describe("soc router: the option ceiling", () => {
  test("shortlist never exceeds the safe budget", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(1);
    a.act({ type: "tap", targetId: "start" });
    a.act({ type: "tap", targetId: "go_shop" });
    const els = a.observe().elements;
    assert.ok(els.filter((e) => e.kind === "button" && e.enabled).length > MAX_SAFE_OPTIONS);
    assert.ok(shortlist(els).length <= MAX_SAFE_OPTIONS);
  });

  test("shortlist drops invisible and disabled controls before the model sees them", () => {
    const els = [
      { id: "a", kind: "button" as const, visible: true, enabled: true, bbox: { x: 0, y: 0, w: 1, h: 1 } },
      { id: "b", kind: "button" as const, visible: false, enabled: true, bbox: { x: 0, y: 1, w: 1, h: 1 } },
      { id: "c", kind: "button" as const, visible: true, enabled: false, bbox: { x: 0, y: 2, w: 1, h: 1 } },
      { id: "d", kind: "label" as const, visible: true, enabled: true, bbox: { x: 0, y: 3, w: 1, h: 1 } },
    ];
    assert.deepEqual(shortlist(els).map((e) => e.id), ["a"]);
  });

  test("hierarchical choice narrows a 20-option list in more than one pass", async () => {
    const client = new MockSystemOne(makeRefgameTruth(), { seed: 2 });
    const options = Array.from({ length: 20 }, (_, i) => "buy_item" + String(i).padStart(2, "0"));
    const res = await hierarchicalChoice(client, socState("shop", options), "pick one", options);
    assert.ok(res.trace.calls >= 2, "should narrow, not ask all 20 at once");
    assert.ok(options.includes(res.value), "must return a real option");
  });

  test("a short list is asked directly, with no narrowing overhead", async () => {
    const client = new MockSystemOne(makeRefgameTruth(), { seed: 2 });
    const res = await hierarchicalChoice(client, socState("menu", ["a", "b", "c"]), "pick", ["a", "b", "c"]);
    assert.equal(res.trace.calls, 1);
  });

  test("positional group labels describe a decidable range", () => {
    // The router sorts before chunking so that "a..m" is a real range. Without
    // that, membership is undecidable and the narrowing step is a coin flip.
    const labels = ["buy_apple..buy_honey", "buy_jerky..buy_wine"];
    assert.equal(resolveGroup("buy_bread", labels), "buy_apple..buy_honey");
    assert.equal(resolveGroup("buy_tonic", labels), "buy_jerky..buy_wine");
  });
});

describe("soc serialization", () => {
  test("precomputes deltas so a two-state question becomes a lookup", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(1);
    a.act({ type: "tap", targetId: "start" });
    const before = a.observe();
    a.act({ type: "tap", targetId: "go_shop" });
    const mid = a.observe();
    a.act({ type: "tap", targetId: "buy_bread" });
    const after = a.observe();
    const soc = serialize(after, mid, { type: "tap", targetId: "buy_bread" });
    assert.equal(soc.deltas["gold"], -5, "the model should not have to do arithmetic");
    assert.equal(soc.deltas["potions"], 1);
    assert.equal(soc.lastAction, "tap buy_bread");
    assert.ok(before.step < after.step);
  });

  test("omits geometry, which is a tier-0 concern and wastes option budget", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(1);
    const soc = serialize(a.observe(), undefined, null);
    assert.equal(JSON.stringify(soc).includes("bbox"), false);
  });
});

describe("wilson lower bound", () => {
  test("refuses to trust a perfect but tiny sample", () => {
    // 2/2 looks like a 100% failure rate; its lower bound says otherwise.
    assert.ok(wilsonLowerBound(2, 2) < 0.4, "2/2 should not be conclusive");
    assert.ok(wilsonLowerBound(12, 12) > 0.7, "12/12 should be");
  });

  test("is monotonic in sample size at a fixed rate", () => {
    assert.ok(wilsonLowerBound(5, 10) < wilsonLowerBound(50, 100));
  });
});

describe("tier1 end-to-end", () => {
  test("clean build produces no findings at all", async () => {
    const { r } = await run(NO_BUGS);
    assert.deepEqual(
      r.findings.map((f) => f.title),
      [],
      "tier1 false positives are the failure mode that kills the product",
    );
  });

  test("clean build stays silent across several seeds", async () => {
    for (const seed of [1, 3, 7, 11]) {
      const { r } = await run(NO_BUGS, seed, 600);
      assert.equal(r.findings.length, 0, "seed " + seed + ": " + JSON.stringify(r.findings.map((f) => f.title)));
    }
  });

  test("detects the economy bug that tier0 provably cannot see", async () => {
    const { r } = await run(only("shopFree"));
    const f = r.findings.find((x) => x.title.includes("Purchase did not deduct"));
    assert.ok(f, "expected the free-shop bug: " + JSON.stringify(r.findings.map((x) => x.title)));
    assert.notEqual(f!.source, "tier0", "tier0 cannot know a purchase should cost something");
    assert.equal(f!.bugClass, "flow");
  });

  test("tier0 and tier1 reach the softlock independently", async () => {
    const { r } = await run(only("settingsSoftlock"));
    const structural = r.findings.find((f) => f.source === "tier0" && f.bugClass === "softlock");
    const semantic = r.findings.find((f) => f.source === "tier1" && f.title.includes("no exit"));
    assert.ok(structural, "tier0 should find it by exhausting controls");
    assert.ok(semantic, "tier1 should find it by understanding the controls' meaning");
  });

  test("exploration reaches optional content the progress policy skips", async () => {
    const { r } = await run(NO_BUGS, 5, 800);
    assert.ok(
      r.screensVisited.includes("shop"),
      "without exploration pressure the bot tunnels into the dungeon and never tests the economy",
    );
  });

  test("most decisions are absorbed without waking tier 2", async () => {
    const { policy } = await run(NO_BUGS);
    const s = policy.stats;
    const absorption = s.absorbed / s.decisions;
    assert.ok(absorption > 0.7, "absorption was " + absorption.toFixed(3) + " - tier 2 cost dominates below this");
  });

  test("forced moves and exploration never cost a model call", async () => {
    const { policy } = await run(NO_BUGS);
    assert.ok(policy.stats.freeSteps > 0);
    assert.equal(policy.stats.steps, policy.stats.freeSteps + policy.stats.decisions);
  });

  test("the whole invariant suite rides in ONE call, whatever its size", async () => {
    // Tested directly rather than through the policy: this is the single property
    // the economics rest on. If the suite were asked one invariant at a time, cost
    // would scale with the number of assertions and continuous checking would be
    // unaffordable.
    const client = new MockSystemOne(makeRefgameTruth(), { seed: 1 });
    const checker = new InvariantChecker(client, REFGAME_INVARIANTS);
    const state = {
      ...socState("shop", ["back"]),
      lastAction: "tap buy_bread",
      deltas: { gold: -5, potions: 1 },
    };
    const callsBefore = client.stats.calls;
    const res = await checker.check(state as any, { step: 1, seed: 1, actionLog: [] });
    assert.ok(res.asked >= 2, "several invariants should apply here, got " + res.asked);
    assert.equal(client.stats.calls - callsBefore, 1, "but they must cost exactly one call");
    assert.equal(client.stats.questions, res.asked, "all of them evaluated in that one pass");
  });
});

describe("tier2 planner", () => {
  test("LlmPlanner parses a JSON reply and refuses options that were not offered", async () => {
    const planner = new LlmPlanner(async () =>
      'sure! {"action": "not_an_option", "rationale": "nope"}',
    );
    const decision = await planner.chooseAction(
      socState("menu", ["go_shop", "go_dungeon"]) as any,
      ["go_shop", "go_dungeon"],
      "test",
    );
    assert.ok(["go_shop", "go_dungeon"].includes(decision.action));
  });

  test("LlmPlanner survives an unparseable reply", async () => {
    const planner = new LlmPlanner(async () => "I'm afraid I can't do that");
    const d = await planner.chooseAction(socState("menu", ["a"]) as any, ["a"], "test");
    assert.equal(d.action, "a");
  });
});
