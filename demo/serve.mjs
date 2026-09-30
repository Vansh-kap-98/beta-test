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

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
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
