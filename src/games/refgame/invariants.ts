import type { Invariant } from "../../core/oracles/invariants.ts";
import type { SocState } from "../../core/soc/serialize.ts";
import type { BoundsSpec } from "../../core/oracles/tier0.ts";

/**
 * Range checks that belong to Tier 0, not to the model.
 *
 * These started life as natural-language invariants and produced hundreds of false
 * positives on a clean build, because they applied on every step and every wrong
 * model answer became a bug report. They are arithmetic; code decides them exactly.
 */
export const REFGAME_BOUNDS: BoundsSpec[] = [
  { variable: "gold", min: 0, label: "Currency went negative" },
  { variable: "hp", min: 0, maxVar: "maxHp", label: "Health left its legal range" },
  { variable: "potions", min: 0, label: "Consumable count went negative" },
];

/**
 * Invariants for the reference game, phrased as a designer would write them in a
 * design doc rather than as code. `true` is always the healthy answer.
 *
 * Note what is NOT here: any mention of `buy_elixir`, `deltas.gold`, or any other
 * identifier from the game. The propositions are about the *game's meaning*, which
 * is what lets the same list be pointed at a different screen - or a different
 * game - without being rewritten.
 */
export const REFGAME_INVARIANTS: Invariant[] = [
  {
    id: "purchase_deducts_currency",
    prompt: "The player just bought an item. Did the player's currency go down?",
    criteria: {
      true: "the currency total is lower than before the purchase",
      false: "the currency total is unchanged or higher after the purchase",
    },
    title: "Purchase did not deduct currency",
    bugClass: "flow",
    severity: "high",
    applies: (s) => s.lastAction.startsWith("tap buy_") && (s.deltas["potions"] ?? 0) > 0,
  },
  {
    id: "consumable_is_consumed",
    prompt: "The player just used a consumable item. Did their stock of it go down?",
    criteria: {
      true: "the stock of the consumable is lower than before",
      false: "the stock is unchanged after using the item",
    },
    title: "Consumable was used without being consumed",
    bugClass: "flow",
    severity: "medium",
    applies: (s) => s.lastAction === "tap use_potion" && s.errorCount === 0 && !s.loading,
  },
  {
    id: "screen_has_an_exit",
    prompt:
      "Does this screen give the player a way to leave it, such as a back, close, cancel or flee control?",
    criteria: {
      true: "at least one control leaves this screen - back, close, cancel, flee or similar",
      false: "every control keeps the player on this screen",
    },
    title: "Screen has no exit",
    bugClass: "softlock",
    severity: "critical",
    applies: (s) =>
      !s.loading && s.screen !== "title" && s.screen !== "menu" && s.screen !== "gameover",
  },
];

/**
 * Ground truth for the invariants above, used only by the offline mock.
 *
 * This is test scaffolding, not product code. It exists so the pipeline can be
 * measured against a known-correct answer without an API key. In production these
 * questions are answered by Jev or Laya reading the same state - which is the whole
 * point, because a real game cannot have its semantics hand-coded this way.
 */
export function refgameInvariantTruth(s: SocState, invariantId: string): boolean | undefined {
  switch (invariantId) {
    case "purchase_deducts_currency":
      return (s.deltas["gold"] ?? 0) < 0;
    case "consumable_is_consumed":
      return (s.deltas["potions"] ?? 0) < 0;
    case "screen_has_an_exit":
      return s.controls.some(
        (c) => c.enabled && /back|menu|close|cancel|flee|restart|exit/i.test(c.id),
      );
    default:
      return undefined;
  }
}
