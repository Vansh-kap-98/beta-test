import type { Action, GameAdapter, GameState, UiElement } from "../../core/types.ts";
import type { BugFlags } from "./bugs.ts";
import type { CoreState } from "./game.ts";
import { RefGame } from "./game.ts";

/**
 * Wraps RefGame in the adapter contract.
 *
 * The important behaviour here is that a thrown exception from the game is caught
 * and turned into an observable error rather than tearing down the run. A beta-test
 * bot that dies on the first crash finds exactly one bug per session; catching lets
 * it record the crash, restore a snapshot, and keep exploring.
 */
export class RefGameAdapter implements GameAdapter {
  readonly name = "refgame";
  private game: RefGame;
  private pendingErrors: string[] = [];

  constructor(bugs: Partial<BugFlags> = {}) {
    this.game = new RefGame(bugs);
  }

  reset(seed: number): void {
    this.game.reset(seed);
    this.pendingErrors = [];
  }

  observe(): GameState {
    const g = this.game;
    const elements: UiElement[] = g.elements().map((e) => ({
      id: e.id,
      kind: e.kind,
      text: e.text,
      visible: e.visible,
      enabled: e.enabled,
      bbox: e.bbox,
      textWidth: e.textWidth,
      tags: e.tags,
    }));

    const errors = [...this.pendingErrors, ...g.drainErrors()];
    this.pendingErrors = [];

    return {
      step: g.s.step,
      screen: g.s.loadingFrames > 0 ? g.s.screen + ".loading" : g.s.screen,
      elements,
      vars: {
        gold: g.s.gold,
        hp: g.s.hp,
        maxHp: g.s.maxHp,
        potions: g.s.potions,
        floor: g.s.floor,
        enemyHp: g.s.enemyHp,
        dead: g.s.dead,
      },
      loading: g.s.loadingFrames > 0,
      errors,
      perf: { fps: g.fps(), heapMB: g.heapMB() },
    };
  }

  act(action: Action): void {
    try {
      switch (action.type) {
        case "tap":
          this.game.tap(action.targetId);
          break;
        case "wait":
          this.game.tick();
          break;
        case "back":
          this.game.tap("back");
          break;
        case "input":
        case "noop":
          this.game.tick();
          break;
      }
    } catch (err) {
      // An uncaught game exception is a finding, not a reason to stop.
      const msg = err instanceof Error ? err.message : String(err);
      this.pendingErrors.push("UNCAUGHT: " + msg);
    }
  }

  availableActions(): Action[] {
    // `wait` is offered ONLY while something is actually in flight. Listing it on
    // every menu makes "do nothing" a permanent candidate, which wastes decisions
    // and lets the bot stall on a screen it should be exercising. An adapter for a
    // game with animations or real-time elements would offer it more widely - that
    // is the adapter's judgement to make, not the agent's.
    if (this.game.s.loadingFrames > 0) return [{ type: "wait", ms: 16 }];
    return this.game.interactableIds().map((id) => ({ type: "tap", targetId: id }) as Action);
  }

  snapshot(): unknown {
    return this.game.snapshot();
  }

  restore(snap: unknown): void {
    this.game.restore(snap as CoreState);
  }
}
