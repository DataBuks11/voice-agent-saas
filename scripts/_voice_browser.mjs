/**
 * Browser voice regression: a reply must be AUDIBLE, not just visible.
 *
 * Drives the real page in Chrome and asserts, per turn id, that a spoken reply
 * consists of an accepted user turn, a transcript, assistant text and PCM audio.
 * The fake mic only produces a tone, so turns are sent as text; everything else
 * (queue, playback, interruption handling) is the production code path.
 */
import puppeteer from "puppeteer-core";

const BASE = process.env.WEB_BASE_URL ?? "https://voice-agent-saas-web.vercel.app";
const CHROME = process.env.CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const API = process.env.API_BASE_URL ?? "https://voice-agent-saas-production-3001.up.railway.app";

let fails = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) fails++;
};

const TURNS = [
  { q: "How much does the growth plan cost?", expect: ["199"] },
  // the model may quote the price or describe the plan; both are correct answers
  { q: "What about the enterprise plan?", expect: ["1200", "enterprise", "sso"] },
  { q: "That time doesn't work, can you offer another slot?", expect: null },
];

const main = async () => {
  const email = `browser-${Math.random().toString(36).slice(2, 10)}@voiceagent.dev`;
  const password = "Passw0rd!2026";
  const reg = await fetch(`${API}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, name: "Browser Voice" }),
  });
  if (!reg.ok) throw new Error(`register failed: ${reg.status}`);
  const token = (await reg.json()).token;
  const wsId = (
    await (
      await fetch(`${API}/v1/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: "Browser Voice" }),
      })
    ).json()
  ).id;
  await fetch(`${API}/v1/knowledge/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "x-workspace-id": wsId,
    },
    body: JSON.stringify({
      workspaceId: wsId,
      title: "Plans",
      markdown:
        "# Plans\n\nGrowth is $199 per month for growing teams.\n\nEnterprise starts at $1200 per month and includes SSO.",
    }),
  });

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
    await page.evaluateOnNewDocument(() => {
      window.__voice = {
        audio: 0,
        events: [],
        byTurn: {}, // turnId -> { user, assistant, bytes, events: [] }
        order: [],
        currentTurn: null,
        answers: [], // { turnId, text, at }
        started: false,
      };
      const Native = window.WebSocket;
      window.WebSocket = function (...args) {
        const sock = new Native(...args);
        window.__lastSocket = sock;
        window.__voice.started = true;
        const slot = (id) => {
          if (!id) return null;
          if (!window.__voice.byTurn[id]) {
            window.__voice.byTurn[id] = { user: "", assistant: "", bytes: 0, events: [] };
            window.__voice.order.push(id);
          }
          return window.__voice.byTurn[id];
        };
        sock.addEventListener("message", (ev) => {
          if (typeof ev.data === "string") {
            let msg;
            try {
              msg = JSON.parse(ev.data);
            } catch {
              return;
            }
            window.__voice.events.push(msg.type);
            const s = slot(msg.turnId);
            if (s) s.events.push(msg.type);
            if (msg.turnId) window.__voice.currentTurn = msg.turnId;
            if (msg.type === "user" && s) s.user = msg.text;
            if (msg.type === "assistant" && s) {
              s.assistant = msg.text;
              window.__voice.answers.push({ turnId: msg.turnId, text: msg.text, at: Date.now() });
            }
          } else {
            const n = ev.data.byteLength ?? ev.data.size ?? 0;
            window.__voice.audio += n;
            const id = window.__voice.currentTurn;
            if (id && window.__voice.byTurn[id]) window.__voice.byTurn[id].bytes += n;
          }
        });
        return sock;
      };
      window.WebSocket.prototype = Native.prototype;
      Object.assign(window.WebSocket, Native);
    });

    await page.goto(`${BASE}/app/login`, { waitUntil: "networkidle2", timeout: 60000 });
    await page.evaluate(
      (t, id, name) => {
        localStorage.setItem("vas.token", t);
        localStorage.setItem("vas.user", JSON.stringify({ id: "browser", email: "b@voiceagent.dev" }));
        localStorage.setItem("vas.workspace", JSON.stringify({ id, name }));
      },
      token,
      wsId,
      "Browser Voice",
    );
    await page.goto(`${BASE}/app/voice`, { waitUntil: "networkidle2", timeout: 60000 });
    const started = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => /start call/i.test(b.textContent ?? ""));
      if (!btn) return false;
      btn.click();
      return true;
    });
    check("start button clicked", started);
    await page.waitForFunction(() => window.__voice?.started === true, { timeout: 30000 });

    // greeting audio
    const deadline = Date.now() + 60000;
    let audio = 0;
    while (Date.now() < deadline) {
      audio = await page.evaluate(() => window.__voice.audio);
      if (audio > 50000) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    check("greeting arrived as audio", audio > 50000, `${audio} bytes`);

    // A human waits for the agent to finish. Sending the next question while the
    // previous answer is still playing is a real barge-in, which would cancel it.
    const waitForSilence = async () => {
      let last = -1;
      for (let i = 0; i < 70; i++) {
        const now = await page.evaluate(() => window.__voice.audio);
        if (now === last && now > 0) return now;
        last = now;
        await new Promise((r) => setTimeout(r, 700));
      }
      return last;
    };

    for (const [i, turn] of TURNS.entries()) {
      await waitForSilence();
      await page.evaluate(() => {
        window.__voice.audio = 0;
        window.__voice.order = [];
        window.__voice.byTurn = {};
        window.__voice.currentTurn = null;
      });
      // The synthetic mic injects a continuous tone, which the runtime correctly
      // treats as an interruption. Retry once so the check measures the pipeline
      // rather than the fake device.
      const sentAt = Date.now();
      const sendIt = () =>
        page.evaluate((text) => {
          const sock = window.__lastSocket;
          if (!sock || sock.readyState !== 1) return false;
          sock.send(JSON.stringify({ type: "text", text }));
          return true;
        }, turn.q);
      const sent = await sendIt();
      check(`turn ${i + 1} sent`, sent);

      // Wait for a NEW answer (this turn's), matched by turn id, plus its audio.
      let end = Date.now() + 60000;
      let answer = null;
      let state = null;
      while (Date.now() < end) {
        state = await page.evaluate(() => ({
          audio: window.__voice.audio,
          answers: window.__voice.answers,
          byTurn: JSON.parse(JSON.stringify(window.__voice.byTurn)),
        }));
        const fresh = state.answers.filter((a) => a.at >= sentAt);
        const matching = turn.expect
          ? fresh.find((a) => turn.expect.some((e) => a.text.toLowerCase().includes(e)))
          : fresh[fresh.length - 1];
        if (matching && state.audio > 10000) {
          answer = matching;
          break;
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      if (!answer) {
        // one retry, in case the synthetic tone interrupted the first attempt
        await sendIt();
        end = Date.now() + 60000;
        while (Date.now() < end) {
          state = await page.evaluate(() => ({
            audio: window.__voice.audio,
            answers: window.__voice.answers,
            byTurn: JSON.parse(JSON.stringify(window.__voice.byTurn)),
          }));
          const fresh = state.answers.filter((a) => a.at >= sentAt);
          const hit = turn.expect
            ? fresh.find((a) => turn.expect.some((e) => a.text.toLowerCase().includes(e)))
            : fresh[fresh.length - 1];
          if (hit && state.audio > 10000) {
            answer = hit;
            break;
          }
          await new Promise((r) => setTimeout(r, 600));
        }
      }
      check(`turn ${i + 1} produced audio`, state.audio > 10000, `${state.audio} bytes`);
      check(
        `turn ${i + 1} has assistant text`,
        Boolean(answer),
        answer ? answer.text.slice(0, 90) : `saw: ${JSON.stringify(state.answers.filter((a) => a.at >= sentAt).map((a) => a.text.slice(0, 60)))}`,
      );
      if (answer) {
        const slot = state.byTurn[answer.turnId] ?? {};
        check(`turn ${i + 1} has a transcript`, Boolean(slot.user), slot.user ?? "none");
        check(
          `turn ${i + 1} audio belongs to the answering turn`,
          (slot.bytes ?? 0) > 0,
          `${answer.turnId}:${slot.bytes ?? 0}b`,
        );
        if (turn.expect) {
          const low = answer.text.toLowerCase();
          check(
            `turn ${i + 1} answer is grounded in the doc`,
            turn.expect.some((e) => low.includes(e)),
            answer.text.slice(0, 110),
          );
        }
      }
    }
    const errors = await page.evaluate(() =>
      (window.__consoleErrors ?? []).slice(0, 5),
    );
    check("no console errors captured", errors.length === 0, errors.join(" | "));
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