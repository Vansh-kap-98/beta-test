/**
 * A four-step purchase wizard, used as a SECOND system-under-test.
 *
 * Deliberately unlike the reference RPG in every way that might have quietly leaked
 * into the core: it has text inputs rather than only taps, validation states, a
 * linear flow rather than a loop, no combat, and no difficulty curve at all. If the
 * agent, oracles, serializer or reporting turn out to assume anything RPG-shaped,
 * this is where it shows.
 */

export type Step = "cart" | "shipping" | "payment" | "review" | "done";

export interface CheckoutBugs {
  /** Line total ignores quantity. -> flow */
  totalIgnoresQuantity: boolean;
  /** Going back clears already-entered fields. -> flow */
  backLosesData: boolean;
  /** Continue is enabled despite an invalid email. -> flow */
  validationBypass: boolean;
  /** Placing the order twice charges twice. -> flow */
  doubleCharge: boolean;
  /** The payment step hangs forever. -> softlock */
  stuckSpinner: boolean;
}

export const NO_CHECKOUT_BUGS: CheckoutBugs = {
  totalIgnoresQuantity: false,
  backLosesData: false,
  validationBypass: false,
  doubleCharge: false,
  stuckSpinner: false,
};

export const ALL_CHECKOUT_BUGS: CheckoutBugs = {
  totalIgnoresQuantity: true,
  backLosesData: true,
  validationBypass: true,
  doubleCharge: true,
  stuckSpinner: true,
};

export function onlyCheckout(...names: Array<keyof CheckoutBugs>): CheckoutBugs {
  const f = { ...NO_CHECKOUT_BUGS };
  for (const n of names) f[n] = true;
  return f;
}

export interface Item {
  id: string;
  name: string;
  price: number;
}

export const CATALOGUE: Item[] = [
  { id: "mug", name: "Enamel Mug", price: 12 },
  { id: "tee", name: "Cotton Tee", price: 25 },
  { id: "cap", name: "Wool Cap", price: 18 },
  { id: "bag", name: "Canvas Bag", price: 30 },
];

export interface CheckoutState {
  seed: number;
  step: number;
  screen: Step;
  quantities: Record<string, number>;
  email: string;
  address: string;
  card: string;
  /** Orders actually placed. Should never exceed 1. */
  ordersPlaced: number;
  amountCharged: number;
  /** Total displayed at the moment the order was placed. */
  chargedFor: number;
  spinnerFrames: number;
  errors: string[];
  visited: Step[];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CheckoutElement {
  id: string;
  kind: "button" | "label" | "input";
  text: string;
  visible: boolean;
  enabled: boolean;
  bbox: { x: number; y: number; w: number; h: number };
  textWidth: number;
  tags: string[];
}

const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export class CheckoutGame {
  readonly bugs: CheckoutBugs;
  private rng: () => number = mulberry32(1);
  s: CheckoutState;

  constructor(bugs: Partial<CheckoutBugs> = {}) {
    this.bugs = { ...NO_CHECKOUT_BUGS, ...bugs };
    this.s = this.fresh(1);
  }

  private fresh(seed: number): CheckoutState {
    return {
      seed,
      step: 0,
      screen: "cart",
      quantities: { mug: 1 },
      email: "",
      address: "",
      card: "",
      ordersPlaced: 0,
      amountCharged: 0,
      chargedFor: 0,
      spinnerFrames: 0,
      errors: [],
      visited: ["cart"],
    };
  }

  reset(seed: number): void {
    this.rng = mulberry32(seed);
    this.s = this.fresh(seed);
  }

  snapshot(): CheckoutState {
    return structuredClone(this.s);
  }
  restore(snap: CheckoutState): void {
    this.s = structuredClone(snap);
  }

  itemCount(): number {
    return Object.values(this.s.quantities).reduce((a, b) => a + b, 0);
  }

  /** What the cart *should* cost. The bug makes the displayed total diverge. */
  trueTotal(): number {
    let t = 0;
    for (const [id, q] of Object.entries(this.s.quantities)) {
      const item = CATALOGUE.find((i) => i.id === id);
      if (item) t += item.price * q;
    }
    return t;
  }

  displayedTotal(): number {
    if (!this.bugs.totalIgnoresQuantity) return this.trueTotal();
    let t = 0;
    for (const id of Object.keys(this.s.quantities)) {
      const item = CATALOGUE.find((i) => i.id === id);
      if (item) t += item.price; // quantity dropped
    }
    return t;
  }

  emailValid(): boolean {
    return EMAIL_OK.test(this.s.email);
  }
  addressValid(): boolean {
    return this.s.address.trim().length >= 5;
  }
  cardValid(): boolean {
    return /^\d{12,19}$/.test(this.s.card);
  }

  private canContinue(): boolean {
    switch (this.s.screen) {
      case "cart":
        return this.itemCount() > 0;
      case "shipping":
        return this.bugs.validationBypass ? true : this.emailValid() && this.addressValid();
      case "payment":
        return this.cardValid();
      case "review":
        return true;
      default:
        return false;
    }
  }

  elements(): CheckoutElement[] {
    const out: CheckoutElement[] = [];
    const px = (t: string) => t.length * 7;
    const add = (
      id: string,
      kind: CheckoutElement["kind"],
      text: string,
      y: number,
      enabled = true,
      w = 220,
      tags: string[] = [],
    ) => {
      out.push({
        id,
        kind,
        text,
        visible: true,
        enabled,
        bbox: { x: 40, y, w, h: kind === "label" ? 20 : 32 },
        textWidth: px(text),
        tags,
      });
    };

    if (this.s.spinnerFrames > 0) {
      add("spinner", "label", "Processing payment...", 100);
      return out;
    }

    add("hdr_total", "label", "Total: $" + this.displayedTotal(), 10, false, 220, ["hud"]);
    add("hdr_items", "label", "Items: " + this.itemCount(), 34, false, 220, ["hud"]);

    switch (this.s.screen) {
      case "cart": {
        let y = 70;
        for (const item of CATALOGUE) {
          const q = this.s.quantities[item.id] ?? 0;
          add("add_" + item.id, "button", "Add " + item.name + " ($" + item.price + ")", y, true, 220, ["cart"]);
          add("qty_" + item.id, "label", item.name + " x" + q, y, false, 120, ["cart"]);
          y += 40;
        }
        add("to_shipping", "button", "Continue to shipping", y, this.canContinue(), 220, ["nav"]);
        break;
      }
      case "shipping":
        add("email", "input", this.s.email || "(email)", 70, true, 220, ["form"]);
        add("address", "input", this.s.address || "(address)", 110, true, 220, ["form"]);
        if (this.s.email && !this.emailValid()) {
          add("email_error", "label", "Enter a valid email address", 94, false, 220, ["error"]);
        }
        add("to_payment", "button", "Continue to payment", 160, this.canContinue(), 220, ["nav"]);
        add("back", "button", "Back", 200, true, 120, ["nav"]);
        break;
      case "payment":
        add("card", "input", this.s.card ? "**** " + this.s.card.slice(-4) : "(card number)", 70, true, 220, ["form"]);
        add("to_review", "button", "Review order", 120, this.canContinue(), 220, ["nav"]);
        add("back", "button", "Back", 160, true, 120, ["nav"]);
        break;
      case "review":
        add("summary", "label", "Charge $" + this.displayedTotal() + " to card", 70, false, 260);
        add("place_order", "button", "Place order", 110, true, 220, ["nav", "commit"]);
        add("back", "button", "Back", 150, true, 120, ["nav"]);
        break;
      case "done":
        add("thanks", "label", "Order confirmed", 70, false, 220);
        add("charged", "label", "Charged $" + this.s.amountCharged, 94, false, 220);
        add("restart", "button", "Start a new order", 130, true, 220, ["nav"]);
        // Returning to the review step after ordering is how a real customer
        // double-submits (browser back, then Place order again). Without this the
        // double-charge bug is unreachable and no bot could ever find it - the same
        // mistake as an earlier planted bug that sat behind a screen transition.
        add("back", "button", "Back to review", 170, true, 120, ["nav"]);
        break;
    }
    return out;
  }

  interactableIds(): string[] {
    return this.elements()
      .filter((e) => (e.kind === "button" || e.kind === "input") && e.visible && e.enabled)
      .map((e) => e.id);
  }

  tick(): void {
    this.s.step++;
    if (this.s.spinnerFrames > 0 && this.s.spinnerFrames !== Infinity) this.s.spinnerFrames--;
  }

  /** Text entry. Exercises the `input` action the RPG never used. */
  input(id: string, value: string): void {
    this.s.step++;
    if (this.s.spinnerFrames > 0) return;
    if (id === "email") this.s.email = value;
    else if (id === "address") this.s.address = value;
    else if (id === "card") this.s.card = value;
  }

  tap(id: string): void {
    this.s.step++;
    if (this.s.spinnerFrames > 0) {
      if (this.s.spinnerFrames !== Infinity) this.s.spinnerFrames--;
      return;
    }
    if (!this.interactableIds().includes(id)) return;

    if (id.startsWith("add_")) {
      const key = id.slice(4);
      this.s.quantities[key] = (this.s.quantities[key] ?? 0) + 1;
      return;
    }

    switch (id) {
      case "to_shipping":
        this.go("shipping");
        break;
      case "to_payment":
        if (this.bugs.stuckSpinner) this.s.spinnerFrames = Infinity;
        else this.s.spinnerFrames = 2;
        this.go("payment");
        break;
      case "to_review":
        this.go("review");
        break;
      case "place_order":
        // The bug: no guard against a second submission.
        if (this.s.ordersPlaced === 0 || this.bugs.doubleCharge) {
          this.s.ordersPlaced += 1;
          this.s.amountCharged += this.displayedTotal();
          // Remember what the customer was quoted, so the invariant compares the
          // charge against the price they agreed to - not against a basket they
          // edited afterwards, which is legitimate behaviour and was being
          // reported as a billing defect.
          if (this.s.ordersPlaced === 1) this.s.chargedFor = this.displayedTotal();
        }
        this.go("done");
        break;
      case "back": {
        const order: Step[] = ["cart", "shipping", "payment", "review", "done"];
        const i = order.indexOf(this.s.screen);
        this.go(order[Math.max(0, i - 1)]!);
        if (this.bugs.backLosesData) {
          // The bug: navigating back wipes entered fields.
          this.s.email = "";
          this.s.address = "";
          this.s.card = "";
        }
        break;
      }
      case "restart": {
        const seed = this.s.seed;
        const step = this.s.step;
        this.reset(seed);
        this.s.step = step;
        break;
      }
    }
  }

  private go(to: Step): void {
    this.s.screen = to;
    if (!this.s.visited.includes(to)) this.s.visited.push(to);
  }

  drainErrors(): string[] {
    const e = this.s.errors;
    this.s.errors = [];
    return e;
  }
}
