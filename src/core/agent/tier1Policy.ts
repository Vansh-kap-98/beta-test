import type { Action, Finding, GameState } from "../types.ts";
import type { Policy } from "./session.ts";
import type { Planner } from "./planner.ts";
import type { Invariant, Escalation } from "../oracles/invariants.ts";
import type { ScoreAnswer, SystemOneClient } from "../soc/types.ts";
import type { SocState } from "../soc/serialize.ts";
import { InvariantChecker } from "../oracles/invariants.ts";
import { serialize, estimateTokens, actionOptionId } from "../soc/serialize.ts";
import { hierarchicalChoice, shortlistOptions, isNavOption } from "../soc/router.ts";
import { mkFinding } from "../oracles/oracle.ts";
import { BalanceRecorder } from "../calibration/balance.ts";

export interface Tier1Stats {
  steps: number;
  /** Steps where a model choice was needed at all. */
  decisions: number;
  /** Steps resolved without waking Tier 2. The absorption rate is decisions>0 ? absorbed/decisions. */
  absorbed: number;
  socCalls: number;
  socQuestions: number;
  invariantAsks: number;
  escalatedChoices: number;
  escalatedInvariants: number;
  plannerCalls: number;
  /** Steps that needed no model at all (forced moves, loading screens, exploration). */
  freeSteps: number;
  /** Steps spent on coverage rather than progress. */
  exploreSteps: number;
  /** Tier-2 adjudications served from cache instead of a call. */
  adjudicationsCached: number;
  inputTokens: number;
}

export interface DifficultySample {
  floor: number;
  score: number;
  confidence: number;
  step: number;
}

export interface Tier1Options {
  invariants: Invariant[];
  planner?: Planner;
  /** Choice confidence below which Tier 2 is woken. */
  escalateBelow?: number;
  /** Invariant-violation confidence below which Tier 2 adjudicates. */
  invariantEscalateBelow?: number;
  /** Sample encounter difficulty at most once every N steps. */
  scoreEvery?: number;
  /**
   * Fraction of decisions spent on coverage rather than progress.
   *
   * Without this the bot tunnels: asked only "what is the progressing move?", it
   * answers `descend` forever, never returns to the menu, and never sees the shop -
   * so the entire economy goes untested and a planted economy bug is invisible.
   * Measured on the reference game, a run with no exploration visited zero shop
   * screens in 800 steps. Progress is the model's job; coverage is the policy's.
   */
  exploreEpsilon?: number;
}

/**
 * The play loop.
 *
 * Every step: serialise state, ask the System One model which control to press,
 * then - after the action lands - evaluate the whole invariant suite in one pass and
 * sample balance telemetry. Tier 2 is woken only when confidence falls under the
 * gate.
 *
 * Two cost rules are enforced here rather than left to discipline:
 *
 *   - **Forced moves never reach the model.** If there is exactly one legal action,
 *     or the screen is loading, the step is free. On the reference game this alone
 *     removes a large share of steps.
 *   - **Invariants ride in a single call.** The suite is one `ask()`, not one per
 *     invariant, because the parallel pass is what makes continuous assertion
 *     affordable at all.
 */
export class Tier1Policy implements Policy {
  readonly name = "tier1";

  private client: SystemOneClient;
  private checker: InvariantChecker;
  private planner?: Planner;
  private escalateBelow: number;
  private scoreEvery: number;
  private exploreEpsilon: number;
  private visits = new Map<string, number>();
  private rand: () => number;

  private prevState?: GameState;
  private recentScreens: string[] = [];
  private actionLog: Action[] = [];
  private pending: Finding[] = [];
  private seed = 0;
  private step = 0;
  private lastScoreStep = -Infinity;
  /**
   * Tier-2 verdicts already obtained, keyed by invariant and screen.
   *
   * Without this the escalation path is unbounded: a persistently-violated
   * invariant wakes the expensive tier on every single step for the rest of the
   * run. Measured on the all-bugs build that was 4,717 Tier-2 calls across 6,000
   * steps. A verdict on "does the shop screen have an exit?" does not change
   * within a run, so it is asked once and cached - which bounds Tier-2 cost by the
   * number of distinct (invariant, screen) pairs rather than by run length.
   */
  private adjudicated = new Map<string, boolean>();

  readonly escalations: Escalation[] = [];
  readonly difficulty: DifficultySample[] = [];
  /** Objective encounter telemetry, aggregated across runs for balance analysis. */
  readonly balance = new BalanceRecorder();
  readonly stats: Tier1Stats = {
    steps: 0,
    decisions: 0,
    absorbed: 0,
    socCalls: 0,
    socQuestions: 0,
    invariantAsks: 0,
    escalatedChoices: 0,
    escalatedInvariants: 0,
    plannerCalls: 0,
    freeSteps: 0,
    exploreSteps: 0,
    adjudicationsCached: 0,
    inputTokens: 0,
  };

  private invariantsById = new Map<string, Invariant>();

  constructor(client: SystemOneClient, opts: Tier1Options) {
    this.client = client;
    for (const inv of opts.invariants) this.invariantsById.set(inv.id, inv);
    this.planner = opts.planner;
    this.escalateBelow = opts.escalateBelow ?? 0.75;
    this.scoreEvery = opts.scoreEvery ?? 5;
    this.exploreEpsilon = opts.exploreEpsilon ?? 0.15;
    let a = 0x9e3779b9;
    this.rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.checker = new InvariantChecker(client, opts.invariants, {
      escalateBelow: opts.invariantEscalateBelow ?? 0.75,
    });
  }

  onReset(seed: number): void {
    this.seed = seed;
    this.step = 0;
    this.prevState = undefined;
    this.recentScreens = [];
    this.actionLog = [];
    this.pending = [];
    this.lastScoreStep = -Infinity;
    this.adjudicated.clear();
    this.visits.clear();
    this.checker.reset();
  }

  drain(): Finding[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  async next(state: GameState, actions: Action[]): Promise<Action> {
    this.stats.steps += 1;
    const actionable = actions.filter((a) => a.type !== "noop");

    // Forced move or a loading screen: nothing to decide, so spend nothing.
    if (actionable.length === 0) {
      this.stats.freeSteps += 1;
      return actions[0] ?? { type: "noop" };
    }
    if (actionable.length === 1) {
      this.stats.freeSteps += 1;
      return actionable[0]!;
    }

    // Options are built from ACTIONS, not from buttons.
    //
    // This started as `actions.filter(a => a.type === "tap")`, which worked only
    // because the first game under test had nothing but buttons. A checkout flow
    // with text fields exposed it immediately: the bot could not type, so it could
    // never fill the form, never reach payment, and never test any of it. Anything
    // the adapter offers is a candidate here.
    const byId = new Map<string, Action>();
    const captions = new Map<string, string>();
    for (const a of actionable) {
      const id = actionOptionId(a);
      byId.set(id, a);
      captions.set(id, this.caption(state, a));
    }
    const allIds = [...byId.keys()];

    // Exploration is deliberately resolved *before* the model is consulted: an
    // exploratory step needs no decision, so it costs nothing. It also ranges over
    // every option, not the shortlist - reaching what progress-seeking skips is
    // the entire point.
    if (this.rand() < this.exploreEpsilon) {
      this.stats.freeSteps += 1;
      this.stats.exploreSteps += 1;
      // Least-visited exploration has an anti-repetition bias, and a whole bug
      // class lives behind repetition: buying the same item twice, submitting a
      // form twice, stacking an effect. Measured on the checkout flow, a
      // quantity-dependent pricing bug was violated 0 times in 1500 steps because
      // the bot never chose the same control twice in a row. A minority of purely
      // uniform picks restores that.
      const target =
        this.rand() < 0.3
          ? (allIds[Math.floor(this.rand() * allIds.length)] ?? allIds[0]!)
          : this.leastVisited(state.screen, allIds);
      this.visit(state.screen, target);
      return byId.get(target) ?? actionable[0]!;
    }

    /**
     * Shortlist before asking.
     *
     * Two reasons, and the second only became visible under measurement. The
     * obvious one is the token budget. The other is that hierarchical narrowing
     * takes the *minimum* confidence across its passes, so a two-level decision
     * clears the escalation gate far less often than a one-level one - on the
     * reference game's 20-item shop this dropped absorption from ~81% to ~28% and
     * tripled Tier-2 cost. Cutting the list to one pass is worth more than the
     * options it discards, which exploration reaches anyway.
     */
    const picked = shortlistOptions(
      allIds.map((id) => ({
        id,
        label: captions.get(id)!,
        pinned: isNavOption(captions.get(id)!) || isNavOption(id),
        deprioritised: (this.visits.get(state.screen + "|" + id) ?? 0) > 0,
      })),
    );
    const options = picked.map((c) => c.id);
    const descriptions: Record<string, string> = {};
    for (const c of picked) descriptions[c.id] = c.label ?? c.id;

    const soc = serialize(state, this.prevState, this.actionLog.at(-1) ?? null, this.recentScreens);
    this.stats.inputTokens += estimateTokens(soc);
    this.stats.decisions += 1;
    const { value, trace } = await hierarchicalChoice(
      this.client,
      soc,
      "Which action should the player take next to make progress in the game?",
      options,
      { idPrefix: "act", descriptions },
    );
    this.stats.socCalls += trace.calls;
    this.stats.socQuestions += trace.calls;

    let chosen = value;
    if (trace.confidence < this.escalateBelow && this.planner) {
      this.stats.escalatedChoices += 1;
      const decision = await this.planner.chooseAction(
        soc,
        options,
        "choice confidence " + trace.confidence.toFixed(2),
      );
      this.stats.plannerCalls += 1;
      chosen = decision.action;
    } else {
      this.stats.absorbed += 1;
    }

    if (!byId.has(chosen)) chosen = options[0]!;
    this.visit(state.screen, chosen);
    return byId.get(chosen) ?? actionable[0]!;
  }

  /** Must match InvariantChecker's key so tier-1 and tier-2 findings collapse together. */
  private invariantKey(invariantId: string, screen: string): string {
    const inv = this.invariantsById.get(invariantId);
    return inv?.dedupeBy === "global" ? "inv:" + invariantId : "inv:" + invariantId + ":" + screen;
  }

  /** Human phrasing for an action, used as the model's choice criteria. */
  private caption(state: GameState, a: Action): string {
    const textOf = (id: string) => state.elements.find((e) => e.id === id)?.text;
    switch (a.type) {
      case "tap":
        return textOf(a.targetId) ?? a.targetId;
      case "input":
        return 'enter "' + a.value + '" into ' + (textOf(a.targetId) ?? a.targetId);
      case "back":
        return "go back";
      case "wait":
        return "wait";
      case "noop":
        return "do nothing";
    }
  }

  private visit(screen: string, optionId: string): void {
    const k = screen + "|" + optionId;
    this.visits.set(k, (this.visits.get(k) ?? 0) + 1);
  }

  private leastVisited(screen: string, options: string[]): string {
    let best: string[] = [];
    let bestN = Infinity;
    for (const o of options) {
      const n = this.visits.get(screen + "|" + o) ?? 0;
      if (n < bestN) {
        bestN = n;
        best = [o];
      } else if (n === bestN) best.push(o);
    }
    return best[Math.floor(this.rand() * best.length)] ?? options[0]!;
  }

  /**
   * Judge the opening screen, which no action has produced.
   *
   * Reuses the ordinary check path with no previous state and no last action, so an
   * invariant gated on `lastAction` correctly declines while one about the screen
   * itself -- an exit existing, the instructions making sense -- gets its look.
   */
  async onStart(state: GameState): Promise<void> {
    this.recentScreens.push(state.screen);
    const soc = serialize(state, undefined, null, this.recentScreens);
    await this.runInvariants(soc, state.step);
  }

  async onResult(before: GameState, action: Action, after: GameState): Promise<void> {
    this.step += 1;
    this.balance.observe(before, action, after);
    this.actionLog.push(action);
    this.recentScreens.push(after.screen);
    if (this.recentScreens.length > 12) this.recentScreens.shift();

    const soc = serialize(after, before, action, this.recentScreens);
    await this.runInvariants(soc, after.step);

    await this.sampleDifficulty(soc, after);
    this.prevState = before;
  }

  /** The invariant suite plus its escalation path, shared by onStart and onResult. */
  private async runInvariants(soc: SocState, step: number): Promise<void> {
    // One call for the whole invariant suite.
    const res = await this.checker.check(soc, {
      step,
      seed: this.seed,
      actionLog: this.actionLog,
    });
    if (res.asked > 0) {
      this.stats.socCalls += 1;
      this.stats.socQuestions += res.asked;
      this.stats.invariantAsks += res.asked;
      this.stats.inputTokens += estimateTokens(soc);
    }
    this.pending.push(...res.findings);

    for (const esc of res.escalations) {
      this.escalations.push(esc);
      this.stats.escalatedInvariants += 1;
      if (!this.planner) continue;

      const memoKey = esc.invariantId + ":" + esc.state.screen;
      const cached = this.adjudicated.get(memoKey);
      let isBug: boolean;
      let rationale: string;
      if (cached !== undefined) {
        this.stats.adjudicationsCached += 1;
        if (!cached) continue; // already ruled a false alarm here
        // Already confirmed; dedup collapses the repeat, so nothing more to do.
        continue;
      } else {
        const verdict = await this.planner.adjudicate(esc);
        this.stats.plannerCalls += 1;
        this.adjudicated.set(memoKey, verdict.isBug);
        isBug = verdict.isBug;
        rationale = verdict.rationale;
      }
      if (!isBug) continue;
      const verdict = { isBug, rationale };
      this.pending.push(
        mkFinding({
          // Reported under the invariant's own name and severity. A developer
          // reading the report wants the defect, not the internal id of the tier
          // that happened to confirm it - that belongs in the detail.
          severity: esc.invariant.severity,
          bugClass: esc.invariant.bugClass,
          title: esc.invariant.title,
          detail:
            "Invariant violated: " +
            JSON.stringify(esc.prompt) +
            ". The fast model flagged this at low confidence (" +
            esc.answer.p.toFixed(2) +
            "), so it was escalated for review, which confirmed it. " +
            verdict.rationale,
          step: esc.step,
          source: "tier2",
          confidence: esc.answer.p,
          dedupeKey: this.invariantKey(esc.invariantId, esc.state.screen),
          replay: { seed: this.seed, actions: [...this.actionLog] },
          evidence: { invariant: esc.invariantId, deltas: esc.state.deltas, rationale: verdict.rationale },
        }),
      );
    }
  }

  /**
   * Balance telemetry.
   *
   * Sampled, never acted on in-episode: a single encounter rated 5/5 means nothing,
   * because the player may simply have arrived underlevelled. Difficulty is a
   * distribution, so these samples are aggregated across many runs and only then
   * interpreted. See calibration/balance.ts.
   */
  private async sampleDifficulty(soc: SocState, after: GameState): Promise<void> {
    if (after.screen !== "combat") return;
    if (this.step - this.lastScoreStep < this.scoreEvery) return;
    this.lastScoreStep = this.step;

    const answers = (await this.client.ask(soc, [
      {
        id: "difficulty",
        kind: "score",
        prompt: "How hard does this encounter look for the player right now?",
        min: 1,
        max: 5,
        labels: ["trivial", "easy", "fair", "hard", "unwinnable"],
      },
    ])) as ScoreAnswer[];
    this.stats.socCalls += 1;
    this.stats.socQuestions += 1;

    const a = answers[0];
    if (!a) return;
    this.difficulty.push({
      floor: Number(after.vars["floor"] ?? 0),
      score: a.value,
      confidence: a.p,
      step: after.step,
    });
  }
}
