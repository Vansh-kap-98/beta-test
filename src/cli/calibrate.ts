import { parseArgs } from "./args.ts";
import { getGame } from "../games/registry.ts";
import { runSession } from "../core/agent/session.ts";
import { Tier1Policy } from "../core/agent/tier1Policy.ts";
import { OraclePlanner } from "../core/agent/planner.ts";
import { MockSystemOne } from "../core/soc/backends/mock.ts";
import type { Calibration } from "../core/soc/backends/mock.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../core/oracles/tier0.ts";
import { calibrate, renderReliabilityDiagram } from "../core/calibration/harness.ts";

const USAGE = `
Measure whether the decision model's confidence means what it says.

Usage:
  npm run calibrate -- [options]

Options:
  --game <name>        Default: refgame
  --variant <v>        Default: clean
  --seeds <n>          Default: 6
  --steps <n>          Default: 1000
  --calibration <c>    good | overconfident | underconfident (default: good)
  --target <n>         Accuracy the recommended gate must deliver (default: 0.95)
  --compare            Run every calibration mode side by side.

Why this matters: the numbers printed here are not diagnostics. The measured error
rate becomes the invariant reporting gate's threshold, and the recommended gate
becomes the escalation threshold. An overconfident model silently stops escalating,
with no error raised anywhere - this is the only thing that catches it.
`;

async function collect(
  gameName: string,
  variant: string,
  mode: Calibration,
  seeds: number,
  steps: number,
) {
  const game = getGame(gameName);
  if (!game.mockTruth || !game.plannerTruth) {
    throw new Error("game '" + gameName + "' has no offline truth oracle to measure against");
  }
  const oracles = [...TIER0_ORACLES, makeBoundsOracle(game.bounds)];
  const samples: Array<{ reported: number; correct: boolean }> = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const client = new MockSystemOne(game.mockTruth(), { calibration: mode, seed });
    const policy = new Tier1Policy(client, {
      invariants: game.invariants,
      planner: new OraclePlanner(game.plannerTruth),
    });
    await runSession(game.makeAdapter(variant), policy, { seed, steps, oracles });
    for (const l of client.log) {
      if (l.correct !== null) samples.push({ reported: l.reported, correct: l.correct });
    }
  }
  return samples;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help")) {
    console.log(USAGE);
    return 0;
  }

  const gameName = args.str("game", "refgame");
  const variant = args.str("variant", "clean");
  const seeds = args.num("seeds", 6);
  const steps = args.num("steps", 1000);
  const target = args.num("target", 0.95);

  const modes: Calibration[] = args.has("compare")
    ? ["good", "overconfident", "underconfident"]
    : [args.str("calibration", "good") as Calibration];

  for (const mode of modes) {
    const samples = await collect(gameName, variant, mode, seeds, steps);
    const report = calibrate(samples, { targetAccuracy: target });
    console.log("");
    console.log("=== " + gameName + " (" + variant + "), model calibration: " + mode + " ===");
    console.log(renderReliabilityDiagram(report));
    console.log("");
    console.log(
      "  -> invariant reporting gate should use expectedErrorRate = " +
        report.errorRate.toFixed(3),
    );
    console.log(
      "  -> escalation gate should use " +
        (report.recommendedGate === null
          ? "N/A (no threshold reaches the target; escalate far more, or simplify the questions)"
          : report.recommendedGate.toFixed(2)),
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
