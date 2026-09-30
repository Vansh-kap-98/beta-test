import type { Answer, Question, SocStats, SystemOneClient } from "../types.ts";

/**
 * Offline stand-in for Jev / Laya.
 *
 * The point is NOT to imitate their internals. It is to be a decision source with a
 * *known, controllable* accuracy and calibration, so that everything built on top -
 * the escalation gate, the invariant suite, the calibration harness - can be tested
 * without an API key and with a ground truth to measure against.
 *
 * A mock that always returns the right answer at p=1.0 would make every downstream
 * test pass while proving nothing. This one is deliberately, measurably wrong some
 * of the time.
 *
 * Calibration model: a confidence p is drawn first, then the answer is made correct
 * with probability f(p). With `good`, f(p) = p, which is the definition of perfect
 * calibration and yields a diagonal reliability diagram. With `overconfident`,
 * f(p) = p - bias, so reported confidence systematically exceeds real accuracy -
 * exactly the failure mode that silently switches off escalation in production.
 */

export type Calibration = "good" | "overconfident" | "underconfident";

export interface MockConfig {
  /** Lowest confidence the model ever reports. Real models rarely emit p<0.5. */
  minConfidence?: number;
  calibration?: Calibration;
  /** Gap between reported confidence and true accuracy for the skewed modes. */
  bias?: number;
  seed?: number;
  /** Simulated wall-clock per call, to keep latency budgeting honest. */
  latencyMs?: number;
  /**
   * How strongly confidence concentrates near 1. A real System One model is
   * confident on most inputs and unsure on a minority; drawing uniformly on
   * [min,1] instead makes half of all answers fall under any sensible gate and
   * produces a meaningless 50% escalation rate. Higher = more confident.
   */
  confidenceSkew?: number;
}

/**
 * Ground truth for a question against a state. Returns the correct answer value, or
 * undefined when the question is not answerable (the mock then guesses and reports
 * low confidence, which is the honest behaviour).
 */
export type TruthFn = (state: unknown, q: Question) => boolean | string | number | undefined;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class MockSystemOne implements SystemOneClient {
  readonly name: string;
  readonly stats: SocStats = { calls: 0, questions: 0, ms: 0 };

  private truth: TruthFn;
  private rand: () => number;
  private minConfidence: number;
  private calibration: Calibration;
  private bias: number;
  private latencyMs: number;
  private confidenceSkew: number;

  /** Every decision made, for the calibration harness. */
  readonly log: Array<{
    questionId: string;
    kind: Question["kind"];
    reported: number;
    correct: boolean | null;
  }> = [];

  constructor(truth: TruthFn, cfg: MockConfig = {}) {
    this.truth = truth;
    this.rand = mulberry32(cfg.seed ?? 1);
    this.minConfidence = cfg.minConfidence ?? 0.5;
    this.calibration = cfg.calibration ?? "good";
    this.bias = cfg.bias ?? 0.2;
    this.latencyMs = cfg.latencyMs ?? 0;
    this.confidenceSkew = cfg.confidenceSkew ?? 3;
    this.name = "mock(" + this.calibration + ")";
  }

  /** True accuracy the mock will actually deliver at a reported confidence. */
  private trueAccuracy(reported: number): number {
    const shift =
      this.calibration === "overconfident"
        ? -this.bias
        : this.calibration === "underconfident"
          ? this.bias
          : 0;
    return Math.max(0, Math.min(1, reported + shift));
  }

  private drawConfidence(): number {
    // 1 - u^k concentrates mass near 1 for k > 1, giving the long high-confidence
    // body and short unsure tail that a real decision model exhibits.
    const u = this.rand();
    const shaped = 1 - Math.pow(u, this.confidenceSkew);
    return this.minConfidence + shaped * (1 - this.minConfidence);
  }

  async ask(state: unknown, questions: Question[]): Promise<Answer[]> {
    const t0 = Date.now();
    // Modelled as one parallel pass: cost and latency do not scale with question
    // count. This is the property the whole invariant-suite design depends on.
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));

    const answers: Answer[] = questions.map((q) => {
      const truth = this.truth(state, q);
      const reported = this.drawConfidence();

      if (truth === undefined) {
        // Not answerable - guess, and say so with low confidence.
        const lowP = this.minConfidence;
        this.log.push({ questionId: q.id, kind: q.kind, reported: lowP, correct: null });
        return this.guess(q, lowP);
      }

      const shouldBeCorrect = this.rand() < this.trueAccuracy(reported);
      this.log.push({ questionId: q.id, kind: q.kind, reported, correct: shouldBeCorrect });
      return shouldBeCorrect ? this.correct(q, truth, reported) : this.wrong(q, truth, reported);
    });

    this.stats.calls += 1;
    this.stats.questions += questions.length;
    this.stats.ms += Math.max(Date.now() - t0, this.latencyMs);
    return answers;
  }

  private correct(q: Question, truth: boolean | string | number, p: number): Answer {
    switch (q.kind) {
      case "noul":
        return { id: q.id, kind: "noul", value: Boolean(truth), p };
      case "choice":
        return { id: q.id, kind: "choice", value: String(truth), p };
      case "score":
        return { id: q.id, kind: "score", value: Number(truth), p };
    }
  }

  private wrong(q: Question, truth: boolean | string | number, p: number): Answer {
    switch (q.kind) {
      case "noul":
        return { id: q.id, kind: "noul", value: !truth, p };
      case "choice": {
        const others = q.options.filter((o) => o !== String(truth));
        const pick = others[Math.floor(this.rand() * others.length)] ?? q.options[0] ?? "";
        return { id: q.id, kind: "choice", value: pick, p };
      }
      case "score": {
        // Off by one or two on the rubric, clamped - a realistic score error.
        const delta = this.rand() < 0.5 ? -1 : 1;
        const magnitude = this.rand() < 0.7 ? 1 : 2;
        const v = Math.max(q.min, Math.min(q.max, Number(truth) + delta * magnitude));
        return { id: q.id, kind: "score", value: v, p };
      }
    }
  }

  private guess(q: Question, p: number): Answer {
    switch (q.kind) {
      case "noul":
        return { id: q.id, kind: "noul", value: this.rand() < 0.5, p };
      case "choice":
        return {
          id: q.id,
          kind: "choice",
          value: q.options[Math.floor(this.rand() * q.options.length)] ?? "",
          p,
        };
      case "score":
        return {
          id: q.id,
          kind: "score",
          value: q.min + Math.floor(this.rand() * (q.max - q.min + 1)),
          p,
        };
    }
  }
}
