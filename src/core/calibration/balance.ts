import type { Action, GameState } from "../types.ts";

/**
 * Balance analysis.
 *
 * Deliberately NOT a per-episode judgement. One encounter rated 5/5 means nothing:
 * the player may simply have arrived underlevelled, out of potions, or unlucky.
 * Difficulty is a distribution, so it is instrumented here and interpreted only
 * after aggregation across many runs.
 *
 * The model's 1-5 `score` alone is not enough either, and the reason is worth
 * stating: **the rubric saturates.** Deep floors all rate 5, so a genuine 10x spike
 * at floor 7 is invisible inside a wall of 5s. Objective outcome telemetry - turns
 * to clear, death rate, health lost - has no ceiling and shows the discontinuity
 * plainly. The score is kept because it captures perceived difficulty, which is
 * what designers actually care about; the telemetry is what makes it measurable.
 */

export interface Encounter {
  floor: number;
  turns: number;
  hpLost: number;
  result: "won" | "died" | "fled" | "abandoned";
}

export interface FloorStats {
  floor: number;
  n: number;
  meanTurns: number;
  meanHpLost: number;
  deathRate: number;
  /** Mean of the model's 1-5 perceived-difficulty score, when sampled. */
  meanScore: number | null;
}

export interface BalanceSignal {
  metric: "turns" | "hpLost" | "deathRate";
  value: number;
  /** Robust expectation from the preceding floors. */
  expected: number;
  ratio: number;
  text: string;
}

export interface BalanceAnomaly {
  floor: number;
  n: number;
  /** Independent metrics that agree. Corroboration is required to report. */
  signals: BalanceSignal[];
  detail: string;
}

/**
 * Watches a run and emits one record per combat encounter.
 *
 * Encounters are delimited by screen transitions rather than by counting attacks,
 * so fleeing, dying and walking away are all captured rather than silently dropped.
 */
export class BalanceRecorder {
  readonly encounters: Encounter[] = [];
  private active: { floor: number; turns: number; hpAtStart: number } | null = null;

  observe(before: GameState, action: Action, after: GameState): void {
    const wasCombat = before.screen === "combat";
    const isCombat = after.screen === "combat";

    if (!wasCombat && isCombat) {
      this.active = {
        floor: Number(after.vars["floor"] ?? 0),
        turns: 0,
        hpAtStart: Number(after.vars["hp"] ?? 0),
      };
      return;
    }

    if (wasCombat && isCombat && this.active) {
      if (action.type === "tap" && action.targetId === "attack") this.active.turns += 1;
      return;
    }

    if (wasCombat && !isCombat && this.active) {
      const hpNow = Number(after.vars["hp"] ?? 0);
      const result: Encounter["result"] =
        after.screen === "gameover"
          ? "died"
          : action.type === "tap" && action.targetId === "flee"
            ? "fled"
            : this.active.turns > 0
              ? "won"
              : "abandoned";
      this.encounters.push({
        floor: this.active.floor,
        turns: this.active.turns,
        hpLost: Math.max(0, this.active.hpAtStart - hpNow),
        result,
      });
      this.active = null;
    }
  }
}

export function aggregate(
  encounters: Encounter[],
  scores: Array<{ floor: number; score: number }> = [],
): FloorStats[] {
  const byFloor = new Map<number, Encounter[]>();
  for (const e of encounters) {
    const arr = byFloor.get(e.floor) ?? [];
    arr.push(e);
    byFloor.set(e.floor, arr);
  }
  const scoreByFloor = new Map<number, number[]>();
  for (const s of scores) {
    const arr = scoreByFloor.get(s.floor) ?? [];
    arr.push(s.score);
    scoreByFloor.set(s.floor, arr);
  }

  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  return [...byFloor.keys()]
    .sort((a, b) => a - b)
    .map((floor) => {
      const es = byFloor.get(floor)!;
      const sc = scoreByFloor.get(floor);
      return {
        floor,
        n: es.length,
        meanTurns: mean(es.map((e) => e.turns)),
        meanHpLost: mean(es.map((e) => e.hpLost)),
        deathRate: es.filter((e) => e.result === "died").length / es.length,
        meanScore: sc && sc.length ? mean(sc) : null,
      };
    });
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Flags floors that break the *preceding* trend.
 *
 * Two design points, both learned by getting it wrong first:
 *
 * 1. **The baseline is trailing, not surrounding.** Difficulty is supposed to rise
 *    monotonically, so comparing a floor against its neighbours on both sides lets
 *    the naturally-harder later floors absorb the anomaly. On the reference game a
 *    real 10x spike at floor 7 was invisible against a neighbourhood that included
 *    floors 8 and 9, and obvious against floors 5 and 6.
 *
 * 2. **Several metrics, because turns-to-clear is censored by death.** A 10x
 *    health bar does not produce 10x turns if the player dies a third of the way
 *    through - the encounter simply ends early, and the metric understates the
 *    spike badly (1.6x observed for a 10x change). Health lost and death rate are
 *    not censored that way and show it plainly.
 */
export function detectAnomalies(
  stats: FloorStats[],
  opts: {
    minSamples?: number;
    turnsRatio?: number;
    hpLostRatio?: number;
    deathRateJump?: number;
    lookback?: number;
    /** Metrics that must agree before a floor is reported. */
    minCorroboration?: number;
    /** Baselines below this are too small for a ratio to mean anything. */
    minBaselineHp?: number;
    minBaselineTurns?: number;
  } = {},
): BalanceAnomaly[] {
  const minSamples = opts.minSamples ?? 3;
  const turnsRatio = opts.turnsRatio ?? 2.0;
  // 2.0, chosen from measurement rather than taste: on the reference game the
  // clean build's largest health-loss break is 1.56x (normal curve) and the
  // planted floor-7 spike sits at 2.4x, so the threshold belongs between them.
  // It was 2.5 and silently missed the spike by 0.07.
  const hpLostRatio = opts.hpLostRatio ?? 2.0;
  const deathRateJump = opts.deathRateJump ?? 0.2;
  const lookback = opts.lookback ?? 2;
  const minCorroboration = opts.minCorroboration ?? 2;
  const minBaselineHp = opts.minBaselineHp ?? 3;
  const minBaselineTurns = opts.minBaselineTurns ?? 1;

  const usable = stats.filter((s) => s.n >= minSamples);
  const out: BalanceAnomaly[] = [];

  for (let i = lookback; i < usable.length; i++) {
    const cur = usable[i]!;
    const prior = usable.slice(Math.max(0, i - lookback), i);
    if (prior.length < lookback) continue;

    const baseTurns = median(prior.map((p) => p.meanTurns));
    const baseHp = median(prior.map((p) => p.meanHpLost));
    const baseDeath = median(prior.map((p) => p.deathRate));
    const signals: BalanceSignal[] = [];

    if (baseHp >= minBaselineHp && cur.meanHpLost / baseHp >= hpLostRatio) {
      const ratio = cur.meanHpLost / baseHp;
      signals.push({
        metric: "hpLost",
        value: Number(cur.meanHpLost.toFixed(2)),
        expected: Number(baseHp.toFixed(2)),
        ratio: Number(ratio.toFixed(2)),
        text:
          "costs " +
          cur.meanHpLost.toFixed(1) +
          " health per encounter against " +
          baseHp.toFixed(1) +
          " on the preceding floors (" +
          ratio.toFixed(1) +
          "x)",
      });
    }

    if (cur.deathRate - baseDeath >= deathRateJump) {
      signals.push({
        metric: "deathRate",
        value: Number(cur.deathRate.toFixed(3)),
        expected: Number(baseDeath.toFixed(3)),
        ratio: Number((cur.deathRate / Math.max(baseDeath, 0.01)).toFixed(2)),
        text:
          "death rate jumps to " +
          Math.round(cur.deathRate * 100) +
          "% from " +
          Math.round(baseDeath * 100) +
          "%",
      });
    }

    if (baseTurns >= minBaselineTurns && cur.meanTurns / baseTurns >= turnsRatio) {
      const ratio = cur.meanTurns / baseTurns;
      signals.push({
        metric: "turns",
        value: Number(cur.meanTurns.toFixed(2)),
        expected: Number(baseTurns.toFixed(2)),
        ratio: Number(ratio.toFixed(2)),
        text:
          "takes " +
          cur.meanTurns.toFixed(1) +
          " turns to clear against " +
          baseTurns.toFixed(1) +
          " (" +
          ratio.toFixed(1) +
          "x)",
      });
    }

    // Corroboration gate.
    //
    // Death rate alone cannot tell a planted spike from a game's natural late
    // difficulty wall - measured on the reference game, the clean build's floor-8
    // ramp (3% -> 29%) and the planted floor-7 spike (0% -> 27%) are numerically
    // indistinguishable. What separates them is that the spike also breaks the
    // health-loss curve while the natural ramp does not. Requiring independent
    // metrics to agree is the same principle that makes the softlock finding
    // trustworthy when Tier 0 and Tier 1 reach it by different routes.
    if (signals.length < minCorroboration) continue;

    out.push({
      floor: cur.floor,
      n: cur.n,
      signals,
      detail:
        "Floor " +
        cur.floor +
        " breaks the difficulty curve on " +
        signals.length +
        " independent measures: " +
        signals.map((x) => x.text).join("; ") +
        "." +
        (cur.meanScore !== null
          ? " Perceived difficulty " + cur.meanScore.toFixed(1) + "/5."
          : "") +
        " Measured over " +
        cur.n +
        " encounters against the " +
        lookback +
        " preceding floors.",
    });
  }
  return out;
}

export function renderBalanceTable(stats: FloorStats[]): string {
  const lines: string[] = [];
  lines.push("floor   n    turns   hpLost  deathRate  score");
  lines.push("------------------------------------------------");
  for (const s of stats) {
    lines.push(
      String(s.floor).padEnd(8) +
        String(s.n).padEnd(5) +
        s.meanTurns.toFixed(1).padEnd(8) +
        s.meanHpLost.toFixed(1).padEnd(8) +
        (s.deathRate * 100).toFixed(0).padStart(3) +
        "%" +
        "      " +
        (s.meanScore === null ? "-" : s.meanScore.toFixed(1)),
    );
  }
  return lines.join("\n");
}
