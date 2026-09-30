import type { GameAdapter } from "../core/types.ts";
import type { Invariant } from "../core/oracles/invariants.ts";
import type { BoundsSpec } from "../core/oracles/tier0.ts";
import type { TruthFn } from "../core/soc/backends/mock.ts";
import type { OraclePlannerTruth } from "../core/agent/planner.ts";
import { RefGameAdapter } from "./refgame/adapter.ts";
import { REFGAME_INVARIANTS, REFGAME_BOUNDS, refgameInvariantTruth } from "./refgame/invariants.ts";
import { makeRefgameTruth, bestControl } from "./refgame/truth.ts";
import { ALL_BUGS, NO_BUGS, only } from "./refgame/bugs.ts";
import type { BugFlags } from "./refgame/bugs.ts";
import { CheckoutAdapter } from "./checkout/adapter.ts";
import {
  ALL_CHECKOUT_BUGS,
  NO_CHECKOUT_BUGS,
  onlyCheckout,
} from "./checkout/game.ts";
import type { CheckoutBugs } from "./checkout/game.ts";
import {
  CHECKOUT_INVARIANTS,
  CHECKOUT_BOUNDS,
  checkoutInvariantTruth,
  checkoutBestControl,
  makeCheckoutTruth,
} from "./checkout/invariants.ts";

/**
 * Everything the CLI needs to test a game, in one entry.
 *
 * Adding a second game means adding one of these - an adapter, an invariant list
 * and a bounds spec. The `mockTruth` and `plannerTruth` fields are for offline
 * measurement only; a real target supplies a Jev or Laya client instead and needs
 * neither.
 */
export interface GameEntry {
  name: string;
  description: string;
  makeAdapter(variant: string): GameAdapter;
  invariants: Invariant[];
  bounds: BoundsSpec[];
  variants: string[];
  mockTruth?: () => TruthFn;
  plannerTruth?: OraclePlannerTruth;
}

function refgameVariant(variant: string): BugFlags {
  if (variant === "clean" || variant === "none") return NO_BUGS;
  if (variant === "all") return ALL_BUGS;
  const names = variant.split(",").map((s) => s.trim()) as Array<keyof BugFlags>;
  const unknown = names.filter((n) => !(n in ALL_BUGS));
  if (unknown.length > 0) {
    throw new Error(
      "unknown bug flag(s): " + unknown.join(", ") + ". Known: " + Object.keys(ALL_BUGS).join(", "),
    );
  }
  return only(...names);
}

function checkoutVariant(variant: string): CheckoutBugs {
  if (variant === "clean" || variant === "none") return NO_CHECKOUT_BUGS;
  if (variant === "all") return ALL_CHECKOUT_BUGS;
  const names = variant.split(",").map((s) => s.trim()) as Array<keyof CheckoutBugs>;
  const unknown = names.filter((n) => !(n in ALL_CHECKOUT_BUGS));
  if (unknown.length > 0) {
    throw new Error(
      "unknown bug flag(s): " +
        unknown.join(", ") +
        ". Known: " +
        Object.keys(ALL_CHECKOUT_BUGS).join(", "),
    );
  }
  return onlyCheckout(...names);
}

export const GAMES: Record<string, GameEntry> = {
  refgame: {
    name: "refgame",
    description: "Reference RPG with seven planted bugs across all four bug classes.",
    makeAdapter: (variant) => new RefGameAdapter(refgameVariant(variant)),
    invariants: REFGAME_INVARIANTS,
    bounds: REFGAME_BOUNDS,
    variants: ["clean", "all", ...Object.keys(ALL_BUGS)],
    mockTruth: makeRefgameTruth,
    plannerTruth: { bestControl, invariantHolds: refgameInvariantTruth },
  },

  // Second target, added to test whether the core really is game-agnostic.
  // Structurally unlike the RPG: text input, validation states, a linear flow,
  // no combat and no difficulty curve. Adding it required generalising the policy
  // beyond tap-only actions - see docs/JOURNAL.md - and nothing else.
  checkout: {
    name: "checkout",
    description: "Four-step purchase wizard with five planted bugs. Exercises form input.",
    makeAdapter: (variant) => new CheckoutAdapter(checkoutVariant(variant)),
    invariants: CHECKOUT_INVARIANTS,
    bounds: CHECKOUT_BOUNDS,
    variants: ["clean", "all", ...Object.keys(ALL_CHECKOUT_BUGS)],
    mockTruth: makeCheckoutTruth,
    plannerTruth: {
      bestControl: checkoutBestControl,
      invariantHolds: checkoutInvariantTruth,
    },
  },
};

export function getGame(name: string): GameEntry {
  const g = GAMES[name];
  if (!g) {
    throw new Error("unknown game '" + name + "'. Known: " + Object.keys(GAMES).join(", "));
  }
  return g;
}
