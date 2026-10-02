import type { SocState } from "../serialize.ts";

/**
 * Hand-labelled game states for measuring how well a System One model reads our
 * state blob.
 *
 * This is the only labelled decision data the project has, and it exists because
 * the model's accuracy cannot be assumed: Laya's own README reports 0.362 on their
 * typed-decisions benchmark zero-shot against 0.766 fine-tuned. The escalation gate
 * and the reporting gate are both derived from measured error rate, so an unmeasured
 * model means both thresholds revert to taste.
 *
 * The cases are deliberately mundane -- ordinary match-3 situations, half of them
 * healthy. A bench made only of bugs measures nothing useful, because a model that
 * answers "broken" to everything would score perfectly.
 */

export interface BenchCase {
  name: string;
  state: SocState;
  /** Question id -> the correct answer. Omitted ids are not scored. */
  truth: Record<string, boolean>;
}

function base(over: Partial<SocState> = {}): SocState {
  return {
    screen: "board",
    loading: false,
    vars: {},
    deltas: {},
    changed: [],
    lastAction: "none",
    controls: [],
    recentScreens: [],
    errorCount: 0,
    ...over,
  };
}

const SWAP = { id: "swap:3_4__3_5", kind: "button", text: "swap two candies", enabled: true };
const PAUSE = { id: "pause", kind: "button", text: "Pause", enabled: true };
const SHUFFLE = { id: "shuffle_board", kind: "button", text: "Shuffle Board", enabled: true };
const GOTIT = { id: "got_it", kind: "button", text: "Got it", enabled: true };
const NEXT = { id: "next_level", kind: "button", text: "Next Level", enabled: true };

export const BENCH_CASES: BenchCase[] = [
  {
    name: "healthy move scores",
    state: base({
      lastAction: "tap swap:3_4__3_5",
      vars: { hud_score: 1240, hud_moves: 14, hud_goal: 1000, legalMoves: 16, movedCells: 5, producedChange: true },
      deltas: { hud_score: 60, hud_moves: -1 },
      controls: [SWAP, SHUFFLE, PAUSE],
    }),
    truth: { action_has_effect: true, clearing_tiles_scores: true, board_is_playable: true, screen_has_an_exit: true },
  },
  {
    name: "cleared tiles but score frozen (planted scoreCascade)",
    state: base({
      lastAction: "tap swap:3_4__3_5",
      vars: { hud_score: 0, hud_moves: 13, hud_goal: 1000, legalMoves: 15, movedCells: 7, producedChange: true },
      deltas: { hud_moves: -1 },
      controls: [SWAP, SHUFFLE, PAUSE],
    }),
    truth: { action_has_effect: true, clearing_tiles_scores: false, board_is_playable: true },
  },
  {
    name: "dead control, nothing changed (planted stuckNoShuffle)",
    state: base({
      screen: "board+stuck",
      lastAction: "tap shuffle_board",
      vars: { hud_score: 300, hud_moves: 9, legalMoves: 0, movedCells: 0, producedChange: false },
      deltas: {},
      controls: [SHUFFLE, PAUSE],
    }),
    truth: { action_has_effect: false, board_is_playable: false, progress_is_possible: false },
  },
  {
    name: "clear tutorial",
    state: base({
      screen: "tutorial",
      lastAction: "none",
      vars: {},
      controls: [GOTIT],
      recentScreens: ["tutorial"],
    }),
    truth: { instructions_are_actionable: true, screen_has_an_exit: true },
  },
  {
    name: "healthy board, several moves",
    state: base({
      lastAction: "tap swap:1_2__2_2",
      vars: { hud_score: 640, hud_moves: 18, hud_goal: 1000, legalMoves: 12, movedCells: 3, producedChange: true },
      deltas: { hud_score: 40, hud_moves: -1 },
      controls: [SWAP, SHUFFLE, PAUSE],
    }),
    truth: { action_has_effect: true, clearing_tiles_scores: true, board_is_playable: true, progress_is_possible: true },
  },
  {
    name: "win screen that does not advance (planted winNoAdvance)",
    state: base({
      screen: "win",
      lastAction: "tap next_level",
      vars: { hud_score: 1020, hud_goal: 1000, producedChange: false },
      deltas: {},
      controls: [NEXT],
      recentScreens: ["win", "win", "win"],
    }),
    truth: { action_has_effect: false, progress_is_possible: false },
  },
  {
    name: "screen with no controls at all",
    state: base({
      screen: "blank_panel",
      lastAction: "tap continue",
      vars: { producedChange: false },
      controls: [],
    }),
    truth: { screen_has_an_exit: false, action_has_effect: false },
  },
  {
    name: "healthy pause menu",
    state: base({
      screen: "pause_menu",
      lastAction: "tap pause",
      vars: { producedChange: true },
      changed: ["screen"],
      controls: [
        { id: "resume", kind: "button", text: "Resume", enabled: true },
        { id: "quit", kind: "button", text: "Quit to Menu", enabled: true },
      ],
    }),
    truth: { screen_has_an_exit: true, action_has_effect: true, instructions_are_actionable: true },
  },
];

/** The invariant prompts, verbatim from the match-3 suite. */
export const BENCH_QUESTIONS: Record<string, string> = {
  action_has_effect:
    "The player just performed an action that the game presented as available. Did anything on the screen change as a result?",
  screen_has_an_exit:
    "Does this screen give the player a way to leave it or continue past it, such as a back, close, continue, or confirm control?",
  instructions_are_actionable:
    "Reading only what is on this screen, would a first-time player know what they are supposed to do next?",
  board_is_playable:
    "The game is showing a puzzle board. Does the player have at least one move available to them?",
  clearing_tiles_scores:
    "The player just cleared tiles from the board. Did their score go up as a result?",
  progress_is_possible:
    "Has the player been able to make progress recently, rather than repeatedly taking actions that lead nowhere?",
};

/**
 * The same six properties asked so that "yes" means THE BUG IS PRESENT.
 *
 * Measured, not stylistic. The model leans toward yes, and every invariant in the
 * suite is phrased so that true = healthy, which points the bias at under-reporting
 * -- a QA tool that looks clean because it cannot say "no". On a state whose truth
 * was "no" on both questions, healthy-positive phrasing scored 0/2 and
 * defect-positive phrasing on the same state and same model scored 2/2.
 */
export const BENCH_QUESTIONS_DEFECT: Record<string, string> = {
  action_has_effect:
    "Did the player's last action fail to change anything on the screen, making the control they used appear broken?",
  screen_has_an_exit:
    "Is the player trapped on this screen, with no control that leaves it, goes back, continues, or confirms?",
  instructions_are_actionable:
    "Would a first-time player be left confused about what to do next or what the goal is on this screen?",
  board_is_playable:
    "Is the player stuck, with no legal move available on the board?",
  clearing_tiles_scores:
    "Did the player clear tiles without their score increasing?",
  progress_is_possible:
    "Is the player unable to make progress, with recent actions leading nowhere?",
};
