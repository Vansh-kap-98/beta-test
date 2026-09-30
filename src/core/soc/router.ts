import type { UiElement } from "../types.ts";
import type { ChoiceAnswer, SystemOneClient } from "./types.ts";
import { MAX_SAFE_OPTIONS } from "./types.ts";

/**
 * Keeps choice questions inside the model's usable option budget.
 *
 * Laya shares a fixed ~192-256 token budget across *all* candidate options, so a
 * 20-item shop screen starves each option down to a few tokens and choice quality
 * falls apart. Two defences, used together:
 *
 *   1. Shortlist deterministically first. Anything Tier 0 can rule out must never
 *      reach the model - it is free to drop and it buys budget for real candidates.
 *   2. When the list is still too long, ask hierarchically: a semantic group first,
 *      then within it. Costs log_max(n) calls instead of one, which at Jev/Laya
 *      latencies is still inside a single frame budget.
 *
 * Group labels are built from real option names ("apple..honey"), never "group 1" -
 * an opaque label gives the model nothing to reason over and converts a semantic
 * decision into a coin flip.
 */

export interface ChoiceTrace {
  /** How many model round-trips the decision actually cost. */
  calls: number;
  /** The narrowing path taken, for debugging bad choices. */
  path: string[];
  confidence: number;
}

export interface ChoiceResult {
  value: string;
  trace: ChoiceTrace;
}

/**
 * Controls that must never be shortlisted away.
 *
 * Navigation and exit controls are the highest-value options on any screen and the
 * cheapest to get wrong. Truncating a 20-item shop in reading order drops `back`,
 * and then the model is choosing the best of a set that excludes the right answer -
 * measured on the reference game, that pushed escalation from ~20% to ~87% because
 * the decision became unanswerable rather than merely hard.
 *
 * Matching on id and caption is a UI convention rather than game knowledge, and is
 * overridable for games that name things differently.
 */
const NAV_PATTERN = /(back|menu|close|cancel|exit|return|flee|restart|continue|resume|skip)/i;

export function isNavControl(e: UiElement): boolean {
  return NAV_PATTERN.test(e.id) || NAV_PATTERN.test(e.text ?? "");
}

/** Deterministic pre-filter. Cheap, free, and never wrong about visibility. */
export function shortlist(
  elements: UiElement[],
  opts: {
    max?: number;
    deprioritise?: (e: UiElement) => boolean;
    alwaysKeep?: (e: UiElement) => boolean;
  } = {},
): UiElement[] {
  const max = opts.max ?? MAX_SAFE_OPTIONS;
  const usable = elements.filter((e) => e.visible && e.enabled && e.kind === "button");
  if (usable.length <= max) return usable;

  const keep = opts.alwaysKeep ?? isNavControl;
  const deprio = opts.deprioritise ?? (() => false);
  const rank = (a: UiElement, b: UiElement) => {
    const ka = keep(a) ? 0 : 1;
    const kb = keep(b) ? 0 : 1;
    if (ka !== kb) return ka - kb;
    const da = deprio(a) ? 1 : 0;
    const db = deprio(b) ? 1 : 0;
    if (da !== db) return da - db;
    // Stable, reading-order fallback so shortlisting is reproducible.
    if (a.bbox.y !== b.bbox.y) return a.bbox.y - b.bbox.y;
    return a.bbox.x - b.bbox.x;
  };
  return [...usable].sort(rank).slice(0, max);
}

export interface OptionCandidate {
  id: string;
  /** Caption or phrasing shown to the model. */
  label?: string;
  /** Pin this option: never shortlisted away. */
  pinned?: boolean;
  /** Push down the ranking when the budget is tight. */
  deprioritised?: boolean;
}

/**
 * Shortlisting over arbitrary action options rather than UI elements.
 *
 * The element-based `shortlist` above assumes every option is a button. That
 * assumption survived only because the first game under test was tap-only; a
 * checkout flow with text fields needs the same budget discipline over options
 * that are not elements at all.
 */
export function shortlistOptions(
  candidates: OptionCandidate[],
  max = MAX_SAFE_OPTIONS,
): OptionCandidate[] {
  if (candidates.length <= max) return candidates;
  const rank = (a: OptionCandidate, b: OptionCandidate) => {
    const pa = a.pinned ? 0 : 1;
    const pb = b.pinned ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const da = a.deprioritised ? 1 : 0;
    const db = b.deprioritised ? 1 : 0;
    if (da !== db) return da - db;
    return 0;
  };
  return [...candidates].sort(rank).slice(0, max);
}

/** Does this option read like navigation? Used to pin exits. */
export function isNavOption(label: string): boolean {
  return NAV_PATTERN.test(label);
}

function groupKey(option: string, groupOf?: (o: string) => string): string {
  if (groupOf) return groupOf(option);
  const us = option.indexOf("_");
  return us > 0 ? option.slice(0, us) : option;
}

function chunkLabel(items: string[]): string {
  if (items.length === 1) return items[0]!;
  return items[0] + ".." + items[items.length - 1];
}

/**
 * Asks a choice question, narrowing hierarchically when the option list exceeds the
 * safe budget. Returns the chosen option plus how many calls it took.
 */
export async function hierarchicalChoice(
  client: SystemOneClient,
  state: unknown,
  prompt: string,
  options: string[],
  opts: {
    max?: number;
    groupOf?: (o: string) => string;
    idPrefix?: string;
    /** Human-meaningful caption per option. Forwarded to the model as criteria. */
    descriptions?: Record<string, string>;
  } = {},
): Promise<ChoiceResult> {
  const max = opts.max ?? MAX_SAFE_OPTIONS;
  const idPrefix = opts.idPrefix ?? "choice";
  const path: string[] = [];
  let calls = 0;
  let confidence = 1;
  let pool = [...options];

  if (pool.length === 0) throw new Error("hierarchicalChoice called with no options");

  let depth = 0;
  while (pool.length > max) {
    depth += 1;
    // Prefer semantic grouping; fall back to positional pages.
    const groups = new Map<string, string[]>();
    for (const o of pool) {
      const k = groupKey(o, opts.groupOf);
      const arr = groups.get(k);
      if (arr) arr.push(o);
      else groups.set(k, [o]);
    }

    let labels: string[];
    let buckets: Map<string, string[]>;
    if (groups.size > 1 && groups.size <= max) {
      buckets = groups;
      labels = [...groups.keys()];
    } else {
      // Positional paging. The pool is SORTED first so that a "apple..honey" label
      // describes a range that is actually decidable: without sorting, the label
      // names two arbitrary endpoints and tells the model nothing about what is
      // inside, turning the narrowing step into a coin flip.
      const sorted = [...pool].sort();
      buckets = new Map();
      const pages = Math.ceil(sorted.length / max);
      const size = Math.ceil(sorted.length / Math.min(pages, max));
      for (let i = 0; i < sorted.length; i += size) {
        const slice = sorted.slice(i, i + size);
        buckets.set(chunkLabel(slice), slice);
      }
      labels = [...buckets.keys()];
    }

    // Describe each group by what is inside it. A label alone ("buy_a..buy_m")
    // is not enough information for a model to choose a group sensibly.
    const groupDescriptions: Record<string, string> = {};
    for (const [label, members] of buckets) {
      const captions = members.slice(0, 6).map((m) => opts.descriptions?.[m] ?? m);
      groupDescriptions[label] =
        captions.join(", ") + (members.length > captions.length ? ", ..." : "");
    }

    const ans = (await client.ask(state, [
      {
        id: idPrefix + ".narrow" + depth,
        kind: "choice",
        prompt: prompt + " (narrow to a group first)",
        options: labels,
        descriptions: groupDescriptions,
      },
    ])) as ChoiceAnswer[];
    calls += 1;
    const picked = ans[0]!;
    confidence = Math.min(confidence, picked.p);
    path.push(picked.value);
    pool = buckets.get(picked.value) ?? buckets.get(labels[0]!) ?? pool.slice(0, max);
  }

  const finalDescriptions: Record<string, string> = {};
  for (const o of pool) if (opts.descriptions?.[o]) finalDescriptions[o] = opts.descriptions[o]!;
  const ans = (await client.ask(state, [
    {
      id: idPrefix + ".final",
      kind: "choice",
      prompt,
      options: pool,
      ...(Object.keys(finalDescriptions).length ? { descriptions: finalDescriptions } : {}),
    },
  ])) as ChoiceAnswer[];
  calls += 1;
  const picked = ans[0]!;
  confidence = Math.min(confidence, picked.p);
  path.push(picked.value);

  return { value: picked.value, trace: { calls, path, confidence } };
}
