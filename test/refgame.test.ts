import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RefGame } from "../src/games/refgame/game.ts";
import { RefGameAdapter } from "../src/games/refgame/adapter.ts";
import { NO_BUGS, ALL_BUGS, only } from "../src/games/refgame/bugs.ts";
import { CoverageFuzzPolicy } from "../src/core/agent/randomPolicy.ts";

/**
 * Fixture contract tests.
 *
 * Each planted bug must be (a) reachable and observable when its flag is on, and
 * (b) absent when it is off. Detectors are validated against these; if the fixture
 * itself is wrong, every downstream accuracy number is meaningless.
 */

function atMenu(bugs = NO_BUGS) {
  const g = new RefGame(bugs);
  g.reset(1);
  g.tap("start");
  return g;
}

describe("determinism", () => {
  test("same seed produces identical trajectories", () => {
    const run = (seed: number) => {
      const a = new RefGameAdapter(NO_BUGS);
      a.reset(seed);
      const hashes: string[] = [];
      for (let i = 0; i < 200; i++) {
        const acts = a.availableActions();
        // Deterministic policy: always take the first legal action.
        a.act(acts[0]!);
        const st = a.observe();
        hashes.push(st.screen + JSON.stringify(st.vars));
      }
      return hashes.join("|");
    };
    assert.equal(run(7), run(7));
  });

  test("different seeds diverge", () => {
    // Compares whole trajectories rather than a single end-state variable: after
    // the rebalance, clearing a floor restores health, so two seeds can easily
    // finish a short fight at identical HP while having taken different paths.
    const trajectory = (seed: number) => {
      const g = new RefGame(NO_BUGS);
      g.reset(seed);
      g.tap("start");
      const trace: string[] = [];
      for (let i = 0; i < 60; i++) {
        g.tap("go_dungeon");
        g.tap("descend");
        g.tick();
        g.tick();
        for (let k = 0; k < 4; k++) g.tap("attack");
        trace.push(g.s.screen + ":" + g.s.hp + ":" + g.s.enemyHp + ":" + g.s.gold);
      }
      return trace.join("|");
    };
    assert.notEqual(trajectory(1), trajectory(2), "seeds should produce different rolls");
    assert.equal(trajectory(1), trajectory(1), "and the same seed must reproduce exactly");
  });

  test("snapshot/restore round-trips exactly", () => {
    const g = atMenu();
    g.tap("go_dungeon");
    const snap = g.snapshot();
    const before = JSON.stringify(g.s);
    g.tap("descend");
    g.tick();
    g.tick();
    g.tap("attack");
    assert.notEqual(JSON.stringify(g.s), before);
    g.restore(snap);
    assert.equal(JSON.stringify(g.s), before);
  });
});

describe("planted bug: shopFree (flow)", () => {
  test("clean build deducts gold on purchase", () => {
    const g = atMenu(NO_BUGS);
    g.tap("go_shop");
    const before = g.s.gold;
    g.tap("buy_bread"); // costs 5
    assert.equal(g.s.gold, before - 5);
    assert.equal(g.s.potions, 2);
  });

  test("buggy build does not deduct gold", () => {
    const g = atMenu(only("shopFree"));
    g.tap("go_shop");
    const before = g.s.gold;
    g.tap("buy_bread");
    assert.equal(g.s.gold, before, "bug: gold unchanged after purchase");
    assert.equal(g.s.potions, 2, "item still granted");
  });
});

describe("planted bug: settingsSoftlock", () => {
  test("clean build always renders Back in settings", () => {
    const g = atMenu(NO_BUGS);
    g.tap("go_dungeon");
    g.tap("go_settings");
    const ids = g.elements().map((e) => e.id);
    assert.ok(ids.includes("back"), "Back should exist");
  });

  test("buggy build strips Back when settings entered from dungeon", () => {
    const g = atMenu(only("settingsSoftlock"));
    g.tap("go_dungeon");
    g.tap("go_settings");
    const ids = g.elements().map((e) => e.id);
    assert.ok(!ids.includes("back"), "bug: no way out of settings");
    // And it is a genuine trap: no sequence of taps changes the screen.
    for (const id of g.interactableIds()) g.tap(id);
    assert.equal(g.s.screen, "settings");
  });

  test("buggy build is fine when settings entered from menu", () => {
    const g = atMenu(only("settingsSoftlock"));
    g.tap("go_settings");
    assert.ok(g.elements().some((e) => e.id === "back"));
  });
});

describe("planted bug: potionCrashAtFullHp (crash)", () => {
  test("clean build heals without throwing", () => {
    const g = atMenu(NO_BUGS);
    assert.equal(g.s.hp, g.s.maxHp);
    assert.doesNotThrow(() => g.tap("use_potion"));
  });

  test("buggy build throws at full hp", () => {
    const g = atMenu(only("potionCrashAtFullHp"));
    assert.throws(() => g.tap("use_potion"), /Cannot read properties of null/);
  });

  test("adapter converts the crash into an observable error, not a run abort", () => {
    const a = new RefGameAdapter(only("potionCrashAtFullHp"));
    a.reset(1);
    a.act({ type: "tap", targetId: "start" });
    a.act({ type: "tap", targetId: "use_potion" });
    const st = a.observe();
    assert.ok(
      st.errors.some((e) => e.includes("UNCAUGHT")),
      "crash should surface as an error on the observation",
    );
    // The run survives and can keep exploring.
    assert.doesNotThrow(() => a.act({ type: "tap", targetId: "go_shop" }));
  });
});

describe("planted bug: infiniteLoad (softlock)", () => {
  test("clean build finishes loading", () => {
    const g = atMenu(NO_BUGS);
    g.s.floor = 2;
    g.tap("go_dungeon");
    g.tap("descend");
    assert.ok(g.s.loadingFrames > 0);
    g.tick();
    g.tick();
    assert.equal(g.s.loadingFrames, 0);
  });

  test("buggy build never finishes loading floor 3", () => {
    const g = atMenu(only("infiniteLoad"));
    g.s.floor = 2;
    g.tap("go_dungeon");
    g.tap("descend");
    assert.equal(g.s.floor, 3);
    for (let i = 0; i < 500; i++) g.tick();
    assert.equal(g.s.loadingFrames, Infinity, "bug: stuck loading forever");
  });
});

describe("planted bug: difficultySpike (balance)", () => {
  test("enemy hp scales smoothly in a clean build", () => {
    const hp: number[] = [];
    for (let floor = 5; floor <= 8; floor++) {
      const g = atMenu(NO_BUGS);
      g.s.floor = floor - 1;
      g.tap("go_dungeon");
      g.tap("descend");
      hp.push(g.s.enemyMaxHp);
    }
    for (let i = 1; i < hp.length; i++) {
      const ratio = hp[i]! / hp[i - 1]!;
      assert.ok(ratio < 1.5, "floor " + (i + 5) + " ratio " + ratio + " should be gradual");
    }
  });

  test("buggy build spikes 10x at floor 7", () => {
    const g = atMenu(only("difficultySpike"));
    g.s.floor = 6;
    g.tap("go_dungeon");
    g.tap("descend");
    assert.equal(g.s.floor, 7);
    assert.equal(g.s.enemyMaxHp, (10 + 7 * 4) * 10);
  });
});

describe("planted bug: textOverflow (ui)", () => {
  test("clean build keeps captions inside their boxes", () => {
    const g = atMenu(NO_BUGS);
    g.tap("go_shop");
    for (const e of g.elements()) {
      assert.ok(e.textWidth <= e.bbox.w, e.id + " overflows: " + e.textWidth + " > " + e.bbox.w);
    }
  });

  test("buggy build overflows exactly one caption", () => {
    const g = atMenu(only("textOverflow"));
    g.tap("go_shop");
    const over = g.elements().filter((e) => e.textWidth > e.bbox.w);
    assert.equal(over.length, 1);
    assert.equal(over[0]!.id, "buy_elixir");
  });
});

describe("planted bug: memLeak (perf)", () => {
  test("clean build heap stays flat and fps holds", () => {
    const g = atMenu(NO_BUGS);
    for (let i = 0; i < 300; i++) g.tick();
    assert.ok(g.heapMB() < 50, "heap " + g.heapMB());
    assert.equal(g.fps(), 60);
  });

  test("buggy build heap grows superlinearly and drags fps down", () => {
    const g = atMenu(only("memLeak"));
    for (let i = 0; i < 300; i++) g.tick();
    assert.ok(g.heapMB() > 130, "heap " + g.heapMB());
    assert.ok(g.fps() < 30, "fps " + g.fps());
  });
});

describe("fixture sanity", () => {
  test("clean build produces no errors over a long random walk", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(3);
    let rng = 3;
    const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff), rng / 0x7fffffff);
    const seen: string[] = [];
    for (let i = 0; i < 1500; i++) {
      const acts = a.availableActions();
      a.act(acts[Math.floor(rand() * acts.length)]!);
      seen.push(...a.observe().errors);
    }
    assert.deepEqual(seen, [], "a clean build must be silent - otherwise false positives");
  });

  test("shop exceeds the safe option ceiling, so shortlisting is exercised", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(1);
    a.act({ type: "tap", targetId: "start" });
    a.act({ type: "tap", targetId: "go_shop" });
    assert.ok(a.availableActions().length > 15, "need >15 candidates to stress the router");
  });

  test("ALL_BUGS still boots", () => {
    const a = new RefGameAdapter(ALL_BUGS);
    a.reset(1);
    assert.equal(a.observe().screen, "title");
  });
});

describe("fixture invariants the oracles rely on", () => {
  // Added after a careless rename broke the combat death check
  // (`if (hp <= 0)` became `if (hp >= maxHp)`), letting HP run negative forever on
  // a build labelled "clean". The bounds oracle caught it; these tests make sure a
  // human does too, and much earlier.
  test("HP never leaves [0, maxHp] on a clean build", async () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(5);
    const p = new CoverageFuzzPolicy(5);
    for (let i = 0; i < 3000; i++) {
      const st = a.observe();
      const hp = Number(st.vars.hp);
      const max = Number(st.vars.maxHp);
      assert.ok(hp >= 0 && hp <= max, "step " + st.step + ": hp=" + hp + " max=" + max);
      a.act(p.next(st, a.availableActions()));
    }
  });

  test("gold and potions never go negative on a clean build", async () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(11);
    const p = new CoverageFuzzPolicy(11);
    for (let i = 0; i < 3000; i++) {
      const st = a.observe();
      assert.ok(Number(st.vars.gold) >= 0, "gold " + st.vars.gold);
      assert.ok(Number(st.vars.potions) >= 0, "potions " + st.vars.potions);
      a.act(p.next(st, a.availableActions()));
    }
  });

  test("the player can actually die - the loss condition is reachable", () => {
    const g = new RefGame(NO_BUGS);
    g.reset(3);
    g.tap("start");
    g.tap("go_dungeon");
    g.s.floor = 20; // deep enough that enemy damage outpaces the player
    g.tap("descend");
    g.tick();
    g.tick();
    for (let i = 0; i < 400 && g.s.screen === "combat"; i++) g.tap("attack");
    assert.equal(g.s.hp, 0);
    assert.ok(g.s.dead, "player should be able to lose");
  });
});
