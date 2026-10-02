/**
 * Browser voice-call smoke test against local preview (Chrome fake mic).
 * 1. PIPER_VOICE=... python scripts\_mk_wav.py            (builds %TEMP%\voice_test.wav)
 * 2. node scripts\_serve_site.cjs                          (after build-site with VITE_API_URL=prod)
 * 3. FAKE_MIC=%TEMP%\voice_test.wav node scripts\_voice_call.mjs
 */
import puppeteer from "puppeteer-core";
const BASE = "http://localhost:5173";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WAV = process.env.FAKE_MIC;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox","--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",`--use-file-for-fake-audio-capture=${WAV}%noloop`,"--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1440, height: 900 },
});
const p = await b.newPage();
p.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
try {
  await p.goto(`${BASE}/app/login`, { waitUntil: "networkidle2", timeout: 60000 });
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: "networkidle2" });
  await sleep(400);
  await p.type(`input[type="email"]`, "web-e2e-1790923138801@voiceagent.dev");
  await p.type(`input[type="password"]`, "Passw0rd!2026");
  await p.click(".setup-card form button");
  await p.waitForFunction(() => location.pathname.endsWith("/setup") || /\/app\/?$/.test(location.pathname), { timeout: 30000 });
  if (p.url().endsWith("/setup")) {
    await sleep(600);
    await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Existing"))?.click());
    await p.waitForFunction(() => (document.querySelector("select.select")?.options.length ?? 0) > 1, { timeout: 20000 });
    const v = await p.evaluate(() => document.querySelector("select.select").options[1].value);
    await p.select("select.select", v);
    await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Open workspace"))?.click());
    await p.waitForFunction(() => /\/app\/?$/.test(location.pathname), { timeout: 30000 });
  }
  await p.waitForSelector("a.nav-link", { timeout: 15000 });
  await p.evaluate(() => [...document.querySelectorAll("a.nav-link")].find((a) => a.textContent.includes("Voice"))?.click());
  await p.waitForFunction(() => location.pathname.endsWith("/voice"), { timeout: 15000 });
  await sleep(500);
  await p.evaluate(() => [...document.querySelectorAll("button")].find((x) => x.textContent.includes("Start call"))?.click());
  let done = false;
  for (let i = 0; i < 16 && !done; i++) {
    await sleep(5000);
    const state = await p.evaluate(() => ({
      s: document.querySelector(".voice-status")?.textContent?.trim() ?? "",
      lines: [...document.querySelectorAll(".voice-line")].map((l) => ({ cls: l.className, t: l.textContent.slice(0, 200) })),
    }));
    console.log(`t=${(i+1)*5}s status="${state.s}"`);
    state.lines.slice(-3).forEach((l) => console.log("   [" + l.cls.replace("voice-line ", "") + "]", l.t));
    if (state.lines.some((l) => l.cls.includes("assistant"))) done = true;
  }
  await sleep(4000);
  await p.screenshot({ path: process.env.TEMP + "\\web_e2e\\08b-voice-live.png" });
  console.log(done ? "BROWSER VOICE TURN OK" : "NO ASSISTANT LINE");
} catch (e) { console.log("EXC:", e.message); }
await b.close();
