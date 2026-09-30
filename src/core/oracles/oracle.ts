import type { Action, Finding, GameState } from "../types.ts";

/** Rolling context handed to every oracle on every step. */
export interface OracleContext {
  seed: number;
  cur: GameState;
  prev?: GameState;
  /** Most recent states, oldest first. Bounded by the runner. */
  window: GameState[];
  /** Actions taken in the same window, aligned with `window`. */
  windowActions: Action[];
  /** Full action log since reset - this is what makes a finding reproducible. */
  actionLog: Action[];
}

export interface Oracle {
  readonly name: string;
  check(ctx: OracleContext): Finding[];
}

/**
 * Identity of a *visible situation*. Two states with the same hash are
 * indistinguishable to a player: same screen, same variables, same set of
 * interactable controls.
 *
 * Deliberately excludes `step`, `perf` and `errors` - including any of them would
 * make every state unique and the softlock detector would never fire.
 */
export function stateHash(s: GameState): string {
  const controls = s.elements
    .filter((e) => e.visible && e.enabled && e.kind === "button")
    .map((e) => e.id)
    .sort()
    .join(",");
  const vars = Object.keys(s.vars)
    .sort()
    .map((k) => k + "=" + String(s.vars[k]))
    .join(",");
  return s.screen + "|" + vars + "|" + controls;
}

let findingSeq = 0;
export function mkFinding(f: Omit<Finding, "id">): Finding {
  findingSeq += 1;
  return { id: "F" + String(findingSeq).padStart(4, "0"), ...f };
}

/** Reset id numbering - used by tests so ids are stable run to run. */
export function _resetFindingIds(): void {
  findingSeq = 0;
}
