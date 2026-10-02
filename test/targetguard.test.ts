import { strict as assert } from "node:assert";
import { test } from "node:test";
import { runSession } from "../src/core/agent/session.ts";
import type { Policy } from "../src/core/agent/session.ts";
import type { Action, GameAdapter, GameState } from "../src/core/types.ts";
import { renderReport } from "../src/core/trace/report.ts";

/**
 * The guardrail that stops the bot clicking into windows it is not testing.
 *
 * Synthetic input goes to whichever window has FOCUS, not to the window that was
 * captured. So when the target is minimised, closed, or pushed behind something else,
 * every click and keystroke lands in whatever the user has in front -- their editor,
 * their browser, their files. These tests pin the two properties that matter:
 *
 *   1. once the target is lost, NO further action is taken, and
 *   2. the run says it stopped early, rather than presenting a short run as a result.
 *
 * The second is not cosmetic. "No defects found" on a run that stopped after a
 * handful of steps reads as a clean bill of health for a game that was never played.
 */

class CountingAdapter implements GameAdapter {
  readonly name = "counting";
  readonly canSnapshot = false;
  acts = 0;
  /** Flips to a reason after this many actions, imitating a lost window. */
  loseAfter = Infinity;
  lost: string | null = null;

  reset(): void {
    this.acts = 0;
    // `lost` is deliberately NOT cleared, matching the real sidecar adapter. A lost
    // target must stay lost across a reset: the window is still minimised, and
    // "un-losing" it on reset would quietly re-enable input into whatever has focus.
  }

  observe(): GameState {
    return {
      step: this.acts,
      screen: "s",
      elements: [{ id: "a", kind: "button", text: "A", visible: true, enabled: true,
                   bbox: { x: 0, y: 0, w: 1, h: 1 } }],
      vars: {},
      loading: false,
      errors: [],
      perf: { fps: 60, heapMB: 0 },
    };
  }

  act(_a: Action): void {
    // A real adapter refuses here too; this asserts the SESSION never gets this far.
    assert.equal(this.lost, null,
      "an action was taken after the target was lost -- this is the input-safety bug");
    this.acts += 1;
    if (this.acts >= this.loseAfter) this.lost = "minimized";
  }

  availableActions(): Action[] {
    return [{ type: "tap", targetId: "a" }];
  }

  snapshot(): unknown {
    return null;
  }

  restore(): void {}
}

const alwaysTap: Policy = {
  name: "always-tap",
  next: () => ({ type: "tap", targetId: "a" }),
};

test("the session stops acting as soon as the target is lost", async () => {
  const adapter = new CountingAdapter();
  adapter.loseAfter = 5;

  const result = await runSession(adapter, alwaysTap, {
    seed: 1,
    steps: 200,
    recover: false,
    shouldStop: () => adapter.lost,
  });

  assert.equal(adapter.acts, 5, "it kept acting after the window was gone");
  assert.equal(result.stoppedEarly, "minimized");
  assert.ok(result.steps < 200, "the run should not report a full step budget");
});

test("a run that was not interrupted reports no early stop", async () => {
  const adapter = new CountingAdapter();
  const result = await runSession(adapter, alwaysTap, {
    seed: 1, steps: 12, recover: false, shouldStop: () => adapter.lost,
  });
  assert.equal(result.stoppedEarly, undefined);
  assert.equal(adapter.acts, 12);
});

test("shouldStop is honoured before the very first action", async () => {
  // A window already minimised at the start must produce zero input, not one click.
  const adapter = new CountingAdapter();
  adapter.lost = "minimized";
  const result = await runSession(adapter, alwaysTap, {
    seed: 1, steps: 50, recover: false, shouldStop: () => adapter.lost,
  });
  assert.equal(adapter.acts, 0, "input was sent to a window that was already lost");
  assert.equal(result.stoppedEarly, "minimized");
});

test("the report says the run stopped early instead of reporting it clean", async () => {
  const adapter = new CountingAdapter();
  adapter.loseAfter = 3;
  const result = await runSession(adapter, alwaysTap, {
    seed: 1, steps: 100, recover: false, shouldStop: () => adapter.lost,
  });

  const md = renderReport({
    game: "fake",
    session: result,
    tier1: undefined as never,
    calibration: { n: 0, accuracy: 0, brier: 0, ece: 0, bins: [] } as never,
    replayDir: "",
    wallClockMs: 1000,
  }, new Map());

  assert.match(md, /stopped early/i,
    "a truncated run must say so in the report, not read as a finished one");
  assert.ok(!/^## No defects found$/m.test(md),
    "a truncated run must not claim a plain clean result");
});
