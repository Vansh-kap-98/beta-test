import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "./args.ts";
import { SidecarAdapter } from "../adapters/sidecar/adapter.ts";
import {
  MATCH3_BOUNDS, MATCH3_INVARIANTS, MIN_CLEAR, match3BestControl, match3InvariantTruth,
  match3RawAnswer,
} from "../adapters/sidecar/match3Invariants.ts";
import { runSession } from "../core/agent/session.ts";
import { Tier1Policy } from "../core/agent/tier1Policy.ts";
import { OraclePlanner } from "../core/agent/planner.ts";
import { MockSystemOne } from "../core/soc/backends/mock.ts";
import { HttpSystemOne } from "../core/soc/backends/http.ts";
import type { Calibration } from "../core/soc/backends/mock.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../core/oracles/tier0.ts";
import { makeRewardConsistencyOracle, makeWastedCostOracle } from "../core/oracles/reward.ts";
import { calibrate } from "../core/calibration/harness.ts";
import { renderReport, writeReplayFiles } from "../core/trace/report.ts";

/**
 * Run the agent against a LIVE window.
 *
 * Everything above the adapter is the code that was built and tested against
 * in-process fixtures: the same tier stack, the same Wilson-gated invariant engine,
 * the same deduplication and the same report. Only the adapter is new, which is the
 * claim the whole architecture rests on.
 *
 *   npm run live -- --match "Sugar Cascade" --profile match3 --steps 60
 */
const USAGE = `
Run the beta-test agent against a live window.

  --match <text>     Window title or process substring to attach to (required)
  --profile <p>      generic | match3   (default: generic)
  --steps <n>        Steps to run (default: 50)
  --expect <text>    Abort unless the attached window title contains this
  --gate <n>         Escalation confidence gate (default: 0.75)
  --backend <b>      laya | mock   (default: laya if reachable, else mock)
  --laya-url <u>     Laya server base URL (default: http://127.0.0.1:8231)
  --calibration <c>  Mock model calibration: good | overconfident
  --out <dir>        Report directory
  --verbose          Print each step

The game must already be running and visible. This never touches credentials --
you launch and sign in; the bot attaches to the window you already have open.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help") || !args.has("match")) {
    console.log(USAGE);
    return args.has("help") ? 0 : 1;
  }

  const match = args.str("match", "");
  const profile = args.str("profile", "generic") as "generic" | "match3";
  const steps = args.num("steps", 50);
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
  const verbose = args.has("verbose");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.str("out", join("artifacts", "live-" + profile + "-" + stamp));

  const adapter = new SidecarAdapter({
    match,
    profile,
    expectTitle: args.has("expect") ? args.str("expect", "") : undefined,
    onLog: (l) => verbose && console.log("  " + l),
  });

  console.log("attaching to " + JSON.stringify(match) + " (profile: " + profile + ")...");
  try {
    await adapter.start();
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    return 2;
  }
  await adapter.refresh();

  const invariants = profile === "match3" ? MATCH3_INVARIANTS : MATCH3_INVARIANTS.slice(0, 3);
  const bounds = profile === "match3" ? MATCH3_BOUNDS : [];

  // The decision model is still the offline mock: it needs no GPU, and its known
  // accuracy is what lets the escalation and reporting gates be measured rather
  // than assumed. Swapping in a real Laya client changes this one object.
  // The real model if one is reachable, the mock otherwise. The mock is not a
  // lesser version of the same thing: it answers by consulting ground truth, so it
  // measures the pipeline while telling you nothing about whether a model can read
  // the state. That difference hid a 0.652-accuracy configuration for a whole night.
  const layaUrl = args.str("laya-url", "http://127.0.0.1:8231");
  const want = args.str("backend", "auto");
  let client: MockSystemOne | HttpSystemOne | undefined;
  let backendName = "mock";
  if (want !== "mock") {
    const reachable = await fetch(layaUrl + "/health", { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok)
      .catch(() => false);
    if (!reachable && want === "laya") {
      console.error("no Laya server at " + layaUrl + " (start it with: LAYA_HOST=127.0.0.1 " +
        "LAYA_PORT=8231 LAYA_DEVICE=cuda py -3.12 -m laya.serve)");
      return 2;
    }
    if (reachable) {
      client = new HttpSystemOne({ baseUrl: layaUrl, name: "laya", timeoutMs: 15000 });
      backendName = "laya";
    }
  }
  if (!client) {
    client = new MockSystemOne(
      (state: unknown, q: any) => {
        // The mock stands in for the MODEL, so it must answer in the model's
        // polarity, not the spec's. See match3RawAnswer.
        if (q.kind === "noul") return match3RawAnswer(state, q.id);
        if (q.kind === "choice") return match3BestControl(state, q.options);
        return undefined;
      },
      { calibration: args.str("calibration", "good") as Calibration, seed: 1 },
    );
  }
  const soc = client;
  console.log("decision model: " + backendName + (backendName === "laya" ? " at " + layaUrl : ""));

  const policy = new Tier1Policy(soc, {
    invariants,
    planner: new OraclePlanner({
      bestControl: match3BestControl as never,
      invariantHolds: match3InvariantTruth as never,
    }),
    escalateBelow: gate,
    invariantEscalateBelow: invariantGate,
    exploreEpsilon: 0.2,
  });

  // Same oracle set as the headless bench, so a difference in findings between the
  // two is attributable to perception and nothing else. The HUD variables these read
  // come from OCR here and from the game object there; everything above is identical.
  const oracles = [
    ...TIER0_ORACLES,
    makeBoundsOracle(bounds),
    ...(profile === "match3"
      ? [
          makeRewardConsistencyOracle([{
            workVar: "movedCells", rewardVar: "hud_score",
            label: "score per tile cleared", minWork: MIN_CLEAR, requirePositive: true,
            /**
             * Here the numbers come from the screen, so the oracle is told how much
             * to distrust them. Measured against the fixture's out-of-band ground
             * truth, cross-scale HUD reads agree with the real score on roughly 97%
             * of frames; the residual few percent was producing confident economy
             * findings on a clean build.
             *
             * The headless bench passes no such rate, because there the numbers come
             * from the game object and are exact -- a mismatch there is always a
             * real defect, and tolerating any would hide one.
             */
            inputErrorRate: 0.03,
            /**
             * The rate test is off here and on in the headless bench, which is the
             * honest division. Measured against ground truth, the vision cell count
             * is exact on 80% of moves while the defect it looks for appears in
             * about 7% -- noise beats signal threefold, so the test cannot work on
             * this input at any threshold. The zero-reward check below it survives
             * because it compares the score against itself and so depends on only
             * one noisy quantity.
             */
            checkRate: false,
            // A single move cannot plausibly change most of the board; 61 cells was
            // observed for a true 9 when a capture landed mid-cascade.
            maxWork: 24,
          }]),
          makeWastedCostOracle([{
            costVar: "hud_moves", workVar: "movedCells", label: "a move",
            // Vision-derived on both sides, so more corroboration than in-process.
            minOccurrences: 6,
          }]),
        ]
      : []),
  ];
  const t0 = Date.now();

  let lastStep = 0;
  if (verbose) {
    const orig = policy.onResult.bind(policy);
    policy.onResult = async (before, action, after) => {
      await orig(before, action, after);
      if (after.step !== lastStep) {
        lastStep = after.step;
        const a = action.type === "tap" ? action.targetId : action.type;
        console.log(
          "  step %s  %-26s screen=%s moves=%s",
          String(after.step).padStart(3),
          a.slice(0, 26),
          after.screen.slice(0, 26),
          String(after.vars["legalMoves"] ?? "-"),
        );
      }
    };
  }

  const result = await runSession(adapter, policy, {
    seed: 1,
    steps,
    oracles,
    // A live game cannot be snapshotted, so recovery is off and the session knows it.
    recover: false,
    // Stop the moment the window we attached to stops being the one that will
    // receive input. Everything after that point would be clicks landing in the
    // user's own applications and captures of a window nobody can see.
    shouldStop: () => adapter.targetLost(),
  });

  await adapter.stop();

  // Only the mock knows whether it was right, because only the mock has ground
  // truth. With the real model there is nothing to calibrate against in-run, and
  // saying so beats reporting a calibration computed from zero samples.
  const calSamples = soc instanceof MockSystemOne
    ? soc.log.filter((l) => l.correct !== null)
        .map((l) => ({ reported: l.reported, correct: l.correct as boolean }))
    : [];
  const cal = calibrate(calSamples);

  mkdirSync(outDir, { recursive: true });
  const replayPaths = writeReplayFiles(result.findings, join(outDir, "replays"), {
    game: match, variant: "live",
  });
  const report = renderReport(
    {
      game: adapter.target + " (live, " + profile + ", " + backendName + ")",
      session: result,
      tier1: policy.stats,
      calibration: cal,
      replayDir: "replays",
      wallClockMs: Date.now() - t0,
    },
    replayPaths,
  );
  writeFileSync(join(outDir, "report.md"), report);

  const s = policy.stats;
  console.log("");
  if (result.stoppedEarly) {
    console.log("*** RUN STOPPED EARLY: " + result.stoppedEarly + " ***");
    console.log(adapter.targetLostDetail);
    console.log("Findings below are from the " + result.steps +
      " steps completed before that, and cover less of the game than a full run.");
    console.log("");
  }
  console.log(
    "%d steps, %d distinct screens, %d defects (%d critical)",
    result.steps,
    result.screensVisited.length,
    result.findings.length,
    result.findings.filter((f) => f.severity === "critical").length,
  );
  if (s.decisions > 0) {
    console.log(
      "tier-1 absorption %s%%, %d tier-2 calls, %d questions in %d calls",
      ((s.absorbed / s.decisions) * 100).toFixed(1),
      s.plannerCalls, s.socQuestions, s.socCalls,
    );
  }
  for (const d of result.results) {
    console.log(
      "  [%s/%s/%s] %s (x%d)",
      d.finding.severity, d.finding.bugClass, d.finding.source, d.finding.title, d.occurrences,
    );
  }
  console.log("report: " + join(outDir, "report.md"));
  // A run that stopped early is not a pass. Reporting 0 would let a scripted sweep
  // record a clean result for a game the bot stopped testing after twelve steps.
  if (result.stoppedEarly) return 4;
  return result.findings.some((f) => f.severity === "critical") ? 2 : 0;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error(e instanceof Error ? e.stack : String(e));
    process.exit(1);
  },
);
