import type { BugClass, Finding, Severity } from "../types.ts";
import type { SocState } from "../soc/serialize.ts";
import type { NoulAnswer, SystemOneClient } from "../soc/types.ts";
import { mkFinding } from "./oracle.ts";

/**
 * Natural-language invariants, evaluated by the System One model every step.
 *
 * ## The obvious objection
 *
 * "`deltas.gold < 0` is three characters of JavaScript - why involve a model?"
 *
 * Because the hard part is not evaluating the predicate, it is *knowing which
 * predicate applies*. Plain code can check that gold went down. It cannot know that
 * `buy_elixir` is a purchase and ought to cost something, that `use_potion` should
 * consume an inventory item, or that a screen with no exit control is a trap - not
 * without a human writing a bespoke assertion per control, per screen, per game,
 * and rewriting them all whenever the UI changes.
 *
 * The invariants below are written the way a designer writes them in a GDD, once,
 * in English, and applied across every screen and every game by a model that reads
 * the state. That generalisation is the entire value proposition. The `applies`
 * predicates are cheap deterministic gates that decide *when to ask*, not what the
 * answer is - keeping them dumb is deliberate, because a gate that is too clever
 * starts encoding the very per-game knowledge we are trying to avoid.
 *
 * ## Why this is affordable
 *
 * Every applicable invariant goes into ONE `ask()` call and is evaluated in a single
 * parallel pass. Ten invariants cost what one costs. With a generative model you
 * would pay per assertion per step and this design would be absurd.
 */

export interface Invariant {
  id: string;
  /** The proposition, phrased so that `true` is the healthy answer. */
  prompt: string;
  title: string;
  bugClass: BugClass;
  severity: Severity;
  /** What each answer means. Sharpens the boundary for the model. */
  criteria?: { true: string; false: string };
  /**
   * How occurrences collapse into one defect.
   *
   * "screen" (the default) is right for screen-local properties like having an
   * exit. "global" is right for properties of the whole application - a wrong
   * basket total is ONE bug, and keying it per screen reported the same defect
   * five times, once for each screen that displayed the bad total.
   */
  dedupeBy?: "screen" | "global";
  /** Cheap gate: is this invariant even relevant to the current state? */
  applies(s: SocState): boolean;
}

export interface Escalation {
  invariantId: string;
  /** The invariant itself, so Tier 2 can report it under its real name. */
  invariant: Invariant;
  prompt: string;
  answer: NoulAnswer;
  state: SocState;
  step: number;
  reason: string;
}

export interface InvariantCheckResult {
  findings: Finding[];
  escalations: Escalation[];
  /** Invariants asked this step. */
  asked: number;
}

export interface InvariantCheckerOptions {
  /**
   * Confidence below which a violation is not reported directly but handed to
   * Tier 2. Set this from measured calibration, never by taste - see
   * calibration/harness.ts.
   */
  escalateBelow?: number;
  /**
   * How many times an invariant must be seen violated, on distinct steps inside
   * `confirmWindow`, before anything is reported or escalated.
   */
  confirmations?: number;
  /** How many recent opportunities per invariant to keep as evidence. */
  evidenceWindow?: number;
  /** Minimum opportunities before any judgement is made at all. */
  minOpportunities?: number;
  /**
   * The model's measured error rate on this workload, from the calibration
   * harness. A violation rate is only believed when its statistical lower bound
   * clears this - which is what makes the gate a measurement rather than a guess.
   */
  expectedErrorRate?: number;
  /**
   * How far the violation rate's lower bound must clear the model's error rate.
   *
   * A bare comparison is not enough. Early in the evidence window the denominator
   * is small, and three stray errors out of five give a Wilson lower bound of 0.23
   * - comfortably above a 0.15 error rate, and a false bug report. Requiring 2x
   * separation costs a little detection latency and removes that whole class of
   * early-window false positive.
   */
  safetyMargin?: number;
  /**
   * Minimum share of *opportunities* that must be violations before reporting.
   *
   * This is the discriminator that actually works. A genuine defect fails on
   * essentially every opportunity (rate ~1.0); model error fails at the model's
   * error rate (~0.1-0.25). A raw count cannot tell them apart, because an
   * invariant asked on a screen the bot revisits hundreds of times will accumulate
   * a few stray errors no matter how high the count threshold.
   */
  minViolationRate?: number;
}

/**
 * Wilson score lower bound for a binomial proportion at ~95% confidence.
 *
 * Preferred over the naive count/total because it is honest about small samples:
 * 2 violations out of 2 gives a point estimate of 100% but a lower bound of only
 * ~34%, which correctly refuses to call it a defect yet. This is what stops rare
 * invariants from producing confident nonsense.
 */
export function wilsonLowerBound(successes: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

export class InvariantChecker {
  private client: SystemOneClient;
  private invariants: Invariant[];
  private escalateBelow: number;
  private confirmations: number;
  private evidenceWindow: number;
  private minOpportunities: number;
  private expectedErrorRate: number;
  private safetyMargin: number;
  private minViolationRate: number;
  /** Every opportunity per invariant inside the window, violated or not. */
  private observations = new Map<string, Array<{ step: number; violated: boolean }>>();

  constructor(
    client: SystemOneClient,
    invariants: Invariant[],
    opts: InvariantCheckerOptions = {},
  ) {
    this.client = client;
    this.invariants = invariants;
    this.escalateBelow = opts.escalateBelow ?? 0.75;
    this.confirmations = opts.confirmations ?? 3;
    this.evidenceWindow = opts.evidenceWindow ?? 20;
    this.minOpportunities = opts.minOpportunities ?? 8;
    this.expectedErrorRate = opts.expectedErrorRate ?? 0.15;
    this.safetyMargin = opts.safetyMargin ?? 2;
    this.minViolationRate = opts.minViolationRate ?? 0.5;
  }

  reset(): void {
    this.observations.clear();
  }

  /** Scope of both the evidence window and the reported defect. */
  private keyFor(inv: Invariant, screen: string): string {
    return inv.dedupeBy === "global" ? "inv:" + inv.id : "inv:" + inv.id + ":" + screen;
  }

  /**
   * Records one opportunity for an invariant and reports whether the evidence is
   * now strong enough to act on.
   *
   * Confirmation must come from *new evidence*, which here means later steps where
   * the invariant applied again. The tempting alternative - re-ask the same question
   * two more times and require unanimity - is worthless against Jev or Laya: they
   * are deterministic, so identical input yields an identical answer and the extra
   * "samples" are perfectly correlated. Only genuinely different states are
   * independent evidence.
   *
   * Both a count and a *rate* are required. The count stops a single stray answer
   * from becoming a bug report; the rate is what separates a defect from noise,
   * because a real defect fails on nearly every opportunity while a model error
   * rate stays near the model's accuracy gap. Count alone fails badly on invariants
   * that are asked hundreds of times.
   *
   * The key is the SAME key the finding dedupes on, and that matters. Keying
   * evidence by invariant id alone pools observations across unrelated contexts:
   * a screen-scoped invariant genuinely violated on one screen dragged the
   * measured rate up everywhere, and a single stray answer on a healthy screen
   * then cleared the gate on borrowed evidence. That produced confident false
   * positives on two screens that were entirely fine.
   */
  private record(
    evidenceKey: string,
    step: number,
    violated: boolean,
  ): { ok: boolean; count: number; total: number; rate: number; lower: number } {
    const arr = this.observations.get(evidenceKey) ?? [];
    arr.push({ step, violated });
    // Keep the last N opportunities rather than the last N steps: a step window
    // leaves rarely-applicable invariants with a denominator of one or two, where
    // no rate is meaningful.
    while (arr.length > this.evidenceWindow) arr.shift();
    this.observations.set(evidenceKey, arr);

    const count = arr.reduce((n, o) => n + (o.violated ? 1 : 0), 0);
    const total = arr.length;
    const rate = total > 0 ? count / total : 0;
    const lower = wilsonLowerBound(count, total);

    const ok =
      count >= this.confirmations &&
      total >= this.minOpportunities &&
      rate >= this.minViolationRate &&
      lower > this.expectedErrorRate * this.safetyMargin;

    return { ok, count, total, rate, lower };
  }

  async check(
    state: SocState,
    ctx: { step: number; seed: number; actionLog: import("../types.ts").Action[] },
  ): Promise<InvariantCheckResult> {
    const applicable = this.invariants.filter((inv) => inv.applies(state));
    if (applicable.length === 0) return { findings: [], escalations: [], asked: 0 };

    // One call, all questions - the parallel pass is what makes this cheap.
    const answers = (await this.client.ask(
      state,
      applicable.map((inv) => ({
        id: inv.id,
        kind: "noul" as const,
        prompt: inv.prompt,
        ...(inv.criteria ? { criteria: inv.criteria } : {}),
      })),
    )) as NoulAnswer[];

    const byId = new Map(answers.map((a) => [a.id, a]));
    const findings: Finding[] = [];
    const escalations: Escalation[] = [];

    for (const inv of applicable) {
      const a = byId.get(inv.id);
      if (!a) continue;

      // Every opportunity is recorded, held or violated - the rate needs the
      // denominator. Evidence is scoped exactly as the finding is.
      const evidenceKey = this.keyFor(inv, state.screen);
      const conf = this.record(evidenceKey, ctx.step, a.value === false);
      if (a.value === true) continue; // invariant holds
      if (!conf.ok) continue;

      if (a.p < this.escalateBelow) {
        escalations.push({
          invariantId: inv.id,
          invariant: inv,
          prompt: inv.prompt,
          answer: a,
          state,
          step: ctx.step,
          reason:
            "violation reported at confidence " +
            a.p.toFixed(2) +
            ", below the " +
            this.escalateBelow +
            " gate",
        });
        continue;
      }

      findings.push(
        mkFinding({
          severity: inv.severity,
          bugClass: inv.bugClass,
          title: inv.title,
          detail:
            "Invariant violated: " +
            JSON.stringify(inv.prompt) +
            ". Last action was '" +
            state.lastAction +
            "' on screen '" +
            state.screen +
            "'. Observed changes: " +
            (Object.keys(state.deltas).length ? JSON.stringify(state.deltas) : "none") +
            ". Model confidence " +
            a.p.toFixed(2) +
            ", violated on " +
            conf.count +
            " of " +
            conf.total +
            " recent opportunities (" +
            Math.round(conf.rate * 100) +
            "%, lower bound " +
            Math.round(conf.lower * 100) +
            "% vs the " +
            Math.round(this.expectedErrorRate * this.safetyMargin * 100) +
            "% needed to clear model noise).",
          step: ctx.step,
          source: "tier1",
          confidence: a.p,
          dedupeKey: evidenceKey,
          replay: { seed: ctx.seed, actions: [...ctx.actionLog] },
          evidence: {
            invariant: inv.id,
            screen: state.screen,
            lastAction: state.lastAction,
            deltas: state.deltas,
            vars: state.vars,
            confidence: a.p,
            violations: conf.count,
            opportunities: conf.total,
            violationRate: Number(conf.rate.toFixed(3)),
            violationRateLowerBound: Number(conf.lower.toFixed(3)),
          },
        }),
      );
    }

    return { findings, escalations, asked: applicable.length };
  }
}
