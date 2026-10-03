/**
 * One command that checks the deployed product end to end.
 *
 *   pnpm verify
 *   pnpm verify --doc "C:\path\to\file.docx"
 *
 * Every step is a real HTTP/WebSocket call against production unless it is a
 * pure unit test. Exits non-zero on the first failure so CI can use it.
 */
import { spawn } from "node:child_process";

const docArg = process.argv.includes("--doc") ? process.argv[process.argv.indexOf("--doc") + 1] : null;
const VOICE_WS = process.env.VOICE_WS_URL ?? "wss://voice-runtime-production-dc24.up.railway.app";
const PIPER = process.env.PIPER_VOICE ?? `${process.env.LOCALAPPDATA ?? ""}\\piper\\en_US-lessac-medium.onnx`;

const steps = [
  { name: "unit: voice runtime", cmd: "python", args: ["-m", "pytest", "services/voice/tests", "-q"], env: { PYTHONPATH: "services/voice/src" } },
  { name: "unit: engines", cmd: "pnpm", args: ["-r", "test"] },
  { name: "types", cmd: "pnpm", args: ["-r", "typecheck"] },
  { name: "unit: capture flow", cmd: "tsx", args: ["scripts/_flow_replay.ts"] },
  { name: "unit: availability", cmd: "tsx", args: ["scripts/_availability_test.ts"] },
  { name: "unit: domain", cmd: "tsx", args: ["scripts/_domain_test.ts"] },
  { name: "unit: extractive answers", cmd: "tsx", args: ["scripts/_extractive_test.ts"] },
  { name: "api e2e", cmd: "node", args: ["scripts/_e2e.mjs"] },
  { name: "api features", cmd: "node", args: ["scripts/_features_e2e.mjs"] },
  { name: "capture e2e", cmd: "node", args: ["scripts/_capture_e2e.mjs"] },
  { name: "booking negotiation", cmd: "node", args: ["scripts/_negotiation_e2e.mjs"] },
  { name: "name homophones", cmd: "node", args: ["scripts/_homophone_e2e.mjs"] },
  { name: "streaming", cmd: "node", args: ["scripts/_stream_smoke.mjs"] },
  { name: "showcase (8 capabilities)", cmd: "node", args: ["scripts/showcase.mjs"] },
  { name: "latency", cmd: "node", args: ["scripts/_latency_probe.mjs"] },
  { name: "voice call (text + audio)", cmd: "python", args: ["scripts/_voice_e2e.py", "--timeout", "60"], env: { VOICE_WS_URL: VOICE_WS, PIPER_VOICE: PIPER } },
  { name: "voice barge-in", cmd: "python", args: ["scripts/_voice_bargein.py"], env: { VOICE_WS_URL: VOICE_WS, PIPER_VOICE: PIPER } },
  { name: "voice in the browser", cmd: "node", args: ["scripts/_voice_browser.mjs"] },
  { name: "web app", cmd: "node", args: ["scripts/_web_e2e.mjs"] },
];
// The path may contain spaces; hand it over as an env var so no shell quoting applies.
if (docArg) {
  steps.push({
    name: "document QA",
    cmd: "node",
    args: ["scripts/_doc_qa.mjs"],
    env: { DOC_QA_FILE: docArg },
  });
}

// tsx ships in the api workspace; call its CLI entry directly (the .bin shims
// are shell scripts and cannot be passed to node directly on Windows).
import { existsSync } from "node:fs";
const TSX = ["node_modules/tsx/dist/cli.mjs", "apps/api/node_modules/tsx/dist/cli.mjs"]
  .map((p) => p.replace(/\//g, process.platform === "win32" ? "\\" : "/"))
  .find((p) => existsSync(p));
if (!TSX) {
  console.error("could not find tsx; run pnpm install first");
  process.exit(1);
}

const run = (step) =>
  new Promise((resolve) => {
    const started = Date.now();
    const isTsx = step.cmd === "tsx";
    const quote = (a) => (process.platform === "win32" && /\s/.test(a) ? `"${a}"` : a);
    const child = spawn(
      isTsx ? process.execPath : step.cmd,
      isTsx ? [TSX, ...step.args] : step.args.map(quote),
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...(step.env ?? {}) },
        shell: !isTsx && process.platform === "win32",
      },
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
  });

const tail = (out, n = 3) =>
  out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n)
    .join(" | ")
    .slice(0, 200);

const main = async () => {
  const results = [];
  const heavy = new Set(["voice in the browser", "web app", "showcase (8 capabilities)"]);
  for (const step of steps) {
    // The deployed app is a real website: give it a moment between heavy browser
    // steps instead of racing Vercel's cold start.
    if (heavy.has(step.name)) await new Promise((r) => setTimeout(r, 5000));
    process.stdout.write(`\n=== ${step.name} ... `);
    const { code, out, ms } = await run(step);
    results.push({ step, code, ms });
    console.log(code === 0 ? `PASS (${(ms / 1000).toFixed(1)}s)` : `FAIL (${(ms / 1000).toFixed(1)}s)`);
    if (code !== 0) console.log(tail(out, 8));
  }
  console.log("\n================ VERIFY SUMMARY ================");
  for (const r of results) {
    console.log(`${r.code === 0 ? "PASS" : "FAIL"}  ${r.step.name.padEnd(28)} ${(r.ms / 1000).toFixed(1)}s`);
  }
  const failed = results.filter((r) => r.code !== 0);
  console.log(
    failed.length === 0
      ? `\nALL ${results.length} CHECKS PASSED`
      : `\n${failed.length} of ${results.length} CHECKS FAILED: ${failed.map((f) => f.step.name).join(", ")}`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
};

main();