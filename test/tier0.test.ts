import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { RefGameAdapter } from "../src/games/refgame/adapter.ts";
import type { BugFlags } from "../src/games/refgame/bugs.ts";
import { NO_BUGS, only } from "../src/games/refgame/bugs.ts";
import { runSession, replaySession } from "../src/core/agent/session.ts";
import { CoverageFuzzPolicy } from "../src/core/agent/randomPolicy.ts";
import { stateHash } from "../src/core/oracles/oracle.ts";
import type { BugClass } from "../src/core/types.ts";

async function fuzz(bugs: BugFlags, seed = 5, steps = 1500) {
  return runSession(new RefGameAdapter(bugs), new CoverageFuzzPolicy(seed), { seed, steps });
}

function classes(findings: { bugClass: BugClass }[]): Set<BugClass> {
  return new Set(findings.map((f) => f.bugClass));
}

describe("tier0: false positives", () => {
  test("a clean build produces zero findings over 3000 fuzz steps", async () => {
    const r = await fuzz(NO_BUGS, 5, 3000);
    assert.deepEqual(
      r.findings.map((f) => f.title),
      [],
      "any finding here is a false positive and poisons developer trust",
    );
  });

  test("clean build is silent across many seeds", async () => {
    for (let seed = 1; seed <= 8; seed++) {
      const r = await fuzz(NO_BUGS, seed, 800);
      assert.equal(r.findings.length, 0, "seed " + seed + " produced " + r.findings.length);
    }
  });
});

describe("tier0: detection", () => {
  test("detects the overheal crash", async () => {
    const r = await fuzz(only("potionCrashAtFullHp"));
    assert.ok(classes(r.findings).has("crash"));
    const crash = r.findings.find((f) => f.bugClass === "crash")!;
    assert.equal(crash.severity, "critical");
    assert.match(crash.detail, /Cannot read properties of null/);
  });

  test("reports one crash per defect, not one per observation", async () => {
    const r = await fuzz(only("potionCrashAtFullHp"));
    const crashes = r.results.filter((d) => d.finding.bugClass === "crash");
    assert.equal(crashes.length, 1, "the game logs and throws; both must collapse to one bug");
    assert.ok(crashes[0]!.occurrences > 1, "but the repeat observations are still counted");
  });

  test("detects the settings softlock", async () => {
    const r = await fuzz(only("settingsSoftlock"));
    const f = r.findings.find((x) => x.bugClass === "softlock");
    assert.ok(f, "softlock not found");
    assert.match(f!.title, /settings/);
  });

  test("detects the infinite load", async () => {
    const r = await fuzz(only("infiniteLoad"));
    const f = r.findings.find((x) => x.title.startsWith("Stuck loading"));
    assert.ok(f, "stuck loading not found");
  });

  test("detects the text overflow and names the element", async () => {
    const r = await fuzz(only("textOverflow"));
    const f = r.findings.find((x) => x.bugClass === "ui");
    assert.ok(f);
    assert.match(f!.title, /buy_elixir/);
  });

  test("detects the leak by growth rate, and does so before fps degrades", async () => {
    const r = await fuzz(only("memLeak"));
    const leak = r.findings.find((f) => f.title.includes("MB/step"));
    const fps = r.findings.find((f) => f.title.includes("Frame rate"));
    assert.ok(leak, "leak not detected");
    assert.ok(fps, "fps collapse not detected");
    assert.ok(
      leak!.step < fps!.step,
      "the leak should be a leading indicator of the fps symptom, not the other way round",
    );
  });
});

describe("tier0: known blind spots", () => {
  // These are documented, not accidental. They are Tier-1 responsibilities and the
  // tests exist so that a future Tier-1 regression shows up as these starting to
  // pass for the wrong reason, or as Tier 1 silently losing the capability.
  test("cannot see the free-shop economy bug (needs a semantic invariant)", async () => {
    const r = await fuzz(only("shopFree"));
    assert.equal(r.findings.length, 0, "tier0 has no notion of what a purchase means");
  });

  test("cannot see the floor-7 difficulty spike (needs cross-run aggregation)", async () => {
    const r = await fuzz(only("difficultySpike"));
    assert.equal(r.findings.length, 0, "tier0 has no notion of what is too hard");
  });
});

describe("tier0: bug masking and recovery", () => {
  test("without recovery, a blocking bug hides everything behind it", async () => {
    const both = await runSession(
      new RefGameAdapter(only("settingsSoftlock", "infiniteLoad")),
      new CoverageFuzzPolicy(5),
      { seed: 5, steps: 1500, recover: false },
    );
    assert.ok(
      !both.findings.some((f) => f.title.startsWith("Stuck loading")),
      "the settings softlock should trap the run before floor 3 is ever reached",
    );
    assert.ok(both.coverage < 60, "and coverage should collapse, was " + both.coverage);
  });

  test("with recovery, the masked bug is found anyway", async () => {
    // This is the payoff for snapshot/restore: one blocking defect no longer costs
    // the entire run. The bot rewinds out of the trap, bans the edge that led in,
    // and keeps exploring.
    const both = await runSession(
      new RefGameAdapter(only("settingsSoftlock", "infiniteLoad")),
      new CoverageFuzzPolicy(5),
      { seed: 5, steps: 1500, recover: true },
    );
    assert.ok(both.recoveries > 0, "should have rewound at least once");
    assert.ok(
      both.findings.some((f) => f.title.startsWith("Softlock")),
      "still reports the trap it escaped",
    );
    assert.ok(
      both.findings.some((f) => f.title.startsWith("Stuck loading")),
      "and goes on to find the bug the trap was hiding",
    );
  });

  test("recovery does not invent findings on a clean build", async () => {
    const r = await runSession(new RefGameAdapter(NO_BUGS), new CoverageFuzzPolicy(5), {
      seed: 5,
      steps: 1500,
      recover: true,
    });
    assert.equal(r.recoveries, 0, "nothing to recover from");
    assert.deepEqual(r.findings.map((f) => f.title), []);
  });
});

describe("tier0: reproducibility", () => {
  test("a recorded action log replays to the same findings", async () => {
    const bugs = only("settingsSoftlock");
    const r = await fuzz(bugs);
    assert.ok(r.findings.length > 0);
    const replayed = await replaySession(new RefGameAdapter(bugs), r.seed, r.actionLog);
    assert.deepEqual(
      replayed.findings.map((f) => f.dedupeKey).sort(),
      r.findings.map((f) => f.dedupeKey).sort(),
      "replay must reproduce the same defects - this is the whole value of the report",
    );
  });

  test("a finding's own replay is sufficient to reach the defect", async () => {
    const bugs = only("potionCrashAtFullHp");
    const r = await fuzz(bugs);
    const crash = r.findings.find((f) => f.bugClass === "crash")!;
    // Replay only the prefix stored on the finding, not the whole session.
    const replayed = await replaySession(new RefGameAdapter(bugs), crash.replay.seed, crash.replay.actions);
    assert.ok(
      replayed.findings.some((f) => f.bugClass === "crash"),
      "the stored prefix should be enough to reproduce",
    );
    assert.ok(
      crash.replay.actions.length <= r.actionLog.length,
      "and it should be a prefix, not the entire run",
    );
  });
});

describe("stateHash", () => {
  test("ignores step and perf, which would make every state unique", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(1);
    const s1 = a.observe();
    a.act({ type: "wait", ms: 16 });
    const s2 = a.observe();
    assert.notEqual(s1.step, s2.step);
    assert.equal(stateHash(s1), stateHash(s2), "a pure time tick must not change identity");
  });

  test("distinguishes screens and variable values", () => {
    const a = new RefGameAdapter(NO_BUGS);
    a.reset(1);
    const title = a.observe();
    a.act({ type: "tap", targetId: "start" });
    assert.notEqual(stateHash(title), stateHash(a.observe()));
  });
});
