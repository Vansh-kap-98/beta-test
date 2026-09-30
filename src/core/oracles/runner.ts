import type { Action, Finding, GameState, Severity } from "../types.ts";
import type { Oracle, OracleContext } from "./oracle.ts";

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface DedupedFinding {
  finding: Finding;
  /** How many times this defect was observed. First occurrence is the one kept. */
  occurrences: number;
  lastStep: number;
}

/**
 * Drives the oracle set over a run, maintaining the rolling window and collapsing
 * repeat observations of the same defect.
 *
 * Deduplication is not cosmetic. A softlock re-fires on every step it persists, and
 * a heap leak fires forever once tripped; without collapsing by `dedupeKey` a
 * 2000-step run reports thousands of "findings" and a developer reads none of them.
 */
export class OracleRunner {
  private oracles: Oracle[];
  private seed: number;
  private windowSize: number;
  private window: GameState[] = [];
  private windowActions: Action[] = [];
  private seen = new Map<string, DedupedFinding>();

  constructor(oracles: Oracle[], seed: number, windowSize = 40) {
    this.oracles = oracles;
    this.seed = seed;
    this.windowSize = windowSize;
  }

  /**
   * Record one observed state and the action that produced it, then run every
   * oracle. Returns only defects seen for the first time.
   */
  step(cur: GameState, action: Action | null, actionLog: Action[]): Finding[] {
    const prev = this.window[this.window.length - 1];
    this.window.push(cur);
    if (action) this.windowActions.push(action);
    if (this.window.length > this.windowSize) this.window.shift();
    if (this.windowActions.length > this.windowSize) this.windowActions.shift();

    const ctx: OracleContext = {
      seed: this.seed,
      cur,
      prev,
      window: this.window,
      windowActions: this.windowActions,
      actionLog,
    };

    const fresh: Finding[] = [];
    for (const oracle of this.oracles) {
      for (const f of oracle.check(ctx)) {
        const existing = this.seen.get(f.dedupeKey);
        if (existing) {
          existing.occurrences += 1;
          existing.lastStep = f.step;
          continue;
        }
        this.seen.set(f.dedupeKey, { finding: f, occurrences: 1, lastStep: f.step });
        fresh.push(f);
      }
    }
    return fresh;
  }

  /**
   * Deduplicate findings produced outside the oracle set - Tier 1 invariants and
   * Tier 2 adjudications. They go through the same collapsing as Tier 0 so a
   * report has one entry per defect regardless of which tier noticed it.
   */
  submit(findings: Finding[]): Finding[] {
    const fresh: Finding[] = [];
    for (const f of findings) {
      const existing = this.seen.get(f.dedupeKey);
      if (existing) {
        existing.occurrences += 1;
        existing.lastStep = f.step;
        continue;
      }
      this.seen.set(f.dedupeKey, { finding: f, occurrences: 1, lastStep: f.step });
      fresh.push(f);
    }
    return fresh;
  }

  /** All distinct defects, most severe first, then earliest. */
  results(): DedupedFinding[] {
    return [...this.seen.values()].sort((a, b) => {
      const s = SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity];
      return s !== 0 ? s : a.finding.step - b.finding.step;
    });
  }

  findings(): Finding[] {
    return this.results().map((r) => r.finding);
  }

  reset(): void {
    this.window = [];
    this.windowActions = [];
    this.seen.clear();
  }
}
