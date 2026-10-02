/**
 * Headless match-3, a faithful port of `demo/web/match3.html` including its five
 * planted bugs.
 *
 * Why this exists when the browser fixture already does: the browser fixture can
 * only be driven through the screen, so every run costs the operator the use of
 * their display, takes minutes, and mixes perception failures into every result.
 * This one runs in-process, deterministically, thousands of steps a minute, and
 * isolates a single question:
 *
 *   given a PERFECT view of the game, does the model find the bug?
 *
 * That separates the two failure modes the plan warns about -- "the screen was
 * unreadable" and "the model could not tell" -- which cannot be told apart when the
 * only path to the game is a screenshot.
 *
 * The bug list is identical to the browser fixture's, so a detection rate measured
 * here is directly comparable with one measured through the real pipeline, and the
 * gap between them is exactly the cost of perception.
 */

export const BOARD_W = 8;
export const BOARD_H = 8;
export const KINDS = 6;

export type Match3Bug =
  | "scoreCascade"
  | "tutorialVague"
  | "stuckNoShuffle"
  | "ghostMove"
  | "winNoAdvance";

export const ALL_MATCH3_BUGS: Match3Bug[] = [
  "scoreCascade", "tutorialVague", "stuckNoShuffle", "ghostMove", "winNoAdvance",
];

export type Overlay = "tutorial" | "win" | "lose" | "stuck" | "pause" | null;

/** The fixture's RNG, ported exactly so a seed produces the same board. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Match3Game {
  grid: Array<number | null> = [];
  score = 0;
  moves = 20;
  goal = 1000;
  level = 1;
  overlay: Overlay = "tutorial";
  /** Set when the last action was rejected, for the "no match there" path. */
  lastRejected = false;
  /** Tiles cleared by the last resolved move. */
  lastCleared = 0;
  /** Chain length of the last resolve, so cascade scoring can be checked. */
  lastChain = 0;

  private bugs: Set<Match3Bug>;
  private rnd: () => number;

  constructor(seed = 1, bugs: Match3Bug[] = []) {
    this.bugs = new Set(bugs);
    this.rnd = makeRng(seed);
    this.newLevel(1);
    this.overlay = "tutorial";
  }

  has(b: Match3Bug): boolean {
    return this.bugs.has(b);
  }

  private idx(x: number, y: number): number {
    return y * BOARD_W + x;
  }

  at(x: number, y: number): number | null {
    if (x < 0 || y < 0 || x >= BOARD_W || y >= BOARD_H) return null;
    return this.grid[this.idx(x, y)] ?? null;
  }

  /** Fill with no pre-existing matches, exactly as the fixture does. */
  fill(): void {
    this.grid = new Array(BOARD_W * BOARD_H).fill(null);
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        let k: number;
        do {
          k = Math.floor(this.rnd() * KINDS);
        } while (
          (x >= 2 && this.grid[this.idx(x - 1, y)] === k && this.grid[this.idx(x - 2, y)] === k) ||
          (y >= 2 && this.grid[this.idx(x, y - 1)] === k && this.grid[this.idx(x, y - 2)] === k)
        );
        this.grid[this.idx(x, y)] = k;
      }
    }
  }

  findMatches(): Set<number> {
    const hit = new Set<number>();
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W - 2; x++) {
        const k = this.at(x, y);
        if (k === null) continue;
        if (this.at(x + 1, y) === k && this.at(x + 2, y) === k) {
          hit.add(this.idx(x, y));
          hit.add(this.idx(x + 1, y));
          hit.add(this.idx(x + 2, y));
          let n = x + 3;
          while (this.at(n, y) === k) { hit.add(this.idx(n, y)); n++; }
        }
      }
    }
    for (let x = 0; x < BOARD_W; x++) {
      for (let y = 0; y < BOARD_H - 2; y++) {
        const k = this.at(x, y);
        if (k === null) continue;
        if (this.at(x, y + 1) === k && this.at(x, y + 2) === k) {
          hit.add(this.idx(x, y));
          hit.add(this.idx(x, y + 1));
          hit.add(this.idx(x, y + 2));
          let n = y + 3;
          while (this.at(x, n) === k) { hit.add(this.idx(x, n)); n++; }
        }
      }
    }
    return hit;
  }

  private swapTest(a: number, b: number): boolean {
    const t = this.grid[a];
    this.grid[a] = this.grid[b] ?? null;
    this.grid[b] = t ?? null;
    const ok = this.findMatches().size > 0;
    const u = this.grid[a];
    this.grid[a] = this.grid[b] ?? null;
    this.grid[b] = u ?? null;
    return ok;
  }

  /** Every swap that produces a match. Ground truth for `board_is_playable`. */
  validSwaps(): Array<{ a: [number, number]; b: [number, number] }> {
    const out: Array<{ a: [number, number]; b: [number, number] }> = [];
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        if (x < BOARD_W - 1 && this.swapTest(this.idx(x, y), this.idx(x + 1, y))) {
          out.push({ a: [x, y], b: [x + 1, y] });
        }
        if (y < BOARD_H - 1 && this.swapTest(this.idx(x, y), this.idx(x, y + 1))) {
          out.push({ a: [x, y], b: [x, y + 1] });
        }
      }
    }
    return out;
  }

  anyValidMove(): boolean {
    return this.validSwaps().length > 0;
  }

  /** Resolve matches and cascades. Returns tiles cleared. */
  private resolve(): number {
    let chain = 0;
    let cleared = 0;
    for (;;) {
      const hit = this.findMatches();
      if (hit.size === 0) break;
      chain++;
      cleared += hit.size;
      // PLANTED BUG: cascades award nothing, so the score silently under-counts.
      const award = chain > 1 && this.has("scoreCascade") ? 0 : hit.size * 20 * chain;
      this.score += award;
      for (const i of hit) this.grid[i] = null;
      // gravity
      for (let x = 0; x < BOARD_W; x++) {
        let write = BOARD_H - 1;
        for (let y = BOARD_H - 1; y >= 0; y--) {
          if (this.grid[this.idx(x, y)] !== null) {
            this.grid[this.idx(x, write)] = this.grid[this.idx(x, y)] ?? null;
            if (write !== y) this.grid[this.idx(x, y)] = null;
            write--;
          }
        }
        for (let y = write; y >= 0; y--) {
          this.grid[this.idx(x, y)] = Math.floor(this.rnd() * KINDS);
        }
      }
    }
    this.lastChain = chain;
    return cleared;
  }

  /** Attempt a swap of two adjacent cells. Returns tiles cleared (0 if rejected). */
  swap(ax: number, ay: number, bx: number, by: number): number {
    this.lastRejected = false;
    this.lastCleared = 0;
    this.lastChain = 0;
    if (this.overlay !== null) return 0;
    if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) {
      this.lastRejected = true;
      return 0;
    }

    const a = this.idx(ax, ay);
    const b = this.idx(bx, by);
    const t = this.grid[a];
    this.grid[a] = this.grid[b] ?? null;
    this.grid[b] = t ?? null;

    if (this.findMatches().size === 0) {
      // Invalid swap: revert. PLANTED BUG: a move is consumed anyway.
      const u = this.grid[a];
      this.grid[a] = this.grid[b] ?? null;
      this.grid[b] = u ?? null;
      if (this.has("ghostMove")) this.moves--;
      this.lastRejected = true;
      this.checkEnd();
      return 0;
    }

    this.moves--;
    this.lastCleared = this.resolve();
    this.checkEnd();
    return this.lastCleared;
  }

  /**
   * Open and close the pause menu.
   *
   * Added because the real model was right and the fixture was wrong. Asked "does
   * this screen give the player a way to leave it", Laya answered no about the board
   * on every variant including the clean build -- and it was correct: the board
   * offered swaps and a shuffle and nothing else. That scored as a false positive on
   * a clean build, the one failure this bench treats as disqualifying, when the
   * actual defect was in the fixture. Every real game of this genre has a pause
   * control; leaving it out made the fixture unrepresentative in exactly the way the
   * invariant was built to notice.
   */
  pause(): boolean {
    if (this.overlay !== null) return false;
    this.overlay = "pause";
    return true;
  }

  resume(): boolean {
    if (this.overlay !== "pause") return false;
    this.overlay = null;
    return true;
  }

  dismissTutorial(): boolean {
    if (this.overlay !== "tutorial") return false;
    this.overlay = null;
    return true;
  }

  /** Returns whether the shuffle actually did anything. */
  shuffle(): boolean {
    // PLANTED BUG: shuffle does nothing, so a dead board is a hard softlock.
    if (this.has("stuckNoShuffle")) return false;
    this.fill();
    if (this.overlay === "stuck") this.overlay = null;
    return true;
  }

  /** Returns whether the level actually advanced. */
  nextLevel(): boolean {
    if (this.overlay !== "win") return false;
    // PLANTED BUG: the button does nothing, trapping the player on the win screen.
    if (this.has("winNoAdvance")) return false;
    this.newLevel(this.level + 1);
    return true;
  }

  retry(): boolean {
    if (this.overlay !== "lose") return false;
    this.newLevel(this.level);
    return true;
  }

  newLevel(n: number): void {
    this.level = n;
    this.score = 0;
    this.moves = 20 + n * 2;
    this.goal = 1000 + (n - 1) * 400;
    this.fill();
    this.overlay = null;
  }

  private checkEnd(): void {
    if (this.score >= this.goal) { this.overlay = "win"; return; }
    if (this.moves <= 0) { this.overlay = "lose"; return; }
    if (!this.anyValidMove()) this.overlay = "stuck";
  }

  /**
   * Deal a board with no legal move, deterministically.
   *
   * Needed because a dead board essentially never arises by chance -- 8x8 with six
   * colours and refill-from-above almost always leaves a move -- so the softlock
   * detector and the planted dead-shuffle bug had no reachable instance to be tested
   * against. An untested detector is an unproven one, and the first version of this
   * bench credited `stuckNoShuffle` as "detected" only because an unrelated policy
   * fault had the bot pressing Shuffle on every step.
   *
   * The pattern is a 2x2 colour tile: no three in a row anywhere, and swapping any
   * adjacent pair cannot make three either, because each swap only ever exchanges
   * two colours that already alternate along both axes. Asserted in the tests rather
   * than trusted.
   */
  dealDeadBoard(): void {
    this.grid = new Array(BOARD_W * BOARD_H).fill(null);
    for (let y = 0; y < BOARD_H; y++) {
      for (let x = 0; x < BOARD_W; x++) {
        this.grid[this.idx(x, y)] = (x % 2) + 2 * (y % 2);
      }
    }
    this.overlay = this.anyValidMove() ? this.overlay : "stuck";
  }

  /** The tutorial text, vague under the planted bug. */
  tutorialText(): string {
    return this.has("tutorialVague")
      ? "Tap things to play."
      : "Swap two candies to make a line of three.";
  }
}
