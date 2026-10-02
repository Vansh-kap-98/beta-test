/*
 * Run the live agent against a sequence of fixture variants.
 *
 * Three things here are not incidental, each one the fix for a failure that produced
 * a confident but meaningless PASS:
 *
 *  1. ONE WINDOW AT A TIME. Four Chrome windows sharing a user-data-dir hit the
 *     singleton lock, so windows 2-4 never opened and their captures were flat grey --
 *     reported as 4/4 clean while measuring nothing.
 *  2. A FRESH PROFILE PER VARIANT, for the same reason.
 *  3. THE TITLE IS VERIFIED. Every variant of this fixture used to be called
 *     "Sugar Cascade", so a run could attach to the previous variant's window; a clean
 *     run and a planted-bug run returned byte-identical output and it looked like a
 *     detector failure rather than a harness fault.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!CHROME) { console.error("no Chromium browser found"); process.exit(2); }

const PORT = 8177;
const variants = (process.argv[2] ?? "clean").split(",");
const steps = process.argv[3] ?? "45";
const extraArgs = process.argv.slice(4);

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts });
}

for (const v of variants) {
  const bug = v === "clean" ? "" : v;
  const url = "http://127.0.0.1:" + PORT + "/match3.html" + (bug ? "?bug=" + bug : "");
  const profileDir = mkdtempSync(join(tmpdir(), "m3-" + v + "-"));

  console.log("\n=== " + v.toUpperCase() + " ===");
  /*
   * --app= opens a chromeless window: no address bar, no bookmarks, no tab strip.
   *
   * Not cosmetic. The capture region is the window's CLIENT area, which includes the
   * browser's own toolbar, so a live run OCR'd Chrome's UI and offered it to the
   * agent as game controls -- "Bookmarks and lists", "Create an account", the
   * signed-in account name. The bot was partly testing the browser, and every one of
   * those captions was a candidate action and a fresh screen identity.
   *
   * A real game owns its whole window, so this is a fixture-hosting concern only --
   * but it is exactly the kind of thing that makes a browser fixture unrepresentative
   * of the target.
   */
  const chrome = spawn(CHROME, [
    "--user-data-dir=" + profileDir,
    "--no-first-run", "--no-default-browser-check",
    "--app=" + url,
    "--window-size=900,900", "--window-position=40,40",
    "--disable-features=Translate,CalculateNativeWinOcclusion",
  ], { detached: false, stdio: "ignore" });

  // Give the page time to render; the agent's own blank-capture guard catches the rest.
  await new Promise((r) => setTimeout(r, 2500));

  // Invoked without a shell. With `shell: true` Windows re-splits the command line
  // and the quotes around "Sugar Cascade" are lost, so --match arrived as "Sugar"
  // and matched the right window only by luck -- on a machine with any other window
  // whose title starts that way it would have attached to the wrong one.
  run(process.execPath, [
    "--experimental-strip-types", "src/cli/live.ts",
    "--match", "Sugar Cascade",
    "--profile", "match3",
    "--steps", String(steps),
    // The guard: refuse to run if we did not get THIS variant's window.
    "--expect", "[" + v + "]",
    ...extraArgs,
  ]);

  chrome.kill();
  await new Promise((r) => setTimeout(r, 600));
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
