import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

/** Static server for the browser demo. No dependency, no config. */
const ROOT = fileURLToPath(new URL("./web/", import.meta.url));
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".css": "text/css",
};

/**
 * Ground truth, off the screen.
 *
 * The fixture used to publish its true state into the window title, which was easy to
 * read with GetWindowTextW and turned out to be a serious leak: in a chromeless
 * window Chrome draws its titlebar INSIDE the client area, so the capture included
 * it and OCR read the answer key. A vision pipeline that can see the ground truth it
 * is being measured against measures nothing -- and the 60-digit board string also
 * parsed as a HUD variable worth 1.13e+65.
 *
 * So the fixture POSTs its state here instead and a measurement process GETs it. The
 * channel is now structurally invisible to the screen, which is the property it
 * needed all along.
 */
let truth = null;

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0] ?? "/";

  if (url === "/truth" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try { truth = JSON.parse(body); } catch { /* ignore a malformed post */ }
    res.writeHead(204).end();
    return;
  }
  if (url === "/truth") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(truth));
    return;
  }

  const rel = url === "/" ? "game.html" : normalize(decodeURIComponent(url)).replace(/^[/\\]+/, "");
  try {
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { "Content-Type": TYPES[extname(rel)] ?? "text/plain" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found: " + rel);
  }
});

server.listen(8177, "127.0.0.1", () => {
  console.log("serving demo/web on http://127.0.0.1:8177");
});
