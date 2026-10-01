const BASE = "https://voice-agent-saas-production-3001.up.railway.app";
let token = "";
let wsId = "";

function headers(extra = {}) {
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(wsId ? { "x-workspace-id": wsId } : {}),
    ...extra,
  };
}

async function call(method, path, body, extraHeaders) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(extraHeaders),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, json };
}

function log(label, r, keys = []) {
  const pick = {};
  for (const k of keys) if (r.json && typeof r.json === "object") pick[k] = r.json[k];
  console.log(`${r.status} ${label} ${keys.length ? JSON.stringify(pick) : ""}`);
  if (r.status >= 400) console.log("   ->", JSON.stringify(r.json).slice(0, 400));
}

const email = `e2e-${Date.now()}@voiceagent.dev`;

let r = await call("POST", "/v1/auth/register", { email, password: "Passw0rd!2026", name: "E2E" });
log("register", r, ["token"]);
if (!r.json?.token) process.exit(1);
token = r.json.token;

r = await call("POST", "/v1/workspaces", { name: "E2E Workspace" });
log("create workspace", r, ["id", "name"]);
if (!r.json?.id) process.exit(1);
wsId = r.json.id;

r = await call("POST", "/v1/agents", { workspaceId: wsId, name: "Support Agent", language: "en", tone: "friendly", systemPrompt: "You are a support agent.", fallbackResponse: "I don't know." });
log("create agent", r, ["id", "name"]);

r = await call("POST", "/v1/knowledge/ingest", {
  workspaceId: wsId,
  title: "Voice Agent OS Handbook",  markdown: `# Knowledge [pricing]
Voice Agent OS costs $49 per month for the Starter plan and $199 per month for the Growth plan.
The Starter plan includes 3 agents and 10,000 vector search queries.

# Knowledge [support]
Customers can reach support at support@voiceagent.dev any time. Response time is under 4 hours.

# Knowledge [voice]
The voice runtime uses open source components: pipecat for the realtime pipeline,
faster-whisper for speech to text and piper for text to speech.`,
});
log("ingest", r, ["sourceId", "documentId", "chunkCount", "embeddingProvider"]);

r = await call("POST", "/v1/knowledge/search", { workspaceId: wsId, query: "how much does the growth plan cost?" });
log("search", r, []);
if (Array.isArray(r.json?.matches)) console.log("   top score:", r.json.matches[0]?.score, "|", (r.json.matches[0]?.content ?? "").slice(0, 80));
else if (Array.isArray(r.json?.items)) console.log("   top score:", r.json.items[0]?.score);
else console.log("   ->", JSON.stringify(r.json).slice(0, 300));

r = await call("POST", "/v1/conversations", { workspaceId: wsId, channel: "web" });
log("create conversation", r, ["id"]);
const convId = r.json?.id;
if (!convId) process.exit(1);

r = await call("POST", `/v1/conversations/${convId}/messages`, {
  workspaceId: wsId,
  content: "What does the Growth plan cost and how do I contact support?",
});
log("turn", r, ["answerSource"]);
if (r.json?.answer) console.log("   answer:", String(r.json.answer.content ?? "").slice(0, 260));
if (r.json?.decision) console.log("   decision:", JSON.stringify(r.json.decision));
if (r.json?.verdict) console.log("   verdict:", JSON.stringify(r.json.verdict));
if (r.json?.retrieved) console.log("   retrieved:", r.json.retrieved.length, "chunks");

r = await call("GET", `/v1/conversations/${convId}/messages?workspaceId=${wsId}`);
log("list messages", r, ["total"]);

console.log("E2E DONE");
