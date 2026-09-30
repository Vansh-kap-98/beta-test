import type { SocState } from "../soc/serialize.ts";
import type { Escalation } from "../oracles/invariants.ts";

/**
 * Tier 2: the slow, expensive, deliberative layer.
 *
 * It is never in the play loop. It is woken only when Tier 1 reports low
 * confidence, and its call count is the cost driver for the whole system - so the
 * interesting number this file exists to produce is not its accuracy but how rarely
 * it gets called.
 */

export interface PlannerDecision {
  action: string;
  rationale: string;
}

export interface PlannerVerdict {
  isBug: boolean;
  rationale: string;
}

export interface Planner {
  readonly name: string;
  readonly calls: number;
  chooseAction(state: SocState, options: string[], reason: string): Promise<PlannerDecision>;
  adjudicate(esc: Escalation): Promise<PlannerVerdict>;
}

/**
 * Offline Tier 2 that answers from ground truth.
 *
 * This deliberately models the *best case*: a Tier 2 that is always right. That is
 * the right stand-in for measuring the architecture, because it isolates the
 * question being asked - "how often must we escalate, and what does escalation
 * recover?" - from the separate question of how good a given LLM is. If the system
 * is uneconomic with a perfect Tier 2, no real model rescues it.
 */
export interface OraclePlannerTruth {
  /** The competent move on this screen, given the offered options. */
  bestControl(state: SocState, options: string[]): string | undefined;
  /** Whether the named invariant actually holds. `true` = healthy. */
  invariantHolds(state: SocState, invariantId: string): boolean | undefined;
}

export class OraclePlanner implements Planner {
  readonly name = "oracle-planner";
  calls = 0;
  private truth: OraclePlannerTruth;

  /**
   * Truth is injected rather than imported so that `core/` never depends on a
   * specific game. Any adapter can supply its own oracle for measurement.
   */
  constructor(truth: OraclePlannerTruth) {
    this.truth = truth;
  }

  async chooseAction(state: SocState, options: string[], reason: string): Promise<PlannerDecision> {
    this.calls += 1;
    const best = this.truth.bestControl(state, options) ?? options[0]!;
    return {
      action: best,
      rationale:
        "Tier 1 was unsure (" +
        reason +
        "). On screen '" +
        state.screen +
        "' the progressing move is " +
        best +
        ".",
    };
  }

  async adjudicate(esc: Escalation): Promise<PlannerVerdict> {
    this.calls += 1;
    const truth = this.truth.invariantHolds(esc.state, esc.invariantId);
    // The invariant is phrased so `true` is healthy; a bug is truth === false.
    const isBug = truth === false;
    return {
      isBug,
      rationale:
        "Reviewed invariant '" +
        esc.invariantId +
        "' against state on screen '" +
        esc.state.screen +
        "' after '" +
        esc.state.lastAction +
        "'. Deltas: " +
        JSON.stringify(esc.state.deltas) +
        ". Verdict: " +
        (isBug ? "genuine violation." : "false alarm, invariant holds."),
    };
  }
}

/** Minimal text-completion surface, so the planner has no SDK dependency. */
export type LlmFn = (prompt: string) => Promise<string>;

/**
 * Production Tier 2. Kept dependency-free by taking a completion function rather
 * than an SDK client, which also makes it testable with a fake.
 *
 * Prompt shape matters here: Tier 2 is asked to *adjudicate a specific typed
 * question that Tier 1 already framed*, not to freely opine about the game. The
 * narrow framing is what keeps its answers comparable to Tier 1's and what makes
 * the reply short enough to be cheap.
 */
export class LlmPlanner implements Planner {
  readonly name: string;
  calls = 0;
  private llm: LlmFn;

  constructor(llm: LlmFn, name = "llm-planner") {
    this.llm = llm;
    this.name = name;
  }

  async chooseAction(state: SocState, options: string[], reason: string): Promise<PlannerDecision> {
    this.calls += 1;
    const prompt = [
      "You are directing an automated beta-test bot playing a game.",
      "The fast decision model was not confident enough to act. Reason: " + reason,
      "",
      "Current state:",
      JSON.stringify(state, null, 2),
      "",
      "Choose exactly one control id from this list:",
      options.join(", "),
      "",
      'Reply as JSON: {"action": "<control id>", "rationale": "<one sentence>"}',
    ].join("\n");
    const raw = await this.llm(prompt);
    const parsed = safeJson(raw);
    const action =
      typeof parsed?.action === "string" && options.includes(parsed.action)
        ? parsed.action
        : options[0]!;
    return {
      action,
      rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "unparsed reply",
    };
  }

  async adjudicate(esc: Escalation): Promise<PlannerVerdict> {
    this.calls += 1;
    const prompt = [
      "You are triaging a possible bug found by an automated beta-test bot.",
      "",
      "The invariant under test (true = healthy):",
      esc.prompt,
      "",
      "The fast model answered FALSE with low confidence (" + esc.answer.p.toFixed(2) + ").",
      "",
      "Game state at the time:",
      JSON.stringify(esc.state, null, 2),
      "",
      "Decide whether this is a genuine violation or a false alarm.",
      'Reply as JSON: {"isBug": true|false, "rationale": "<one or two sentences>"}',
    ].join("\n");
    const raw = await this.llm(prompt);
    const parsed = safeJson(raw);
    return {
      isBug: parsed?.isBug === true,
      rationale: typeof parsed?.rationale === "string" ? parsed.rationale : "unparsed reply",
    };
  }
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}
