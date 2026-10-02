import type { Action, Finding, GameAdapter, GameState } from "../types.ts";
import type { Oracle } from "../oracles/oracle.ts";
import type { DedupedFinding } from "../oracles/runner.ts";
import { OracleRunner } from "../oracles/runner.ts";
import { TIER0_ORACLES } from "../oracles/tier0.ts";
import { stateHash } from "../oracles/oracle.ts";

/**
 * A policy decides what to do next. The fuzzer, the System One model and a scripted
 * plan all implement this, which is what lets them be compared on identical runs and
 * mixed in the same session.
 */
export interface Policy {
  readonly name: string;
  next(state: GameState, actions: Action[]): Promise<Action> | Action;
  /** Optional hook so a policy can observe the outcome of its own choice. */
  onResult?(before: GameState, action: Action, after: GameState): void | Promise<void>;
  /** Told the seed at session start, so a policy can stamp its own findings. */
  onReset?(seed: number): void;
  /**
   * The very first observation, before any action has been taken.
   *
   * Without this the opening screen is never judged. The invariant suite runs from
   * `onResult`, which only ever sees post-action states, so the title screen and
   * the tutorial -- the two screens every player meets first and the richest source
   * of comprehension findings -- were evaluated zero times. On the fixture the
   * planted vague-tutorial bug was consequently unfindable: the bot dismissed the
   * tutorial with its first action and the suite's first look came afterwards.
   */
  onStart?(state: GameState): void | Promise<void>;
  /** Findings the policy itself produced since the last call. */
  drain?(): Finding[];
}

export interface SessionOptions {
  seed: number;
  steps: number;
  oracles?: Oracle[];
  /** Stop as soon as a critical defect is found. Useful for bisecting, off by default. */
  stopOnCritical?: boolean;
  /** Retain every observed state. Off by default - a long run would hold a lot. */
  keepStates?: boolean;
  /**
   * After a blocking defect, rewind to an earlier snapshot and keep exploring
   * instead of ending the run trapped. On by default.
   */
  recover?: boolean;
  /** Take a restore point every N steps. */
  snapshotEvery?: number;
  /** Rewind at least this far back, so recovery lands before the trap was entered. */
  rewindSteps?: number;
  /** Give up recovering after this many rewinds. */
  maxRecoveries?: number;
  /**
   * Checked each step; a non-null return ends the run early with that reason.
   *
   * Exists for the live adapter, whose target can stop being safe to touch midway
   * through a run -- the window minimised, closed, or pushed behind something else.
   * Continuing then is worse than stopping twice over: synthetic input goes to
   * whichever window has focus, so the clicks land in the user's own applications,
   * and captures of a hidden window return stale pixels so the agent reports
   * confident softlocks for screens it never actually saw.
   *
   * Returning a reason rather than throwing is deliberate: the findings gathered
   * before the target was lost are real and are kept, and the report says plainly
   * where the run stopped and why.
   */
  shouldStop?: () => string | null;
}

export interface SessionResult {
  /**
   * Why the run ended before using its step budget, if it did. A report that covers
   * fewer screens than intended must say so, or it reads as a clean bill of health
   * for content that was never reached.
   */
  stoppedEarly?: string;
  seed: number;
  policy: string;
  steps: number;
  actionLog: Action[];
  findings: Finding[];
  results: DedupedFinding[];
  states?: GameState[];
  /** Distinct state hashes visited - a cheap coverage proxy. */
  coverage: number;
  screensVisited: string[];
  /** How many times the run had to rewind out of a blocking defect. */
  recoveries: number;
}

function actionSig(a: Action | null): string {
  if (!a) return "none";
  switch (a.type) {
    case "tap":
      return "tap:" + a.targetId;
    case "input":
      return "input:" + a.targetId;
    default:
      return a.type;
  }
}

const BLOCKING = new Set(["softlock"]);

export async function runSession(
  adapter: GameAdapter,
  policy: Policy,
  opts: SessionOptions,
): Promise<SessionResult> {
  const oracles = opts.oracles ?? TIER0_ORACLES;
  const runner = new OracleRunner(oracles, opts.seed);
  // Recovery requires working snapshots. An adapter that cannot provide them gets
  // no rewind rather than a fake one.
  const recover = (opts.recover ?? true) && adapter.canSnapshot !== false;
  const snapshotEvery = opts.snapshotEvery ?? 25;
  const rewindSteps = opts.rewindSteps ?? 40;
  const maxRecoveries = opts.maxRecoveries ?? 30;

  const actionLog: Action[] = [];
  const states: GameState[] = [];
  const screens = new Set<string>();
  const hashes = new Set<string>();

  /**
   * Transitions that lead into a known trap, keyed by SCREEN and action.
   *
   * Recovery without this is useless: rewinding to a point before the softlock and
   * then letting the policy make the same choice again just walks straight back in,
   * and the run spends its budget oscillating.
   *
   * The key is deliberately the screen, not the full state hash. A state hash
   * includes every game variable, so banning one exact (state, action) edge bans
   * nothing in practice - the bot returns with one more gold and walks through a
   * numerically different door into the same trap. "Never open settings from the
   * dungeon" is the rule that actually holds. It is coarse enough to occasionally
   * forgo a legitimate path, which is the right trade against losing the rest of
   * the run.
   */
  const blacklist = new Set<string>();
  /**
   * Screen-level bans, which EXPIRE with exponential backoff.
   *
   * A permanent screen-level ban is too blunt. On the reference game, descending
   * to floor 3 hits an infinite-load trap, so "never press Descend in the dungeon"
   * got banned forever - and Descend is the game's entire progression path. The
   * run then wandered the menus for 1,500 steps asking unanswerable questions,
   * which is how absorption fell to 13%.
   *
   * So: the exact (state, action) edge is banned permanently, because that edge is
   * genuinely known-bad. The generalised (screen, action) ban is temporary and
   * backs off exponentially on repeat, which keeps the bot out of a tight loop
   * without permanently amputating a core mechanic.
   */
  const screenBans = new Map<string, { until: number; strikes: number }>();
  /** States known to be traps, so re-entry triggers recovery without a new finding. */
  const trapHashes = new Set<string>();
  let stepNo = 0;
  const history: Array<{ hash: string; screen: string; action: Action | null }> = [];
  const checkpoints: Array<{ snap: unknown; historyLen: number; actionLen: number }> = [];
  let recoveries = 0;

  adapter.reset(opts.seed);
  policy.onReset?.(opts.seed);
  let cur = adapter.observe();
  runner.step(cur, null, actionLog);
  screens.add(cur.screen);
  history.push({ hash: stateHash(cur), screen: cur.screen, action: null });
  await policy.onStart?.(cur);

  let stoppedEarly: string | null = null;

  for (let i = 0; i < opts.steps; i++) {
    const stop = opts.shouldStop?.() ?? null;
    if (stop) {
      stoppedEarly = stop;
      break;
    }
    // Never take a restore point inside a known trap, or while something is in
    // flight. Otherwise the checkpoint ring fills with trapped states and every
    // later rewind lands straight back in the trap - which is why recovery fired
    // once and then sat in a payment spinner for 1,400 steps.
    const snapshotSafe = !trapHashes.has(stateHash(cur)) && !cur.loading;
    if (recover && snapshotSafe && i % snapshotEvery === 0) {
      checkpoints.push({
        snap: adapter.snapshot(),
        historyLen: history.length,
        actionLen: actionLog.length,
      });
      if (checkpoints.length > 32) checkpoints.shift();
    }

    stepNo = i;
    const curHash = stateHash(cur);
    const banned = (a: Action): boolean => {
      if (blacklist.has(curHash + "|" + actionSig(a))) return true;
      const sb = screenBans.get(cur.screen + "|" + actionSig(a));
      return sb !== undefined && i < sb.until;
    };
    const legal = adapter.availableActions().filter((a) => !banned(a));
    // If everything here is blacklisted, the state itself is a dead end; fall back
    // to the unfiltered set rather than stalling, and let recovery handle it.
    const choices = legal.length > 0 ? legal : adapter.availableActions();
    if (choices.length === 0) break;

    const action = await policy.next(cur, choices);
    const before = cur;
    await adapter.act(action);
    actionLog.push(action);
    cur = adapter.observe();
    if (opts.keepStates) states.push(cur);
    screens.add(cur.screen);
    hashes.add(cur.screen + JSON.stringify(cur.vars));
    history.push({ hash: stateHash(cur), screen: cur.screen, action });

    const fresh = runner.step(cur, action, actionLog);
    await policy.onResult?.(before, action, cur);
    const fromPolicy = policy.drain ? runner.submit(policy.drain()) : [];
    const all = [...fresh, ...fromPolicy];

    if (opts.stopOnCritical && all.some((f) => f.severity === "critical")) break;

    const blocking = all.find((f) => f.severity === "critical" && BLOCKING.has(f.bugClass));
    if (blocking) trapHashes.add(stateHash(cur));

    // Recover on the *condition*, not on a fresh finding. Findings are deduplicated,
    // so a second visit to a known trap reports nothing new - relying on the finding
    // would recover once and then sit in the trap for the rest of the run.
    const inTrap = blocking !== undefined || trapHashes.has(stateHash(cur));
    if (recover && inTrap && recoveries < maxRecoveries) {
      if (rewind()) {
        recoveries += 1;
        cur = adapter.observe();
        continue;
      }
    }
  }

  /**
   * Rewinds to a checkpoint from before the trap and bans the edge that entered it.
   * Returns false when no usable checkpoint remains.
   */
  function rewind(): boolean {
    const trapHash = stateHash(cur);
    // Find where this state was first entered, and ban that transition.
    let entryIdx = -1;
    for (let j = history.length - 1; j > 0; j--) {
      if (history[j]!.hash === trapHash && history[j - 1]!.hash !== trapHash) {
        entryIdx = j;
        break;
      }
    }
    if (entryIdx > 0) {
      const prev = history[entryIdx - 1]!;
      const edgeAction = actionSig(history[entryIdx]!.action);
      // Permanent: this precise state led into the trap.
      blacklist.add(prev.hash + "|" + edgeAction);
      // Temporary and generalised, with backoff so a core mechanic is not lost.
      const key = prev.screen + "|" + edgeAction;
      const existing = screenBans.get(key);
      const strikes = (existing?.strikes ?? 0) + 1;
      const cooldown = Math.min(50 * Math.pow(2, strikes - 1), 400);
      screenBans.set(key, { until: stepNo + cooldown, strikes });
    }

    const target = entryIdx > 0 ? entryIdx : history.length - rewindSteps;
    let chosen: (typeof checkpoints)[number] | undefined;
    for (let k = checkpoints.length - 1; k >= 0; k--) {
      if (checkpoints[k]!.historyLen <= target) {
        chosen = checkpoints[k];
        checkpoints.length = k + 1;
        break;
      }
    }
    if (!chosen) return false;

    adapter.restore(chosen.snap);
    history.length = chosen.historyLen;
    actionLog.length = chosen.actionLen;
    return true;
  }

  const result: SessionResult = {
    seed: opts.seed,
    policy: policy.name,
    steps: actionLog.length,
    actionLog,
    findings: runner.findings(),
    results: runner.results(),
    coverage: hashes.size,
    screensVisited: [...screens].sort(),
    recoveries,
  };
  if (stoppedEarly) result.stoppedEarly = stoppedEarly;
  if (opts.keepStates) result.states = states;
  return result;
}

/**
 * Replays a recorded action log against a fresh adapter and checks the run is
 * reproducible. This is the guarantee that makes a finding actionable: a developer
 * gets a seed plus a list of taps and lands in the same broken state.
 */
export async function replaySession(
  adapter: GameAdapter,
  seed: number,
  actions: Action[],
  oracles: Oracle[] = TIER0_ORACLES,
): Promise<SessionResult> {
  const runner = new OracleRunner(oracles, seed);
  const log: Action[] = [];
  const screens = new Set<string>();
  const hashes = new Set<string>();

  adapter.reset(seed);
  let cur = adapter.observe();
  runner.step(cur, null, log);
  screens.add(cur.screen);

  for (const action of actions) {
    await adapter.act(action);
    log.push(action);
    cur = adapter.observe();
    screens.add(cur.screen);
    hashes.add(cur.screen + JSON.stringify(cur.vars));
    runner.step(cur, action, log);
  }

  return {
    seed,
    policy: "replay",
    steps: log.length,
    actionLog: log,
    findings: runner.findings(),
    results: runner.results(),
    coverage: hashes.size,
    screensVisited: [...screens].sort(),
    recoveries: 0,
  };
}
