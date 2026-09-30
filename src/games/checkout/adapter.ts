import type { Action, GameAdapter, GameState, UiElement } from "../../core/types.ts";
import type { CheckoutBugs, CheckoutState } from "./game.ts";
import { CheckoutGame } from "./game.ts";

/**
 * Candidate values the bot may type into each field.
 *
 * Both valid and invalid values are offered on purpose: a form is only properly
 * tested if the bot can try to submit bad input, which is how validation bugs are
 * found at all. The adapter proposes the values; the model chooses among them,
 * exactly as it chooses among buttons.
 */
const FIELD_VALUES: Record<string, string[]> = {
  email: ["buyer@example.com", "not-an-email"],
  address: ["12 High Street, Springfield", "x"],
  card: ["4242424242424242", "1234"],
};

export class CheckoutAdapter implements GameAdapter {
  readonly name = "checkout";
  private game: CheckoutGame;
  private pendingErrors: string[] = [];

  constructor(bugs: Partial<CheckoutBugs> = {}) {
    this.game = new CheckoutGame(bugs);
  }

  reset(seed: number): void {
    this.game.reset(seed);
    this.pendingErrors = [];
  }

  observe(): GameState {
    const g = this.game;
    const elements: UiElement[] = g.elements().map((e) => ({
      id: e.id,
      kind: e.kind,
      text: e.text,
      visible: e.visible,
      enabled: e.enabled,
      bbox: e.bbox,
      textWidth: e.textWidth,
      tags: e.tags,
    }));
    const errors = [...this.pendingErrors, ...g.drainErrors()];
    this.pendingErrors = [];

    return {
      step: g.s.step,
      screen: g.s.spinnerFrames > 0 ? g.s.screen + ".processing" : g.s.screen,
      elements,
      vars: {
        // Field lengths rather than contents: the serializer's delta pass then
        // exposes "the address field just emptied" as a negative number, which a
        // typed model can answer about directly. It also keeps entered values out
        // of reports.
        emailLen: g.s.email.length,
        addressLen: g.s.address.length,
        cardLen: g.s.card.length,
        emailValid: g.emailValid(),
        itemCount: g.itemCount(),
        displayedTotal: g.displayedTotal(),
        trueTotal: g.trueTotal(),
        ordersPlaced: g.s.ordersPlaced,
        amountCharged: g.s.amountCharged,
        chargedFor: g.s.chargedFor,
      },
      loading: g.s.spinnerFrames > 0,
      errors,
      perf: { fps: 60, heapMB: 40 },
    };
  }

  act(action: Action): void {
    try {
      switch (action.type) {
        case "tap":
          this.game.tap(action.targetId);
          break;
        case "input":
          this.game.input(action.targetId, action.value);
          break;
        case "back":
          this.game.tap("back");
          break;
        case "wait":
        case "noop":
          this.game.tick();
          break;
      }
    } catch (err) {
      this.pendingErrors.push("UNCAUGHT: " + (err instanceof Error ? err.message : String(err)));
    }
  }

  availableActions(): Action[] {
    if (this.game.s.spinnerFrames > 0) return [{ type: "wait", ms: 16 }];
    const out: Action[] = [];
    for (const e of this.game.elements()) {
      if (!e.visible || !e.enabled) continue;
      if (e.kind === "button") {
        out.push({ type: "tap", targetId: e.id });
      } else if (e.kind === "input") {
        for (const v of FIELD_VALUES[e.id] ?? []) {
          out.push({ type: "input", targetId: e.id, value: v });
        }
      }
    }
    return out;
  }

  snapshot(): unknown {
    return this.game.snapshot();
  }
  restore(snap: unknown): void {
    this.game.restore(snap as CheckoutState);
  }
}
