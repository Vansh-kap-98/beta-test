import type { Invariant } from "../../core/oracles/invariants.ts";
import type { BoundsSpec } from "../../core/oracles/tier0.ts";

/**
 * Invariants for a match-3 game, written as a designer or a spec author would state
 * them -- in English, about the game's meaning, with no mention of a control id, a
 * screen name or an internal variable.
 *
 * That phrasing is the whole point of the layer. The same list should be pointable
 * at any match-3, because nothing in it knows about *this* game.
 *
 * Every one is DEFECT-POSITIVE: "yes" means the bug is present. Each one ASKS rather
 * than asserts -- "is the player trapped on this screen?" and not "this screen has no
 * exit; is the player trapped?". The asserting form leads a yes-biased model into
 * agreeing with the premise, and it reported a clean board as having no way out while
 * a Pause control sat in the list. That reads slightly
 * against the grain -- a spec author writes "the board should be playable", not "is
 * the player stuck" -- and it is worth the awkwardness, because a System One model
 * leans toward yes and healthy-positive phrasing therefore biases the whole suite
 * toward declaring a broken build fine. Measured on the labelled bench, flipping
 * polarity took bugs missed from 6 of 8 to 1 of 8. See `polarity` in invariants.ts.
 *
 * Note which things are deliberately NOT here. "Does the board have 8 columns" and
 * "is the move count non-negative" are arithmetic over observed values, so they are
 * Tier-0 bounds checks below. Asking a model to evaluate arithmetic every step is
 * how the first version of this system produced hundreds of false positives on a
 * clean build.
 */

/**
 * The smallest number of tiles a legitimate match can clear.
 *
 * Used as the floor for "work was done". Where the cell count comes from vision, one
 * or two changed cells is a misread rather than a move, and treating it as work
 * produced confident score findings on a build with no score bug.
 */
export const MIN_CLEAR = 3;

/**
 * Affordance score above which a text region is confidently a control, and so a
 * claim that it is BROKEN can be made about it. Deliberately above the threshold used
 * to decide whether to offer it at all -- offering is cheap and informative, while a
 * false critical finding is the most expensive output this system has.
 */
export const CONFIDENT_CONTROL = 0.7;

export const MATCH3_BOUNDS: BoundsSpec[] = [
  { variable: "legalMoves", min: 0, label: "Negative legal-move count" },
  { variable: "movedCells", min: 0, label: "Negative changed-cell count" },
];

/**
 * `clearing_tiles_scores` was removed for a related reason, and it is the clearer
 * case of the two. Once the deterministic oracle took over whenever the score could
 * be READ as a number, all that was left for the model was the situation where the
 * score could NOT be read -- which is precisely the situation in which the model has
 * no way to answer either. On the live pipeline that is what happened: OCR dropped
 * the score on one side of a move, the invariant became applicable for that reason,
 * and the model guessed. It reported broken scoring on a build whose planted bug was
 * somewhere else entirely.
 *
 * An invariant that becomes applicable BECAUSE a field is missing has its dependency
 * backwards. A missing field should skip the check and be recorded as a screen we
 * could not read, which is a finding about the tool rather than about the game.
 *
 * `progress_is_possible` used to live here and was removed, which is worth recording
 * because it looked like one of the most valuable entries in the list.
 *
 * It asked whether the player had been able to make progress RECENTLY -- a property
 * of a window of steps -- but was evaluated against a single state, using one
 * `producedChange` flag. Two things followed. It duplicated the Tier-0 stagnation
 * oracle, which measures the same thing deterministically over a real window and
 * caught both relevant planted bugs on its own. And it produced a false positive on
 * a CLEAN build across three seeds, because the agent deliberately probes invalid
 * moves to exercise error paths: a rejected swap correctly changes nothing, and a
 * single-step view of that is indistinguishable from being stuck.
 *
 * The tool's own testing strategy was manufacturing the evidence for its own
 * finding. No prompt could fix that, because the question was being asked of the
 * wrong scope.
 */
export const MATCH3_INVARIANTS: Invariant[] = [
  {
    id: "action_has_effect",
    polarity: "defect-positive",
    prompt:
      "Did the player's last action fail to change anything on the screen, making the control they used appear broken?",
    criteria: {
      true: "the action was offered but produced no visible change at all",
      false: "the screen changed in some visible way after the action",
    },
    title: "An offered action does nothing",
    bugClass: "flow",
    severity: "high",
    dedupeBy: "screen",
    /**
     * Only claim a control is broken when we are confident it IS a control.
     *
     * Every readable text region is offered as a candidate, because from a
     * screenshot a label and a button are indistinguishable. Clicking "Score 0"
     * then does nothing, which is true and is not a defect -- and this invariant
     * reported it as one until provenance was carried through. Actions derived
     * from real structure (a computed board swap) make the claim; optimistic OCR
     * guesses do not.
     */
    applies: (s) => {
      if (!s.lastAction.startsWith("tap ") || s.loading) return false;
      if (s.vars["lastActionOrigin"] === "ocr") return false;
      /**
       * Where an affordance score was measured, it must be decisively a control.
       *
       * The provenance check alone was not enough. A dialog's body copy -- "Resume to
       * continue playing." -- scored just over the button threshold on the live
       * pipeline, was offered, was tapped, did nothing, and was reported as a broken
       * control on a clean build. Offering it is right, because trying one is how you
       * find out; CLAIMING it is broken needs more than a borderline score.
       *
       * Left undefined by adapters that cannot measure affordance, in which case the
       * provenance check above stands alone.
       */
      const aff = s.vars["lastActionAffordance"];
      if (typeof aff === "number" && aff < CONFIDENT_CONTROL) return false;
      return true;
    },
  },
  {
    id: "screen_has_an_exit",
    polarity: "defect-positive",
    prompt:
      "Is the player trapped on this screen, with no control that leaves it, goes back, continues, or confirms?",
    criteria: {
      true: "every control leaves the player on this same screen",
      false: "at least one control moves the player onward or back",
    },
    title: "Screen has no way forward or back",
    bugClass: "softlock",
    severity: "critical",
    dedupeBy: "screen",
    /**
     * Requires at least one control to have been DETECTED.
     *
     * With an empty control list the question cannot be answered honestly: "no exit
     * exists" and "we failed to see the exit" produce exactly the same evidence, and
     * the model has no way to tell them apart either. Asked anyway, it reported a
     * CRITICAL softlock on a clean build -- 20 of 20 opportunities, confidence 0.87 --
     * about an overlay that had a perfectly good button on it which OCR had simply
     * missed while the board underneath was mid-animation.
     *
     * A confident critical finding sourced from our own blindness is the worst output
     * this system can produce, because it is indistinguishable from its best one.
     *
     * So the invariant judges the controls we can see -- "do any of THESE lead out?"
     * -- and the harder case, a screen where we see nothing at all, is left to the
     * Tier-0 stagnation oracle, which can prove a trap by exhausting the available
     * actions instead of by asking.
     */
    applies: (s) => !s.loading && s.controls.length > 0,
  },
  {
    id: "instructions_are_actionable",
    polarity: "defect-positive",
    prompt:
      "Would a first-time player be left confused about what to do next or what the goal is on this screen?",
    criteria: {
      true: "the screen gives no usable indication of what to do or what the goal is",
      false: "the screen states or clearly implies the next action or the objective",
    },
    // This is the "understanding difficulty" product, expressed as an invariant.
    // It rides free in the same parallel pass as everything else, and it is gated by
    // the same Wilson machinery, so one uncertain answer never becomes a finding.
    title: "Screen does not tell the player what to do",
    bugClass: "ui",
    severity: "medium",
    dedupeBy: "screen",
    // A tutorial is seen once and dismissed. Repetition evidence can never
    // accumulate on it, so the single most valuable usability finding would be
    // structurally unreportable. Reviewed instead, and corroborated by asking the
    // same thing several ways in the same call rather than by waiting for a second
    // visit that never comes.
    evidence: "escalation",
    paraphrases: [
      "A new player is looking at this screen for the first time. Is it unclear to them what they should do?",
      "Does this screen fail to say what the player is trying to achieve?",
      "Would a player have to guess what to do next on this screen?",
    ],
    applies: (s) => !s.loading && s.controls.length > 0,
  },
  {
    id: "board_is_playable",
    polarity: "defect-positive",
    prompt:
      "Is the player stuck, with no legal move available on the board?",
    criteria: {
      true: "no legal move exists and the player cannot proceed",
      false: "one or more legal moves exist on the board",
    },
    title: "Board has no legal moves",
    bugClass: "softlock",
    severity: "critical",
    dedupeBy: "global",
    /**
     * Only asked when the legal-move count CANNOT be computed.
     *
     * Where the count is known, this is arithmetic, and a real run showed the model
     * answering "the player is stuck" with "legal moves is 15" in the blob in front
     * of it -- a false positive on a clean build. The repo's own rule, learned the
     * first time round: anything decidable by plain code belongs in Tier 0, and
     * asking a model to evaluate arithmetic every step is how hundreds of false
     * positives got produced.
     *
     * So the deterministic path owns it when the number is there (the softlock
     * oracle already distinguishes a dead board the player can shuffle out of from
     * one they cannot), and the model is only asked about games where no move count
     * can be derived from the screen -- which is most real games, and the reason the
     * invariant stays.
     */
    applies: (s) =>
      s.vars["boardCols"] !== undefined &&
      s.vars["legalMoves"] === undefined &&
      !s.loading,
  },
  {
    id: "move_not_wasted",
    polarity: "defect-positive",
    prompt:
      "Was a move taken from the player even though their swap did nothing?",
    criteria: {
      true: "a move was consumed even though the swap did nothing",
      false: "every consumed move actually cleared tiles",
    },
    title: "A move is consumed when the swap is rejected",
    bugClass: "flow",
    severity: "high",
    dedupeBy: "global",
    /**
     * Added because a whole defect class had no invariant that could see it.
     *
     * The fixture plants a bug where an INVALID swap still costs a move. Nothing in
     * the suite could catch it: the screen does change (the counter ticks down), so
     * "did the action have an effect" says yes, and no tiles cleared, so the scoring
     * invariant does not apply. The defect is precisely the conjunction -- a move
     * spent for nothing -- and that needed stating.
     *
     * The GATE is narrow on purpose, and that turned out to matter more than the
     * prompt. Written as "any move was spent", the bug fired 15 times in 237
     * opportunities -- a true 6% violation rate, which the Wilson gate correctly
     * refused to report because it cannot be told apart from a 5% model error rate.
     * The defect was real, detected, and statistically invisible.
     *
     * So `applies` counts only the opportunities where the question is meaningful: a
     * move was spent AND nothing was cleared. The denominator drops from every move
     * to just the suspicious ones, the violation rate goes to ~100%, and a clean
     * build never reaches the gate at all because the situation never arises.
     *
     * The general rule, which cost a detection to learn: the `applies` predicate IS
     * the denominator. A loose one dilutes real signal below the noise floor, and
     * loosening the gate to compensate would bring back the false positives the gate
     * exists to stop.
     */
    applies: (s) =>
      !s.loading &&
      Number(s.deltas?.["hud_moves"] ?? s.vars["d_moves"] ?? 0) < 0 &&
      Number(s.vars["movedCells"] ?? 0) === 0,
  },
];

/**
 * Ground truth for the offline mock only.
 *
 * Production answers these with Laya or Jev reading the same blob. This exists so
 * the pipeline can be exercised and measured without a GPU, and so the fixture's
 * planted bugs give a known-correct answer to score against.
 */
function numeric(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** The score change, under either path's naming. */
function scoreDelta(s: any): number | undefined {
  return numeric(s.deltas?.["hud_score"]) ?? numeric(s.vars?.["d_score"]);
}

export function match3InvariantTruth(s: any, id: string): boolean | undefined {
  // Paraphrase questions arrive as "<invariant>##p<n>" and are the SAME proposition,
  // so ground truth is the same. Without stripping the suffix the mock returns
  // undefined for every paraphrase and the corroboration silently does nothing.
  id = id.replace(/##p\d+$/, "");
  const vars = s.vars ?? {};
  const controls: Array<{ id: string; text?: string; enabled?: boolean }> = s.controls ?? [];
  const text: string[] = (s.text ?? []).map((t: string) => String(t).toLowerCase());

  switch (id) {
    case "action_has_effect":
      return vars["producedChange"] !== false;

    case "screen_has_an_exit":
      return controls.some((c) =>
        /back|close|cancel|exit|continue|next|confirm|ok|got|retry|shuffle|play|resume|start/i.test(
          (c.text ?? "") + " " + c.id,
        ),
      );

    case "instructions_are_actionable": {
      // A screen is actionable if its text says what to do or names a goal. The
      // fixture's vague tutorial ("Tap things to play") deliberately does neither.
      const joined = text.join(" ");
      if (!joined.trim()) return undefined;
      const actionable = /(swap|match|line of|clear|reach|score|goal|collect|make a)/i.test(joined);
      const vague = /tap things|just play|have fun/i.test(joined);
      if (vague && !actionable) return false;
      return actionable || controls.length > 0;
    }

    case "clearing_tiles_scores": {
      // The delta arrives under different names on the two paths: the live sidecar
      // precomputes `d_score` from HUD readings, while an in-process adapter lets
      // `serialize` diff `hud_score` itself. Reading only one of them made the
      // planted score bug undetectable on the headless bench while looking fine.
      const d = scoreDelta(s);
      if (d === undefined) return undefined;   // no confident before/after pair
      return d > 0;
    }

    case "move_not_wasted": {
      const dm = numeric(s.deltas?.["hud_moves"] ?? vars["d_moves"]);
      if (dm === undefined) return undefined;
      // Healthy when a consumed move actually cleared something.
      return !(dm < 0 && Number(vars["movedCells"] ?? 0) === 0);
    }

    case "board_is_playable": {
      const n = vars["legalMoves"];
      return typeof n === "number" ? n > 0 : undefined;
    }

    case "progress_is_possible":
      return vars["producedChange"] !== false;

    default:
      return undefined;
  }
}

/**
 * The truth function above answers "does this invariant hold" -- healthy is true,
 * which is how a spec reads. The model is asked defect-positive questions, so its
 * raw answer is the opposite, and the mock has to imitate the MODEL, not the spec.
 *
 * Getting this backwards would be silent and total: every healthy screen would be
 * reported broken and every real bug would pass. Hence one helper deriving the
 * inversion from each invariant's own declared polarity, rather than a hand-written
 * second copy of the truth table that can drift out of step with the prompts.
 */
const MATCH3_POLARITY = new Map(
  MATCH3_INVARIANTS.map((i) => [i.id, i.polarity ?? "healthy-positive"] as const),
);

export function match3RawAnswer(s: any, id: string): boolean | undefined {
  const base = id.replace(/##p\d+$/, "");
  const healthy = match3InvariantTruth(s, base);
  if (healthy === undefined) return undefined;
  return MATCH3_POLARITY.get(base) === "defect-positive" ? !healthy : healthy;
}

/**
 * A competent player's next move, used to score the mock's `choice` answers and as
 * the Tier-2 planner's recommendation.
 *
 * The first version of this was one regex that preferred anything matching
 * `got_it|continue|next_level|retry|shuffle|ok` and fell through to a swap. Since
 * `shuffle_board` is offered on every board screen, "shuffle" always matched and the
 * agent pressed Shuffle on all 200 steps of every run -- never once swapping a
 * candy. It therefore never spent a move, never cleared a tile and never changed the
 * score, so three invariants could not apply even in principle and two planted bugs
 * were structurally unreachable.
 *
 * Nothing announced this. Absorption stayed at 90%, the clean build stayed silent,
 * and two bugs were still "detected" -- one of them only BECAUSE the bot was stuck
 * pressing the inert control. A healthy-looking scoreboard for an agent that was not
 * playing the game.
 *
 * So the order is now explicit, and shuffle is last by construction.
 */
export function match3BestControl(s: any, options: string[]): string | undefined {
  const find = (re: RegExp) => options.find((o) => re.test(o));
  const swaps = options.filter((o) => /(^|\s)(tap\s+)?swap:/.test(o));

  // 1. Clear a modal first: a popup blocks everything behind it. Deliberately does
  //    NOT include shuffle, which is a board control, not a way out of a dialog.
  const dismiss = find(/got_it|tut_ok|continue|next_level|retry|resume|ok/i);
  if (dismiss) return dismiss;

  // 2. Play the game. This is the common case and has to come before any fallback,
  //    because a tester that never takes the game's primary action tests nothing.
  if (swaps.length > 0) return swaps[0];

  // 3. Only with no move available is shuffling the right move -- which is also the
  //    only situation in which a dead shuffle button is a genuine softlock.
  const shuffle = find(/shuffle/i);
  if (shuffle) return shuffle;

  // Pausing is never the competent move; it exists so the screen has an exit.
  const notPause = options.filter((o) => !/pause/i.test(o));
  if (notPause.length > 0) return notPause[0];

  return options.find((o) => !/wait|ui_cancel/.test(o)) ?? options[0];
}
