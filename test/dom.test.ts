import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DomAdapter, readElements, elementId } from "../src/adapters/dom/adapter.ts";
import type { DocumentLike, ElementLike } from "../src/adapters/dom/adapter.ts";
import { runSession } from "../src/core/agent/session.ts";
import { CoverageFuzzPolicy } from "../src/core/agent/randomPolicy.ts";
import { TIER0_ORACLES } from "../src/core/oracles/tier0.ts";

/**
 * The DOM adapter is tested against plain objects rather than a headless browser.
 *
 * That is deliberate: it keeps these tests instant and dependency-free, and the
 * adapter is written against structural interfaces precisely so the host can be
 * faked. What it does NOT prove is behaviour against a real browser's layout and
 * event model - that gap is real and is called out in the README.
 */

interface FakeOpts {
  tag?: string;
  id?: string;
  text?: string;
  attrs?: Record<string, string>;
  rect?: { x: number; y: number; width: number; height: number };
  scrollWidth?: number;
  clientWidth?: number;
  disabled?: boolean;
  hidden?: boolean;
  onClick?: () => void;
}

function el(o: FakeOpts): ElementLike {
  const attrs = o.attrs ?? {};
  const node: ElementLike = {
    tagName: (o.tag ?? "button").toUpperCase(),
    textContent: o.text ?? null,
    getAttribute: (n: string) => attrs[n] ?? null,
    getBoundingClientRect: () => o.rect ?? { x: 0, y: 0, width: 100, height: 30 },
    click: o.onClick,
  };
  if (o.id !== undefined) node.id = o.id;
  if (o.scrollWidth !== undefined) node.scrollWidth = o.scrollWidth;
  if (o.clientWidth !== undefined) node.clientWidth = o.clientWidth;
  if (o.disabled !== undefined) node.disabled = o.disabled;
  if (o.hidden !== undefined) node.hidden = o.hidden;
  return node;
}

function doc(nodes: ElementLike[]): DocumentLike {
  return {
    querySelectorAll: () => nodes,
    querySelector: () => nodes[0] ?? null,
  };
}

const SEL = "button";

describe("dom adapter: element identity", () => {
  test("prefers a test id, then dom id, then name, then label", () => {
    assert.equal(elementId(el({ attrs: { "data-testid": "buy" }, id: "x", text: "Buy" }), 0), "buy");
    assert.equal(elementId(el({ id: "checkout", text: "Buy" }), 0), "checkout");
    assert.equal(elementId(el({ attrs: { name: "qty" } }), 0), "button:qty");
    assert.equal(elementId(el({ text: "Place order" }), 0), "button:Place_order");
  });

  test("falls back to a positional id only as a last resort", () => {
    // Worth knowing this is the weak case: positional ids are unstable across
    // re-renders, which breaks both deduplication and replay.
    assert.equal(elementId(el({}), 3), "button#3");
  });

  test("uses aria-label in preference to text content", () => {
    assert.equal(elementId(el({ attrs: { "aria-label": "Close dialog" }, text: "x" }), 0), "button:Close_dialog");
  });
});

describe("dom adapter: visibility and enablement", () => {
  test("treats hidden, aria-hidden and zero-size as invisible", () => {
    const els = readElements(
      doc([
        el({ id: "a", text: "ok" }),
        el({ id: "b", text: "hidden", hidden: true }),
        el({ id: "c", text: "aria", attrs: { "aria-hidden": "true" } }),
        el({ id: "d", text: "zero", rect: { x: 0, y: 0, width: 0, height: 0 } }),
      ]),
      SEL,
    );
    assert.deepEqual(
      els.filter((e) => e.visible).map((e) => e.id),
      ["a"],
    );
  });

  test("treats disabled and aria-disabled as not enabled", () => {
    const els = readElements(
      doc([
        el({ id: "a", text: "ok" }),
        el({ id: "b", text: "off", disabled: true }),
        el({ id: "c", text: "aria", attrs: { "aria-disabled": "true" } }),
      ]),
      SEL,
    );
    assert.deepEqual(
      els.filter((e) => e.enabled).map((e) => e.id),
      ["a"],
    );
  });

  test("classifies inputs separately from buttons", () => {
    const els = readElements(doc([el({ tag: "input", id: "email" }), el({ tag: "a", id: "link" })]), SEL);
    assert.equal(els[0]!.kind, "input");
    assert.equal(els[1]!.kind, "button");
  });
});

describe("dom adapter: text overflow", () => {
  test("reports a measured overflow", () => {
    const els = readElements(doc([el({ id: "a", text: "long", scrollWidth: 300, clientWidth: 100 })]), SEL);
    assert.equal(els[0]!.textWidth, 300);
    assert.equal(els[0]!.bbox.w, 100);
  });

  test("never guesses a width when the host did not measure one", () => {
    // A guess here manufactures an overflow finding on every long caption, which
    // is exactly the kind of false positive that destroys trust in the tool.
    const els = readElements(doc([el({ id: "a", text: "a very long caption indeed" })]), SEL);
    assert.equal(els[0]!.textWidth, undefined);
  });
});

describe("dom adapter: actions", () => {
  test("clicks the element matching the action target", () => {
    let clicked = 0;
    const d = doc([el({ id: "go", text: "Go", onClick: () => clicked++ })]);
    const a = new DomAdapter({ doc: d });
    a.act({ type: "tap", targetId: "go" });
    assert.equal(clicked, 1);
  });

  test("a missing target is a no-op, not a crash", () => {
    const a = new DomAdapter({ doc: doc([el({ id: "go" })]) });
    assert.doesNotThrow(() => a.act({ type: "tap", targetId: "nonexistent" }));
  });

  test("an exception during an action becomes an observable error", () => {
    const a = new DomAdapter({
      doc: doc([el({ id: "boom", onClick: () => { throw new Error("handler blew up"); } })]),
    });
    a.act({ type: "tap", targetId: "boom" });
    assert.ok(a.observe().errors.some((e) => e.includes("handler blew up")));
  });

  test("offers only visible, enabled buttons as actions", () => {
    const a = new DomAdapter({
      doc: doc([
        el({ id: "ok", text: "ok" }),
        el({ id: "off", text: "off", disabled: true }),
        el({ id: "gone", text: "gone", hidden: true }),
      ]),
    });
    assert.deepEqual(a.availableActions(), [{ type: "tap", targetId: "ok" }]);
  });
});

describe("dom adapter: honest capabilities", () => {
  test("declares it cannot snapshot unless the host provides hooks", () => {
    assert.equal(new DomAdapter({ doc: doc([]) }).canSnapshot, false);
    assert.equal(
      new DomAdapter({ doc: doc([]), snapshot: () => ({}), restore: () => {} }).canSnapshot,
      true,
    );
  });

  test("a session disables recovery rather than faking it", async () => {
    // Without this, a "recovery" on a non-snapshotting adapter rewinds nothing,
    // lands in the same trap, and reports progress that never happened.
    const trap = el({ id: "stuck", text: "Does nothing", onClick: () => {} });
    const a = new DomAdapter({ doc: doc([trap]), screenOf: () => "trap" });
    const r = await runSession(a, new CoverageFuzzPolicy(1), { seed: 1, steps: 60, recover: true });
    assert.equal(r.recoveries, 0, "must not claim a rewind it cannot perform");
  });

  test("derives a screen name from the location by default", () => {
    const a = new DomAdapter({
      doc: doc([]),
      win: { location: { pathname: "/shop/", hash: "#cart" } },
    });
    assert.equal(a.observe().screen, "/shop#cart");
  });

  test("reports heap in MB when the host exposes it", () => {
    const a = new DomAdapter({
      doc: doc([]),
      win: { performance: { memory: { usedJSHeapSize: 52428800 } } },
    });
    assert.equal(a.observe().perf.heapMB, 50);
  });
});

describe("dom adapter: end to end", () => {
  test("the real agent finds a softlock in a fake DOM app", async () => {
    // A two-screen app. "Open" leads to a modal whose only control does nothing -
    // a trap with no close button, which is one of the most common real UI bugs.
    let screen = "home";
    const home = [
      el({ id: "open", text: "Open settings", rect: { x: 0, y: 0, width: 120, height: 30 }, onClick: () => { screen = "modal"; } }),
      el({ id: "play", text: "Play", rect: { x: 0, y: 40, width: 120, height: 30 }, onClick: () => {} }),
    ];
    const modal = [el({ id: "toggle", text: "Toggle sound", onClick: () => {} })];
    const d: DocumentLike = {
      querySelectorAll: () => (screen === "home" ? home : modal),
      querySelector: () => null,
    };

    const adapter = new DomAdapter({ doc: d, screenOf: () => screen });
    const r = await runSession(adapter, new CoverageFuzzPolicy(3), {
      seed: 3,
      steps: 200,
      oracles: TIER0_ORACLES,
    });

    const softlock = r.findings.find((f) => f.bugClass === "softlock");
    assert.ok(softlock, "expected a softlock: " + JSON.stringify(r.findings.map((f) => f.title)));
    assert.match(softlock!.title, /modal/);
    assert.ok(softlock!.replay.actions.length > 0, "and a reproduction");
  });

  test("a healthy fake DOM app produces no findings", async () => {
    let screen = "home";
    const home = [el({ id: "open", text: "Open", onClick: () => { screen = "modal"; } })];
    const modal = [
      el({ id: "close", text: "Close", rect: { x: 0, y: 0, width: 80, height: 30 }, onClick: () => { screen = "home"; } }),
      el({ id: "toggle", text: "Toggle", rect: { x: 0, y: 40, width: 80, height: 30 }, onClick: () => {} }),
    ];
    const d: DocumentLike = {
      querySelectorAll: () => (screen === "home" ? home : modal),
      querySelector: () => null,
    };
    const r = await runSession(new DomAdapter({ doc: d, screenOf: () => screen }), new CoverageFuzzPolicy(2), {
      seed: 2,
      steps: 300,
      oracles: TIER0_ORACLES,
    });
    assert.deepEqual(r.findings.map((f) => f.title), []);
  });
});
