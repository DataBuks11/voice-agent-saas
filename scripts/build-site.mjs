/**
 * Assemble the deployable site:
 *   @voice-agent/landing  React + Vite + Tailwind landing page (outputs to site-dist/ at root /)
 *   @voice-agent/web      React dashboard (outputs to site-dist/app/ at /app/)
 * Output: site-dist/  (Vercel outputDirectory)
 */
import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const out = path.join(root, "site-dist");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

await rm(out, { recursive: true, force: true });

// 1. Build the single-page dental clinic landing page
console.log("[build-site] building landing page...");
const landingRes = spawnSync(pnpm, ["--filter", "@voice-agent/landing", "build"], {
  cwd: root,
  env: {
    ...process.env,
    VITE_OUT_DIR: out,
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (landingRes.status !== 0) {
  console.error("[build-site] landing build failed");
  process.exit(landingRes.status ?? 1);
}
console.log("[build-site] landing page built ->", out);

// 2. Build the React dashboard & voice console
console.log("[build-site] building web dashboard...");
const webRes = spawnSync(pnpm, ["--filter", "@voice-agent/web", "build"], {
  cwd: root,
  env: {
    ...process.env,
    VITE_BASE: "/app/",
    VITE_OUT_DIR: path.join(out, "app"),
  },
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (webRes.status !== 0) {
  console.error("[build-site] dashboard build failed");
  process.exit(webRes.status ?? 1);
}
console.log("[build-site] dashboard built ->", path.join(out, "app"));
console.log("[build-site] site assembly complete!");
