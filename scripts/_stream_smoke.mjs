// SSE streaming + empty-knowledge instant-fallback smoke test against prod.
const API = process.env.API_URL || "https://voice-agent-saas-production-3001.up.railway.app";
const email = `stream+${Date.now()}@example.com`;
const pass = "Stream123!";

async function j(path, opts = {}, token, ws) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ws ? { "x-workspace-id": ws } : {}),
      ...((opts.headers) || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return data;
}

async function runStream(ws, token, conv, content) {
  const t0 = Date.now();
  const res = await fetch(`${API}/v1/conversations/${conv}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-workspace-id": ws },
    body: JSON.stringify({ workspaceId: ws, content, stream: true }),
  });
  if (!res.ok) throw new Error(`stream POST -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("text/event-stream")) throw new Error(`expected SSE, got ${ct}`);
  let firstDelta = null;
  let preview = "";
  let final = null;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const ev = JSON.parse(line.slice(5).trim());
      if (ev.type === "delta") {
        if (firstDelta === null) firstDelta = Date.now() - t0;
        preview += ev.text;
      } else if (ev.type === "final") {
        final = { at: Date.now() - t0, ...ev };
      } else if (ev.type === "error") {
        throw new Error(`stream error: ${ev.message}`);
      }
    }
  }
  if (!final) throw new Error("no final frame");
  return { firstDelta, preview, final };
}

const { token } = await j("/v1/auth/register", { method: "POST", body: JSON.stringify({ email, password: pass, name: "Stream" }) });
const ws = (await j("/v1/workspaces", { method: "POST", body: JSON.stringify({ name: "StreamWS" }) }, token)).id;

// 1) No knowledge, JSON (harness contract): instant fallback, no LLM
const conv1 = (await j("/v1/conversations", { method: "POST", body: JSON.stringify({ workspaceId: ws, channel: "web" }) }, token, ws)).id;
const t1 = Date.now();
const plain = await j(`/v1/conversations/${conv1}/messages`, { method: "POST", body: JSON.stringify({ workspaceId: ws, content: "How much is a haircut?" }) }, token, ws);
console.log(`[json fallback] ${Date.now() - t1}ms src=${plain.answerSource} ok=${plain.verdict.ok}`);
if (plain.answerSource !== "fallback") { console.error("FAIL: expected fallback source"); process.exit(1); }

// 2) No knowledge, streamed: answer paints BEFORE persist
const s1 = await runStream(ws, token, conv1, "Do you offer student discounts?");
console.log(`[stream fallback] first=${s1.firstDelta}ms final=${s1.final.at}ms src=${s1.final.answerSource} preview="${s1.preview.slice(0, 50)}"`);
if (s1.firstDelta === null || s1.firstDelta > 900) { console.error(`FAIL: fallback first delta ${s1.firstDelta}ms > 900ms`); process.exit(1); }

// 3) With knowledge: live token stream + grounded final
await j("/v1/knowledge/ingest", { method: "POST", body: JSON.stringify({ workspaceId: ws, title: "Acme Pricing FAQ", markdown: "# Prices\nStandard haircut is 400 INR and takes 30 minutes.\nBeard trim is 150 INR.\nOpening hours are 9am to 8pm, Monday to Saturday." }) }, token, ws);
const conv2 = (await j("/v1/conversations", { method: "POST", body: JSON.stringify({ workspaceId: ws, channel: "web" }) }, token, ws)).id;
const s2 = await runStream(ws, token, conv2, "how much is a haircut?");
console.log(`[stream knowledge] first=${s2.firstDelta}ms final=${s2.final.at}ms ok=${s2.final.verdict.ok} preview="${s2.preview.slice(0, 60)}"`);
if (s2.firstDelta === null || s2.firstDelta > 1600) { console.error(`FAIL: knowledge first delta ${s2.firstDelta}ms`); process.exit(1); }
if (!s2.final.answer.content.includes("400")) { console.error("FAIL: ungrounded final"); process.exit(1); }
if (s2.final.at <= s2.firstDelta) { console.error("FAIL: final should follow first delta"); process.exit(1); }

console.log(`STREAM SMOKE PASS (fallback paint ${s1.firstDelta}ms, knowledge first token ${s2.firstDelta}ms, full ${s2.final.at}ms)`);
