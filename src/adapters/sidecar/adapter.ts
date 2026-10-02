import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Action, GameAdapter, GameState, UiElement } from "../../core/types.ts";

/**
 * Drives a real game through the Python perception/actuation sidecar.
 *
 * This is the join between the two halves of the system. Image processing, Win32
 * input and the Windows OCR engine live in Python; the invariant engine, the Wilson
 * reporting gate, deduplication, calibration and reporting live here and are reused
 * unchanged. Neither side is rewritten in the other's language.
 *
 * Two design points carry most of the weight:
 *
 * 1. **Only sigs cross the boundary.** The sidecar detected the grid and owns the
 *    cell-to-pixel mapping, so it keeps the coordinates. This side sees
 *    `"swap:1_2__2_2"` and never a pixel, which is also why an action identity stays
 *    stable while the window moves.
 *
 * 2. **A sig is carried as a `tap` targetId.** That looks like a shortcut and is
 *    deliberate: the existing agent already keys dedup, bans, visit counts and
 *    choice options off `tap:<targetId>`, so macros slot into all of it with no
 *    change to `Action`, `actionSig` or `shortlistOptions`.
 */

export interface SidecarOptions {
  /** Window title or process substring to attach to. */
  match: string;
  /** Genre profile: "match3" adds board reading and swap enumeration. */
  profile?: "generic" | "match3";
  python?: string;
  script?: string;
  /** Skip OCR on some observations to save time. */
  ocrEvery?: number;
  /**
   * Refuse to run unless the attached window's title contains this text.
   *
   * A test that silently attaches to the wrong window reports a clean result for a
   * build it never touched. Cheap to assert, and it caught a real false PASS.
   */
  expectTitle?: string;
  onLog?: (line: string) => void;
}

interface SidecarAction {
  sig: string;
  label: string;
  origin: string;
  confidence: number | null;
}

interface SidecarState {
  step: number;
  text?: string[];
  board?: { cols: number; rows: number; confidence: number; cellsChanged?: number };
  legalMoves?: number;
  bestClears?: number;
  frame: { uniformity: number; information: number };
  screenId?: string;
  screenNovel?: boolean;
  screenClusters?: number;
  lastActionOrigin?: string;
  lastActionAffordance?: number | null;
  hud?: Record<string, { value: number; confidence: number }>;
  hudDeltas?: Record<string, number>;
  unreadable?: Array<{ field: string; reason: string; detail?: string }>;
  perceptionMs: number;
}

export class SidecarAdapter implements GameAdapter {
  readonly name = "sidecar";
  /**
   * A live game cannot be snapshotted, and saying so is what stops the session
   * from performing a rewind that silently does nothing.
   */
  readonly canSnapshot = false;

  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending: Array<(v: any) => void> = [];
  private opts: SidecarOptions;
  private lastState: SidecarState | null = null;
  private lastActions: SidecarAction[] = [];
  private lastChange: { producedChange: boolean; cells?: number; tileBits: number } | null = null;
  private errors: string[] = [];
  private observations = 0;
  private attached = false;
  private attachedTitle = "";
  /**
   * Set once the sidecar reports the target is no longer safe to touch -- minimised,
   * closed, hidden, or no longer the focused window. Sticky on purpose: a run whose
   * first half tested the game and whose second half tested whatever stole focus is
   * not a run, and silently recovering focus would also mean grabbing it back from
   * the person using the machine.
   */
  private lost: string | null = null;
  private lostDetail = "";

  constructor(opts: SidecarOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const python = this.opts.python ?? "python";
    const script = this.opts.script ?? "bot/sidecar.py";
    this.proc = spawn(python, [script], { stdio: ["pipe", "pipe", "pipe"] });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const resolve = this.pending.shift();
      if (!resolve) return;
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, error: "unparseable sidecar reply: " + line.slice(0, 120) });
      }
    });
    this.proc.stderr.on("data", (b) => this.opts.onLog?.(String(b).trim()));

    const res = await this.call({
      cmd: "attach",
      match: this.opts.match,
      profile: this.opts.profile ?? "generic",
    });
    if (!res.ok) {
      throw new Error(
        "could not attach to " + JSON.stringify(this.opts.match) + ": " + res.error +
          (res.candidates ? "\n  visible windows: " + res.candidates.join(", ") : ""),
      );
    }
    const title = String(res.window.title ?? "");
    if (this.opts.expectTitle && !title.includes(this.opts.expectTitle)) {
      throw new Error(
        "attached to the wrong window: expected a title containing " +
          JSON.stringify(this.opts.expectTitle) + ", got " + JSON.stringify(title),
      );
    }
    this.attached = true;
    this.attachedTitle = title;
    this.opts.onLog?.("attached to " + title + " " + res.window.width + "x" + res.window.height);
  }

  /** The reason the target was lost, or null while it is still safe to act. */
  targetLost(): string | null {
    return this.lost;
  }

  get targetLostDetail(): string {
    return this.lostDetail;
  }

  /** Record a sidecar reply that reports the target is gone. */
  private noteLoss(res: { targetLost?: string; error?: string }): boolean {
    if (!res.targetLost) return false;
    if (!this.lost) {
      this.lost = res.targetLost;
      this.lostDetail = String(res.error ?? res.targetLost);
      this.opts.onLog?.("TARGET LOST (" + this.lost + "): " + this.lostDetail);
    }
    return true;
  }

  private call(req: Record<string, unknown>): Promise<any> {
    return new Promise((resolve) => {
      if (!this.proc) return resolve({ ok: false, error: "sidecar not started" });
      this.pending.push(resolve);
      this.proc.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  /** Pull a fresh observation. Must be awaited before `observe()` is read. */
  async refresh(): Promise<void> {
    this.observations += 1;
    const useOcr = this.opts.ocrEvery ? this.observations % this.opts.ocrEvery === 1 : true;
    const res = await this.call({ cmd: "observe", ocr: useOcr });
    if (!res.ok) {
      if (this.noteLoss(res)) {
        this.errors.push("TARGET_LOST: " + this.lostDetail);
        return;
      }
      this.errors.push("OBSERVE_FAILED: " + res.error);
      return;
    }
    this.lastState = res.state as SidecarState;
    this.lastActions = res.actions as SidecarAction[];
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    await this.call({ cmd: "quit" });
    this.proc.kill();
    this.proc = null;
  }

  async screenshot(path: string): Promise<boolean> {
    const r = await this.call({ cmd: "screenshot", path });
    return Boolean(r.ok);
  }

  // ------------------------------------------------------------ GameAdapter

  /**
   * Note what is deliberately NOT reset: `lost`.
   *
   * A reset re-seeds the run, it does not un-minimise the window. Clearing the loss
   * here would quietly re-enable input into whatever currently has focus, which is
   * the exact failure the guard exists to prevent.
   */
  reset(_seed: number): void {
    // A commercial game cannot be reset to a seed. Saying nothing here is correct;
    // `canSnapshot=false` plus the absence of seeding is what makes the report
    // downgrade its reproduction claim rather than promise a replay that cannot work.
    this.errors = [];
  }

  observe(): GameState {
    const s = this.lastState;
    const errors = this.errors;
    this.errors = [];

    if (!s) {
      return {
        step: 0, screen: "unattached", elements: [], vars: {},
        loading: true, errors, perf: { fps: 0, heapMB: 0 },
      };
    }

    /**
     * Screen identity comes from the perceptual cluster library, not from the set of
     * available actions.
     *
     * The action-set version was wrong in a way that only showed up live. Control
     * names come from OCR, so a single misread caption mints a brand new screen: a
     * 45-step run reported 20 distinct screens with 120-character ids assembled from
     * whatever text happened to be legible, including the browser's own toolbar.
     * Dedup, visit counts, ban lists and the stagnation detector are all keyed on
     * screen identity, so all four were quietly degraded and one defect was reported
     * twice because its two sightings disagreed about where they were.
     *
     * The cluster library was built and benchmarked for exactly this and then never
     * connected. It matches on stable image tiles, so an animating board does not
     * fragment the identity.
     */
    const sigs = this.lastActions.map((a) => a.sig).sort();
    const screen = s.screenId
      ? s.screenId + (s.board ? "+board" : "")
      : this.screenIdFrom(sigs, s);

    const elements: UiElement[] = this.lastActions.map((a, i) => ({
      id: a.sig,
      kind: "button",
      text: a.label,
      visible: true,
      enabled: true,
      // No real geometry crosses the boundary, so none is claimed. The overlap
      // oracle's all-identical guard then correctly declines to run.
      bbox: { x: 0, y: i, w: 0, h: 0 },
    }));

    const vars: Record<string, number | string | boolean> = {};
    if (s.legalMoves !== undefined) vars["legalMoves"] = s.legalMoves;
    if (s.bestClears !== undefined) vars["bestClears"] = s.bestClears;
    if (s.board) {
      vars["boardCols"] = s.board.cols;
      vars["boardRows"] = s.board.rows;
      if (s.board.cellsChanged !== undefined) vars["cellsChanged"] = s.board.cellsChanged;
    }
    // HUD numbers become ordinary typed variables, and their confidence gates them:
    // a misread score is worse than no score, because a phantom change looks exactly
    // like an economy bug.
    if (s.hud) {
      for (const [k, v] of Object.entries(s.hud)) {
        if (v.confidence >= 0.6) vars["hud_" + k] = v.value;
      }
    }
    if (s.hudDeltas) {
      for (const [k, d] of Object.entries(s.hudDeltas)) vars["d_" + k] = d;
    }
    if (s.lastActionOrigin) vars["lastActionOrigin"] = s.lastActionOrigin;
    if (typeof s.lastActionAffordance === "number") {
      vars["lastActionAffordance"] = s.lastActionAffordance;
    }
    if (this.lastChange) {
      vars["producedChange"] = this.lastChange.producedChange;
      if (this.lastChange.cells !== undefined) vars["movedCells"] = this.lastChange.cells;
    }

    return {
      step: s.step,
      screen,
      elements,
      vars,
      // OCR text, when a pass actually ran. Left undefined on a skipped pass so an
      // un-OCR'd frame is not mistaken for a screen with nothing written on it.
      ...(s.text ? { text: s.text } : {}),
      loading: s.frame.information < 0.05,
      errors,
      perf: { fps: 60, heapMB: 0 },
    };
  }

  private screenIdFrom(sigs: string[], s: SidecarState): string {
    // Swap sigs change every move, so they are summarised rather than enumerated --
    // otherwise every board state would be a brand new "screen" and the cluster
    // count would grow without bound.
    const nonSwap = sigs.filter((x) => !x.startsWith("swap:"));
    const hasBoard = Boolean(s.board);
    return (hasBoard ? "board+" : "nobooard+") + nonSwap.join(",").slice(0, 120);
  }

  /**
   * Perform an action. Async because a live target must send real input and then
   * wait for the screen to stop animating before the next observation is valid --
   * reading mid-cascade yields a state that is already stale when acted on.
   */
  async act(action: Action): Promise<void> {
    if (action.type !== "tap") {
      this.lastChange = null;
      return;
    }
    if (this.lost) {
      // Belt and braces: the session should already have stopped, but never send
      // input after a loss under any circumstances.
      this.lastChange = null;
      return;
    }
    const res = await this.call({ cmd: "act", sig: action.targetId });
    if (!res.ok) {
      if (this.noteLoss(res)) {
        this.errors.push("TARGET_LOST: " + this.lostDetail);
        this.lastChange = null;
        return;
      }
      this.errors.push("ACT_FAILED: " + res.error);
      this.lastChange = null;
      return;
    }
    this.lastChange = {
      producedChange: Boolean(res.producedChange),
      cells: res.changed?.cells,
      tileBits: res.changed?.tileBits ?? 0,
    };
    await this.refresh();
  }

  availableActions(): Action[] {
    return this.lastActions.map((a) => ({ type: "tap", targetId: a.sig }) as Action);
  }

  /** Human-readable captions, for the model's choice criteria. */
  labels(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of this.lastActions) out[a.sig] = a.label;
    return out;
  }

  snapshot(): unknown {
    return null;
  }

  restore(_snap: unknown): void {
    // Intentionally a no-op; `canSnapshot=false` keeps the session from relying on it.
  }

  get isAttached(): boolean {
    return this.attached;
  }

  /** The window actually attached to -- recorded in the report as provenance. */
  get target(): string {
    return this.attachedTitle;
  }
}
