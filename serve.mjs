// Minimal static server for the dashboard. No dependencies.
// Usage: node serve.mjs   (serves ./dashboard on http://localhost:8099)
// Also accepts POST /__saveog with a data URL body and writes ./dashboard/og.jpg
// (used once to generate the Open Graph image).
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, extname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "dashboard");
const PORT = Number(process.env.PORT) || 8099;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

createServer(async (req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/__saveog") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        const b64 = body.replace(/^data:image\/\w+;base64,/, "");
        await writeFile(join(ROOT, "og.jpg"), Buffer.from(b64, "base64"));
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok " + Buffer.from(b64, "base64").length);
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    return;
  }
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end("forbidden"); return; }
    const buf = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, () => console.log(`Dashboard on http://localhost:${PORT}`));
