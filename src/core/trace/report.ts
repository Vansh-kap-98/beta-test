import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Severity } from "../types.ts";
import type { DedupedFinding } from "../oracles/runner.ts";
import type { SessionResult } from "../agent/session.ts";
import type { Tier1Stats } from "../agent/tier1Policy.ts";
import type { CalibrationReport } from "../calibration/harness.ts";
import { renderReliabilityDiagram } from "../calibration/harness.ts";
import type { BalanceAnomaly, FloorStats } from "../calibration/balance.ts";
import { renderBalanceTable } from "../calibration/balance.ts";

/**
 * Turns a run into something a developer will actually act on.
 *
 * The organising principle: every finding ships with a deterministic replay, and
 * the replay is written to disk as a file the developer can run. A report that
 * says "the economy is broken somewhere" gets ignored; one that says "run this
 * command and watch gold stay at 30" gets fixed. The evidence and the confidence
 * are shown too, because a developer's first reaction to an automated finding is
 * to doubt it, and they are entitled to see the working.
 */

export interface ReportInput {
  game: string;
  session: SessionResult;
  tier1?: Tier1Stats;
  calibration?: CalibrationReport;
  balance?: { stats: FloorStats[]; anomalies: BalanceAnomaly[] };
  /** Directory replay files are written to, relative to the report. */
  replayDir?: string;
  wallClockMs?: number;
}

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];

export function writeReplayFiles(
  findings: Finding[],
  dir: string,
  meta: { game?: string; variant?: string } = {},
): Map<string, string> {
  mkdirSync(dir, { recursive: true });
  const paths = new Map<string, string>();
  for (const f of findings) {
    const name = f.id + "-" + f.dedupeKey.replace(/[^a-z0-9]+/gi, "-").slice(0, 40) + ".json";
    const p = join(dir, name);
    writeFileSync(
      p,
      JSON.stringify(
        {
          findingId: f.id,
          title: f.title,
          // The build matters: a replay against a clean build reproduces nothing
          // and looks like the finding was bogus.
          game: meta.game,
          variant: meta.variant,
          seed: f.replay.seed,
          steps: f.replay.actions.length,
          actions: f.replay.actions,
        },
        null,
        2,
      ),
    );
    paths.set(f.id, name);
  }
  return paths;
}

export function renderReport(input: ReportInput, replayPaths?: Map<string, string>): string {
  const { session, tier1, calibration, balance } = input;
  const L: string[] = [];

  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of session.findings) counts[f.severity] += 1;

  L.push("# Beta-test report: " + input.game);
  L.push("");
  L.push(
    "Seed `" +
      session.seed +
      "` - policy `" +
      session.policy +
      "` - " +
      session.steps +
      " steps - " +
      session.coverage +
      " distinct states" +
      (input.wallClockMs ? " - " + (input.wallClockMs / 1000).toFixed(1) + "s" : ""),
  );
  L.push("");
  L.push("Screens reached: " + session.screensVisited.map((s) => "`" + s + "`").join(", "));
  L.push("");

  // Stated before the findings, not in a footnote.
  //
  // A run that was cut short covers less of the game than it was asked to, and the
  // most dangerous way to present that is as an ordinary result: "no defects found"
  // on a report whose run stopped after twelve steps reads as a clean bill of health
  // for content nobody ever reached.
  if (session.stoppedEarly) {
    L.push("> **This run stopped early: " + session.stoppedEarly + ".**");
    L.push("> It completed " + session.steps + " of its intended steps, so the game is");
    L.push("> covered less thoroughly than a full run and absence of a finding below");
    L.push("> is not evidence that the defect is absent.");
    L.push("");
  }

  if (session.findings.length === 0) {
    L.push(session.stoppedEarly ? "## No defects found before the run stopped"
                                : "## No defects found");
    L.push("");
    L.push(
      "The run completed with every oracle silent. Note what this does and does not mean: " +
        "it covered " +
        session.coverage +
        " distinct states across " +
        session.screensVisited.length +
        " screens. States never reached were never tested.",
    );
  } else {
    L.push("## Summary");
    L.push("");
    L.push("| severity | count |");
    L.push("|---|---|");
    for (const s of SEVERITY_ORDER) if (counts[s] > 0) L.push("| " + s + " | " + counts[s] + " |");
    L.push("");

    L.push("## Findings");
    L.push("");
    for (const d of session.results) {
      L.push(renderFinding(d, replayPaths, input.replayDir));
    }
  }

  if (balance && balance.stats.length > 0) {
    L.push("## Balance");
    L.push("");
    L.push("```");
    L.push(renderBalanceTable(balance.stats));
    L.push("```");
    L.push("");
    if (balance.anomalies.length === 0) {
      L.push(
        "No discontinuities in the difficulty curve. Rising difficulty is expected and is not reported; " +
          "only floors that break the trend on two or more independent measures are.",
      );
    } else {
      for (const a of balance.anomalies) {
        L.push("### Floor " + a.floor + " breaks the curve");
        L.push("");
        L.push(a.detail);
        L.push("");
        L.push("| measure | observed | expected | ratio |");
        L.push("|---|---|---|---|");
        for (const s of a.signals) {
          L.push("| " + s.metric + " | " + s.value + " | " + s.expected + " | " + s.ratio + "x |");
        }
        L.push("");
      }
    }
    L.push("");
  }

  if (tier1) {
    const absorption = tier1.decisions > 0 ? tier1.absorbed / tier1.decisions : 1;
    L.push("## Cost and behaviour");
    L.push("");
    L.push("| metric | value |");
    L.push("|---|---|");
    L.push("| steps | " + tier1.steps + " |");
    L.push("| free steps (forced moves, loading, exploration) | " + tier1.freeSteps + " |");
    L.push("| model decisions | " + tier1.decisions + " |");
    L.push("| **tier-1 absorption** | **" + (absorption * 100).toFixed(1) + "%** |");
    L.push("| System One calls | " + tier1.socCalls + " |");
    L.push("| System One questions | " + tier1.socQuestions + " |");
    L.push("| invariant evaluations | " + tier1.invariantAsks + " |");
    L.push("| tier-2 (LLM) calls | " + tier1.plannerCalls + " |");
    L.push("| input tokens (est.) | " + tier1.inputTokens.toLocaleString() + " |");
    L.push("");
    L.push(
      "Absorption is the share of decisions resolved without waking Tier 2, and it is the cost model: " +
        "every point of absorption lost is an LLM call added to every run. " +
        "Questions exceed calls because the invariant suite is evaluated in a single parallel pass - " +
        tier1.invariantAsks +
        " invariant evaluations cost what one call costs.",
    );
    L.push("");
  }

  if (calibration && calibration.n > 0) {
    L.push("## Calibration");
    L.push("");
    L.push("```");
    L.push(renderReliabilityDiagram(calibration));
    L.push("```");
    L.push("");
    L.push(
      "This is not a diagnostic afterthought: the measured error rate (" +
        (calibration.errorRate * 100).toFixed(1) +
        "%) is the threshold the invariant reporting gate uses to decide whether a violation rate " +
        "is a defect or noise, and the recommended gate is what the escalation decision uses.",
    );
    L.push("");
  }

  return L.join("\n");
}

function renderFinding(
  d: DedupedFinding,
  replayPaths: Map<string, string> | undefined,
  replayDir: string | undefined,
): string {
  const f = d.finding;
  const L: string[] = [];
  L.push("### " + severityBadge(f.severity) + " " + f.title);
  L.push("");
  L.push(
    "`" +
      f.bugClass +
      "` - found by **" +
      f.source +
      "**" +
      (f.confidence !== undefined ? " at confidence " + f.confidence.toFixed(2) : "") +
      " - first seen at step " +
      f.step +
      (d.occurrences > 1 ? ", observed " + d.occurrences + " times" : ""),
  );
  L.push("");
  L.push(f.detail);
  L.push("");

  if (f.evidence && Object.keys(f.evidence).length > 0) {
    L.push("<details><summary>Evidence</summary>");
    L.push("");
    L.push("```json");
    L.push(JSON.stringify(f.evidence, null, 2));
    L.push("```");
    L.push("");
    L.push("</details>");
    L.push("");
  }

  const path = replayPaths?.get(f.id);
  L.push("**Reproduce** - seed `" + f.replay.seed + "`, " + f.replay.actions.length + " actions:");
  L.push("");
  L.push("```bash");
  if (path && replayDir) {
    // Forward slashes: this line is copied into a shell, including on Windows.
    L.push("npm run replay -- " + replayDir + "/" + path);
  } else {
    L.push("npm run replay -- --seed " + f.replay.seed);
  }
  L.push("```");
  L.push("");
  return L.join("\n");
}

function severityBadge(s: Severity): string {
  switch (s) {
    case "critical":
      return "[CRITICAL]";
    case "high":
      return "[HIGH]";
    case "medium":
      return "[MEDIUM]";
    case "low":
      return "[LOW]";
  }
}
