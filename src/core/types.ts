/**
 * Core vocabulary shared by every tier.
 *
 * Design note: this is deliberately a *semantic* view of the game, not a pixel view.
 * A System One model is only as good as the state handed to it, so the adapter's job
 * is to produce something a model can reason over in a few hundred tokens: named
 * elements, explicit enabled/visible flags, and typed game variables.
 */

export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ElementKind = "button" | "label" | "icon" | "input" | "container";

export interface UiElement {
  id: string;
  kind: ElementKind;
  /** Visible caption, if any. */
  text?: string;
  visible: boolean;
  enabled: boolean;
  bbox: BBox;
  /**
   * Rendered width of `text` in px. Compared against bbox.w by the Tier-0 overflow
   * oracle. Adapters that cannot measure text should leave this undefined rather
   * than guess - a missing signal is recoverable, a wrong one produces false bugs.
   */
  textWidth?: number;
  tags?: string[];
  parent?: string;
}

/** Everything the bot can see at one instant. */
export interface GameState {
  step: number;
  /** Semantic screen identifier, e.g. "shop", "dungeon.combat". */
  screen: string;
  elements: UiElement[];
  /** Typed game variables: gold, hp, level, ... */
  vars: Record<string, number | string | boolean>;
  loading: boolean;
  /** Errors observed since the previous observe() call. Drained by the adapter. */
  errors: string[];
  perf: { fps: number; heapMB: number };
}

export type Action =
  | { type: "tap"; targetId: string }
  | { type: "input"; targetId: string; value: string }
  | { type: "wait"; ms: number }
  | { type: "back" }
  | { type: "noop" };

export type BugClass = "crash" | "softlock" | "flow" | "ui" | "balance" | "perf";
export type Severity = "critical" | "high" | "medium" | "low";
export type Tier = "tier0" | "tier1" | "tier2";

export interface Replay {
  seed: number;
  actions: Action[];
}

export interface Finding {
  id: string;
  severity: Severity;
  bugClass: BugClass;
  title: string;
  detail: string;
  step: number;
  source: Tier;
  /**
   * Stable identity for the *defect*, not the occurrence. A softlock fires on every
   * step it persists; without this the report is 400 copies of one bug. The runner
   * keeps the first occurrence per key and counts the rest.
   */
  dedupeKey: string;
  /** Tier-1 confidence, when the finding came from a model rather than plain code. */
  confidence?: number;
  replay: Replay;
  evidence?: Record<string, unknown>;
}

/**
 * The only surface the agent needs from a game. Keeping this narrow is what lets a
 * browser/OS-level adapter be added later for black-box targets without touching
 * the agent, the oracles or the trace layer.
 */
export interface GameAdapter {
  readonly name: string;
  /**
   * Whether `snapshot`/`restore` genuinely round-trip.
   *
   * Many real targets cannot cheaply snapshot - a live DOM app, or anything with
   * server state. Recovery silently becomes a lie when restore is a no-op: the run
   * "rewinds", lands in the same trap, and reports progress it did not make. An
   * adapter that cannot snapshot says so, and the session disables recovery rather
   * than pretending.
   */
  readonly canSnapshot?: boolean;
  reset(seed: number): void;
  observe(): GameState;
  act(action: Action): void;
  /** Legal actions from the current state. Used for shortlisting and for fuzzing. */
  availableActions(): Action[];
  snapshot(): unknown;
  restore(snap: unknown): void;
}
