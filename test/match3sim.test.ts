import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Match3Game } from "../src/games/match3sim/game.ts";
import { Match3SimAdapter, swapSig } from "../src/games/match3sim/adapter.ts";

/**
 * These check the FIXTURE, not the agent -- that the ported game behaves and, more
 * importantly, that each planted bug is actually reachable and observable.
 *
 * That second part is the one that matters. An honest audit of the browser fixture
 * found two of its five bugs structurally unreachable by the bot: the score bug was
 * invisible because nothing read the score, and the rejected-swap bug could never
 * fire because the bot only ever offered legal moves. Both scored as "not detected"
 * when they had simply never been exercised, which is a far more flattering result
 * than it deserved. A detection rate is meaningless without this file.
 */

test("a fresh board has no pre-existing matches and some legal moves", () => {
  for (let seed = 1; seed <= 8; seed++) {
    const g = new Match3Game(seed);
    g.dismissTutorial();
    assert.equal(g.findMatches().size, 0, "seed " + seed + " dealt a pre-matched board");
    assert.ok(g.validSwaps().length > 0, "seed " + seed + " dealt a dead board");
  }
});

test("the same seed deals the same board", () => {
  const a = new Match3Game(42);
  const b = new Match3Game(42);
  assert.deepEqual(a.grid, b.grid);
});

test("a valid swap clears tiles and scores; the clean build scores every chain", () => {
  const g = new Match3Game(3);
  g.dismissTutorial();
  const s = g.validSwaps()[0]!;
  const before = g.score;
  const cleared = g.swap(s.a[0], s.a[1], s.b[0], s.b[1]);
  assert.ok(cleared >= 3, "a valid swap should clear at least three tiles");
  assert.ok(g.score > before, "clearing tiles must score");
});

test("scoreCascade: a multi-chain resolve under-counts", () => {
  // Driven until a cascade actually happens, because a chain of 1 cannot show the
  // bug and a test that never produced one would pass against a fixed build.
  let sawChain = 0;
  let cleanTotal = 0;
  let buggyTotal = 0;
  for (let seed = 1; seed <= 60 && sawChain < 3; seed++) {
    const clean = new Match3Game(seed);
    const buggy = new Match3Game(seed, ["scoreCascade"]);
    clean.dismissTutorial();
    buggy.dismissTutorial();
    for (let i = 0; i < 12; i++) {
      const s = clean.validSwaps()[0];
      if (!s) break;
      clean.swap(s.a[0], s.a[1], s.b[0], s.b[1]);
      buggy.swap(s.a[0], s.a[1], s.b[0], s.b[1]);
      if (clean.lastChain > 1) sawChain++;
    }
    cleanTotal += clean.score;
    buggyTotal += buggy.score;
  }
  assert.ok(sawChain > 0, "no cascade ever occurred, so this test proved nothing");
  assert.ok(buggyTotal < cleanTotal,
    "scoreCascade must under-count: buggy " + buggyTotal + " vs clean " + cleanTotal);
});

test("ghostMove: a rejected swap consumes a move only when planted", () => {
  const find = (g: Match3Game) => {
    g.dismissTutorial();
    const valid = new Set(g.validSwaps().map((s) => swapSig(s.a, s.b)));
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 8; x++) {
        if (!valid.has(swapSig([x, y], [x, y + 1]))) return [x, y] as const;
      }
    }
    return null;
  };
  const clean = new Match3Game(5);
  const buggy = new Match3Game(5, ["ghostMove"]);
  const p = find(clean);
  find(buggy);
  assert.ok(p, "no invalid swap existed to test with");
  const [x, y] = p;
  const cm = clean.moves;
  const bm = buggy.moves;
  assert.equal(clean.swap(x, y, x, y + 1), 0, "the swap should have been rejected");
  assert.equal(buggy.swap(x, y, x, y + 1), 0, "the swap should have been rejected");
  assert.equal(clean.moves, cm, "clean build must not consume a move on a rejected swap");
  assert.equal(buggy.moves, bm - 1, "ghostMove must silently consume a move");
});

test("stuckNoShuffle: shuffle reports whether it did anything", () => {
  const clean = new Match3Game(7);
  const buggy = new Match3Game(7, ["stuckNoShuffle"]);
  clean.dismissTutorial();
  buggy.dismissTutorial();
  assert.equal(clean.shuffle(), true);
  assert.equal(buggy.shuffle(), false, "the planted shuffle must be inert");
});

test("winNoAdvance: the win screen traps the player", () => {
  const mk = (bugs: Parameters<typeof Match3Game.prototype.has>[0][]) => {
    const g = new Match3Game(2, bugs as never);
    g.dismissTutorial();
    g.score = g.goal;          // stand on the win condition directly
    g.overlay = "win";
    return g;
  };
  assert.equal(mk([]).nextLevel(), true, "clean build must advance");
  assert.equal(mk(["winNoAdvance"]).nextLevel(), false, "planted build must not");
});

test("tutorialVague: the tutorial stops stating the objective", () => {
  assert.match(new Match3Game(1).tutorialText(), /line of three/);
  assert.doesNotMatch(new Match3Game(1, ["tutorialVague"]).tutorialText(), /line of three/);
});

test("the adapter offers invalid swaps so the error path is reachable", async () => {
  const a = new Match3SimAdapter({ seed: 4, invalidShare: 0.3 });
  await a.act({ type: "tap", targetId: "got_it" });
  const valid = new Set(a.truth.validSwaps().map((s) => swapSig(s.a, s.b)));
  const offered = a.availableActions()
    .map((x) => (x.type === "tap" ? x.targetId : ""))
    .filter((s) => s.startsWith("swap:"));
  const invalid = offered.filter((s) => !valid.has(s));
  assert.ok(offered.length > 0, "no swaps offered at all");
  assert.ok(invalid.length > 0, "every offered swap was legal, so ghostMove is unreachable");
});

test("the adapter reports no change when a control is inert", async () => {
  const a = new Match3SimAdapter({ seed: 9, bugs: ["stuckNoShuffle"], invalidShare: 0 });
  await a.act({ type: "tap", targetId: "got_it" });
  await a.act({ type: "tap", targetId: "shuffle_board" });
  assert.equal(a.observe().vars["producedChange"], false,
    "an inert shuffle must be observable as producing no change");
});

test("snapshot and restore round-trip", async () => {
  const a = new Match3SimAdapter({ seed: 11, invalidShare: 0 });
  await a.act({ type: "tap", targetId: "got_it" });
  const snap = a.snapshot();
  const before = a.observe();
  const s = a.truth.validSwaps()[0]!;
  await a.act({ type: "tap", targetId: swapSig(s.a, s.b) });
  a.restore(snap);
  assert.deepEqual(a.observe().vars["hud_score"], before.vars["hud_score"]);
  assert.deepEqual(a.truth.grid.join(","), (snap as { grid: unknown[] }).grid.join(","));
});
