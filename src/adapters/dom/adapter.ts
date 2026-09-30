import type { Action, GameAdapter, GameState, UiElement } from "../../core/types.ts";

/**
 * Generic DOM adapter — the integration path for any web game.
 *
 * Works for a plain DOM UI, and for canvas engines (LayaAir, Phaser, Cocos, Egret)
 * provided the game exposes its scene tree. Canvas games render to pixels, so
 * reading the DOM alone finds nothing; `elementsFrom` is the hook where you walk
 * the engine's own node tree instead. That is the single most valuable piece of
 * integration work for a canvas target and it is usually under an hour: walk the
 * stage, emit id / text / visible / enabled / bounds per node.
 *
 * Structural interfaces rather than lib.dom types: it keeps the core free of a DOM
 * dependency, and it makes the whole adapter unit-testable against plain objects
 * with no browser and no headless driver.
 */

export interface RectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ElementLike {
  tagName: string;
  id?: string;
  textContent?: string | null;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): RectLike;
  /** Rendered vs available width, used for overflow detection. */
  scrollWidth?: number;
  clientWidth?: number;
  hidden?: boolean;
  disabled?: boolean;
  click?(): void;
  value?: string;
  /** Computed visibility, when the host can supply it. */
  __visible?: boolean;
}

export interface DocumentLike {
  querySelectorAll(selector: string): ArrayLike<ElementLike>;
  querySelector(selector: string): ElementLike | null;
}

export interface WindowLike {
  location?: { pathname?: string; hash?: string };
  performance?: { memory?: { usedJSHeapSize?: number } };
}

export interface DomAdapterConfig {
  doc: DocumentLike;
  win?: WindowLike;
  /** CSS selector for anything the player can interact with. */
  interactiveSelector?: string;
  /**
   * Semantic screen name. Defaults to the URL path + hash, which is right for a
   * routed app and useless for a single-page canvas game - override it there.
   */
  screenOf?: (doc: DocumentLike, win: WindowLike | undefined) => string;
  /**
   * Typed game variables. This is what makes flow invariants possible at all: a
   * bot that cannot see the player's currency cannot check that buying deducted it.
   * Usually reads a debug hook the game already has, e.g. `window.__GAME__.state`.
   */
  varsOf?: (doc: DocumentLike, win: WindowLike | undefined) => Record<string, number | string | boolean>;
  /** Replace the default DOM walk, e.g. to walk a canvas engine's scene tree. */
  elementsFrom?: (doc: DocumentLike) => UiElement[];
  /** Errors collected by the host since the last call. Drained each observe. */
  drainErrors?: () => string[];
  /** Frames per second, if the host measures it. */
  fps?: () => number;
  /** Put the app back into a known state for a seeded run. */
  reset?: (seed: number) => void;
  snapshot?: () => unknown;
  restore?: (snap: unknown) => void;
  /** Perform an action. Defaults to `click()` and setting `value`. */
  perform?: (action: Action, doc: DocumentLike) => void;
}

const DEFAULT_SELECTOR =
  'button, a[href], input, select, textarea, [role="button"], [role="link"], [role="tab"], [onclick], [data-testid]';

function isVisible(el: ElementLike): boolean {
  if (el.__visible !== undefined) return el.__visible;
  if (el.hidden === true) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function isEnabled(el: ElementLike): boolean {
  if (el.disabled === true) return false;
  if (el.getAttribute("aria-disabled") === "true") return false;
  return true;
}

function kindOf(el: ElementLike): UiElement["kind"] {
  const tag = el.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return "input";
  if (tag === "button" || tag === "a") return "button";
  const role = el.getAttribute("role");
  if (role === "button" || role === "link" || role === "tab") return "button";
  return "container";
}

/**
 * Stable identity for an element.
 *
 * Order of preference matters: a test id or DOM id survives re-renders, a label
 * usually does, and a DOM path almost never does. An unstable id makes every
 * finding a new defect and breaks replay, so anything better than a path is worth
 * reaching for first.
 */
export function elementId(el: ElementLike, index: number): string {
  const testId = el.getAttribute("data-testid") ?? el.getAttribute("data-test-id");
  if (testId) return testId;
  if (el.id) return el.id;
  const name = el.getAttribute("name");
  if (name) return el.tagName.toLowerCase() + ":" + name;
  const label = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 32);
  if (label) return el.tagName.toLowerCase() + ":" + label.replace(/\s+/g, "_");
  return el.tagName.toLowerCase() + "#" + index;
}

export function readElements(doc: DocumentLike, selector: string): UiElement[] {
  const nodes = doc.querySelectorAll(selector);
  const out: UiElement[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i]!;
    const rect = el.getBoundingClientRect();
    const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
    const item: UiElement = {
      id: elementId(el, i),
      kind: kindOf(el),
      text: text || undefined,
      visible: isVisible(el),
      enabled: isEnabled(el),
      bbox: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
    };
    // Only claim a text width when the host actually measured one. Guessing here
    // manufactures overflow findings on every long caption.
    if (typeof el.scrollWidth === "number" && typeof el.clientWidth === "number") {
      item.textWidth = el.scrollWidth;
      item.bbox.w = el.clientWidth || rect.width;
    }
    out.push(item);
  }
  return out;
}

export class DomAdapter implements GameAdapter {
  readonly name = "dom";
  readonly canSnapshot: boolean;

  private cfg: DomAdapterConfig;
  private selector: string;
  private step = 0;
  private pendingErrors: string[] = [];

  constructor(cfg: DomAdapterConfig) {
    this.cfg = cfg;
    this.selector = cfg.interactiveSelector ?? DEFAULT_SELECTOR;
    // Honest by default: a live DOM cannot be snapshotted unless the host says so.
    this.canSnapshot = Boolean(cfg.snapshot && cfg.restore);
  }

  reset(seed: number): void {
    this.step = 0;
    this.pendingErrors = [];
    this.cfg.reset?.(seed);
  }

  observe(): GameState {
    const elements = this.cfg.elementsFrom
      ? this.cfg.elementsFrom(this.cfg.doc)
      : readElements(this.cfg.doc, this.selector);

    const errors = [...this.pendingErrors, ...(this.cfg.drainErrors?.() ?? [])];
    this.pendingErrors = [];

    const heapBytes = this.cfg.win?.performance?.memory?.usedJSHeapSize;

    return {
      step: this.step,
      screen: this.cfg.screenOf
        ? this.cfg.screenOf(this.cfg.doc, this.cfg.win)
        : defaultScreen(this.cfg.win),
      elements,
      vars: this.cfg.varsOf?.(this.cfg.doc, this.cfg.win) ?? {},
      loading: elements.length === 0,
      errors,
      perf: {
        fps: this.cfg.fps?.() ?? 60,
        heapMB: heapBytes ? Math.round((heapBytes / 1048576) * 10) / 10 : 0,
      },
    };
  }

  act(action: Action): void {
    this.step += 1;
    try {
      if (this.cfg.perform) {
        this.cfg.perform(action, this.cfg.doc);
        return;
      }
      if (action.type === "tap" || action.type === "input") {
        const el = this.find(action.targetId);
        if (!el) return;
        if (action.type === "input") el.value = action.value;
        else el.click?.();
      }
    } catch (err) {
      this.pendingErrors.push("UNCAUGHT: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  availableActions(): Action[] {
    const out: Action[] = [];
    for (const e of this.observe().elements) {
      if (!e.visible || !e.enabled) continue;
      if (e.kind === "button") out.push({ type: "tap", targetId: e.id });
    }
    return out;
  }

  snapshot(): unknown {
    return this.cfg.snapshot?.() ?? null;
  }

  restore(snap: unknown): void {
    this.cfg.restore?.(snap);
  }

  private find(id: string): ElementLike | null {
    const nodes = this.cfg.doc.querySelectorAll(this.selector);
    for (let i = 0; i < nodes.length; i++) {
      if (elementId(nodes[i]!, i) === id) return nodes[i]!;
    }
    return null;
  }
}

function defaultScreen(win: WindowLike | undefined): string {
  const path = (win?.location?.pathname ?? "/").replace(/\/+$/, "");
  const hash = win?.location?.hash ?? "";
  return path + hash || "/";
}
