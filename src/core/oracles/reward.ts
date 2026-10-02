import type { Finding } from "../types.ts";
import type { Oracle } from "./oracle.ts";
import { mkFinding } from "./oracle.ts";
import { wilsonLowerBound } from "./invariants.ts";

/**
 * Reward per unit of work should not vary wildly between otherwise similar actions.
 *
 * This exists because a real defect class was invisible to every yes/no invariant in
 * the suite. The fixture plants a bug where cascade clears award no points: the
 * player makes a big chain, the score still goes up (the first link scores), and so
 * "did clearing tiles increase the score?" is honestly answered YES. Nothing is
 * wrong on any single move. What is wrong is the RATE -- some moves pay about 20
 * points a tile and others pay 8 -- and a rate is a property of a distribution, not
 * of a state. No amount of rephrasing a per-step question can reach it.
 *
 * It also cannot be a Tier-1 question, for the reason the invariant file already
 * states about arithmetic: asking a non-generative model to compare a ratio against
 * a running median across two hundred samples is precisely what it is worst at. So
 * it is deterministic code over accumulated observations, with no model and no cost.
 *
 * Deliberately generic. "Work" and "reward" are variable names supplied by the
 * caller, so the same oracle covers tiles cleared against score, enemies killed
 * against experience, or items sold against currency. The property being asserted --
 * that a game pays consistently for the same effort -- is a design invariant of
 * almost every game with a number that goes up, and a player notices when it breaks
 * long before they can explain why.
 */

export interface RewardConsistencySpec {
  /** Variable measuring effort spent on this step, e.g. tiles cleared. */
  workVar: string;
  /** Variable measuring the reward, compared against its own previous value. */
  rewardVar: string;
  /** Human name for the report. */
  label?: string;
  /**
   * Samples needed before any claim is made. A median over a handful of moves is
   * not a baseline, and firing early is how a detector earns distrust.
   */
  minSamples?: number;
  /** A sample this far below the median rate is "underpaid". */
  underpaidRatio?: number;
  /** Minimum number of underpaid samples. Guards against a lucky outlier. */
  minUnderpaid?: number;
  /** Which low quantile must itself be underpaid. */
  tailQuantile?: number;
  /**
   * Smallest amount of work that counts as work at all.
   *
   * Needed because `work` can come from vision. On the live pipeline `movedCells` is
   * a diff of board cell labels read from pixels, so a couple of misread cells on a
   * swap the game actually REJECTED looks like work was done -- and with the score
   * correctly unchanged, that reads as "the player was paid nothing for their
   * effort". It produced confident score findings on a build whose only planted bug
   * was somewhere else entirely.
   *
   * Setting this to the smallest legitimate unit of work in the genre (a match-3
   * clear is three tiles) separates real work from read noise. It is a property of
   * the game's rules, not a tuned threshold.
   */
  minWork?: number;
  /**
   * Largest believable amount of work in one action. Samples above it are discarded
   * as misreads rather than treated as enormous effort.
   *
   * Measured live: a move whose true effect was 9 changed cells was read as 61 -- a
   * capture that landed mid-cascade and saw nearly the whole board in flight. One
   * sample like that drags a per-unit rate far enough to invent a defect by itself.
   */
  maxWork?: number;
  /**
   * Whether to run the per-unit RATE test at all. Default true.
   *
   * Switched off wherever the work count comes from vision, on a measurement rather
   * than out of caution. Against the fixture's ground truth the cell count is exact
   * on 80% of moves, so a rate -- needing the work count AND the reward right --
   * carries roughly 20% input error, while the defect it looks for (cascades that pay
   * nothing) appears in about 7% of moves. Noise exceeds signal threefold and no
   * threshold separates them: set low it reports clean builds, set high it reports
   * nothing at all.
   *
   * That is a clean argument for the plan's dual-pipeline idea. The same test finds
   * the planted bug on the headless bench, where the count is exact, so what it needs
   * is a better input -- an injected scene tree -- not a better threshold.
   */
  checkRate?: boolean;
  /**
   * Also report any single action that did work and was paid nothing at all.
   *
   * Deterministic, and it belongs here rather than in a model question for the
   * reason this codebase learned the hard way: asked "did the score go up?" with
   * "score before: 1180, score after: 1240, change: +60" in front of it, the real
   * model still answered no, on a clean build. Comparing two numbers is exactly what
   * a non-generative model is worst at and exactly what plain code is perfect at.
   */
  requirePositive?: boolean;
  /**
   * Error rate of the INPUT variables, when they come from perception.
   *
   * This oracle is called deterministic, and it is -- but only as deterministic as
   * the numbers it is given. In-process, tiles cleared and score are exact and any
   * mismatch is a real defect. Through the live pipeline both come from vision: the
   * score is OCR'd and the cell count is a diff of board labels read from pixels.
   * Measured against the fixture's out-of-band ground truth, the score reads
   * correctly about 97% of the time once cross-scale verification is applied -- and a
   * claim needs the value right on BOTH sides of an action, so a few percent of
   * action pairs carry a wrong number.
   *
   * That was enough to produce confident economy findings on a CLEAN build, which is
   * the disqualifying failure. Three percent of two hundred moves is six apparent
   * defects, indistinguishable from a real bug by count alone.
   *
   * So a Tier-0 claim over a perception channel earns the same statistical discipline
   * the Tier-1 invariants already have: the observed violation rate must clear the
   * input's own error rate, judged by a Wilson lower bound so a small sample cannot
   * claim a high rate. Set it to 0 for an exact source, which restores the old
   * behaviour of reporting the first mismatch.
   */
  inputErrorRate?: number;
  /** Multiplier on the input error rate the violation rate must clear. */
  safetyMargin?: number;
}

interface Sample {
  rate: number;
  step: number;
}

const DEFAULTS = {
  minSamples: 40,
  minWork: 1,
  maxWork: Number.POSITIVE_INFINITY,
  checkRate: true,
  inputErrorRate: 0,
  safetyMargin: 2,
  /**
   * Paying 40% less than the median for the same work is the anomaly threshold.
   * Deliberately wide: real games pay bonuses and multipliers, so rates ABOVE the
   * median are normal and mild variation below it is too.
   */
  underpaidRatio: 0.6,
  minUnderpaid: 8,
  /**
   * The test is on the low TAIL, not on the share of underpaid samples, and that
   * distinction came from measurement.
   *
   * Playing the fixture 687 moves on a clean build gives a rate of exactly 20.0 per
   * tile at every quantile -- median 20.0, minimum 20.0. The planted cascade bug
   * gives the same median of 20.0 with a minimum of 2.7 and a tenth percentile of
   * 10.0. So the median is useless as a signal and only the tail moves.
   *
   * A share test also failed: the underpaid moves were 7% of the total, and any
   * share threshold low enough to catch that is low enough to be tripped by a
   * handful of outliers. A quantile is robust to outliers by construction, which is
   * what makes it the right statistic here.
   */
  tailQuantile: 0.1,
};

export function makeRewardConsistencyOracle(specs: RewardConsistencySpec[]): Oracle {
  // One accumulator per spec, keyed by index; the oracle is stateful across steps,
  // which is the whole point -- a distribution cannot be seen one state at a time.
  const samples: Sample[][] = specs.map(() => []);
  const reported = new Set<number>();
  const zeroReward: number[] = specs.map(() => 0);
  const workSeen: number[] = specs.map(() => 0);
  const zeroReported = new Set<number>();

  return {
    name: "reward-consistency",
    check(ctx): Finding[] {
      const out: Finding[] = [];
      if (!ctx.prev) return out;

      for (const [i, spec] of specs.entries()) {
        const cfg = { ...DEFAULTS, ...spec };
        const work = ctx.cur.vars[spec.workVar];
        const rewardNow = ctx.cur.vars[spec.rewardVar];
        const rewardBefore = ctx.prev.vars[spec.rewardVar];
        if (typeof work !== "number" || work < Math.max(1, cfg.minWork)) continue;
        if (work > cfg.maxWork) continue;   // implausible: a misread, not effort
        if (typeof rewardNow !== "number" || typeof rewardBefore !== "number") continue;

        // A reward that RESET rather than changed -- a new level zeroing the score --
        // is not an underpaid move. Without this guard every level transition looks
        // like the game refusing to pay, which is a false positive the fixture
        // produces on a clean build every twenty moves.
        const delta = rewardNow - rewardBefore;
        if (delta < 0) continue;

        // Zero-reward occurrences are counted first and only reported once the rate
        // clears the input channel's noise floor.
        if (spec.requirePositive && delta <= 0) {
          zeroReward[i] = (zeroReward[i] ?? 0) + 1;
        }
        if (spec.requirePositive) workSeen[i] = (workSeen[i] ?? 0) + 1;

        const zr = zeroReward[i] ?? 0;
        const ws = workSeen[i] ?? 0;
        const floorRate = cfg.inputErrorRate * cfg.safetyMargin;
        const clears = ws > 0 && wilsonLowerBound(zr, ws) > floorRate;
        if (spec.requirePositive && zr > 0 && clears && !zeroReported.has(i) &&
            ws >= Math.min(cfg.minSamples, 20)) {
          zeroReported.add(i);
          out.push(
            mkFinding({
              severity: "high",
              bugClass: "flow",
              title: "Work done with no reward: " + (spec.label ?? spec.rewardVar),
              detail:
                zr + " of " + ws + " actions that did measurable " + spec.workVar +
                " produced no increase in " + spec.rewardVar +
                " (most recently " + work + " " + spec.workVar + " for a change of " +
                delta + "). That rate clears the " +
                (floorRate * 100).toFixed(1) +
                "% expected from reading these numbers off the screen. Effort that " +
                "pays nothing reads to a player as the game losing their progress.",
              step: ctx.cur.step,
              source: "tier0",
              dedupeKey: "zero-reward:" + spec.workVar + ":" + spec.rewardVar,
              replay: { seed: ctx.seed, actions: [...ctx.actionLog] },
              evidence: {
                work, delta, workVar: spec.workVar, rewardVar: spec.rewardVar,
                zeroRewardCount: zr, workActions: ws,
                rateLowerBound: Number(wilsonLowerBound(zr, ws).toFixed(3)),
                inputNoiseFloor: Number(floorRate.toFixed(3)),
              },
            }),
          );
        }

        samples[i]!.push({ rate: delta / work, step: ctx.cur.step });
        const all = samples[i]!;
        if (!cfg.checkRate || all.length < cfg.minSamples || reported.has(i)) continue;

        const rates = all.map((s) => s.rate).sort((a, b) => a - b);
        const median = rates[Math.floor(rates.length / 2)]!;
        if (median <= 0) continue;

        const floor = median * cfg.underpaidRatio;
        const tail = rates[Math.floor(rates.length * cfg.tailQuantile)]!;
        const underpaid = all.filter((s) => s.rate < floor);
        const share = underpaid.length / all.length;
        // Both must hold: the low tail is genuinely underpaid (a distribution-level
        // fact, robust to outliers) and enough samples are underpaid to rule out a
        // coincidence.
        // The underpaid population must also clear the input noise floor, for the
        // same reason: a few percent of misread score pairs put a low tail into an
        // otherwise perfectly consistent distribution, and on a clean build through
        // the live pipeline that was enough to claim the game pays inconsistently.
        const underpaidClears =
          wilsonLowerBound(underpaid.length, all.length) >
          cfg.inputErrorRate * cfg.safetyMargin;
        if (tail >= floor || underpaid.length < cfg.minUnderpaid || !underpaidClears) continue;

        reported.add(i);
        const worst = underpaid.reduce((a, b) => (a.rate < b.rate ? a : b));
        const name = spec.label ?? spec.rewardVar + " per " + spec.workVar;
        out.push(
          mkFinding({
            severity: "high",
            bugClass: "flow",
            title: "Inconsistent reward: " + name,
            detail:
              "The game pays " +
              name +
              " at a median rate of " +
              median.toFixed(1) +
              ", but " +
              underpaid.length +
              " of " +
              all.length +
              " actions (" +
              Math.round(share * 100) +
              "%) paid less than " +
              (cfg.underpaidRatio * 100).toFixed(0) +
              "% of that, as low as " +
              worst.rate.toFixed(1) +
              " at step " +
              worst.step +
              " (tenth percentile " +
              tail.toFixed(1) +
              ")" +
              ". Every individual action did increase " +
              spec.rewardVar +
              ", so no single-step check can see this; the defect is in the rate. " +
              "A player experiences it as effort that sometimes does not count.",
            step: ctx.cur.step,
            source: "tier0",
            // One defect, however many moves show it.
            dedupeKey: "reward-consistency:" + spec.workVar + ":" + spec.rewardVar,
            replay: { seed: ctx.seed, actions: [...ctx.actionLog] },
            evidence: {
              medianRate: Number(median.toFixed(3)),
              underpaidShare: Number(share.toFixed(3)),
              tailRate: Number(tail.toFixed(3)),
              underpaidCount: underpaid.length,
              samples: all.length,
              worstRate: Number(worst.rate.toFixed(3)),
              worstStep: worst.step,
            },
          }),
        );
      }
      return out;
    },
  };
}


/**
 * A consumable was spent and nothing happened.
 *
 * The counterpart of reward consistency, and the same lesson a second time. The
 * fixture plants a bug where a rejected swap still costs the player a move; the
 * condition is a comparison of two observed numbers -- a cost went down, the work
 * done was zero -- and asking the model about it produced nothing usable while plain
 * code decides it exactly. Everything decidable by arithmetic belongs in Tier 0; the
 * model's budget is for judgment.
 *
 * Generic over the two variable names, so it covers moves in a puzzle game, ammo,
 * stamina, a charge, or currency spent on a purchase that never arrived. "You paid
 * and got nothing" is among the most player-visible faults there is, and among the
 * easiest to verify.
 */
export interface WastedCostSpec {
  /** Variable that decreases when the player is charged, e.g. moves remaining. */
  costVar: string;
  /** Variable measuring what the player got for it, e.g. tiles cleared. */
  workVar: string;
  label?: string;
  /** Occurrences before reporting, so one odd frame is not a finding. */
  minOccurrences?: number;
}

export function makeWastedCostOracle(specs: WastedCostSpec[]): Oracle {
  const seen = specs.map(() => 0);
  const reported = new Set<number>();

  return {
    name: "wasted-cost",
    check(ctx): Finding[] {
      const out: Finding[] = [];
      if (!ctx.prev) return out;

      for (const [i, spec] of specs.entries()) {
        const minOccurrences = spec.minOccurrences ?? 3;
        const now = ctx.cur.vars[spec.costVar];
        const before = ctx.prev.vars[spec.costVar];
        const work = ctx.cur.vars[spec.workVar];
        if (typeof now !== "number" || typeof before !== "number") continue;
        if (typeof work !== "number") continue;

        // A cost that went UP, or a reset at a new level, is not a charge.
        const spent = before - now;
        if (spent <= 0 || work > 0) continue;

        seen[i] = (seen[i] ?? 0) + 1;
        if ((seen[i] ?? 0) < minOccurrences || reported.has(i)) continue;
        reported.add(i);

        const name = spec.label ?? spec.costVar;
        out.push(
          mkFinding({
            severity: "high",
            bugClass: "flow",
            title: "Charged for nothing: " + name,
            detail:
              "On " + seen[i] + " occasions the player's " + spec.costVar +
              " was reduced while " + spec.workVar +
              " stayed at zero -- they were charged and nothing happened. " +
              "Most recently at step " + ctx.cur.step + ", where " + spec.costVar +
              " went from " + before + " to " + now + ".",
            step: ctx.cur.step,
            source: "tier0",
            dedupeKey: "wasted-cost:" + spec.costVar + ":" + spec.workVar,
            replay: { seed: ctx.seed, actions: [...ctx.actionLog] },
            evidence: {
              occurrences: seen[i], costVar: spec.costVar, workVar: spec.workVar,
              lastBefore: before, lastAfter: now,
            },
          }),
        );
      }
      return out;
    },
  };
}
