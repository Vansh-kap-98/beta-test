import { readFileSync } from "node:fs";
import { parseArgs } from "./args.ts";
import { getGame } from "../games/registry.ts";
import { replaySession } from "../core/agent/session.ts";
import { TIER0_ORACLES, makeBoundsOracle } from "../core/oracles/tier0.ts";
import type { Action } from "../core/types.ts";

const USAGE = `
Replay a recorded defect.

Usage:
  npm run replay -- <replay.json> [options]

Options:
  --game <name>     Game (default: taken from the replay file, else refgame).
  --variant <v>     Build variant (default: taken from the file, else all).
  --trace           Print the state after every action.
  --at <n>          Print state around step n only.

The replay file is written next to every report, one per finding. Re-running it
lands in the same broken state, deterministically - that is the whole point of
seeding the run.
`;

interface ReplayFile {
  findingId?: string;
  title?: string;
  seed: number;
  actions: Action[];
  game?: string;
  variant?: string;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help") || args.positional.length === 0) {
    console.log(USAGE);
    return args.has("help") ? 0 : 1;
  }

  const path = args.positional[0]!;
  let file: ReplayFile;
  try {
    file = JSON.parse(readFileSync(path, "utf8")) as ReplayFile;
  } catch (err) {
    console.error("could not read replay file '" + path + "': " + (err as Error).message);
    return 1;
  }
  if (!Array.isArray(file.actions) || typeof file.seed !== "number") {
    console.error("replay file is missing 'seed' or 'actions'");
    return 1;
  }

  const gameName = args.str("game", file.game ?? "refgame");
  // A replay only reproduces against the build it was recorded on; default to the
  // full bug set rather than a clean build, which would silently reproduce nothing.
  const variant = args.str("variant", file.variant ?? "all");
  const game = getGame(gameName);
  const oracles = [...TIER0_ORACLES, makeBoundsOracle(game.bounds)];

  console.log("Replaying " + (file.title ?? file.findingId ?? path));
  console.log("  game " + gameName + " (" + variant + "), seed " + file.seed + ", " + file.actions.length + " actions");
  console.log("");

  const adapter = game.makeAdapter(variant);

  if (args.has("trace") || args.has("at")) {
    const at = args.num("at", -1);
    adapter.reset(file.seed);
    let i = 0;
    for (const a of file.actions) {
      adapter.act(a);
      i++;
      const st = adapter.observe();
      const show = args.has("trace") || (at >= 0 && Math.abs(i - at) <= 5);
      if (show) {
        const desc = a.type === "tap" ? "tap " + a.targetId : a.type;
        console.log(
          String(i).padStart(4) +
            "  " +
            desc.padEnd(22) +
            "-> " +
            st.screen.padEnd(16) +
            JSON.stringify(st.vars) +
            (st.errors.length ? "  ERRORS: " + st.errors.join("; ") : ""),
        );
      }
    }
    console.log("");
  }

  const r = await replaySession(game.makeAdapter(variant), file.seed, file.actions, oracles);

  if (r.findings.length === 0) {
    console.log("No defects reproduced.");
    console.log(
      "If this replay came from a report, check --variant matches the build it was recorded against.",
    );
    return 1;
  }

  console.log("Reproduced " + r.findings.length + " defect(s):");
  for (const d of r.results) {
    console.log(
      "  [" +
        d.finding.severity +
        "/" +
        d.finding.bugClass +
        "] " +
        d.finding.title +
        " (step " +
        d.finding.step +
        ", x" +
        d.occurrences +
        ")",
    );
  }
  const target = file.findingId;
  if (target) {
    console.log("");
    console.log("Final state: " + JSON.stringify(adapter.observe().vars));
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
