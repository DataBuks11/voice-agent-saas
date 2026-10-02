#!/usr/bin/env node
/**
 * Full browser harness: landing → auth → setup → agents → knowledge → conversations → signout → relogin.
 * Uses local Chrome via puppeteer-core. Fails on any check or unexpected console error.
 *
 * Usage: node scripts/_web_e2e.mjs [--url https://voice-agent-saas-web.vercel.app]
 */
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const argIdx = process.argv.indexOf("--url");
const BASE = (argIdx > -1 ? process.argv[argIdx + 1] : process.env.WEB_URL ?? "https://voice-agent-saas-web.vercel.app").replace(/\/$/, "");
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const SHOTS = process.env.E2E_SHOTS ?? path.join(process.env.TEMP ?? "/tmp", "web_e2e");
fs.mkdirSync(SHOTS, { recursive: true });

const consoleErrors = [];
let failures = 0;
const stamp = Date.now();

function check(name, cond, extra = "") {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function clickText(page, selector, text) {
  const ok = await page.evaluate(
    (sel, t) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.replace(/\s+/g, " ").trim().includes(t));
      if (!el) return false;
      el.click();
      return true;
    },
    selector,
    text,
  );
  if (!ok) throw new Error(`clickText: "${text}" in ${selector} not found`);
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }).catch(() => undefined);
}

async function waitForText(page, text, timeout = 20000) {
  await page.waitForFunction((t) => document.body.innerText.toLowerCase().includes(t.toLowerCase()), { timeout }, text);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`WEB E2E → ${BASE}`);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu", "--window-size=1440,900", "--autoplay-policy=no-user-gesture-required"],
    defaultViewport: { width: 1440, height: 900 },
  });
  const page = await browser.newPage();
  const netErrors = [];
  page.on("response", (r) => {
    if (r.status() >= 400 && !r.url().includes("favicon")) netErrors.push(`${r.status()} ${r.request().method()} ${r.url()}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/i.test(m.text())) consoleErrors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    // 1. Landing
    console.log("\n[1] Landing");
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
    check("title exact", (await page.title()) === "Intelligence Designed To Evolve", await page.title());
    check("video background", Boolean(await page.$("video")));
    check("hero headline", await page.evaluate(() => document.body.innerText.includes("Voice Agents")));
    check("stats labels", await page.evaluate(() => document.body.innerText.includes("Retrieval Latency")));
    check("Product link → /app/", await page.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "/app/")));
    check("fonts loaded (Bubbledot)", await page.evaluate(() => document.fonts.check('16px "BubbledotICG-FinePos"')));
    await shot(page, "01-landing");

    // 2. Sign in link → login (no double /app)
    console.log("\n[2] Sign in link");
    await clickText(page, "a", "Sign in");
    await page.waitForFunction(() => location.pathname.endsWith("/login"), { timeout: 20000 });
    check("url is /app/login", page.url().endsWith("/app/login"), page.url());
    check("no double /app", !page.url().includes("/app/app"));
    await waitForText(page, "sign in to your console");
    check("login form renders", Boolean(await page.$('input[type="email"]')));
    await shot(page, "02-login");

    // 3. Register
    console.log("\n[3] Register");
    await clickText(page, "button", "Create account");
    await page.type('input[placeholder="Ada Lovelace"]', "Web E2E");
    const email = `web-e2e-${stamp}@voiceagent.dev`;
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', "Passw0rd!2026");
    await Promise.all([
      page.waitForNavigation({ timeout: 30000 }).catch(() => undefined),
      page.click(".setup-card form button"),
    ]);
    await page.waitForFunction(() => location.pathname.endsWith("/setup"), { timeout: 30000 });
    check("→ /app/setup", page.url().endsWith("/app/setup"), page.url());
    await waitForText(page, "create or pick a workspace");
    await shot(page, "03-setup");

    // 4. Create workspace → dashboard
    console.log("\n[4] Workspace setup");
    await page.type('input[placeholder="Acme Hair Salon"]', `Web E2E WS ${stamp}`);
    await clickText(page, "button", "Create workspace");
    await page.waitForFunction(() => /\/app\/?$/.test(location.pathname), { timeout: 30000 });
    check("→ dashboard /app/", /\/app\/?$/.test(new URL(page.url()).pathname), page.url());
    await waitForText(page, "voice agent control plane");
    await waitForText(page, "api online", 20000).catch(() => undefined);
    const healthText = await page.evaluate(() => document.body.innerText);
    check("api online badge (CORS works)", healthText.includes("api online"), healthText.includes("api offline") ? "api offline" : "");
    await page.waitForSelector("a.nav-link", { timeout: 15000 });
    await shot(page, "04-dashboard");

    // 5. Agents
    console.log("\n[5] Agents");
    await clickText(page, "a.nav-link", "Agents");
    await page.waitForFunction(() => location.pathname.endsWith("/agents"), { timeout: 15000 });
    await waitForText(page, "Configured agents");
    await page.type('input[placeholder="Salon Receptionist"]', "Web E2E Agent");
    await clickText(page, "button", "Create agent");
    await waitForText(page, "Web E2E Agent", 20000);
    check("agent created + listed", true);
    await shot(page, "05-agents");

    // 6. Knowledge: sample ingest + search
    console.log("\n[6] Knowledge ingest + search");
    await clickText(page, "a.nav-link", "Knowledge");
    await page.waitForFunction(() => location.pathname.endsWith("/knowledge"), { timeout: 15000 });
    await waitForText(page, "Vector search playground");
    await clickText(page, "button", "Load sample");
    await clickText(page, "button", "Ingest & embed");
    await waitForText(page, "Ingested", 60000);
    const ingestToast = await page.evaluate(() => document.body.innerText);
    check("ingest toast shows local-fastembed", ingestToast.includes("local-fastembed"), ingestToast.slice(0, 0));
    await waitForText(page, "Acme Pricing FAQ", 20000);
    check("document listed", true);
    await page.type('input[placeholder="how much is a haircut?"]', "how much is a premium styling?");
    await clickText(page, "button", "Search (cosine)");
    await waitForText(page, "0.", 30000);
    check("search returned scored hits", await page.evaluate(() => Boolean(document.querySelector(".score-fill"))));
    await shot(page, "06-knowledge");

    // 7. Conversations: live turn
    console.log("\n[7] Conversation turn (LLM + harness)");
    await clickText(page, "a.nav-link", "Conversations");
    await page.waitForFunction(() => location.pathname.endsWith("/conversations"), { timeout: 15000 });
    await clickText(page, "button", "+ New conversation");
    await page.waitForSelector('input[placeholder="Ask the agent…"]', { timeout: 30000 });
    await page.type('input[placeholder="Ask the agent…"]', "How much is a premium styling and when are you open?");
    await clickText(page, "button", "Send");
    await waitForText(page, "900", 120000); // grounded answer price
    check("assistant answer grounded (900 INR)", true);
    await waitForText(page, "answer source", 30000).catch(() => undefined);
    const traceText = await page.evaluate(() => document.body.innerText.toLowerCase());
    check("turn trace visible", traceText.includes("decision") && traceText.includes("harness verdict"));
    check("retrieval hits in trace", traceText.includes("retrieval ("));
    await shot(page, "07-conversation");

    // 8. Sign out
    console.log("\n[8] Sign out");
    await clickText(page, "button", "Sign out");
    await page.waitForFunction(() => location.pathname.endsWith("/login"), { timeout: 20000 });
    check("signed out → /app/login", page.url().endsWith("/app/login"), page.url());

    // 9. Re-login → setup (pick existing workspace)
    console.log("\n[9] Re-login + existing workspace");
    await waitForText(page, "sign in to your console", 30000);
    await page.waitForSelector('input[type="email"]', { timeout: 30000 });
    await page.type('input[type="email"]', email);
    await page.type('input[type="password"]', "Passw0rd!2026");
    await page.click(".setup-card form button");
    await page.waitForFunction(() => location.pathname.endsWith("/setup"), { timeout: 30000 });
    await waitForText(page, "Existing (");
    await clickText(page, "button", "Existing (");
    await page.waitForFunction(() => (document.querySelector("select.select")?.options.length ?? 0) > 1, { timeout: 20000 });
    const wsValue = await page.evaluate(() => document.querySelector("select.select").options[1].value);
    await page.select("select.select", wsValue);
    await clickText(page, "button", "Open workspace");
    await page.waitForFunction(() => /\/app\/?$/.test(location.pathname), { timeout: 30000 });
    check("re-login → dashboard", true);
    await shot(page, "09-relogin");

    // 10. Deep link without session (isolated context = no localStorage)
    console.log("\n[10] Deep-link redirect (fresh context, no token)");
    const ctx = await browser.createBrowserContext().catch(() => browser.createIncognitoBrowserContext());
    const fresh = await ctx.newPage();
    fresh.on("pageerror", (e) => consoleErrors.push(`pageerror(fresh): ${e.message}`));
    await fresh.goto(`${BASE}/app/knowledge`, { waitUntil: "networkidle2", timeout: 60000 });
    await fresh.waitForFunction(() => location.pathname.endsWith("/login") || location.pathname === "/app", { timeout: 20000 }).catch(() => undefined);
    const freshUrl = fresh.url();
    check("deep link lands on login (no /app/app)", freshUrl.endsWith("/app/login"), freshUrl);
    check("deep link page not blank", await fresh.evaluate(() => document.body.innerText.length > 20));
    await ctx.close().catch(() => undefined);

    // 11. Mobile viewport smoke (landing burger)
    console.log("\n[11] Mobile landing");
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(`${BASE}/`, { waitUntil: "networkidle2", timeout: 60000 });
    check("burger visible on mobile", await page.evaluate(() => Boolean(document.querySelector(".burger, .m-signin, [class*=burger]"))));
    await shot(page, "11-mobile");
    await page.setViewport({ width: 1440, height: 900 });
  } catch (err) {
    failures++;
    console.log(`\nHARNESS EXCEPTION: ${err.message}`);
    await shot(page, "99-error").catch(() => undefined);
  } finally {
    await browser.close();
  }

  const benign = consoleErrors.filter(
    (e) => !/favicon|net::ERR_ABORTED|Download the React DevTools/i.test(e),
  );
  console.log(`\nconsole/page errors: ${benign.length}`);
  benign.slice(0, 10).forEach((e) => console.log(`  ${e}`));
  if (benign.length) failures++;
  if (netErrors.length) {
    failures++;
    console.log(`network errors: ${netErrors.length}`);
    netErrors.slice(0, 10).forEach((e) => console.log(`  ${e}`));
  }

  console.log(`\n${failures === 0 ? "WEB E2E PASS ✅" : `WEB E2E FAIL (${failures}) ❌`}`);
  console.log(`screenshots: ${SHOTS}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
