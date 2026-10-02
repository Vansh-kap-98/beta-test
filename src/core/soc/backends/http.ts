import { renderProse } from "../prose.ts";
import type { SocState } from "../serialize.ts";
import type {
  Answer,
  ChoiceQuestion,
  NoulQuestion,
  Question,
  ScoreQuestion,
  SocStats,
  SystemOneClient,
} from "../types.ts";

/**
 * HTTP backend for Jev and Laya.
 *
 * The two converged on the same wire contract - `POST /v1/systemone`, a `state`
 * blob plus a `questions` map keyed by id, and the same three question types with
 * the same answer shapes. So one client serves both and the only differences are
 * the base URL, the auth header and the model field. That is worth stating plainly
 * because it means the choice between a managed API and local open weights is a
 * deployment decision, not an architectural one, and can be revisited later
 * without touching anything above this file.
 *
 * Reference:
 *   Jev  - POST https://api.typesafe.ai/v1/systemone, Authorization: Bearer <key>
 *   Laya - POST <host>/v1/systemone, typically local and unauthenticated
 *
 * Three response details this maps carefully, because getting any of them wrong
 * silently corrupts the calibration the whole system depends on:
 *
 *   - `noul` is returned as P(true), NOT a boolean. The answer is `noul >= 0.5`
 *     and its calibrated confidence is `max(noul, 1 - noul)` - not `noul` itself,
 *     which would report 0.05 confidence for a firmly-false answer.
 *   - `choice` carries a full distribution. `probabilities[choice]` is the
 *     calibrated probability that the chosen option is right, which is what the
 *     escalation gate wants; the separate `confidence` field is a fallback.
 *   - `score` is a float expected value over zero-indexed levels, so it is shifted
 *     back onto the question's own `min..max` range.
 */

export interface HttpSocOptions {
  baseUrl: string;
  apiKey?: string;
  model?: string;
  /** Per-request timeout. Jev quotes 70-500ms; this is a generous ceiling. */
  timeoutMs?: number;
  /** Retries on network error or 5xx. */
  retries?: number;
  name?: string;
  fetchImpl?: typeof fetch;
  /**
   * How the state blob is rendered for the model. Defaults to prose, and that
   * default is load-bearing rather than tidy.
   *
   * Measured against real Laya on the labelled bench, holding the model and the
   * questions fixed and changing only this: JSON state scored 0.652 accuracy and
   * missed 6 of 8 planted bugs; prose state scored 0.957 and missed 1. Handed a
   * dict, the model answered one question at exactly p=0.500 while the answer sat
   * in the blob as `producedChange: true` -- it reads language, and JSON is not
   * language.
   *
   * Pass `(s) => s` to send the raw object, which is worth doing only to reproduce
   * that measurement.
   */
  renderState?: (state: unknown) => unknown;
}

/** Does this look like our state blob, as opposed to a caller's own string? */
function isSocState(x: unknown): x is SocState {
  return (
    typeof x === "object" && x !== null &&
    "screen" in x && "controls" in x && "lastAction" in x
  );
}

interface WireNoulAnswer {
  type?: string;
  noul: number;
  confidence?: number;
}
interface WireChoiceAnswer {
  type?: string;
  choice: string;
  probabilities?: Record<string, number>;
  confidence?: number;
}
interface WireScoreAnswer {
  type?: string;
  score: number;
  probabilities?: number[] | Record<string, number>;
  confidence?: number;
}
type WireAnswer = WireNoulAnswer | WireChoiceAnswer | WireScoreAnswer;

interface WireResponse {
  model?: string;
  answers: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
  routing?: { model?: string; reason?: string };
}

/**
 * Confidence in a choice, restricted to the top two candidates.
 *
 * The obvious measure -- `probabilities[chosen]` -- is not comparable across
 * questions, because probability mass spreads over however many options were
 * offered. On a twelve-option board screen a confident pick still scores around
 * 0.25, so a single escalation gate shared with yes/no questions is unreachable by
 * construction. The first real-model run absorbed 0% of its decisions for exactly
 * this reason: the gate was 0.75 and Laya's chosen-option probability sat below it
 * on essentially every step, which destroys the cost argument the design rests on.
 *
 * `top / (top + second)` asks the question that actually matters -- am I sure it is
 * this option rather than the runner-up -- and is independent of the option count.
 * It also puts choice confidence on the SAME scale as a noul's `max(p, 1-p)`, so one
 * threshold can honestly govern both.
 *
 * Measured over 200 real decisions at ~12 options each, selecting the lowest gate
 * holding accuracy at or above 0.80:
 *
 *   measure                     gate   absorbed   accuracy
 *   -------------------------   ----   --------   --------
 *   probabilities[chosen]       0.25     30.5%      0.885
 *   top / (top + second)        0.55     63.5%      0.819
 *   lift over chance (top x n)  3.00     29.5%      0.881
 *
 * The full distribution is still carried on `dist`, so nothing is lost.
 */
function twoWay(w: WireChoiceAnswer): number {
  const probs = w.probabilities;
  if (!probs) return w.confidence ?? 0.5;
  const sorted = Object.values(probs).sort((a, b) => b - a);
  const top = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  if (top + second <= 0) return w.confidence ?? 0.5;
  return top / (top + second);
}

function toWireQuestion(q: Question): Record<string, unknown> {
  switch (q.kind) {
    case "noul":
      return {
        type: "noul",
        instructions: q.prompt,
        criteria: q.criteria ?? { true: "the statement holds", false: "the statement does not hold" },
      };
    case "choice": {
      const criteria: Record<string, string> = {};
      for (const o of q.options) criteria[o] = q.descriptions?.[o] ?? o;
      return { type: "choice", instructions: q.prompt, criteria };
    }
    case "score": {
      const levels = q.max - q.min + 1;
      const labels =
        q.labels && q.labels.length === levels
          ? q.labels
          : Array.from({ length: levels }, (_, i) => "level " + (q.min + i));
      return { type: "score", instructions: q.prompt, criteria: labels };
    }
  }
}

export class HttpSystemOne implements SystemOneClient {
  readonly name: string;
  readonly stats: SocStats = { calls: 0, questions: 0, ms: 0 };
  /** Tokens billed, for the cost model. */
  readonly usage = { inputTokens: 0, outputTokens: 0 };

  private baseUrl: string;
  private apiKey: string | undefined;
  private model: string | undefined;
  private timeoutMs: number;
  private retries: number;
  private doFetch: typeof fetch;
  private renderState: (state: unknown) => unknown;

  constructor(opts: HttpSocOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.retries = opts.retries ?? 2;
    this.doFetch = opts.fetchImpl ?? fetch;
    this.name = opts.name ?? "http";
    this.renderState =
      opts.renderState ?? ((st) => (isSocState(st) ? renderProse(st) : st));
  }

  async ask(state: unknown, questions: Question[]): Promise<Answer[]> {
    if (questions.length === 0) return [];
    const t0 = Date.now();

    const wireQuestions: Record<string, unknown> = {};
    for (const q of questions) wireQuestions[q.id] = toWireQuestion(q);

    const body: Record<string, unknown> = {
      state: this.renderState(state),
      questions: wireQuestions,
    };
    if (this.model) body["model"] = this.model;

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = "Bearer " + this.apiKey;

    const res = await this.post(body, headers);

    this.stats.calls += 1;
    this.stats.questions += questions.length;
    this.stats.ms += Date.now() - t0;
    this.usage.inputTokens += res.usage?.input_tokens ?? 0;
    this.usage.outputTokens += res.usage?.output_tokens ?? 0;

    return questions.map((q) => this.decode(q, res.answers?.[q.id]));
  }

  private async post(
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<WireResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const r = await this.doFetch(this.baseUrl + "/v1/systemone", {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (r.status >= 500) throw new Error("server error " + r.status);
        if (!r.ok) {
          // 4xx is a request defect; retrying will not fix it.
          throw Object.assign(new Error("System One request failed: " + r.status + " " + (await r.text()).slice(0, 200)), {
            fatal: true,
          });
        }
        return (await r.json()) as WireResponse;
      } catch (err) {
        lastErr = err;
        if ((err as { fatal?: boolean })?.fatal) throw err;
        if (attempt === this.retries) break;
        // Brief exponential backoff. These calls are in the play loop, so the
        // ceiling stays low - a stalled run is worse than a skipped decision.
        await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private decode(q: Question, raw: WireAnswer | undefined): Answer {
    if (!raw) return this.fallback(q);
    switch (q.kind) {
      case "noul": {
        const w = raw as WireNoulAnswer;
        if (typeof w.noul !== "number") return this.fallback(q);
        const value = w.noul >= 0.5;
        // Confidence in the ANSWER GIVEN, not P(true): a confident "no" is
        // noul=0.02, which is 0.98 confidence that the answer is "no".
        return { id: q.id, kind: "noul", value, p: value ? w.noul : 1 - w.noul };
      }
      case "choice": {
        const w = raw as WireChoiceAnswer;
        if (typeof w.choice !== "string") return this.fallback(q);
        const value = (q as ChoiceQuestion).options.includes(w.choice)
          ? w.choice
          : ((q as ChoiceQuestion).options[0] ?? w.choice);
        const answer: Answer = { id: q.id, kind: "choice", value, p: twoWay(w) };
        if (w.probabilities) answer.dist = w.probabilities;
        return answer;
      }
      case "score": {
        const w = raw as WireScoreAnswer;
        if (typeof w.score !== "number") return this.fallback(q);
        const sq = q as ScoreQuestion;
        // Levels are zero-indexed on the wire; shift onto the question's range.
        const value = Math.min(sq.max, Math.max(sq.min, sq.min + w.score));
        return { id: q.id, kind: "score", value, p: w.confidence ?? 0.5 };
      }
    }
  }

  /** A missing or malformed answer becomes a minimum-confidence guess, which the
   * escalation gate will then route to Tier 2 - the correct outcome. */
  private fallback(q: Question): Answer {
    switch (q.kind) {
      case "noul":
        return { id: q.id, kind: "noul", value: true, p: 0 };
      case "choice":
        return { id: q.id, kind: "choice", value: (q as ChoiceQuestion).options[0] ?? "", p: 0 };
      case "score": {
        const sq = q as ScoreQuestion;
        return { id: q.id, kind: "score", value: (sq.min + sq.max) / 2, p: 0 };
      }
    }
  }
}

/** Managed Jev endpoint. Requires an API key. */
export function createJevClient(
  apiKey: string,
  opts: Partial<HttpSocOptions> = {},
): HttpSystemOne {
  return new HttpSystemOne({
    baseUrl: opts.baseUrl ?? "https://api.typesafe.ai",
    apiKey,
    model: opts.model ?? "jev-latest",
    name: "jev",
    ...opts,
  });
}

/**
 * Self-hosted Laya. Defaults to a local server.
 *
 * Preferred for the play loop when you can host it: at ~33ms and open weights
 * there is no per-call cost and no network round-trip, which matters when the
 * decision rate is tens per second and the run is unattended overnight.
 */
export function createLayaClient(
  baseUrl = "http://127.0.0.1:8000",
  opts: Partial<HttpSocOptions> = {},
): HttpSystemOne {
  return new HttpSystemOne({ baseUrl, name: "laya", ...opts });
}
