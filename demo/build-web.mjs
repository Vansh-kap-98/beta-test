import { readdir, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

/**
 * Bundles the agent for the browser.
 *
 * The only obstacle is import specifiers: the repo uses `.ts` extensions so Node
 * can run the sources directly with no build step, and a browser cannot resolve
 * those. So the sources are copied with specifiers rewritten to `.js`, then `tsc`
 * emits plain ESM. No bundler, no dependency beyond the TypeScript already present.
 *
 * The result is the real agent - same oracles, same policy, same gates - running
 * inside the page rather than a reimplementation of it.
 */

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(ROOT, "src");
const STAGE = join(ROOT, "demo", ".stage");
const OUT = join(ROOT, "demo", "web", "lib");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

await rm(STAGE, { recursive: true, force: true });
await rm(OUT, { recursive: true, force: true });

const files = await walk(SRC);
for (const file of files) {
  // The CLI entry points read process.argv and would break in a page.
  if (relative(SRC, file).startsWith("cli")) continue;
  const rel = relative(SRC, file);
  const dest = join(STAGE, rel);
  await mkdir(dirname(dest), { recursive: true });
  const code = (await readFile(file, "utf8")).replace(
    /(from\s+["'])(\.[^"']*?)\.ts(["'])/g,
    "$1$2.js$3",
  );
  await writeFile(dest, code);
}

// A generated tsconfig rather than a long argv: the file list is big enough to
// hit command-line limits, and invoking tsc through node avoids the Windows
// npx.cmd spawn problem entirely.
await writeFile(
  join(STAGE, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2022",
        module: "es2022",
        moduleResolution: "bundler",
        skipLibCheck: true,
        outDir: OUT,
        rootDir: STAGE,
      },
      include: ["**/*.ts"],
    },
    null,
    2,
  ),
);

const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
execFileSync(process.execPath, [tsc, "-p", join(STAGE, "tsconfig.json")], {
  stdio: "inherit",
  cwd: ROOT,
});

await rm(STAGE, { recursive: true, force: true });
console.log("built browser agent -> demo/web/lib/");
