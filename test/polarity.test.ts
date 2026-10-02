import { strict as assert } from "node:assert";
import { test } from "node:test";
import { InvariantChecker } from "../src/core/oracles/invariants.ts";
import type { Invariant } from "../src/core/oracles/invariants.ts";
import {
  MATCH3_INVARIANTS, match3InvariantTruth, match3RawAnswer,
} from "../src/adapters/sidecar/match3Invariants.ts";
import type { SocState } from "../src/core/soc/serialize.ts";

/**
 * These guard the inversion introduced with defect-positive phrasing.
 *
 * An inverted polarity is the worst class of bug this project can have, because it
 * fails silently and completely: every healthy screen is reported broken and every
 * real defect passes, while the run still produces a confident, plausible report.
 * Nothing else in the suite would catch it -- the 161 existing tests all use
 * healthy-positive invariants and stayed green through the change.
 */

function state(over: Partial<SocState> = {}): SocState {
  return {
    screen: "board", loading: false, vars: {}, deltas: {}, changed: [],
    lastAction: "tap swap:1_1__1_2", controls: [], recentScreens: [], errorCount: 0,
    ...over,
  };
}

test("every match-3 invariant declares defect-positive polarity", () => {
  for (const inv of MATCH3_INVARIANTS) {
    assert.equal(inv.polarity, "defect-positive", inv.id + " must declare its polarity");
  }
});

test("the mock answers in the model's polarity, not the spec's", () => {
  // A healthy board: the spec says the invariant HOLDS, so a defect-positive model
  // must answer "no, not stuck".
  const healthy = state({ vars: { legalMoves: 16, boardCols: 8, producedChange: true } });
  assert.equal(match3InvariantTruth(healthy, "board_is_playable"), true, "spec: holds");
  assert.equal(match3RawAnswer(healthy, "board_is_playable"), false, "model: no defect");

  // A dead board: the spec says violated, so the model must answer "yes, stuck".
  const stuck = state({ vars: { legalMoves: 0, boardCols: 8, producedChange: false } });
  assert.equal(match3InvariantTruth(stuck, "board_is_playable"), false, "spec: violated");
  assert.equal(match3RawAnswer(stuck, "board_is_playable"), true, "model: defect present");
});

test("unknown answers stay unknown through the inversion", () => {
  // `undefined` means "could not judge". Inverting it into `true` would manufacture
  // a defect out of an unreadable screen.
  const blind = state({ vars: {} });
  assert.equal(match3RawAnswer(blind, "board_is_playable"), undefined);
});

test("checker treats a defect-positive yes as a violation", async () => {
  const inv: Invariant = {
    id: "x", polarity: "defect-positive",
    prompt: "Is this control broken?",
    title: "Broken control", bugClass: "flow", severity: "high",
    dedupeBy: "screen", applies: () => true,
  };
  // A client that always says "yes, broken" with full confidence.
  const client = {
    name: "yes-man",
    ask: async (_s: unknown, qs: Array<{ id: string }>) =>
      qs.map((q) => ({ id: q.id, kind: "noul" as const, value: true, p: 0.99 })),
    stats: { calls: 0, questions: 0, inputTokens: 0, outputTokens: 0, errors: 0 },
  };
  const checker = new InvariantChecker(client as never, [inv], {
    confirmations: 1, minOpportunities: 1, expectedErrorRate: 0.01, escalateBelow: 0.5,
  });
  let findings = 0;
  for (let i = 0; i < 12; i++) {
    const r = await checker.check(state({ screen: "s" + (i % 2) }), { step: i, seed: 1, actionLog: [] });
    findings += r.findings.length;
  }
  assert.ok(findings > 0, "a confident defect-positive yes must become a finding");
});

test("checker treats a defect-positive no as healthy", async () => {
  const inv: Invariant = {
    id: "x", polarity: "defect-positive",
    prompt: "Is this control broken?",
    title: "Broken control", bugClass: "flow", severity: "high",
    dedupeBy: "screen", applies: () => true,
  };
  const client = {
    name: "no-man",
    ask: async (_s: unknown, qs: Array<{ id: string }>) =>
      qs.map((q) => ({ id: q.id, kind: "noul" as const, value: false, p: 0.99 })),
    stats: { calls: 0, questions: 0, inputTokens: 0, outputTokens: 0, errors: 0 },
  };
  const checker = new InvariantChecker(client as never, [inv], {
    confirmations: 1, minOpportunities: 1, expectedErrorRate: 0.01, escalateBelow: 0.5,
  });
  let findings = 0;
  for (let i = 0; i < 12; i++) {
    const r = await checker.check(state({ screen: "s" + (i % 2) }), { step: i, seed: 1, actionLog: [] });
    findings += r.findings.length;
  }
  assert.equal(findings, 0, "a clean build must stay silent");
});
