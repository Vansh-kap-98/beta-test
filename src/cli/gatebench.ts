import { writeFileSync, mkdirSync } from "node:fs";
import { Match3SimAdapter } from "../games/match3sim/adapter.ts";
import { match3BestControl } from "../adapters/sidecar/match3Invariants.ts";
import { serialize, actionOptionId } from "../core/soc/serialize.ts";
import { renderProse } from "../core/soc/prose.ts";
import { HttpSystemOne } from "../core/soc/backends/http.ts";
import { shortlistOptions } from "../core/soc/router.ts";

/**
 * Measure where the real model's CHOICE confidence actually falls, and how accurate
 * it is there, so the escalation gate can be set from data instead of taste.
 *
 * Needed because the first real-model run absorbed 0% of decisions: every single
 * choice escalated to Tier 2, which destroys the cost argument the whole design
 * rests on. The cause was a threshold, not the model. The gate was 0.75, chosen
 * against a well-calibrated mock, while Laya's chosen-option probability sits just
 * below it -- the very first probe returned `probabilities[choice] = 0.7335`.
 *
 * A gate is only honest if it is derived from a measured accuracy-versus-confidence
 * curve, which is exactly what the calibration harness was built to consume and what
 * a commercial target can never supply. The fixture can, so it does.
 *
 *   npm run gatebench -- --n 240
 */
async function main(): Promise<number> {
  const n = Number(process.argv.find((a) => a.startsWith("--n="))?.slice(4) ?? 200);
  const url = process.argv.find((a) => a.startsWith("--url="))?.slice(6) ?? "http://127.0.0.1:8231";

  const ok = await fetch(url + "/health", { signal: AbortSignal.timeout(2000) })
    .then((r) => r.ok).catch(() => false);
  if (!ok) {
    console.error("no Laya server at " + url);
    return 2;
  }
  const client = new HttpSystemOne({ baseUrl: url, name: "laya", timeoutMs: 20000 });

  // Three candidate confidence measures, because the raw one turned out not to be
  // comparable across option counts.
  const samples: Array<{
    p: number; twoWay: number; lift: number; correct: boolean; options: number;
  }> = [];
  let step = 0;

  for (let seed = 1; samples.length < n && seed <= 12; seed++) {
    const adapter = new Match3SimAdapter({ seed, invalidShare: 0.25 });
    let prev: ReturnType<Match3SimAdapter["observe"]> | undefined;
    let cur = adapter.observe();

    for (let i = 0; i < 80 && samples.length < n; i++) {
      const actions = adapter.availableActions();
      if (actions.length === 0) break;
      const soc = serialize(cur, prev, null, []);
      const allIds = actions.map((a) => actionOptionId(a));
      const labels = adapter.labels();
      void step;

      // Shortlisted exactly as the live policy does, so the measurement is of the
      // decision the system actually makes rather than of an easier one.
      const shortlist = shortlistOptions(
        allIds.map((id) => ({
          id,
          label: labels[id.replace(/^tap /, "")] ?? id,
          // Exits stay on the list. The repo already measured that dropping them
          // collapses absorption from 81% to 28%.
          pinned: /pause|resume|got_it|next_level|retry/.test(id),
        })),
        12,
      ).map((c) => c.id);
      if (shortlist.length < 2) {
        await adapter.act(actions[0]!);
        prev = cur; cur = adapter.observe(); continue;
      }

      const descriptions: Record<string, string> = {};
      for (const o of shortlist) {
        const bare = o.replace(/^tap /, "");
        descriptions[o] = labels[bare] ?? bare;
      }

      const [answer] = await client.ask(renderProse(soc, { labels }), [{
        id: "pick", kind: "choice",
        prompt: "Which control should the player use next to make progress in this game?",
        options: shortlist, descriptions,
      }]);

      const best = match3BestControl(soc, shortlist);
      if (answer && answer.kind === "choice" && best) {
        const dist = answer.dist ?? {};
        const sorted = Object.values(dist).sort((a, b) => b - a);
        const top = sorted[0] ?? answer.p;
        const second = sorted[1] ?? 0;
        samples.push({
          p: answer.p,
          // Confidence restricted to the top two candidates: "am I sure it is this
          // one rather than the runner-up". Independent of how many options there
          // are, which is the property the raw probability lacks.
          twoWay: top + second > 0 ? top / (top + second) : 0.5,
          lift: top * shortlist.length,   // how much better than picking at random
          correct: answer.value === best,
          options: shortlist.length,
        });
      }

      const chosenId = answer && answer.kind === "choice" ? answer.value : shortlist[0]!;
      const act = actions.find((a) => actionOptionId(a) === chosenId) ?? actions[0]!;
      await adapter.act(act);
      prev = cur;
      cur = adapter.observe();
      step += 1;
    }
  }

  // --- the accuracy-vs-confidence curve ------------------------------------
  samples.sort((a, b) => a.p - b.p);
  console.log("n=" + samples.length + " choice decisions on " +
    (samples.reduce((t, s) => t + s.options, 0) / samples.length).toFixed(1) + " options avg\n");
  console.log("confidence band      n     accuracy   (what a gate here would absorb)");
  const bands = [[0, 0.3], [0.3, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
  for (const [lo, hi] of bands) {
    const inBand = samples.filter((s) => s.p >= lo! && s.p < hi!);
    if (inBand.length === 0) continue;
    const acc = inBand.filter((s) => s.correct).length / inBand.length;
    console.log("  " + lo!.toFixed(2) + "-" + hi!.toFixed(2) + "        " +
      String(inBand.length).padStart(4) + "     " + acc.toFixed(3));
  }

  const report = (name: string, key: "p" | "twoWay" | "lift", gates: number[]) => {
    console.log("");
    console.log("=== " + name + " ===");
    console.log("gate    absorbed   accuracy of absorbed");
    let best = { gate: gates[0]!, absorbed: 0, acc: 0 };
    for (const gate of gates) {
      const above = samples.filter((s) => s[key] >= gate);
      if (above.length < 5) continue;
      const acc = above.filter((s) => s.correct).length / above.length;
      const share = above.length / samples.length;
      console.log("  " + gate.toFixed(2) + "    " + (share * 100).toFixed(1).padStart(5) +
        "%    " + acc.toFixed(3));
      // The lowest gate whose absorbed decisions stay accurate enough to act on
      // without review. Below 0.80, absorbing means acting on a wrong move more
      // than one time in five.
      if (acc >= 0.8 && share > best.absorbed) best = { gate, absorbed: share, acc };
    }
    console.log("  -> best: gate " + best.gate.toFixed(2) + " absorbs " +
      (best.absorbed * 100).toFixed(1) + "% at accuracy " + best.acc.toFixed(3));
    return best;
  };

  report("raw probabilities[choice] (depends on option count)", "p",
    [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75]);
  const best = report("two-way confidence: top/(top+second)", "twoWay",
    [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9]);
  report("lift over chance: top * n", "lift", [1, 1.5, 2, 2.5, 3, 4, 6]);

  mkdirSync("artifacts", { recursive: true });
  writeFileSync("artifacts/gatebench.json", JSON.stringify({ samples, best }, null, 1));
  return 0;
}

main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
