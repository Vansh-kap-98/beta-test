import type { TruthFn } from "../../core/soc/backends/mock.ts";
import type { SocState } from "../../core/soc/serialize.ts";
import { refgameInvariantTruth } from "./invariants.ts";

/**
 * Ground truth for every question kind, for the offline mock only.
 *
 * Production has no equivalent of this file - Jev or Laya answers these. It exists
 * so that accuracy, calibration and escalation can be *measured* rather than
 * asserted, which is the only way to know the rest of the system works.
 */

/** A competent player's next move. The standard the model's `choice` is scored against. */
export function bestControl(s: SocState, options: string[]): string | undefined {
  // Defensive about missing fields: this is consulted from inside the play loop,
  // and an oracle that throws on an unexpected state shape takes the whole run
  // down with it rather than degrading to a guess.
  const vars = s.vars ?? {};
  const controls = s.controls ?? [];
  // Options are action descriptions ("tap attack"), not raw control ids, since the
  // agent generalised beyond tap-only games. Match on the target either way so this
  // oracle keeps working regardless of how the option is spelled.
  const matching = (id: string) => options.find((o) => targetOf(o) === id || o === id);
  const has = (id: string) => matching(id) !== undefined;
  const hp = Number(vars["hp"] ?? 0);
  const maxHp = Number(vars["maxHp"] ?? 1);
  const potions = Number(vars["potions"] ?? 0);

  const wanted = ((): string | undefined => {
    if (s.screen === "title") return "start";
    if (s.screen === "gameover") return "restart";
    if (s.screen === "combat") {
      if (hp < maxHp * 0.3 && potions > 0) return "use_potion";
      return "attack";
    }
    if (s.screen === "dungeon") return "descend";
    if (s.screen === "menu") return "go_dungeon";
    if (s.screen === "settings") return "back";
    if (s.screen === "shop") {
      const gold = Number(vars["gold"] ?? 0);
      const affordable = controls
        .filter((c) => c.id.startsWith("buy_") && c.enabled)
        .map((c) => c.id)
        .filter((id) => has(id));
      if (gold > 40 && affordable.length > 0) return affordable[0];
      return "back";
    }
    return undefined;
  })();

  if (!wanted) return options[0];
  const direct = matching(wanted);
  if (direct) return direct;

  // The question may be a narrowing step, where options are group labels rather
  // than control ids. Resolve which group the wanted control falls into.
  const group = resolveGroup(wanted, options);
  if (group) return group;

  // The preferred move is not on offer - shortlisted away, or banned by recovery.
  // Fall back rather than returning undefined: a real decision model always ranks
  // whatever it is shown, it does not abstain. Returning undefined here made the
  // mock abstain on every constrained screen, which drove simulated escalation to
  // 87% and made the cost model far more pessimistic than reality.
  const nav = options.find((o) => /back|menu|close|cancel|exit|return|flee|restart/i.test(o));
  return nav ?? options[0];
}

/**
 * Maps a desired option onto the group label that contains it.
 *
 * Handles both grouping schemes the router uses: semantic prefixes ("buy") and
 * sorted positional ranges ("buy_apple..buy_honey"). The range form is only
 * decidable because the router sorts before chunking.
 */
/** Extracts the control id an action option refers to. */
export function targetOf(option: string): string {
  if (option.startsWith("tap ")) return option.slice(4);
  if (option.startsWith("input ")) return option.slice(6).split("=")[0] ?? option;
  return option;
}

export function resolveGroup(wanted: string, labels: string[]): string | undefined {
  for (const label of labels) {
    if (label === wanted) return label;
    const dots = label.indexOf("..");
    if (dots > 0) {
      const lo = label.slice(0, dots);
      const hi = label.slice(dots + 2);
      if (wanted >= lo && wanted <= hi) return label;
    } else {
      const us = wanted.indexOf("_");
      const prefix = us > 0 ? wanted.slice(0, us) : wanted;
      if (label === prefix) return label;
    }
  }
  return undefined;
}

/**
 * True difficulty of the encounter on a 1-5 rubric, derived from how many hits it
 * would take to win versus how many the player can survive. The floor-7 spike
 * pushes this to 5; normal floors sit at 1-3.
 */
export function encounterDifficulty(s: SocState): number | undefined {
  if (s.screen !== "combat") return undefined;
  const enemyHp = Number(s.vars["enemyHp"] ?? 0);
  const hp = Number(s.vars["hp"] ?? 1);
  const floor = Number(s.vars["floor"] ?? 1);
  if (enemyHp <= 0) return undefined;
  const avgPlayerDamage = 8.5;
  const avgEnemyDamage = 2.5 + Math.floor(floor / 2);
  const turnsToKill = enemyHp / avgPlayerDamage;
  const turnsToDie = hp / avgEnemyDamage;
  const ratio = turnsToKill / Math.max(turnsToDie, 0.001);
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.8) return 3;
  if (ratio < 1.1) return 4;
  return 5;
}

export function makeRefgameTruth(): TruthFn {
  return (state, q) => {
    const s = state as SocState;
    switch (q.kind) {
      case "noul":
        return refgameInvariantTruth(s, q.id);
      case "choice":
        return bestControl(s, q.options);
      case "score":
        return encounterDifficulty(s);
    }
  };
}
