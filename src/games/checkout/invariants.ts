import type { Invariant } from "../../core/oracles/invariants.ts";
import type { SocState } from "../../core/soc/serialize.ts";
import type { BoundsSpec } from "../../core/oracles/tier0.ts";
import type { TruthFn } from "../../core/soc/backends/mock.ts";
import { targetOf } from "../refgame/truth.ts";

/** Arithmetic, so Tier 0 - never the model. */
export const CHECKOUT_BOUNDS: BoundsSpec[] = [
  { variable: "itemCount", min: 0, label: "Cart item count went negative" },
  { variable: "amountCharged", min: 0, label: "Negative amount charged" },
  { variable: "ordersPlaced", min: 0, max: 1, label: "Order submitted more than once" },
];

/**
 * Invariants for the checkout flow, written the way a product spec states them.
 *
 * Note that none of these mention a screen id, a control id, or a variable name.
 * That is the test of whether the invariant layer really generalises: this list was
 * written for a different domain than the RPG's and the engine needed no changes to
 * evaluate it.
 */
export const CHECKOUT_INVARIANTS: Invariant[] = [
  {
    id: "total_reflects_quantities",
    prompt:
      "Does the total shown to the customer account for how many of each item is in the basket?",
    criteria: {
      true: "the displayed total equals the sum of item prices times their quantities",
      false: "the displayed total ignores quantity, or disagrees with the items listed",
    },
    title: "Displayed total ignores item quantities",
    bugClass: "flow",
    severity: "critical",
    // One wrong total is one bug, however many screens display it.
    dedupeBy: "global",
    applies: (s) => Number(s.vars["itemCount"] ?? 0) > 0,
  },
  {
    id: "charge_matches_total",
    prompt:
      "Does the amount actually charged match the price the customer was quoted when they confirmed the order?",
    criteria: {
      true: "the charged amount equals the quoted price for the order",
      false: "the customer was charged more or less than the price they confirmed",
    },
    title: "Amount charged does not match the total shown",
    bugClass: "flow",
    severity: "critical",
    dedupeBy: "global",
    applies: (s) => Number(s.vars["ordersPlaced"] ?? 0) > 0,
  },
  {
    id: "entered_data_survives_back",
    prompt:
      "The customer just navigated backwards. Did the information they had already entered survive?",
    criteria: {
      true: "previously entered fields still hold their values",
      false: "one or more fields the customer filled in were cleared",
    },
    title: "Going back discards entered data",
    bugClass: "flow",
    severity: "high",
    dedupeBy: "global",
    applies: (s) => s.lastAction.includes("back"),
  },
  {
    id: "invalid_input_blocks_progress",
    prompt:
      "The customer has entered an invalid email address. Is the control that advances to the next step correctly unavailable?",
    criteria: {
      true: "the advance control is disabled or absent while the input is invalid",
      false: "the customer can advance despite the invalid input",
    },
    title: "Validation can be bypassed",
    bugClass: "flow",
    severity: "high",
    dedupeBy: "global",
    // Gated on the field being present on THIS screen. Without that it fired on
    // the basket screen, whose Continue control has nothing to do with the email,
    // and reported a validation bug in a build that had none.
    applies: (s) =>
      Number(s.vars["emailLen"] ?? 0) > 0 &&
      s.vars["emailValid"] === false &&
      !s.loading &&
      s.controls.some((c) => c.id === "email"),
  },
  {
    id: "screen_has_an_exit",
    prompt:
      "Does this step give the customer a way to go back or leave, rather than trapping them?",
    criteria: {
      true: "a back, cancel or close control is available",
      false: "every control keeps the customer on this step",
    },
    title: "Step has no way back",
    bugClass: "softlock",
    severity: "critical",
    applies: (s) => !s.loading && s.screen !== "cart" && s.screen !== "done",
  },
];

/** Ground truth for the offline mock only. */
export function checkoutInvariantTruth(s: SocState, id: string): boolean | undefined {
  switch (id) {
    case "total_reflects_quantities":
      return Number(s.vars["displayedTotal"] ?? 0) === Number(s.vars["trueTotal"] ?? 0);
    case "charge_matches_total":
      return Number(s.vars["amountCharged"] ?? 0) === Number(s.vars["chargedFor"] ?? 0);
    case "entered_data_survives_back":
      return (
        (s.deltas["emailLen"] ?? 0) >= 0 &&
        (s.deltas["addressLen"] ?? 0) >= 0 &&
        (s.deltas["cardLen"] ?? 0) >= 0
      );
    case "invalid_input_blocks_progress":
      return !s.controls.some((c) => c.enabled && /^to_/.test(c.id));
    case "screen_has_an_exit":
      return s.controls.some((c) => c.enabled && /back|cancel|close|exit/i.test(c.id));
    default:
      return undefined;
  }
}

/** A competent shopper's next move, used to score the mock's `choice` answers. */
export function checkoutBestControl(s: SocState, options: string[]): string | undefined {
  const vars = s.vars ?? {};
  const pick = (id: string) => options.find((o) => targetOf(o) === id || o === id);
  const typed = (field: string, value: string) =>
    options.find((o) => o.startsWith("input " + field + "=") && o.includes(value));

  const screen = s.screen;
  if (screen === "cart") {
    if (Number(vars["itemCount"] ?? 0) > 0) return pick("to_shipping") ?? options[0];
    return pick("add_mug") ?? options[0];
  }
  if (screen === "shipping") {
    if (vars["emailValid"] !== true) return typed("email", "buyer@example.com") ?? options[0];
    if (Number(vars["addressLen"] ?? 0) < 5) return typed("address", "12 High Street") ?? options[0];
    return pick("to_payment") ?? options[0];
  }
  if (screen === "payment") {
    if (Number(vars["cardLen"] ?? 0) < 12) return typed("card", "4242424242424242") ?? options[0];
    return pick("to_review") ?? options[0];
  }
  if (screen === "review") return pick("place_order") ?? options[0];
  if (screen === "done") return pick("restart") ?? options[0];
  return options[0];
}

export function makeCheckoutTruth(): TruthFn {
  return (state, q) => {
    const s = state as SocState;
    switch (q.kind) {
      case "noul":
        return checkoutInvariantTruth(s, q.id);
      case "choice":
        return checkoutBestControl(s, q.options);
      case "score":
        // No difficulty curve in a checkout flow. Returning undefined is the honest
        // answer and exercises the "model is unsure" path, which should escalate.
        return undefined;
    }
  };
}
