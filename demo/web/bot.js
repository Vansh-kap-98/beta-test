/**
 * The whole agent, running inside the page.
 *
 * Everything imported here is the real compiled source - the same oracles, the
 * same statistical reporting gate, the same escalation logic the Node test suite
 * exercises. Nothing is reimplemented for the browser.
 *
 * This is the architecture that was recommended at the start: for a web game the
 * bot can live in the game's own JS context, so observation is a scene-tree read
 * and actuation is a real event, with no IPC and no round-trip per action.
 */
import { DomAdapter } from "./lib/adapters/dom/adapter.js";
import { runSession } from "./lib/core/agent/session.js";
import { Tier1Policy } from "./lib/core/agent/tier1Policy.js";
import { OraclePlanner } from "./lib/core/agent/planner.js";
import { MockSystemOne } from "./lib/core/soc/backends/mock.js";
import { TIER0_ORACLES, makeBoundsOracle } from "./lib/core/oracles/tier0.js";

/** Written as a spec author would, with no mention of a control or screen id. */
const INVARIANTS = [
  {
    id: "purchase_deducts_currency",
    prompt: "The player just bought an item. Did the player's currency go down?",
    criteria: {
      true: "the currency total is lower than before the purchase",
      false: "the currency total is unchanged or higher after the purchase",
    },
    title: "Purchase did not deduct currency",
    bugClass: "flow",
    severity: "critical",
    dedupeBy: "global",
    applies: (s) => s.lastAction.includes("buy-") && (s.deltas.potions ?? 0) > 0,
  },
  {
    id: "screen_has_an_exit",
    prompt: "Does this screen give the player a way to leave it, such as a back or close control?",
    criteria: {
      true: "at least one control leaves this screen",
      false: "every control keeps the player on this screen",
    },
    title: "Screen has no exit",
    bugClass: "softlock",
    severity: "critical",
    applies: (s) => !s.loading && s.screen !== "home",
  },
];

const BOUNDS = [
  { variable: "gold", min: 0, label: "Currency went negative" },
  { variable: "potions", min: 0, label: "Item count went negative" },
];

/** Ground truth, standing in for Jev/Laya so this runs with no API key. */
function invariantHolds(s, id) {
  if (id === "purchase_deducts_currency") return (s.deltas.gold ?? 0) < 0;
  if (id === "screen_has_an_exit") {
    return s.controls.some((c) => c.enabled && /back|close|cancel|exit|home/i.test(c.id));
  }
  return undefined;
}

function bestControl(s, options) {
  const target = (id) => options.find((o) => o === id || o.endsWith(" " + id));
  const exit = () => options.find((o) => /back|close|home/i.test(o));

  if (s.screen === "home") return target("shop") ?? options[0];

  // A shopper with money buys something. This matters: a policy that only ever
  // leaves the shop gives the economy invariant no opportunities at all, and a
  // real purchase bug stays invisible however long the run is.
  if (s.screen === "shop") {
    const gold = Number(s.vars.gold ?? 0);
    const buy = options.find((o) => /buy-potion/.test(o));
    if (gold >= 10 && buy) return buy;
    return exit() ?? options[0];
  }

  if (s.screen === "settings" || s.screen === "play") return exit() ?? options[0];
  return options[0];
}

const truth = (state, q) => {
  if (q.kind === "noul") return invariantHolds(state, q.id);
  if (q.kind === "choice") return bestControl(state, q.options);
  return undefined;
};

export async function runBot({ steps = 400, seed = 1 } = {}) {
  const errors = [];
  window.addEventListener("error", (e) => errors.push("UNCAUGHT: " + e.message));

  const adapter = new DomAdapter({
    doc: document,
    win: window,
    screenOf: () => window.__GAME__.screen(),
    varsOf: () => window.__GAME__.vars(),
    drainErrors: () => errors.splice(0),
    reset: () => window.__GAME__.reset(),
    // Scoped to the active screen: without this the adapter offers controls on
    // display:none screens, which no player can reach.
    interactiveSelector: ".screen.active [data-testid]",
  });

  const client = new MockSystemOne(truth, { seed });
  const policy = new Tier1Policy(client, {
    invariants: INVARIANTS,
    planner: new OraclePlanner({ bestControl, invariantHolds }),
  });

  const result = await runSession(adapter, policy, {
    seed,
    steps,
    oracles: [...TIER0_ORACLES, makeBoundsOracle(BOUNDS)],
  });

  return { result, stats: policy.stats };
}

window.__RUN_BOT__ = runBot;
