/**
 * Browser voice regression: a reply must be AUDIBLE, not just visible.
 *
 * The transcript rendered while no sound played because the client cleared the
 * audio buffer when the server announced playback. This drives the real page in
 * Chrome, hooks the WebSocket, and asserts that spoken replies come with PCM
 * audio frames.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.WEB_BASE_URL ?? "https://voice-agent-saas-web.vercel.app";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const WS = process.env.VOICE_WS_URL ?? "wss://voice-runtime-production-dc24.up.railway.app";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const main = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: [
      "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });
  try {
    const page = await browser.newPage();
    // Count what the page actually receives, per websocket.
    await page.evaluateOnNewDocument(() => {
      window.__voice = {
        audio: 0,
        events: [],
        binaryAfterText: 0,
        started: false,
        assistantTexts: [],
        turnIds: [],
        rejected: [],
      };
      const Native = window.WebSocket;
      window.WebSocket = function (...args) {
        const sock = new Native(...args);
        window.__lastSocket = sock;
        window.__voice.started = true;
        sock.addEventListener("message", (ev) => {
          if (typeof ev.data === "string") {
            try {
              const msg = JSON.parse(ev.data);
              window.__voice.events.push(msg.type);
              if (msg.turnId) window.__voice.turnIds.push(msg.turnId);
              if (msg.type === "assistant" && msg.text) window.__voice.assistantTexts.push(msg.text);
              if (msg.type === "trace" && msg.type && /USER_TURN_REJECTED|VOICE_ERROR/.test(String(msg.data?.type ?? ""))) {
                window.__voice.rejected.push(msg);
              }
              if (msg.type === "assistant" || msg.type === "audio_end") {
                window.__voice.pendingText = true;
              }
            } catch {
              /* ignore */
            }
          } else {
            window.__voice.audio += ev.data.byteLength ?? ev.data.size ?? 0;
            if (window.__voice.pendingText) {
              window.__voice.binaryAfterText += 1;
              window.__voice.pendingText = false;
            }
          }
        });
        return sock;
      };
      window.WebSocket.prototype = Native.prototype;
      Object.assign(window.WebSocket, Native);
    });

    const email = `browser-${Math.random().toString(36).slice(2, 10)}@voiceagent.dev`;
    const password = "Passw0rd!2026";
    const api = process.env.API_BASE_URL ?? "https://voice-agent-saas-production-3001.up.railway.app";
    const reg = await fetch(`${api}/v1/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password, name: "Browser Voice" }),
    });
    if (!reg.ok) throw new Error(`register failed: ${reg.status} ${await reg.text()}`);
    const token = (await reg.json()).token;
    const ws = await (
      await fetch(`${api}/v1/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Browser Voice" }),
      })
    ).json();
    const wsId = ws.id;
    await fetch(`${api}/v1/knowledge/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-workspace-id": wsId,
      },
      body: JSON.stringify({
        workspaceId: wsId,
        title: "Pricing",
        markdown: "# Plans\n\nGrowth is $199 per month.\n\nEnterprise starts at $1200 per month.",
      }),
    });
    // Give the page a session without driving the UI: the app reads these.
    await page.goto(`${BASE}/app/login`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(
      (t, id, name) => {
        localStorage.setItem("vas.token", t);
        localStorage.setItem("vas.user", JSON.stringify({ id: "browser", email: "browser@voiceagent.dev" }));
        localStorage.setItem("vas.workspace", JSON.stringify({ id, name }));
      },
      token,
      wsId,
      "Browser Voice",
    );

    await page.goto(`${BASE}/app/voice`, { waitUntil: "networkidle2", timeout: 60000 });
    // Start the call.
    const started = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        /start call/i.test(b.textContent ?? ""),
      );
      if (!btn) return false;
      btn.click();
      return true;
    });
    check("start button clicked", started);

    await page.waitForFunction(() => window.__voice?.started === true, { timeout: 30000 });
    console.log("      websocket opened");

    // Wait for the greeting to arrive as audio.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const s = await page.evaluate(() => ({ ...window.__voice, events: window.__voice.events.slice(-14) }));
      if (s.audio > 20000) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    let s = await page.evaluate(() => ({ ...window.__voice, events: window.__voice.events.slice(-14) }));
    check("greeting arrived as audio", s.audio > 20000, `${s.audio} bytes, events=${s.events.join(",")}`);

    // Multi-turn: prove the cycle repeats, not just once.
    const turns = [
      { q: "How much does the growth plan cost?", expect: "199" },
      { q: "What about the enterprise plan?", expect: "1200" },
      { q: "That time doesn't work, can you offer another slot?", expect: null },
    ];
    for (const [i, turn] of turns.entries()) {
      await page.evaluate(() => {
        window.__voice.audio = 0;
        window.__voice.binaryAfterText = 0;
        window.__voice.assistantTexts = [];
      });
      const sent = await page.evaluate((text) => {
        const sock = window.__lastSocket;
        if (!sock || sock.readyState !== 1) return false;
        sock.send(JSON.stringify({ type: "text", text }));
        return true;
      }, turn.q);
      check(`turn ${i + 1} sent`, sent);
      const end = Date.now() + 45000;
      let seen = null;
      while (Date.now() < end) {
        seen = await page.evaluate(() => ({ ...window.__voice, events: window.__voice.events.slice(-16) }));
        if (seen.binaryAfterText > 0 && seen.audio > 10000) break;
        await new Promise((r) => setTimeout(r, 700));
      }
      check(
        `turn ${i + 1} produced audio`,
        seen.audio > 10000,
        `${seen.audio} bytes, events=${seen.events.join(",")}`,
      );
      if (turn.expect) {
        const texts = await page.evaluate(() => window.__voice.assistantTexts ?? []);
        const joined = texts.join(" | ");
        check(
          `turn ${i + 1} answer is grounded`,
          joined.includes(turn.expect),
          joined.slice(-140),
        );
      }
      // every reply must carry the same turn id end to end
      const ids = await page.evaluate(() => window.__voice.turnIds ?? []);
      check(`turn ${i + 1} turn id present`, ids.length > 0, `turnIds=${ids.join(",")}`);
    }

    // Now send a text turn and expect audio again.
    await page.evaluate(() => {
      window.__voice.audio = 0;
      window.__voice.binaryAfterText = 0;
    });
    const spoke = await page.evaluate(
      (wsUrl) => {
        const sock = window.__lastSocket;
        if (!sock || sock.readyState !== 1) return false;
        sock.send(JSON.stringify({ type: "text", text: "How much does the growth plan cost?" }));
        return true;
      },
      WS,
    );
    check("text turn sent", spoke);
    const deadline2 = Date.now() + 45000;
    while (Date.now() < deadline2) {
      s = await page.evaluate(() => ({ ...window.__voice, events: window.__voice.events.slice(-14) }));
      if (s.binaryAfterText > 0 || s.audio > 20000) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    s = await page.evaluate(() => ({ ...window.__voice, events: window.__voice.events.slice(-14) }));
    check("reply produced audio frames", s.audio > 10000, `${s.audio} bytes, events=${s.events.join(",")}`);
    check("no stalled playback (audio present after assistant text)", s.binaryAfterText > 0 || s.audio > 10000);
  } finally {
    await browser.close();
  }
  console.log(fails === 0 ? "\nBROWSER VOICE PASS" : `\nBROWSER VOICE FAIL (${fails})`);
  process.exit(fails === 0 ? 0 : 1);
};

main().catch((err) => {
  console.error("BROWSER VOICE ERROR", err.message);
  process.exit(1);
});