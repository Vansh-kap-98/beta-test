import { writeFileSync } from "node:fs";
import { BENCH_CASES, BENCH_QUESTIONS, BENCH_QUESTIONS_DEFECT } from "../core/soc/bench/cases.ts";
import { renderProse } from "../core/soc/prose.ts";

/**
 * Emit the labelled bench in every rendering, so one Python pass can score them all
 * against the real model. Keeping the renderer in TypeScript and the scoring in
 * Python avoids a second implementation of either.
 */
const out = {
  questions: BENCH_QUESTIONS,
  questionsDefect: BENCH_QUESTIONS_DEFECT,
  cases: BENCH_CASES.map((c) => ({
    name: c.name,
    truth: c.truth,
    renderings: {
      json: JSON.stringify(c.state),
      prose: renderProse(c.state),
    },
  })),
};
const path = process.argv[2] ?? "artifacts/prosebench.json";
writeFileSync(path, JSON.stringify(out, null, 1));
console.log("wrote " + path + ": " + out.cases.length + " cases, " +
  Object.keys(BENCH_QUESTIONS).length + " questions");
console.log("\n--- sample prose ---\n" + renderProse(BENCH_CASES[0]!.state));
