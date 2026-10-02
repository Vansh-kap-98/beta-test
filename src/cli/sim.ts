import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.ts";
import { Match3SimAdapter } from "../games/match3sim/adapter.ts";
import { ALL_MATCH3_BUGS } from "../games/match3sim/game.ts";
import type { Match3Bug } from "../games/match3sim/game.ts";
import {
  MATCH3_BOUNDS, MATCH3_INVARIANTS, MIN_CLEAR, match3BestControl, match3RawAnswer,
} from "../adapters/sidecar/match3Invariants.ts";
import { runSession } from "../core/agent/session.ts";
import { Tier1Policy } from "../core/agent/tier1Policy.ts";
import { OraclePlanner } from "../core/agent/planner.ts";
import { MockSystemOne } from "../core/soc/backends/mock.ts";
import { HttpSystemOne } from "../core/soc/backends/http.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../core/oracles/tier0.ts";
import { makeRewardConsistencyOracle, makeWastedCostOracle } from "../core/oracles/reward.ts";
import { renderReport } from "../core/trace/report.ts";

/**
 * Run the agent against the HEADLESS match-3, once per planted bug, and score
 * whether each bug was actually found.
 *
 * This is the acceptance bench. It answers the only question that matters about the
 * decision layer -- given a perfect view of the game, does the model find the bug? --
 * without spending the operator's screen and without letting perception failures
 * masquerade as model failures.
 *
 * The clean run is the most important row in the output. A detector that reports
 * every build broken scores 5/5 on the planted bugs and is worthless, so the clean
 * build must stay silent for any other number to mean anything.
 *
 *   npm run sim -- --backend laya --steps 220
 */
const USAGE = `
Run the agent against the headless match-3 fixture, one run per planted bug.

  --backend <b>     laya | mock   (default: laya if reachable)
  --laya-url <u>    Laya server base URL (default: http://127.0.0.1:8231)
  --steps <n>       Steps per variant (default: 200)
  --seeds <n>       Seeds per variant (default: 1)
  --gate <n>        Escalation confidence gate (default: 0.75)
  --variant <v>     Only this variant (clean | ${ALL_MATCH3_BUGS.join(" | ")})
  --invalid <f>     Share of offered swaps that are invalid (default: 0.15)
  --out <dir>       Write a report per variant
  --verbose         Print each finding as it lands
`;

/**
 * Which invariant is expected to catch which planted bug.
 *
 * Written down so a "detection" cannot be claimed by accident. A run that reports
 * the right bug for the wrong reason is not a working detector, and without this
 * map it would be scored as a pass.
 */
const EXPECTED: Record<Match3Bug, string[]> = {
  scoreCascade: ["reward-consistency:movedCells:hud_score",
    "zero-reward:movedCells:hud_score"],
  tutorialVague: ["instructions_are_actionable"],
  stuckNoShuffle: ["action_has_effect", "board_is_playable",
    "softlock:overlay_stuck:tap:pause,tap:shuffle_board"],
  ghostMove: ["move_not_wasted", "wasted-cost:hud_moves:movedCells"],
  winNoAdvance: ["action_has_effect", "screen_has_an_exit",
    "softlock:overlay_win:tap:next_level"],
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help")) {
    console.log(USAGE);
    return 0;
  }

  const steps = args.num("steps", 200);
  const seeds = args.num("seeds", 1);
  /**
   * Separate gates per question type, both measured rather than chosen.
   *
   * Choice confidence is the two-way top/(top+second) measure (see http.ts): 0.55
   * absorbs 63.5% of real decisions at 0.819 accuracy, where 0.75 absorbed 0%.
   * Yes/no answers are already on a two-way scale and hold 0.957 accuracy at 0.75
   * on the labelled bench, so they keep the stricter gate -- a wrong invariant
   * answer becomes a false finding, which is costlier than a wrong move.
   */
  const gate = args.num("gate", 0.55);
  const invariantGate = args.num("invariant-gate", 0.75);
  const invalidShare = args.num("invalid", 0.15);
  const verbose = args.has("verbose");
  const outDir = args.str("out", "");
  const only = args.str("variant", "");

  const layaUrl = args.str("laya-url", "http://127.0.0.1:8231");
  const want = args.str("backend", "auto");
  let useLaya = false;
  if (want !== "mock") {
    useLaya = await fetch(layaUrl + "/health", { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!useLaya && want === "laya") {
      console.error("no Laya server at " + layaUrl);
      return 2;
    }
  }
  console.log("decision model: " + (useLaya ? "laya at " + layaUrl : "mock (ground truth)"));
  console.log("steps/variant: " + steps + "   seeds: " + seeds + "   gate: " + gate);
  console.log("");

  // A bug that only exists in a rarely-reached state needs the run to START there,
  // otherwise the bench is reporting that chance never produced the state rather
  // than anything about the detector.
  const SCENARIO: Partial<Record<string, "fresh" | "stuck">> = {
    stuckNoShuffle: "stuck",
  };

  const variants: Array<{ name: string; bugs: Match3Bug[] }> = [
    { name: "clean", bugs: [] },
    ...ALL_MATCH3_BUGS.map((b) => ({ name: b, bugs: [b] })),
  ].filter((v) => !only || v.name === only);

  const rows: Array<{
    name: string; found: string[]; expected: string[]; hit: boolean;
    findings: number; critical: number; absorption: number; tier2: number;
    questions: number; ms: number;
  }> = [];

  for (const v of variants) {
    const t0 = Date.now();
    const found = new Set<string>();
    let findings = 0, critical = 0, absorbed = 0, decisions = 0, tier2 = 0, questions = 0;

    for (let seed = 1; seed <= seeds; seed++) {
      const adapter = new Match3SimAdapter({
        bugs: v.bugs, invalidShare, seed, scenario: SCENARIO[v.name] ?? "fresh",
      });
      const client = useLaya
        ? new HttpSystemOne({ baseUrl: layaUrl, name: "laya", timeoutMs: 20000 })
        : new MockSystemOne(
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
          // Tier 2 adjudicates in SPEC terms (healthy is true), which is the
          // convention the planner was written against; only the model is asked
          // defect-positive questions.
          invariantHolds: ((s: unknown, id: string) => {
            const raw = match3RawAnswer(s, id);
            return raw === undefined ? undefined : !raw;
          }) as never,
        }),
        escalateBelow: gate,
        invariantEscalateBelow: invariantGate,
        exploreEpsilon: 0.25,
      });

      const oracles = [
        ...TIER0_ORACLES,
        makeBoundsOracle(MATCH3_BOUNDS),
        // Tiles cleared against score: the only way to see a cascade that pays
        // nothing, because every individual move still scores.
        makeRewardConsistencyOracle([
          {
            workVar: "movedCells", rewardVar: "hud_score",
            label: "score per tile cleared", minWork: MIN_CLEAR,
            // Deterministic: tiles cleared must pay something.
            requirePositive: true,
          },
        ]),
        // A move spent with nothing cleared: deterministic, and the model had no
        // usable opinion on it.
        makeWastedCostOracle([
          { costVar: "hud_moves", workVar: "movedCells", label: "a move" },
        ]),
      ];
      const result = await runSession(adapter, policy, {
        seed, steps, oracles, recover: false,
      });

      for (const f of result.findings) {
        findings += 1;
        if (f.severity === "critical") critical += 1;
        // The invariant id lives in `evidence.invariant`, not at the top level of
        // the finding. Reading a non-existent `invariantId` scored every run as a
        // miss -- including runs against the ground-truth mock, where detection is
        // guaranteed by construction. A scoreboard that reports 0/5 when the oracle
        // is perfect is measuring itself, not the system.
        // Tier-1 findings name their invariant in `evidence.invariant`; Tier-0
        // findings have no invariant and are credited by their dedupe key, which is
        // the stable identity of the defect they describe.
        const id = String((f.evidence as { invariant?: string } | undefined)?.invariant ?? "")
          || (f.source === "tier0" ? f.dedupeKey : "");
        if (id) found.add(id);
        if (verbose) {
          console.log("    [" + v.name + " seed " + seed + "] " +
            f.severity + "/" + f.bugClass + " " + f.title + (id ? "  <" + id + ">" : ""));
        }
      }
      absorbed += policy.stats.absorbed;
      decisions += policy.stats.decisions;
      tier2 += policy.stats.plannerCalls;
      questions += policy.stats.socQuestions;

      if (outDir) {
        mkdirSync(outDir, { recursive: true });
        writeFileSync(
          join(outDir, v.name + "-seed" + seed + ".md"),
          renderReport({
            game: "match3sim (" + v.name + ", " + (useLaya ? "laya" : "mock") + ")",
            session: result, tier1: policy.stats,
            calibration: { n: 0, accuracy: 0, brier: 0, ece: 0, bins: [] } as never,
            replayDir: "", wallClockMs: Date.now() - t0,
          }, new Map()),
        );
      }
    }

    const expected = v.name === "clean" ? [] : EXPECTED[v.name as Match3Bug];
    const hit = v.name === "clean" ? findings === 0 : expected.some((e) => found.has(e));
    rows.push({
      name: v.name, found: [...found], expected, hit, findings, critical,
      absorption: decisions > 0 ? absorbed / decisions : 0,
      tier2, questions, ms: Date.now() - t0,
    });

    const verdict = v.name === "clean"
      ? (hit ? "SILENT (correct)" : "FALSE POSITIVES (" + findings + ")")
      : (hit ? "DETECTED" : "MISSED");
    // Node's console.log has no width specifiers, so padding is done here. Left as
    // printf-style it silently printed the format string itself.
    console.log(
      v.name.padEnd(16) + verdict.padEnd(22) +
      "findings " + String(findings).padEnd(4) +
      "absorption " + (decisions > 0 ? ((absorbed / decisions) * 100).toFixed(1) : "0.0").padStart(5) + "%  " +
      "tier2 " + String(tier2).padEnd(5) +
      ((Date.now() - t0) / 1000).toFixed(1) + "s",
    );
    if (found.size > 0) console.log("                 via: " + [...found].join(", "));
  }

  // --- scoreboard ----------------------------------------------------------
  const planted = rows.filter((r) => r.name !== "clean");
  const detected = planted.filter((r) => r.hit);
  const clean = rows.find((r) => r.name === "clean");
  console.log("");
  console.log("=== detection: " + detected.length + "/" + planted.length + " planted bugs ===");
  for (const r of planted) {
    console.log("  " + r.name.padEnd(16) + (r.hit ? "found" : "MISSED") +
      (r.hit ? " via " + r.found.filter((f) => r.expected.includes(f)).join(", ")
             : (r.findings > 0 ? " (reported " + r.findings + " other finding(s))" : " (silent)")));
  }
  if (clean) {
    console.log("  " + "clean build".padEnd(16) +
      (clean.findings === 0 ? "silent, as required"
                            : "*** " + clean.findings + " FALSE POSITIVES ***"));
  }
  if (outDir) console.log("\nreports: " + outDir);

  // A false positive on the clean build invalidates the whole run, so it is the
  // failing exit code rather than a missed bug -- a noisy detector is worse than a
  // quiet one, because nobody keeps using a tool that cries wolf.
  if (clean && clean.findings > 0) return 3;
  return detected.length === planted.length ? 0 : 1;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  },
);
