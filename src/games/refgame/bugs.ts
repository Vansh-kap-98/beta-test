/**
 * Planted bugs for the reference game.
 *
 * Every detector in this repo is validated against these. A detector that cannot
 * find its planted bug is broken; a detector that fires when all flags are false is
 * producing false positives. Both are caught by the test suite.
 */
export interface BugFlags {
  /** Buying in the shop does not deduct gold. -> flow / invariant violation */
  shopFree: boolean;
  /** Entering settings from the dungeon clears the nav stack. -> softlock */
  settingsSoftlock: boolean;
  /** Using a potion at full HP throws (overheal edge case). -> crash */
  potionCrashAtFullHp: boolean;
  /** One shop item's caption is wider than its box. -> ui */
  textOverflow: boolean;
  /** Floor 3 never finishes loading. -> softlock (stuck loading) */
  infiniteLoad: boolean;
  /** Floor 7 enemies have 10x hp. -> balance */
  difficultySpike: boolean;
  /** Heap grows superlinearly with steps. -> perf */
  memLeak: boolean;
}

export const NO_BUGS: BugFlags = {
  shopFree: false,
  settingsSoftlock: false,
  potionCrashAtFullHp: false,
  textOverflow: false,
  infiniteLoad: false,
  difficultySpike: false,
  memLeak: false,
};

export const ALL_BUGS: BugFlags = {
  shopFree: true,
  settingsSoftlock: true,
  potionCrashAtFullHp: true,
  textOverflow: true,
  infiniteLoad: true,
  difficultySpike: true,
  memLeak: true,
};

export function only(...names: Array<keyof BugFlags>): BugFlags {
  const f: BugFlags = { ...NO_BUGS };
  for (const n of names) f[n] = true;
  return f;
}
