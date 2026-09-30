import type { Action, Finding, GameState, UiElement } from "../types.ts";
import type { Oracle, OracleContext } from "./oracle.ts";
import { mkFinding, stateHash } from "./oracle.ts";

/**
 * Tier 0: deterministic oracles.
 *
 * No model, no network, no cost. These run on every step and catch the cheapest and
 * most objective defect classes. Anything that can be decided by plain code belongs
 * here rather than in Tier 1 - every check moved down a tier is one the System One
 * model does not have to spend option budget on, and one that cannot be wrong.
 */

const SOFTLOCK_WINDOW = 12;
const STUCK_LOADING_STEPS = 30;
const LOW_FPS = 25;
const LEAK_MIN_GROWTH_MB = 5;
/**
 * Sustained growth rate, not a ratio.
 *
 * A ratio test looks sensible and is wrong: late in a leaking run the heap goes
 * 1080 -> 1151 MB across a window, a ratio of 1.07, so a "grew 50%" rule silently
 * stops firing exactly when the leak is worst. Rate per step is scale-free and
 * separates cleanly - the reference game's healthy churn is ~0.005 MB/step and its
 * leak is ~0.6 MB/step, two orders of magnitude apart.
 */
const LEAK_MB_PER_STEP = 0.25;

function replayOf(ctx: OracleContext) {
  return { seed: ctx.seed, actions: [...ctx.actionLog] };
}

function actionSig(a: Action): string {
  switch (a.type) {
    case "tap":
      return "tap:" + a.targetId;
    case "input":
      return "input:" + a.targetId;
    default:
      return a.type;
  }
}

function interactable(s: GameState): UiElement[] {
  return s.elements.filter((e) => e.visible && e.enabled && e.kind === "button");
}

/** Uncaught exceptions and console errors drained from the adapter. */
export const crashOracle: Oracle = {
  name: "crash",
  check(ctx) {
    const out: Finding[] = [];
    for (const err of ctx.cur.errors) {
      // One defect can surface twice: the game logs it *and* throws, and the adapter
      // tags the throw. Normalise transport prefixes and digits so both observations
      // collapse onto a single key rather than reporting one crash as two bugs.
      const key =
        "crash:" +
        err
          .replace(/^(UNCAUGHT|ERROR|Uncaught|Error):\s*/i, "")
          .replace(/\d+/g, "N")
          .slice(0, 120);
      out.push(
        mkFinding({
          severity: "critical",
          bugClass: "crash",
          // The transport prefix is noise in a title; it stays in `detail`.
          title:
            "Uncaught error: " +
            err.replace(/^(UNCAUGHT|ERROR|Uncaught|Error):\s*/i, "").slice(0, 80),
          detail:
            "The game raised an error during normal interaction on screen '" +
            ctx.cur.screen +
            "'. Full message: " +
            err,
          step: ctx.cur.step,
          source: "tier0",
          dedupeKey: key,
          replay: replayOf(ctx),
          evidence: { screen: ctx.cur.screen, vars: ctx.cur.vars, error: err },
        }),
      );
    }
    return out;
  },
};

/**
 * A softlock is not "the state stopped changing" - a bot idling on a healthy menu
 * also looks like that. It is: *every control currently available has been tried,
 * and none of them changed anything the player can see.*
 *
 * Requiring full coverage of the available controls is what keeps this from firing
 * on a legitimate settings screen where the bot happened to press the same
 * do-nothing toggle twelve times in a row without ever trying Back.
 */
export const softlockOracle: Oracle = {
  name: "softlock",
  check(ctx) {
    const w = ctx.window;
    if (w.length < SOFTLOCK_WINDOW) return [];
    const recent = w.slice(-SOFTLOCK_WINDOW);
    const h = stateHash(recent[0]!);
    if (!recent.every((s) => stateHash(s) === h)) return [];
    if (ctx.cur.loading) return []; // stuck-loading oracle owns that case

    const tried = new Set(ctx.windowActions.slice(-SOFTLOCK_WINDOW).map(actionSig));
    const available = interactable(ctx.cur).map((e) => "tap:" + e.id);
    if (available.length === 0) return [];
    const untried = available.filter((a) => !tried.has(a));
    if (untried.length > 0) return [];

    return [
      mkFinding({
        severity: "critical",
        bugClass: "softlock",
        title: "Softlock on screen '" + ctx.cur.screen + "'",
        detail:
          "Every available control (" +
          available.join(", ") +
          ") was exercised over " +
          SOFTLOCK_WINDOW +
          " steps and the observable state never changed. The player cannot leave this screen.",
        step: ctx.cur.step,
        source: "tier0",
        // Keyed on the screen and its controls, deliberately NOT on the state hash.
        // The hash carries every game variable, so the same trap re-entered with
        // one more gold looked like a brand new defect - one softlock was being
        // reported twenty times after recovery started revisiting it.
        dedupeKey: "softlock:" + ctx.cur.screen + ":" + available.slice().sort().join(","),
        replay: replayOf(ctx),
        evidence: { screen: ctx.cur.screen, controls: available, stateHash: h },
      }),
    ];
  },
};

export const stuckLoadingOracle: Oracle = {
  name: "stuck-loading",
  check(ctx) {
    const w = ctx.window;
    if (w.length < STUCK_LOADING_STEPS) return [];
    const recent = w.slice(-STUCK_LOADING_STEPS);
    if (!recent.every((s) => s.loading)) return [];
    return [
      mkFinding({
        severity: "critical",
        bugClass: "softlock",
        title: "Stuck loading on '" + ctx.cur.screen + "'",
        detail:
          "The game reported a loading state for " +
          STUCK_LOADING_STEPS +
          " consecutive steps without completing. Input is swallowed while loading, so this is unrecoverable.",
        step: ctx.cur.step,
        source: "tier0",
        dedupeKey: "stuckload:" + ctx.cur.screen,
        replay: replayOf(ctx),
        evidence: { screen: ctx.cur.screen, vars: ctx.cur.vars },
      }),
    ];
  },
};

/**
 * Caption wider than its box. Only fires when the adapter actually measured text -
 * a missing `textWidth` is treated as "unknown", never as "fits".
 */
export const textOverflowOracle: Oracle = {
  name: "text-overflow",
  check(ctx) {
    const out: Finding[] = [];
    for (const e of ctx.cur.elements) {
      if (!e.visible || e.textWidth === undefined) continue;
      if (e.textWidth <= e.bbox.w) continue;
      const over = Math.round(e.textWidth - e.bbox.w);
      out.push(
        mkFinding({
          severity: "low",
          bugClass: "ui",
          title: "Text overflows its box: " + e.id,
          detail:
            "Caption " +
            JSON.stringify(e.text ?? "") +
            " renders at " +
            e.textWidth +
            "px inside a " +
            e.bbox.w +
            "px box (" +
            over +
            "px over) on screen '" +
            ctx.cur.screen +
            "'.",
          step: ctx.cur.step,
          source: "tier0",
          dedupeKey: "overflow:" + e.id,
          replay: replayOf(ctx),
          evidence: { element: e.id, text: e.text, textWidth: e.textWidth, boxWidth: e.bbox.w },
        }),
      );
    }
    return out;
  },
};

/** Two interactable controls occupying the same pixels - one of them is unclickable. */
export const overlapOracle: Oracle = {
  name: "overlap",
  check(ctx) {
    const out: Finding[] = [];
    const els = interactable(ctx.cur);

    // Layout-availability guard.
    //
    // When every element reports the same box, the host is not doing layout -
    // jsdom without a renderer, or a headless page measured before paint. Every
    // pair then "overlaps" perfectly and the report fills with false positives.
    // Identical geometry across all elements means no geometry, not a defect.
    if (els.length > 1) {
      const first = els[0]!.bbox;
      const allIdentical = els.every(
        (e) =>
          e.bbox.x === first.x &&
          e.bbox.y === first.y &&
          e.bbox.w === first.w &&
          e.bbox.h === first.h,
      );
      const allZero = els.every((e) => e.bbox.w === 0 || e.bbox.h === 0);
      if (allIdentical || allZero) return [];
    }

    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        const a = els[i]!;
        const b = els[j]!;
        const overlapX = Math.min(a.bbox.x + a.bbox.w, b.bbox.x + b.bbox.w) - Math.max(a.bbox.x, b.bbox.x);
        const overlapY = Math.min(a.bbox.y + a.bbox.h, b.bbox.y + b.bbox.h) - Math.max(a.bbox.y, b.bbox.y);
        if (overlapX <= 0 || overlapY <= 0) continue;
        const area = overlapX * overlapY;
        const smaller = Math.min(a.bbox.w * a.bbox.h, b.bbox.w * b.bbox.h);
        if (area / smaller < 0.2) continue; // ignore hairline touching
        const pair = [a.id, b.id].sort();
        out.push(
          mkFinding({
            severity: "medium",
            bugClass: "ui",
            title: "Overlapping controls: " + pair[0] + " / " + pair[1],
            detail:
              "Two interactable controls overlap by " +
              Math.round((area / smaller) * 100) +
              "% of the smaller one on screen '" +
              ctx.cur.screen +
              "'. At least one is partly or wholly unclickable.",
            step: ctx.cur.step,
            source: "tier0",
            dedupeKey: "overlap:" + pair.join("|"),
            replay: replayOf(ctx),
            evidence: { a: a.id, b: b.id, aBox: a.bbox, bBox: b.bbox },
          }),
        );
      }
    }
    return out;
  },
};

export const perfOracle: Oracle = {
  name: "perf",
  check(ctx) {
    const out: Finding[] = [];
    if (ctx.cur.perf.fps < LOW_FPS) {
      out.push(
        mkFinding({
          severity: "medium",
          bugClass: "perf",
          title: "Frame rate collapsed to " + ctx.cur.perf.fps + " fps",
          detail:
            "Frame rate fell below " +
            LOW_FPS +
            " fps on screen '" +
            ctx.cur.screen +
            "' with heap at " +
            ctx.cur.perf.heapMB +
            " MB.",
          step: ctx.cur.step,
          source: "tier0",
          dedupeKey: "lowfps",
          replay: replayOf(ctx),
          evidence: { fps: ctx.cur.perf.fps, heapMB: ctx.cur.perf.heapMB },
        }),
      );
    }
    const w = ctx.window;
    if (w.length >= 20) {
      const first = w[0]!.perf.heapMB;
      const last = w[w.length - 1]!.perf.heapMB;
      const growth = last - first;
      const rate = growth / w.length;
      if (growth > LEAK_MIN_GROWTH_MB && rate > LEAK_MB_PER_STEP) {
        out.push(
          mkFinding({
            severity: "high",
            bugClass: "perf",
            title: "Heap growing " + rate.toFixed(2) + " MB/step",
            detail:
              "Heap went from " +
              first +
              " MB to " +
              last +
              " MB across " +
              w.length +
              " steps (" +
              rate.toFixed(2) +
              " MB/step sustained) with no sign of collection. Consistent with a leak rather than normal churn.",
            step: ctx.cur.step,
            source: "tier0",
            dedupeKey: "heapleak",
            replay: replayOf(ctx),
            evidence: { fromMB: first, toMB: last, steps: w.length, mbPerStep: Number(rate.toFixed(3)) },
          }),
        );
      }
    }
    return out;
  },
};

/** Numeric variables that left the set of legal values. */
export const invalidStateOracle: Oracle = {
  name: "invalid-state",
  check(ctx) {
    const out: Finding[] = [];
    for (const [k, v] of Object.entries(ctx.cur.vars)) {
      if (typeof v !== "number") continue;
      const bad = Number.isNaN(v) ? "NaN" : !Number.isFinite(v) ? "not finite" : null;
      if (!bad) continue;
      out.push(
        mkFinding({
          severity: "high",
          bugClass: "flow",
          title: "Variable '" + k + "' became " + bad,
          detail: "Game variable '" + k + "' held " + String(v) + " on screen '" + ctx.cur.screen + "'.",
          step: ctx.cur.step,
          source: "tier0",
          dedupeKey: "invalidvar:" + k + ":" + bad,
          replay: replayOf(ctx),
          evidence: { variable: k, value: String(v) },
        }),
      );
    }
    return out;
  },
};

export interface BoundsSpec {
  /** Variable to constrain. */
  variable: string;
  min?: number;
  max?: number;
  /** Upper bound taken from another variable, e.g. hp bounded by maxHp. */
  maxVar?: string;
  label: string;
}

/**
 * Declarative range checks on game variables.
 *
 * These exist because the first end-to-end run put "is currency non-negative?" and
 * "is health within bounds?" into the *model's* invariant suite, where they were
 * asked every single step and generated a false bug report on every wrong answer -
 * hundreds of them across a clean run.
 *
 * They are arithmetic. Plain code decides them exactly, for free, and cannot be
 * wrong. The rule this enforces: if a predicate is decidable from the state by
 * code, it is a Tier-0 check, no matter how much it reads like a design rule.
 */
export function makeBoundsOracle(specs: BoundsSpec[]): Oracle {
  return {
    name: "bounds",
    check(ctx) {
      const out: Finding[] = [];
      for (const spec of specs) {
        const v = ctx.cur.vars[spec.variable];
        if (typeof v !== "number" || Number.isNaN(v)) continue;
        const max =
          spec.maxVar !== undefined && typeof ctx.cur.vars[spec.maxVar] === "number"
            ? (ctx.cur.vars[spec.maxVar] as number)
            : spec.max;
        const belowMin = spec.min !== undefined && v < spec.min;
        const aboveMax = max !== undefined && v > max;
        if (!belowMin && !aboveMax) continue;
        const bound = belowMin ? "minimum " + spec.min : "maximum " + max;
        out.push(
          mkFinding({
            severity: "high",
            bugClass: "flow",
            title: spec.label,
            detail:
              "Variable '" +
              spec.variable +
              "' held " +
              v +
              " on screen '" +
              ctx.cur.screen +
              "', violating its " +
              bound +
              ".",
            step: ctx.cur.step,
            source: "tier0",
            dedupeKey: "bounds:" + spec.variable + ":" + (belowMin ? "min" : "max"),
            replay: replayOf(ctx),
            evidence: { variable: spec.variable, value: v, min: spec.min, max },
          }),
        );
      }
      return out;
    },
  };
}

export const TIER0_ORACLES: Oracle[] = [
  crashOracle,
  softlockOracle,
  stuckLoadingOracle,
  textOverflowOracle,
  overlapOracle,
  perfOracle,
  invalidStateOracle,
];
