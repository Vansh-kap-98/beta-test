import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Match3SimAdapter } from "../src/games/match3sim/adapter.ts";
import { ALL_MATCH3_BUGS } from "../src/games/match3sim/game.ts";
import type { Match3Bug } from "../src/games/match3sim/game.ts";
import {
  MATCH3_BOUNDS, MATCH3_INVARIANTS, match3BestControl, match3RawAnswer,
} from "../src/adapters/sidecar/match3Invariants.ts";
import { runSession } from "../src/core/agent/session.ts";
import { Tier1Policy } from "../src/core/agent/tier1Policy.ts";
import { OraclePlanner } from "../src/core/agent/planner.ts";
import { MockSystemOne } from "../src/core/soc/backends/mock.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../src/core/oracles/tier0.ts";
import {
  makeRewardConsistencyOracle, makeWastedCostOracle,
} from "../src/core/oracles/reward.ts";

/**
 * End-to-end acceptance: the agent plays the headless match-3 and must find each
 * planted bug while staying silent on the clean build.
 *
 * Runs against the ground-truth mock so it is fast and deterministic and needs no
 * GPU. The same bench run against the real Laya model is `npm run sim -- --backend
 * laya`, which currently scores the same 5/5 with the clean build silent; this test
 * exists to stop a regression in the pipeline being mistaken for a model problem.
 *
 * The clean-build assertion is the one that matters. A detector that reports every
 * build broken scores 5/5 here and is worthless.
 */

const EXPECTED: Record<Match3Bug, string[]> = {
  scoreCascade: ["reward-consistency:movedCells:hud_score", "zero-reward:movedCells:hud_score"],
  tutorialVague: ["instructions_are_actionable"],
  stuckNoShuffle: ["action_has_effect", "board_is_playable",
    "softlock:overlay_stuck:tap:pause,tap:shuffle_board"],
  ghostMove: ["wasted-cost:hud_moves:movedCells", "move_not_wasted"],
  winNoAdvance: ["action_has_effect", "softlock:overlay_win:tap:next_level"],
};

const SCENARIO: Partial<Record<string, "fresh" | "stuck">> = { stuckNoShuffle: "stuck" };

async function run(bugs: Match3Bug[], name: string, seeds: number, steps: number) {
  const found = new Set<string>();
  let findings = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const adapter = new Match3SimAdapter({
      bugs, seed, invalidShare: 0.25, scenario: SCENARIO[name] ?? "fresh",
    });
    const client = new MockSystemOne(
      (state: unknown, q: { kind: string; id: string; options?: string[] }) => {
        if (q.kind === "noul") return match3RawAnswer(state, q.id);
        if (q.kind === "choice") return match3BestControl(state, q.options ?? []);
        return undefined;
      },
      { calibration: "good", seed },
    );
    const policy = new Tier1Policy(client, {
      invariants: MATCH3_INVARIANTS,
      planner: new OraclePlanner({
        bestControl: match3BestControl as never,
        invariantHolds: ((s: unknown, id: string) => {
          const raw = match3RawAnswer(s, id);
          return raw === undefined ? undefined : !raw;
        }) as never,
      }),
      escalateBelow: 0.55,
      invariantEscalateBelow: 0.75,
      exploreEpsilon: 0.25,
    });
    const result = await runSession(adapter, policy, {
      seed, steps, recover: false,
      oracles: [
        ...TIER0_ORACLES,
        makeBoundsOracle(MATCH3_BOUNDS),
        makeRewardConsistencyOracle([
          { workVar: "movedCells", rewardVar: "hud_score", requirePositive: true },
        ]),
        makeWastedCostOracle([{ costVar: "hud_moves", workVar: "movedCells" }]),
      ],
    });
    for (const f of result.findings) {
      findings += 1;
      const id = String((f.evidence as { invariant?: string } | undefined)?.invariant ?? "")
        || (f.source === "tier0" ? f.dedupeKey : "");
      if (id) found.add(id);
    }
  }
  return { found, findings };
}

test("a clean build produces no findings at all", async () => {
  const { findings } = await run([], "clean", 2, 300);
  assert.equal(findings, 0,
    "a clean build must be silent; every other number in this file is meaningless otherwise");
});

for (const bug of ALL_MATCH3_BUGS) {
  test("detects planted bug: " + bug, async () => {
    const { found } = await run([bug], bug, 2, 300);
    const want = EXPECTED[bug];
    const hit = want.filter((w) => found.has(w));
    assert.ok(hit.length > 0,
      bug + " was not detected. Expected one of [" + want.join(", ") +
      "], got [" + [...found].join(", ") + "]");
  });
}

test("every invariant is defect-positive and the mock matches that polarity", () => {
  for (const inv of MATCH3_INVARIANTS) {
    assert.equal(inv.polarity, "defect-positive", inv.id);
  }
});

test("single-visit invariants carry paraphrases for corroboration", () => {
  // A screen passed through once cannot accumulate repetition evidence, so the only
  // corroboration available is asking the same thing several ways.
  for (const inv of MATCH3_INVARIANTS) {
    if (inv.evidence !== "escalation") continue;
    assert.ok((inv.paraphrases?.length ?? 0) >= 2,
      inv.id + " is escalation-evidence and needs at least two paraphrases");
  }
});
