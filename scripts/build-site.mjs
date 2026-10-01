/**
 * Assemble the deployable site:
 *   site/           static landing (html/css/js/assets)
 *   site-dist/app/  React dashboard (built with base /app/)
 * Output: site-dist/  (Vercel outputDirectory)
 */
import { cp, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const out = path.join(root, "site-dist");

await rm(out, { recursive: true, force: true });
await cp(path.join(root, "site"), out, { recursive: true });
console.log("[build-site] landing copied ->", out);

const env = {
  ...process.env,
  VITE_BASE: "/app/",
  VITE_OUT_DIR: path.join(out, "app"),
};

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const res = spawnSync(pnpm, ["--filter", "@voice-agent/web", "build"], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (res.status !== 0) {
  console.error("[build-site] dashboard build failed");
  process.exit(res.status ?? 1);
}
console.log("[build-site] dashboard built ->", path.join(out, "app"));
