import type { BugFlags } from "./bugs.ts";
import { NO_BUGS } from "./bugs.ts";

/**
 * A small deterministic RPG used as the system-under-test.
 *
 * Headless by design: no canvas, no DOM, no rendering. That keeps the whole agent
 * loop runnable in-process at thousands of steps per second, which is what makes
 * overnight regression runs and the calibration harness practical. A rendered build
 * would add nothing the bot can use - the bot consumes the semantic tree, not pixels.
 */

export type Screen =
  | "title"
  | "menu"
  | "shop"
  | "dungeon"
  | "combat"
  | "settings"
  | "gameover";

/** mulberry32 - small, fast, fully determined by the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ShopItem {
  id: string;
  name: string;
  cost: number;
  heals: number;
}

/**
 * Deliberately long. A real game screen routinely has 20-40 interactable nodes, and
 * Laya's shared ~192-256 token option budget degrades past roughly 20 candidates.
 * The fixture has to exceed that ceiling or the router's shortlisting and
 * hierarchical-choice mitigations would never actually be exercised by the tests.
 */
export const SHOP_ITEMS: ShopItem[] = [
  { id: "potion_s", name: "Small Potion", cost: 10, heals: 15 },
  { id: "potion_m", name: "Medium Potion", cost: 25, heals: 40 },
  { id: "potion_l", name: "Large Potion", cost: 50, heals: 90 },
  { id: "elixir", name: "Elixir of Absolutely Everything Forever", cost: 80, heals: 200 },
  { id: "bread", name: "Bread", cost: 5, heals: 5 },
  { id: "cheese", name: "Cheese", cost: 7, heals: 8 },
  { id: "apple", name: "Apple", cost: 4, heals: 4 },
  { id: "jerky", name: "Dried Jerky", cost: 9, heals: 10 },
  { id: "tonic", name: "Bitter Tonic", cost: 12, heals: 14 },
  { id: "salve", name: "Field Salve", cost: 15, heals: 18 },
  { id: "bandage", name: "Bandage", cost: 6, heals: 6 },
  { id: "herb", name: "Healing Herb", cost: 8, heals: 9 },
  { id: "stew", name: "Hot Stew", cost: 14, heals: 16 },
  { id: "wine", name: "Red Wine", cost: 11, heals: 12 },
  { id: "honey", name: "Jar of Honey", cost: 13, heals: 15 },
  { id: "root", name: "Bitterroot", cost: 3, heals: 3 },
  { id: "broth", name: "Bone Broth", cost: 16, heals: 20 },
  { id: "tea", name: "Chamomile Tea", cost: 5, heals: 6 },
  { id: "mushroom", name: "Cave Mushroom", cost: 7, heals: 7 },
  { id: "draught", name: "Sleeping Draught", cost: 18, heals: 22 },
];

export interface RefElement {
  id: string;
  kind: "button" | "label";
  text: string;
  visible: boolean;
  enabled: boolean;
  bbox: { x: number; y: number; w: number; h: number };
  textWidth: number;
  tags: string[];
}

export interface CoreState {
  seed: number;
  step: number;
  screen: Screen;
  navStack: Screen[];
  gold: number;
  hp: number;
  maxHp: number;
  potions: number;
  floor: number;
  loadingFrames: number;
  enemyHp: number;
  enemyMaxHp: number;
  errors: string[];
  heapBase: number;
  dead: boolean;
}

export class RefGame {
  readonly bugs: BugFlags;
  private rng: () => number = mulberry32(1);
  s: CoreState;

  constructor(bugs: Partial<BugFlags> = {}) {
    this.bugs = { ...NO_BUGS, ...bugs };
    this.s = this.fresh(1);
  }

  private fresh(seed: number): CoreState {
    return {
      seed,
      step: 0,
      screen: "title",
      navStack: [],
      gold: 30,
      hp: 50,
      maxHp: 50,
      potions: 1,
      floor: 1,
      loadingFrames: 0,
      enemyHp: 0,
      enemyMaxHp: 0,
      errors: [],
      heapBase: 40,
      dead: false,
    };
  }

  reset(seed: number): void {
    this.rng = mulberry32(seed);
    this.s = this.fresh(seed);
  }

  snapshot(): CoreState {
    return structuredClone(this.s);
  }

  restore(snap: CoreState): void {
    this.s = structuredClone(snap);
  }

  private roll(n: number): number {
    return 1 + Math.floor(this.rng() * n);
  }

  private nav(to: Screen): void {
    this.s.navStack.push(this.s.screen);
    this.s.screen = to;
  }

  /** Heap in MB. With memLeak on, growth is superlinear in step count. */
  heapMB(): number {
    const leak = this.bugs.memLeak ? (this.s.step * this.s.step) / 900 : this.s.step / 200;
    return Math.round((this.s.heapBase + leak) * 10) / 10;
  }

  fps(): number {
    // Frame rate sags as the heap grows; a leak eventually drags it under 30.
    const h = this.heapMB();
    return Math.max(8, Math.round(60 - Math.max(0, h - 60) * 0.7));
  }

  /** Ids of every element the player could legally interact with right now. */
  interactableIds(): string[] {
    return this.elements()
      .filter((e) => e.kind === "button" && e.visible && e.enabled)
      .map((e) => e.id);
  }

  elements(): RefElement[] {
    const out: RefElement[] = [];
    const px = (t: string) => t.length * 7;
    const btn = (
      id: string,
      text: string,
      x: number,
      y: number,
      w = 120,
      enabled = true,
      tags: string[] = [],
    ) => {
      out.push({
        id,
        kind: "button",
        text,
        visible: true,
        enabled,
        bbox: { x, y, w, h: 32 },
        textWidth: px(text),
        tags,
      });
    };
    const label = (id: string, text: string, x: number, y: number, w = 200) => {
      out.push({
        id,
        kind: "label",
        text,
        visible: true,
        enabled: false,
        bbox: { x, y, w, h: 20 },
        textWidth: px(text),
        tags: ["hud"],
      });
    };

    if (this.s.loadingFrames > 0) {
      label("loading_text", "Loading...", 100, 100);
      return out;
    }

    // Persistent HUD, present on every real screen.
    if (this.s.screen !== "title") {
      label("hud_gold", "Gold: " + this.s.gold, 10, 10);
      label("hud_hp", "HP: " + this.s.hp + "/" + this.s.maxHp, 10, 34);
      label("hud_floor", "Floor: " + this.s.floor, 10, 58);
      label("hud_potions", "Potions: " + this.s.potions, 10, 82);
    }

    switch (this.s.screen) {
      case "title":
        label("title_text", "DUNGEON OF TESTING", 100, 60, 260);
        btn("start", "Start Game", 100, 120);
        break;

      case "menu":
        btn("go_dungeon", "Enter Dungeon", 100, 120);
        btn("go_shop", "Shop", 100, 160);
        btn("go_settings", "Settings", 100, 200);
        btn("use_potion", "Use Potion", 100, 240, 120, this.s.potions > 0);
        break;

      case "shop": {
        let y = 120;
        for (const it of SHOP_ITEMS) {
          const overflow = this.bugs.textOverflow && it.id === "elixir";
          const name = overflow ? it.name : it.name.slice(0, 16);
          const caption = name + " (" + it.cost + "g)";
          out.push({
            id: "buy_" + it.id,
            kind: "button",
            text: caption,
            visible: true,
            enabled: this.s.gold >= it.cost,
            bbox: { x: 100, y, w: 160, h: 32 },
            textWidth: px(caption),
            tags: ["shop", "purchase"],
          });
          label("price_" + it.id, it.cost + " gold", 280, y, 80);
          y += 40;
        }
        btn("back", "Back", 100, y + 10);
        break;
      }

      case "dungeon":
        btn("descend", "Descend", 100, 120);
        btn("go_settings", "Settings", 100, 160);
        btn("use_potion", "Use Potion", 100, 200, 120, this.s.potions > 0);
        btn("back", "Back", 100, 240);
        break;

      case "combat":
        label("enemy_hp", "Enemy HP: " + this.s.enemyHp + "/" + this.s.enemyMaxHp, 100, 90, 220);
        btn("attack", "Attack", 100, 130);
        btn("use_potion", "Use Potion", 100, 170, 120, this.s.potions > 0);
        btn("flee", "Flee", 100, 210);
        break;

      case "settings":
        label("settings_text", "Settings", 100, 90);
        btn("toggle_sound", "Toggle Sound", 100, 130);
        if (!(this.bugs.settingsSoftlock && this.s.navStack.at(-1) === "dungeon")) {
          btn("back", "Back", 100, 170);
        }
        break;

      case "gameover":
        label("gameover_text", "You Died", 100, 90);
        btn("restart", "Restart", 100, 130);
        break;
    }
    return out;
  }

  /** Advance one tick without input (used by wait actions). */
  tick(): void {
    this.s.step++;
    if (this.s.loadingFrames > 0 && this.s.loadingFrames !== Infinity) {
      this.s.loadingFrames--;
    }
  }

  tap(id: string): void {
    this.s.step++;
    if (this.s.loadingFrames > 0) {
      if (this.s.loadingFrames !== Infinity) this.s.loadingFrames--;
      return; // input is swallowed while loading
    }
    if (!this.interactableIds().includes(id)) return;

    switch (id) {
      case "start":
        this.s.screen = "menu";
        this.s.navStack = [];
        break;

      case "go_dungeon":
        this.nav("dungeon");
        break;

      case "go_shop":
        this.nav("shop");
        break;

      case "go_settings":
        if (this.bugs.settingsSoftlock && this.s.screen === "dungeon") {
          // The bug: nav stack is clobbered, so Back can never be rendered.
          this.s.navStack = ["dungeon"];
          this.s.screen = "settings";
        } else {
          this.nav("settings");
        }
        break;

      case "back": {
        const prev = this.s.navStack.pop();
        this.s.screen = prev ?? "menu";
        break;
      }

      case "toggle_sound":
        break;

      case "use_potion":
        if (this.bugs.potionCrashAtFullHp && this.s.hp >= this.s.maxHp) {
          const err = "TypeError: Cannot read properties of null (reading heal)";
          this.s.errors.push(err);
          throw new Error(err);
        }
        if (this.s.potions > 0) {
          this.s.potions--;
          this.s.hp = Math.min(this.s.maxHp, this.s.hp + 25);
        }
        break;

      case "descend": {
        this.s.floor++;
        if (this.bugs.infiniteLoad && this.s.floor === 3) {
          this.s.loadingFrames = Infinity;
        } else {
          this.s.loadingFrames = 2;
        }
        const spike = this.bugs.difficultySpike && this.s.floor === 7;
        const base = 10 + this.s.floor * 4;
        this.s.enemyMaxHp = spike ? base * 10 : base;
        this.s.enemyHp = this.s.enemyMaxHp;
        this.s.screen = "combat";
        this.s.navStack = ["dungeon"];
        break;
      }

      case "attack": {
        this.s.enemyHp -= this.roll(8) + 4;
        if (this.s.enemyHp <= 0) {
          this.s.gold += 10 + this.s.floor * 3;
          // Clearing a floor restores a little health, so the clean build has a
          // survivable curve. Without this the player dies by floor 5 no matter
          // what, which flattens turns-to-clear and hides any real spike behind a
          // wall of instant deaths - the baseline has to be sane for an anomaly
          // detector to have anything to stand out against.
          this.s.hp = Math.min(this.s.maxHp, this.s.hp + 10);
          this.s.screen = "dungeon";
          this.s.navStack = ["menu"];
          break;
        }
        this.s.hp -= this.roll(4) + Math.floor(this.s.floor / 2);
        if (this.s.hp <= 0) {
          this.s.hp = 0;
          this.s.dead = true;
          this.s.screen = "gameover";
        }
        break;
      }

      case "flee":
        this.s.screen = "dungeon";
        this.s.navStack = ["menu"];
        break;

      case "restart": {
        const seed = this.s.seed;
        // A soft restart clears game progress but NOT accumulated heap. Real leaks
        // survive a level restart, and modelling it otherwise would let the fixture
        // hide its own leak: the player dies, restarts, and the heap counter goes
        // back to zero before the leak ever becomes visible.
        const carriedStep = this.s.step;
        const carriedHeap = this.s.heapBase;
        this.reset(seed);
        this.s.step = carriedStep;
        this.s.heapBase = carriedHeap;
        this.s.screen = "menu";
        break;
      }

      default:
        if (id.startsWith("buy_")) {
          const item = SHOP_ITEMS.find((i) => "buy_" + i.id === id);
          if (!item) break;
          if (this.s.gold >= item.cost) {
            if (!this.bugs.shopFree) this.s.gold -= item.cost;
            this.s.potions++;
          }
        }
        break;
    }
  }

  drainErrors(): string[] {
    const e = this.s.errors;
    this.s.errors = [];
    return e;
  }
}
