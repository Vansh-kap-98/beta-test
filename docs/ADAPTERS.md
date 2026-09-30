# Pointing this at your game

The whole integration surface is one interface and one registry entry. Everything
above it — the tiers, oracles, escalation, recovery, reporting, replay — is
game-agnostic, and that claim has been tested against two deliberately dissimilar
games rather than merely asserted.

## The interface

```ts
interface GameAdapter {
  readonly name: string;
  readonly canSnapshot?: boolean;   // say false if you cannot really restore
  reset(seed: number): void;
  observe(): GameState;
  act(action: Action): void;
  availableActions(): Action[];
  snapshot(): unknown;
  restore(snap: unknown): void;
}
```

`observe()` is the one that matters. Everything the bot can ever find is limited by
what you put in it.

```ts
interface GameState {
  step: number;
  screen: string;                    // semantic screen name, e.g. "shop"
  elements: UiElement[];             // what the player can see and press
  vars: Record<string, number | string | boolean>;   // gold, hp, cart total...
  loading: boolean;
  errors: string[];                  // drained since the last observe
  perf: { fps: number; heapMB: number };
}
```

## The three things worth spending real time on

**1. `vars` decides which bugs are findable at all.** A bot that cannot see the
player's currency cannot check that buying something deducted it. Most games
already have a debug hook — `window.__GAME__.state`, a Redux store, a singleton —
and exposing it is usually a few lines. If you do nothing else, do this.

**2. Element ids must be stable across re-renders.** An unstable id makes every
observation look like a new defect and breaks replay. Prefer, in order: an explicit
test id, a DOM/node id, a name, a label. A positional path is the last resort and
it is genuinely bad.

**3. `reset(seed)` is what makes reports reproducible.** Seed the game's RNG from
it. Without determinism, a finding cannot be replayed, and a finding a developer
cannot reproduce gets ignored. If your game cannot be seeded, say so early — it
changes what the tool can promise.

## Web games (DOM or canvas)

`src/adapters/dom/adapter.ts` works out of the box for DOM UIs:

```ts
import { DomAdapter } from "./src/adapters/dom/adapter.ts";

const adapter = new DomAdapter({
  doc: document,
  win: window,
  screenOf: () => window.__GAME__.currentScene,
  varsOf: () => ({
    gold: window.__GAME__.player.gold,
    hp: window.__GAME__.player.hp,
    level: window.__GAME__.level,
  }),
  drainErrors: () => collectedErrors.splice(0),
  fps: () => window.__GAME__.fps,
  reset: (seed) => window.__GAME__.restart(seed),
});
```

**Canvas engines (LayaAir, Phaser, Cocos, Egret) need `elementsFrom`.** A canvas
game renders to pixels, so reading the DOM finds one element: the canvas. Walk the
engine's own scene tree instead:

```ts
const adapter = new DomAdapter({
  doc: document,
  elementsFrom: () => walk(Laya.stage),   // your engine's root node
  // ...
});

function walk(node, out = []) {
  for (const child of node._children ?? []) {
    if (child.name) {
      out.push({
        id: child.name,
        kind: child.on ? "button" : "label",
        text: child.text ?? child.label,
        visible: child.visible && child.alpha > 0,
        enabled: child.mouseEnabled !== false,
        bbox: { x: child.x, y: child.y, w: child.width, h: child.height },
      });
    }
    walk(child, out);
  }
  return out;
}
```

This is the highest-value hour of integration work for a canvas target, and it is
also where the advantage of a white-box adapter shows: you get a semantic tree with
names and state, rather than pixels a vision model has to interpret.

Hook errors before anything else runs:

```ts
const collectedErrors: string[] = [];
window.addEventListener("error", (e) => collectedErrors.push("UNCAUGHT: " + e.message));
window.addEventListener("unhandledrejection", (e) => collectedErrors.push("REJECTED: " + e.reason));
```

## Writing invariants

Invariants are written the way a designer writes them in a design doc, once, in
English. They should not mention a control id, a screen name or a variable:

```ts
{
  id: "purchase_deducts_currency",
  prompt: "The player just bought an item. Did the player's currency go down?",
  criteria: {
    true: "the currency total is lower than before the purchase",
    false: "the currency total is unchanged or higher",
  },
  title: "Purchase did not deduct currency",
  bugClass: "flow",
  severity: "high",
  dedupeBy: "global",            // one bug, however many screens show it
  applies: (s) => s.lastAction.startsWith("tap buy_") && (s.deltas.items ?? 0) > 0,
}
```

Two rules, both learned the hard way (see [JOURNAL.md](JOURNAL.md)):

- **If plain code can decide it, it is a Tier-0 bounds check, not an invariant.**
  `currency >= 0` is arithmetic. Putting it in the model's suite got it asked every
  step and produced hundreds of false bug reports on a clean build.
- **Keep `applies` dumb and narrow.** It decides *when to ask*, not what the answer
  is. Gate it to states where the question is meaningful — a validation invariant
  that fires on a screen without the input field will report a bug that isn't there.

## Registering it

```ts
// src/games/registry.ts
export const GAMES = {
  mygame: {
    name: "mygame",
    description: "...",
    makeAdapter: (variant) => new MyAdapter(variant),
    invariants: MY_INVARIANTS,
    bounds: MY_BOUNDS,
    variants: ["clean", "release", "staging"],
  },
};
```

Then:

```bash
npm run play -- --game mygame --seeds 8 --steps 2000
```

## Before you trust the output

1. **Run it against a build you believe is clean, first.** If it finds anything,
   that is your false-positive rate and it must be zero before any other number
   means anything. This is the single most important step and it is easy to skip.
2. **Run the calibration harness** (`npm run calibrate`) and set the escalation
   gate and `expectedErrorRate` from measurement rather than taste.
3. **Replay one finding by hand** and confirm it lands where the report says.

## Connecting a real model

Replace `MockSystemOne` with a real client:

```ts
import { createLayaClient, createJevClient } from "./src/core/soc/backends/http.ts";

const client = createLayaClient("http://127.0.0.1:8000");     // local, open weights
// or
const client = createJevClient(process.env.JEV_API_KEY!);      // managed
```

Both speak the same wire contract, so this is the only line that changes. The
backend is unit-tested against fixture payloads from the published docs but has not
been run against a live server — expect to shake out something on first contact.
