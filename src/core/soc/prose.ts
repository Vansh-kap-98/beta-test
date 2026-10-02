import type { SocState } from "./serialize.ts";

/**
 * Renders the state blob as plain prose for a System One model.
 *
 * This file exists because of a measurement, not a preference. Handing Laya the
 * JSON blob and handing it the same facts as sentences are not equivalent:
 *
 *   rendering      P(yes) on four questions whose truth was all "yes"
 *   -----------    ------------------------------------------------------
 *   raw dict       0.485  0.500  0.611  0.548      <- every answer a coin flip
 *   json string    0.485  0.500  0.611  0.548      <- identical; it stringifies
 *   prose          0.656  0.890  0.282  0.744      <- decisive, and 40% faster
 *
 * `effect: 0.500` is the giveaway: exactly undecided on a question whose answer was
 * sitting in the blob as `producedChange: true`. A non-autoregressive model reads
 * language, and `{"vars":{"producedChange":true}}` is not language.
 *
 * The consequence is architectural rather than cosmetic. The escalation gate is
 * 0.75, so a model answering everything near 0.5 escalates EVERY decision: tier-1
 * absorption goes to zero and the cost argument the whole design rests on
 * disappears. Prose rendering is load-bearing.
 *
 * Two details earn their place:
 *
 * 1. **Deltas are spelled out as before/after/change.** Measured on one fact with
 *    three phrasings: naming only the current value gave 0.466 (undecided), stating
 *    "Change: 0" gave 0.080 (correctly no), and stating "Change: +60" gave 0.909
 *    (correctly yes). Same truth, three answers. The arithmetic must be done here.
 *
 * 2. **Controls are a list, one per line, captions first.** Prose that mentioned
 *    the controls inside a sentence scored 0.282 on "does this screen have a way
 *    out" while a Pause control was present -- the fact was in the text and still
 *    unreadable.
 *
 * 3. **Absence is stated emphatically, never as a zero.** Every one of this
 *    renderer's confident errors was a state whose truth was "no" answered "yes":
 *    `legal moves is 0` was read as moves being available (p=0.822), and
 *    "Nothing measurable changed" was read as something having changed (p=0.771).
 *    Small non-autoregressive models match topic rather than polarity, so a fact
 *    expressed as a number near a word is not the same input as a sentence saying
 *    the thing is absent. "There are no legal moves available. The board cannot be
 *    played." is read; "legal moves is 0" is not.
 */

/** Keep the blob small: token budget spent here is budget not spent on options. */
const MAX_CONTROLS = 14;
const MAX_RECENT = 5;

/**
 * Variables whose zero means "none of these exist" rather than "the quantity is
 * zero". A score of 0 is a real score; 0 legal moves is an absence, and the
 * difference decides whether a softlock is reported or missed.
 */
const ZERO_MEANS_NONE = ["moves", "cells", "count", "options", "controls", "legal"];

function signed(n: number): string {
  return n > 0 ? "+" + n : String(n);
}

/** `hud_score` -> `score`, `producedChange` -> `produced change`. */
function humanVar(k: string): string {
  return k
    .replace(/^hud_/, "")
    .replace(/^d_/, "change in ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .toLowerCase();
}

function renderValue(v: number | string | boolean): string {
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

export interface ProseOptions {
  /** Natural-language captions for action ids, so options read as words. */
  labels?: Record<string, string>;
}

export function renderProse(s: SocState, opts: ProseOptions = {}): string {
  const L: string[] = [];
  const labels = opts.labels ?? {};

  L.push("Screen: " + s.screen + ".");
  if (s.loading) L.push("The screen is still loading.");

  // On-screen prose comes early and verbatim. It is the only evidence the
  // comprehension invariant has, and paraphrasing it would be measuring our summary
  // rather than the game's own writing.
  if (s.text && s.text.length > 0) {
    L.push("The screen reads: " + s.text.map((t) => JSON.stringify(t)).join(" "));
  } else if (s.text) {
    L.push("There is no readable text on this screen.");
  }

  // --- what the player just did, and what it did ---------------------------
  //
  // The opening screen has no preceding action, and describing one is worse than
  // saying nothing: the renderer used to assert "the action had no effect at all" on
  // the very first observation, about an action that never happened, which is both
  // false and an invitation to report a broken control on a screen nobody had
  // touched yet.
  const acted = s.lastAction !== "none" && s.lastAction !== "noop";
  if (acted) {
    L.push("The player just did: " + s.lastAction + ".");
  } else {
    L.push("The player has not acted yet; this is the screen as they first find it.");
  }

  // Deltas first and in words: this is the single highest-value part of the blob.
  const deltaEntries = Object.entries(s.deltas);
  if (!acted) {
    // No action, so no change language at all.
  } else if (deltaEntries.length > 0) {
    for (const [k, d] of deltaEntries) {
      const after = s.vars[k];
      if (typeof after === "number") {
        L.push(
          humanVar(k) + " before: " + (after - d) + ". " +
          humanVar(k) + " after: " + after + ". Change: " + signed(d) + ".",
        );
      } else {
        L.push("Change in " + humanVar(k) + ": " + signed(d) + ".");
      }
    }
  } else if (s.changed.length === 0 && s.vars["producedChange"] !== true) {
    // Repeated three ways on purpose. One mention of absence was measurably not
    // enough: the single sentence "Nothing measurable changed after that action."
    // was still answered "something changed" with p=0.771.
    //
    // The `producedChange` guard matters as much as the repetition. Without it this
    // branch fired whenever no NUMBER changed, so dismissing a tutorial -- which
    // changes the whole screen and no variable at all -- was described to the model
    // as "the action had no effect at all", two lines above "produced change is
    // yes". The blob contradicted itself and invited a false broken-control report
    // on the very first step of a clean build.
    L.push("The screen did not change. The action had no effect at all. " +
      "The display is identical to what it was before.");
  } else if (s.vars["producedChange"] === true && deltaEntries.length === 0) {
    L.push("The screen changed after that action.");
  }
  if (s.changed.length > 0) {
    L.push("These also changed: " + s.changed.map(humanVar).join(", ") + ".");
  }

  // --- current values ------------------------------------------------------
  //
  // Absences are pulled out of the value list and restated as negative sentences,
  // because "legal moves is 0" buried in a semicolon list does not read as absence.
  const negatives: string[] = [];
  const varLines: string[] = [];
  for (const [k, v] of Object.entries(s.vars)) {
    if (k.startsWith("d_")) continue;
    const name = humanVar(k);
    if (v === 0 && ZERO_MEANS_NONE.some((z) => k.toLowerCase().includes(z))) {
      negatives.push("There are no " + name + ". ");
    } else if (v === false) {
      // Skipped before the first action: "it is not true that produced change" is
      // meaningless when nothing has been done.
      if (k === "producedChange" && !acted) continue;
      negatives.push("It is not true that " + name + ". ");
    } else {
      varLines.push(name + " is " + renderValue(v));
    }
  }
  if (varLines.length > 0) L.push("Current values: " + varLines.join("; ") + ".");
  if (negatives.length > 0) L.push(negatives.join("").trim());

  // --- controls, one per line ----------------------------------------------
  if (s.controls.length === 0) {
    L.push("There are no controls on this screen.");
  } else {
    /**
     * Identical captions are collapsed with a count.
     *
     * A puzzle board offers eight interchangeable "swap two candies" controls plus a
     * Shuffle and a Pause. Listed one per line, the two distinctive controls sat at
     * the bottom of ten lines of the same sentence -- and the model answered that the
     * screen had no way out while a Pause control was right there, on a clean build.
     * Eight repetitions of one caption carry no more information than one caption and
     * a number, and they cost the token budget that the distinctive controls need.
     */
    const groups: Array<{ caption: string; n: number }> = [];
    for (const c of s.controls) {
      const caption = (c.text || labels[c.id] || c.id) + (c.enabled ? "" : " (disabled)");
      const last = groups.find((g) => g.caption === caption);
      if (last) last.n += 1;
      else groups.push({ caption, n: 1 });
    }
    L.push("The player can use these " + s.controls.length +
      (s.controls.length === 1 ? " control:" : " controls:"));
    for (const g of groups.slice(0, MAX_CONTROLS)) {
      L.push("- " + g.caption + (g.n > 1 ? " (" + g.n + " of these)" : ""));
    }
    if (groups.length > MAX_CONTROLS) {
      L.push("- and " + (groups.length - MAX_CONTROLS) + " more kinds");
    }
  }

  if (s.recentScreens.length > 0) {
    L.push("Recently visited screens, oldest first: " +
      s.recentScreens.slice(-MAX_RECENT).join(" then ") + ".");
  }
  if (s.errorCount > 0) {
    L.push("The game reported " + s.errorCount + " error(s) on this step.");
  }

  return L.join("\n");
}
