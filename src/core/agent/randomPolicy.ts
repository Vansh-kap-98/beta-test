import type { Action, GameState } from "../types.ts";
import type { Policy } from "./session.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded monkey tester.
 *
 * This is the baseline every smarter policy has to beat. It is genuinely good at
 * crashes and at hammering a single screen, and genuinely bad at reaching states
 * behind a sequence (a tutorial, a purchase flow, floor 7). Keeping it in the repo
 * as a measurable baseline is what stops "the model plays the game" from being an
 * unfalsifiable claim.
 */
export class RandomPolicy implements Policy {
  readonly name = "random";
  private rand: () => number;

  constructor(seed = 1) {
    this.rand = mulberry32(seed);
  }

  next(_state: GameState, actions: Action[]): Action {
    return actions[Math.floor(this.rand() * actions.length)] ?? { type: "noop" };
  }
}

/**
 * Prefers controls it has pressed least often on the current screen.
 *
 * Measured on the reference game, 10 seeds x 1500 steps: +13% distinct states over
 * uniform random (457 vs 403) and no difference at all in softlock detection - both
 * find it on 10/10 seeds. So this is a mild coverage win, not the large one it is
 * tempting to assume. It is kept as the fuzz baseline because the coverage edge is
 * free, but it is not the reason deep states get reached; that is the planner's job.
 */
export class CoverageFuzzPolicy implements Policy {
  readonly name = "coverage-fuzz";
  private rand: () => number;
  private counts = new Map<string, number>();

  constructor(seed = 1) {
    this.rand = mulberry32(seed);
  }

  next(state: GameState, actions: Action[]): Action {
    if (actions.length === 0) return { type: "noop" };
    const key = (a: Action) =>
      state.screen + "|" + (a.type === "tap" ? "tap:" + a.targetId : a.type);
    let best: Action[] = [];
    let bestN = Infinity;
    for (const a of actions) {
      const n = this.counts.get(key(a)) ?? 0;
      if (n < bestN) {
        bestN = n;
        best = [a];
      } else if (n === bestN) {
        best.push(a);
      }
    }
    const chosen = best[Math.floor(this.rand() * best.length)] ?? actions[0]!;
    this.counts.set(key(chosen), bestN + 1);
    return chosen;
  }
}
