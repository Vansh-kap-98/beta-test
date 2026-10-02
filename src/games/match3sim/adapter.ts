import type { Action, GameAdapter, GameState, UiElement } from "../../core/types.ts";
import { ALL_MATCH3_BUGS, Match3Game } from "./game.ts";
import type { Match3Bug } from "./game.ts";

/**
 * Exposes the headless match-3 through the same `GameAdapter` interface the live
 * sidecar uses, and deliberately through the same ACTION IDENTITY scheme: a swap is
 * offered as `tap` with targetId `swap:<ax>_<ay>__<bx>_<by>`, exactly the sig the
 * Python side emits.
 *
 * Keeping the two identical is what makes the comparison meaningful. Any difference
 * in findings between this adapter and the live one is then attributable to
 * perception, because nothing else differs.
 *
 * One deliberate difference from a "smart" bot: a slice of the offered swaps are
 * INVALID. A bot that only ever makes legal moves never exercises the game's error
 * paths, so the fixture's `ghostMove` bug -- a move silently consumed on a rejected
 * swap -- was unreachable and scored as "not detected" when it had simply never
 * been tried. Real players misclick; a tester that cannot is blind to a whole class
 * of defect.
 */

export interface Match3SimOptions {
  bugs?: Match3Bug[];
  /** Share of offered swaps that are deliberately invalid. 0 disables. */
  invalidShare?: number;
  seed?: number;
  /**
   * Start in a specific situation instead of a fresh board.
   *
   * "stuck" deals a board with no legal move. Some defects only exist in states a
   * player reaches rarely, and a bench that waits for chance to produce them is
   * really just reporting that it never looked. This is the seed of the task
   * framework: drive the game to the state the defect lives in, then judge it.
   */
  scenario?: "fresh" | "stuck";
}

const SWAP = /^swap:(\d+)_(\d+)__(\d+)_(\d+)$/;

export class Match3SimAdapter implements GameAdapter {
  readonly name = "match3sim";
  /** In-process, so unlike a real game this one genuinely can be snapshotted. */
  readonly canSnapshot = true;

  private game: Match3Game;
  private bugs: Match3Bug[];
  private invalidShare: number;
  private seed: number;
  private scenario: "fresh" | "stuck";
  private step = 0;
  private rng: () => number;
  private errors: string[] = [];
  /** Outcome of the last action, for the change-detection vars. */
  private last = { changed: false, cleared: 0, rejected: false };

  constructor(opts: Match3SimOptions = {}) {
    this.bugs = opts.bugs ?? [];
    /**
     * A quarter of offered swaps are invalid.
     *
     * Raised from 0.15 after a measurement: at the lower rate the planted
     * consumed-move bug was found on two of three seeds and missed on the third,
     * purely because the bot had not misclicked often enough for the evidence gate
     * to clear. Detection of an error-path defect scales with how often the error
     * path is probed, so the probe budget is a dial, not an accident -- and a human
     * tester deliberately tries things that should not work.
     */
    this.invalidShare = opts.invalidShare ?? 0.25;
    this.seed = opts.seed ?? 1;
    this.scenario = opts.scenario ?? "fresh";
    this.game = new Match3Game(this.seed, this.bugs);
    this.rng = mulberry(this.seed ^ 0x9e3779b9);
    this.applyScenario();
  }

  private applyScenario(): void {
    if (this.scenario === "stuck") {
      this.game.dismissTutorial();
      this.game.dealDeadBoard();
    }
  }

  reset(seed: number): void {
    this.seed = seed;
    this.game = new Match3Game(seed, this.bugs);
    this.rng = mulberry(seed ^ 0x9e3779b9);
    this.applyScenario();
    this.step = 0;
    this.errors = [];
    this.last = { changed: false, cleared: 0, rejected: false };
  }

  observe(): GameState {
    const g = this.game;
    const errors = this.errors;
    this.errors = [];

    const elements: UiElement[] = this.availableActions().map((a, i) => ({
      id: a.type === "tap" ? a.targetId : a.type,
      kind: "button",
      text: this.labels()[a.type === "tap" ? a.targetId : a.type] ?? "",
      visible: true,
      enabled: true,
      bbox: { x: 0, y: i, w: 0, h: 0 },
    }));

    const vars: Record<string, number | string | boolean> = {
      hud_score: g.score,
      hud_moves: g.moves,
      hud_goal: g.goal,
      hud_level: g.level,
      producedChange: this.last.changed,
      movedCells: this.last.cleared,
    };
    // Only on the board is a legal-move count meaningful; on an overlay the board
    // is not what the player is looking at, and offering the number there invites
    // the "board has no moves" invariant to fire about a screen it cannot see.
    if (g.overlay === null || g.overlay === "stuck") {
      vars["legalMoves"] = g.validSwaps().length;
      vars["boardCols"] = 8;
      vars["boardRows"] = 8;
    }

    return {
      step: this.step,
      screen: this.screenId(),
      elements,
      vars,
      text: this.text(),
      loading: false,
      errors,
      perf: { fps: 60, heapMB: 0 },
    };
  }

  /** Text the player can read, which is what the comprehension invariant judges. */
  text(): string[] {
    const g = this.game;
    switch (g.overlay) {
      case "tutorial":
        return ["Welcome!", g.tutorialText()];
      case "win":
        return ["Level complete!", "Score " + g.score + " of " + g.goal];
      case "lose":
        return ["Out of moves", "Score " + g.score + " of " + g.goal];
      case "stuck":
        return ["No moves left", "Shuffle the board to continue"];
      case "pause":
        return ["Paused", "Resume to continue playing"];
      default:
        return [
          "Score " + g.score,
          "Moves " + g.moves,
          "Goal " + g.goal,
          "Level " + g.level,
        ];
    }
  }

  private screenId(): string {
    const g = this.game;
    return g.overlay === null ? "board" : "overlay_" + g.overlay;
  }

  async act(action: Action): Promise<void> {
    this.step += 1;
    this.last = { changed: false, cleared: 0, rejected: false };
    if (action.type !== "tap") return;

    const g = this.game;
    const before = snapshotOf(g);
    const id = action.targetId;

    const m = SWAP.exec(id);
    if (m) {
      const cleared = g.swap(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]));
      this.last.cleared = cleared;
      this.last.rejected = g.lastRejected;
    } else if (id === "got_it") {
      g.dismissTutorial();
    } else if (id === "shuffle_board") {
      g.shuffle();
    } else if (id === "next_level") {
      g.nextLevel();
    } else if (id === "retry") {
      g.retry();
    } else if (id === "pause") {
      g.pause();
    } else if (id === "resume") {
      g.resume();
    } else {
      this.errors.push("UNKNOWN_ACTION: " + id);
    }

    // "Did anything change?" measured the same way the live path measures it -- by
    // comparing observable state before and after -- rather than by trusting the
    // game to report it. The live adapter has no choice; this one matches so the
    // two agree about what a dead control looks like.
    this.last.changed = snapshotOf(g) !== before;
  }

  /**
   * Memoised per observable state.
   *
   * `labels()` calls this, and so does `observe()`, and the invalid-swap probes are
   * drawn from an RNG -- so each call returned a DIFFERENT action list for the same
   * state, and a caption lookup could miss an action that was offered a moment
   * earlier. Action identity is what dedup, bans, visit counts and the option
   * shortlist are all keyed on, so an unstable list quietly corrupts every one of
   * them.
   */
  private actionCache: { key: string; actions: Action[] } | null = null;

  availableActions(): Action[] {
    const key = snapshotOf(this.game) + "#" + this.step;
    if (this.actionCache && this.actionCache.key === key) return this.actionCache.actions;
    const actions = this.computeActions();
    this.actionCache = { key, actions };
    return actions;
  }

  private computeActions(): Action[] {
    const g = this.game;
    const out: Action[] = [];

    if (g.overlay === "tutorial") {
      out.push({ type: "tap", targetId: "got_it" });
      return out;
    }
    if (g.overlay === "win") {
      out.push({ type: "tap", targetId: "next_level" });
      return out;
    }
    if (g.overlay === "lose") {
      out.push({ type: "tap", targetId: "retry" });
      return out;
    }
    if (g.overlay === "stuck") {
      out.push({ type: "tap", targetId: "shuffle_board" });
      out.push({ type: "tap", targetId: "pause" });
      return out;
    }
    if (g.overlay === "pause") {
      out.push({ type: "tap", targetId: "resume" });
      return out;
    }

    // Board: offer a handful of real swaps, plus some invalid ones so the error
    // path is exercised. Capped to stay inside the model's option budget.
    const valid = g.validSwaps();
    for (const s of valid.slice(0, 8)) {
      out.push({ type: "tap", targetId: swapSig(s.a, s.b) });
    }
    const wantInvalid = Math.max(1, Math.round(out.length * this.invalidShare));
    let guard = 0;
    const seen = new Set(out.map((a) => (a.type === "tap" ? a.targetId : "")));
    while (out.length > 0 && guard++ < 60) {
      if (out.length >= valid.slice(0, 8).length + wantInvalid) break;
      const x = Math.floor(this.rng() * 8);
      const y = Math.floor(this.rng() * 7);
      const sig = swapSig([x, y], [x, y + 1]);
      const isValid = valid.some((s) => swapSig(s.a, s.b) === sig);
      if (!isValid && !seen.has(sig)) {
        seen.add(sig);
        out.push({ type: "tap", targetId: sig });
      }
    }
    out.push({ type: "tap", targetId: "shuffle_board" });
    // The board's way out. Without it the board genuinely has no exit, which the
    // exit invariant correctly reported on a "clean" build.
    out.push({ type: "tap", targetId: "pause" });
    return out;
  }

  labels(): Record<string, string> {
    const out: Record<string, string> = {
      got_it: "Got it",
      shuffle_board: "Shuffle Board",
      next_level: "Next Level",
      retry: "Retry",
      pause: "Pause",
      resume: "Resume",
    };
    for (const a of this.availableActionsRaw()) {
      const m = SWAP.exec(a);
      if (m) out[a] = "swap two candies";
    }
    return out;
  }

  private availableActionsRaw(): string[] {
    return this.availableActions().map((a) => (a.type === "tap" ? a.targetId : a.type));
  }

  snapshot(): unknown {
    return {
      grid: this.game.grid.slice(),
      score: this.game.score,
      moves: this.game.moves,
      goal: this.game.goal,
      level: this.game.level,
      overlay: this.game.overlay,
      step: this.step,
    };
  }

  restore(snap: unknown): void {
    const s = snap as ReturnType<Match3SimAdapter["snapshot"]> & Record<string, never>;
    const o = s as unknown as {
      grid: Array<number | null>; score: number; moves: number;
      goal: number; level: number; overlay: Match3Game["overlay"]; step: number;
    };
    this.game.grid = o.grid.slice();
    this.game.score = o.score;
    this.game.moves = o.moves;
    this.game.goal = o.goal;
    this.game.level = o.level;
    this.game.overlay = o.overlay;
    this.step = o.step;
  }

  /** The live game, for ground-truth scoring. Never read by the agent. */
  get truth(): Match3Game {
    return this.game;
  }
}

export function swapSig(a: [number, number], b: [number, number]): string {
  return "swap:" + a[0] + "_" + a[1] + "__" + b[0] + "_" + b[1];
}

/** Everything observable, as one string: the change detector's input. */
function snapshotOf(g: Match3Game): string {
  return g.grid.join(",") + "|" + g.score + "|" + g.moves + "|" + g.level + "|" + g.overlay;
}

function mulberry(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { ALL_MATCH3_BUGS };
