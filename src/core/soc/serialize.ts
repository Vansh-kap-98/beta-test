import type { Action, GameState } from "../types.ts";

/**
 * Turns two game states plus the action between them into the compact blob handed
 * to the System One model.
 *
 * Two decisions carry most of the weight here:
 *
 * 1. **Deltas are precomputed.** Questions like "did buying that item reduce the
 *    player's gold?" are two-state comparisons, and asking a model to perform
 *    arithmetic across two nested objects is exactly the kind of work a non-
 *    generative model is worst at. Emitting `deltas: { gold: -5 }` converts the
 *    question into a lookup. This single change is the difference between the
 *    economy invariant working and not working.
 *
 * 2. **It is lean on purpose.** Token budget spent on decoration is budget not
 *    spent on option representation, which is the scarce resource. Element
 *    geometry, z-order and styling are Tier-0 concerns and never reach the model.
 */

export interface SocState {
  screen: string;
  loading: boolean;
  vars: Record<string, number | string | boolean>;
  /** Signed changes since the previous observation. Only non-zero entries. */
  deltas: Record<string, number>;
  /** Variables that changed to or from a non-numeric value. */
  changed: string[];
  lastAction: string;
  /**
   * Every interactive element, not just buttons.
   *
   * This filtered to `kind === "button"` until a game with text fields was added,
   * at which point the model could not see the form it was being asked about -
   * and an invariant about invalid input had no way to tell which screen the input
   * even lived on.
   */
  controls: Array<{ id: string; kind: string; text: string; enabled: boolean }>;
  /** Readable, non-control text on the screen. Absent if the adapter cannot read it. */
  text?: string[];
  recentScreens: string[];
  errorCount: number;
}

export function describeAction(a: Action | null | undefined): string {
  if (!a) return "none";
  switch (a.type) {
    case "tap":
      return "tap " + a.targetId;
    case "input":
      return "input " + a.targetId + "=" + a.value;
    case "wait":
      return "wait";
    case "back":
      return "back";
    case "noop":
      return "noop";
  }
}

/**
 * Stable, human-readable id for an action, used as a choice option.
 *
 * Readable on purpose: "input email=a@b.com" is something a model can reason about,
 * where an opaque index is not.
 */
export function actionOptionId(a: Action): string {
  return describeAction(a);
}

export function serialize(
  cur: GameState,
  prev: GameState | undefined,
  lastAction: Action | null,
  recentScreens: string[] = [],
): SocState {
  const deltas: Record<string, number> = {};
  const changed: string[] = [];

  if (prev) {
    for (const [k, v] of Object.entries(cur.vars)) {
      const p = prev.vars[k];
      if (typeof v === "number" && typeof p === "number") {
        if (v !== p) deltas[k] = Number((v - p).toFixed(4));
      } else if (v !== p) {
        changed.push(k);
      }
    }
  }

  return {
    screen: cur.screen,
    loading: cur.loading,
    vars: cur.vars,
    deltas,
    changed,
    lastAction: describeAction(lastAction),
    controls: cur.elements
      .filter((e) => e.visible && e.kind !== "label")
      .map((e) => ({ id: e.id, kind: e.kind, text: e.text ?? "", enabled: e.enabled })),
    ...(cur.text ? { text: cur.text } : {}),
    recentScreens: recentScreens.slice(-6),
    errorCount: cur.errors.length,
  };
}

/** Rough token estimate, for budgeting and for the cost model in reports. */
export function estimateTokens(blob: unknown): number {
  return Math.ceil(JSON.stringify(blob).length / 4);
}
