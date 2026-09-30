/**
 * System One client contract.
 *
 * Jev and Laya share the same shape: hand over a block of state plus a set of typed
 * questions, get back typed answers with calibrated probabilities, all evaluated in
 * a single parallel forward pass. That parallelism is the reason this project is
 * affordable - asking 40 questions costs essentially the same as asking one, which
 * is what makes a continuously-evaluated invariant suite possible.
 *
 * Laya's three primitives (choice / score / noul) are the common denominator, so
 * they are the interface. A Jev backend maps onto them; anything Jev-specific stays
 * behind the backend boundary.
 */

export interface NoulQuestion {
  id: string;
  kind: "noul";
  /** A yes/no proposition about the state. */
  prompt: string;
  /**
   * What each answer means. Both Jev and Laya accept this as `criteria` and it
   * measurably sharpens the answer, because it tells the model where the boundary
   * sits rather than leaving it to infer one.
   */
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  id: string;
  kind: "choice";
  prompt: string;
  /**
   * Candidate options. Keep this <= MAX_SAFE_OPTIONS: Laya shares a fixed ~192-256
   * token budget across *all* options, so long lists starve each option of
   * representation. Shortlist deterministically or go hierarchical instead.
   */
  options: string[];
  /**
   * Human-meaningful description per option, e.g. the button's caption.
   *
   * Both models take choice criteria as a map of option -> description. Sending
   * bare control ids throws away the single most useful signal on the screen: the
   * text the player actually reads. `buy_elixir` means nothing; "Elixir (80g)"
   * means everything.
   */
  descriptions?: Record<string, string>;
}

export interface ScoreQuestion {
  id: string;
  kind: "score";
  prompt: string;
  min: number;
  max: number;
  /**
   * Ordered rubric labels, one per level from `min` to `max`. Both models express
   * a score question as an array of level descriptions rather than a bare range.
   */
  labels?: string[];
}

export type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface NoulAnswer {
  id: string;
  kind: "noul";
  value: boolean;
  /** Calibrated probability that `value` is correct, in [0,1]. */
  p: number;
}

export interface ChoiceAnswer {
  id: string;
  kind: "choice";
  value: string;
  p: number;
  /** Full distribution over options when the backend exposes it. */
  dist?: Record<string, number>;
}

export interface ScoreAnswer {
  id: string;
  kind: "score";
  value: number;
  p: number;
}

export type Answer = NoulAnswer | ChoiceAnswer | ScoreAnswer;

export interface SocStats {
  calls: number;
  questions: number;
  ms: number;
}

export interface SystemOneClient {
  readonly name: string;
  /** Evaluate every question against `state` in one pass. */
  ask(state: unknown, questions: Question[]): Promise<Answer[]>;
  readonly stats: SocStats;
}

/**
 * Above this many options, Laya's shared token budget degrades each option's
 * representation badly enough that choice quality falls off. Enforced by the router.
 */
export const MAX_SAFE_OPTIONS = 15;

export function answersById(answers: Answer[]): Map<string, Answer> {
  return new Map(answers.map((a) => [a.id, a]));
}
