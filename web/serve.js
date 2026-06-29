// Tiny zero-dependency static server for the MyRadio web client.
// Unlike `python -m http.server`, this sends `Cache-Control: no-store` so the browser
// never serves a stale app.js/spotify.js — critical while iterating on the OAuth flow.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (path === "/") path = "/index.html";
    // Strip cache-busting query and prevent path traversal.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    const file = join(ROOT, safe);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const body = await readFile(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] || "application/octet-stream",
      "cache-control": "no-store, must-revalidate",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`MyRadio web on http://127.0.0.1:${PORT} (no-cache)`));
