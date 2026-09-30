# Browser demo

A tiny web game with three planted bugs, with the **entire agent running inside the
page** — the same tiers, oracles, gates and reporting the Node test suite exercises,
compiled to ESM and loaded as a module. Nothing here is reimplemented for the
browser.

This is the architecture recommended at the outset: for a web game the bot can live
in the game's own JS context, so observation is a scene-tree read and actuation is a
real event, with no IPC and no round-trip per action.

```bash
npm run build:web     # compile the DOM adapter to browser-loadable JS
npm run demo:web      # serve on http://127.0.0.1:8177
```

Open the page and press **Run the bot**, or call `window.__RUN_BOT__({ steps: 500 })`
from the console.

## Planted bugs

| Bug | Class | How it shows up |
|---|---|---|
| Settings has no way back | softlock | one control, exercising it changes nothing |
| Buying does not deduct gold | flow | `potions` goes up, `gold` does not go down |
| Elixir caption overflows its box | ui | `scrollWidth` 320 in a `clientWidth` 117 box |

## Verifying it end to end

```js
const { adapter } = window.__BOT__;

// Real layout, real measurement:
adapter.act({ type: "tap", targetId: "shop" });
adapter.observe().elements.filter(e => e.textWidth > e.bbox.w);
// -> [{ id: "buy-elixir", textWidth: 320, bbox: { w: 117 } }]

// The delta the economy invariant reads:
const before = adapter.observe().vars.gold;
adapter.act({ type: "tap", targetId: "buy-potion" });
adapter.observe().vars;            // gold unchanged, potions +1

// The softlock:
adapter.act({ type: "tap", targetId: "settings" });
adapter.availableActions();        // only [toggle-sound]
```

All three were confirmed in a real browser, which is what the main README means by
the DOM adapter being browser-validated.

## Actual result

500 steps, 91 distinct states, ~72% Tier-1 absorption, 25 Tier-2 calls:

```
[critical/flow/tier1]     Purchase did not deduct currency        repro: 15 actions
[critical/softlock/tier1] Screen has no exit                      repro: 106 actions
[critical/softlock/tier0] Softlock on screen 'settings'           repro: 110 actions
[low/ui/tier0]            Text overflows its box: buy-elixir      repro: 1 action
```

All three planted bugs found, and the softlock found **twice by independent
routes** — Tier 0 structurally (every control exercised, nothing changed) and
Tier 1 semantically (no control on this screen means "leave"). The page's own HUD
makes the economy bug plain: it ends the run showing 82 potions bought and 50 gold
still in hand.

## What this proves, and what it does not

**Proves:** the adapter reads real DOM state correctly — element discovery, the
active-screen selector, stable ids from `data-testid`, visibility, enablement, real
`getBoundingClientRect` geometry, and overflow from real `scrollWidth` vs
`clientWidth`. Clicks dispatch through real handlers. And the whole tier stack runs
unmodified in a browser.

**Does not:** use a real model. The System One tier is still `MockSystemOne` with a
ground-truth function, because there is no API key here — see the main README's
"what is real and what is simulated". Swapping in `createLayaClient()` is one line.

**Note:** this page provides no snapshot hook, so `canSnapshot` is false and the
session correctly disables recovery rather than faking a rewind. A real integration
should supply `snapshot`/`restore` if the game can — recovery is worth a lot when a
blocking bug would otherwise cost the whole run.
