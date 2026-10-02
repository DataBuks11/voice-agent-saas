/**
 * Local preview of site-dist with /app SPA fallback.
 * Usage: node scripts/build-site.mjs && node scripts/_serve_site.cjs   → http://localhost:5173
 * Port 5173 matches the API CORS allowlist (CORS_ORIGINS default).
 */
/** Local preview server for site-dist with /app SPA fallback (harness testing). */
const http = require("http");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..", "site-dist");
const port = Number(process.env.PORT || 5173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function send(res, file) {
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { "content-type": types[ext] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = path.join(root, p);
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) {
      if (p.startsWith("/app")) file = path.join(root, "app", "index.html");
      else file = path.join(root, "index.html");
    }
    if (!fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    send(res, file);
  })
  .listen(port, () => console.log(`site-dist on http://localhost:${port}`));
