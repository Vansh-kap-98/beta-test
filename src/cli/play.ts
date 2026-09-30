import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.ts";
import { getGame, GAMES } from "../games/registry.ts";
import { runSession } from "../core/agent/session.ts";
import { Tier1Policy } from "../core/agent/tier1Policy.ts";
import { CoverageFuzzPolicy } from "../core/agent/randomPolicy.ts";
import { OraclePlanner } from "../core/agent/planner.ts";
import { MockSystemOne } from "../core/soc/backends/mock.ts";
import type { Calibration } from "../core/soc/backends/mock.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../core/oracles/tier0.ts";
import { calibrate } from "../core/calibration/harness.ts";
import { aggregate, detectAnomalies } from "../core/calibration/balance.ts";
import type { Encounter } from "../core/calibration/balance.ts";
import { renderReport, writeReplayFiles } from "../core/trace/report.ts";
import type { Finding } from "../core/types.ts";
import type { SessionResult } from "../core/agent/session.ts";
import type { Tier1Stats } from "../core/agent/tier1Policy.ts";

const USAGE = `
beta-test-bot - autonomous game beta tester

Usage:
  npm run play -- [options]

Options:
  --game <name>        Game to test (default: refgame). Known: ${Object.keys(GAMES).join(", ")}
  --variant <v>        Build variant / bug set (default: clean).
                       "clean", "all", or a comma-separated list of bug flags.
  --seeds <n>          Independent runs (default: 8). More seeds = better balance stats.
  --steps <n>          Steps per run (default: 1200).
  --policy <p>         tier1 (default) or fuzz (the baseline monkey tester).
  --calibration <c>    Mock model calibration: good | overconfident | underconfident.
  --gate <n>           Escalation confidence gate (default: 0.75).
  --out <dir>          Output directory (default: artifacts/<timestamp>).
  --quiet              Only print the summary line.
  --help

Examples:
  npm run play -- --variant all --seeds 10
  npm run play -- --variant shopFree --steps 2000
  npm run play -- --policy fuzz --variant clean
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help")) {
    console.log(USAGE);
    return 0;
  }

  const gameName = args.str("game", "refgame");
  const variant = args.str("variant", "clean");
  const seeds = args.num("seeds", 8);
  const steps = args.num("steps", 1200);
  const policyKind = args.str("policy", "tier1");
  const calibration = args.str("calibration", "good") as Calibration;
  const gate = args.num("gate", 0.75);
  const quiet = args.has("quiet");

  const game = getGame(gameName);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.str("out", join("artifacts", gameName + "-" + variant + "-" + stamp));
  const oracles = [...TIER0_ORACLES, makeBoundsOracle(game.bounds)];

  if (!game.mockTruth || !game.plannerTruth) {
    console.error(
      "Game '" + gameName + "' has no offline truth oracle. Supply a real Jev/Laya client instead.",
    );
    return 1;
  }

  const t0 = Date.now();
  const allFindings: Finding[] = [];
  const encounters: Encounter[] = [];
  const scores: Array<{ floor: number; score: number }> = [];
  const calSamples: Array<{ reported: number; correct: boolean }> = [];
  const sessions: SessionResult[] = [];
  const totals: Tier1Stats = {
    steps: 0,
    decisions: 0,
    absorbed: 0,
    socCalls: 0,
    socQuestions: 0,
    invariantAsks: 0,
    escalatedChoices: 0,
    escalatedInvariants: 0,
    plannerCalls: 0,
    freeSteps: 0,
    exploreSteps: 0,
    adjudicationsCached: 0,
    inputTokens: 0,
  };

  for (let seed = 1; seed <= seeds; seed++) {
    const adapter = game.makeAdapter(variant);
    if (policyKind === "fuzz") {
      const r = await runSession(adapter, new CoverageFuzzPolicy(seed), { seed, steps, oracles });
      sessions.push(r);
      allFindings.push(...r.findings);
      totals.steps += r.steps;
      totals.freeSteps += r.steps;
    } else {
      const client = new MockSystemOne(game.mockTruth(), { calibration, seed });
      const policy = new Tier1Policy(client, {
        invariants: game.invariants,
        planner: new OraclePlanner(game.plannerTruth),
        escalateBelow: gate,
        invariantEscalateBelow: gate,
      });
      const r = await runSession(adapter, policy, { seed, steps, oracles });
      sessions.push(r);
      allFindings.push(...r.findings);
      encounters.push(...policy.balance.encounters);
      scores.push(...policy.difficulty.map((d) => ({ floor: d.floor, score: d.score })));
      for (const l of client.log) {
        if (l.correct !== null) calSamples.push({ reported: l.reported, correct: l.correct });
      }
      for (const k of Object.keys(totals) as Array<keyof Tier1Stats>) {
        totals[k] += policy.stats[k];
      }
    }
    if (!quiet) {
      const r = sessions[sessions.length - 1]!;
      console.log(
        "  seed " +
          String(seed).padStart(2) +
          ": " +
          String(r.findings.length).padStart(2) +
          " findings, coverage " +
          String(r.coverage).padStart(4) +
          ", screens " +
          r.screensVisited.length,
      );
    }
  }

  // Merge findings across seeds, keeping the shortest reproduction for each defect.
  const byKey = new Map<string, { finding: Finding; occurrences: number; lastStep: number }>();
  for (const f of allFindings) {
    const prev = byKey.get(f.dedupeKey);
    if (!prev) {
      byKey.set(f.dedupeKey, { finding: f, occurrences: 1, lastStep: f.step });
    } else {
      prev.occurrences += 1;
      // A shorter action log is a better bug report.
      if (f.replay.actions.length < prev.finding.replay.actions.length) prev.finding = f;
    }
  }
  const merged = [...byKey.values()].sort(
    (a, b) =>
      ["critical", "high", "medium", "low"].indexOf(a.finding.severity) -
      ["critical", "high", "medium", "low"].indexOf(b.finding.severity),
  );

  const stats = aggregate(encounters, scores);
  const anomalies = detectAnomalies(stats);
  const cal = calibrate(calSamples);

  const combined: SessionResult = {
    seed: 0,
    policy: policyKind === "fuzz" ? "coverage-fuzz" : "tier1",
    steps: totals.steps,
    actionLog: [],
    findings: merged.map((m) => m.finding),
    results: merged,
    coverage: sessions.reduce((a, s) => a + s.coverage, 0),
    screensVisited: [...new Set(sessions.flatMap((s) => s.screensVisited))].sort(),
    recoveries: sessions.reduce((a, s) => a + s.recoveries, 0),
  };

  mkdirSync(outDir, { recursive: true });
  const replayPaths = writeReplayFiles(combined.findings, join(outDir, "replays"), {
    game: gameName,
    variant,
  });
  const report = renderReport(
    {
      game: gameName + " (" + variant + ")",
      session: combined,
      tier1: policyKind === "fuzz" ? undefined : totals,
      calibration: policyKind === "fuzz" ? undefined : cal,
      balance: stats.length > 0 ? { stats, anomalies } : undefined,
      replayDir: "replays",
      wallClockMs: Date.now() - t0,
    },
    replayPaths,
  );

  const reportPath = join(outDir, "report.md");
  writeFileSync(reportPath, report);
  writeFileSync(
    join(outDir, "findings.json"),
    JSON.stringify({ game: gameName, variant, seeds, steps, findings: combined.findings }, null, 2),
  );

  const critical = combined.findings.filter((f) => f.severity === "critical").length;
  console.log("");
  console.log(
    combined.findings.length +
      " distinct defects (" +
      critical +
      " critical), " +
      anomalies.length +
      " balance anomalies, across " +
      seeds +
      " runs / " +
      totals.steps +
      " steps in " +
      ((Date.now() - t0) / 1000).toFixed(1) +
      "s" +
      (combined.recoveries > 0
        ? " (" + combined.recoveries + " recoveries from blocking defects)"
        : ""),
  );
  if (policyKind !== "fuzz" && totals.decisions > 0) {
    console.log(
      "tier-1 absorption " +
        ((totals.absorbed / totals.decisions) * 100).toFixed(1) +
        "%, " +
        totals.plannerCalls +
        " tier-2 calls, " +
        totals.socQuestions +
        " questions in " +
        totals.socCalls +
        " calls",
    );
  }
  console.log("report: " + reportPath);

  // Non-zero exit when critical defects are present, so CI can gate on it.
  return critical > 0 ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
