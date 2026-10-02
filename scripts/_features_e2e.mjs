// Feature E2E against prod API: greeting fast path, Gemini latency, grounded answer,
// calendar booking tool, maps location tool, chunked text upload.
// Usage: node scripts/_features_e2e.mjs
const BASE = "https://voice-agent-saas-production-3001.up.railway.app";
let token = "";
let wsId = "";

const headers = () => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(wsId ? { "x-workspace-id": wsId } : {}),
});

async function call(method, path, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
  return { status: res.status, json, ms };
}

function ok(label, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!cond) process.exitCode = 1;
}

const email = `feat-${Date.now()}@voiceagent.dev`;
let r = await call("POST", "/v1/auth/register", { email, password: "Passw0rd!2026", name: "Feature E2E" });
ok("register", !!r.json?.token);
token = r.json.token;

r = await call("POST", "/v1/workspaces", { name: "Feature Workspace" });
wsId = r.json.id;
ok("workspace", !!wsId);

r = await call("POST", "/v1/agents", {
  workspaceId: wsId,
  name: "City Hair Studio",
  language: "en",
  tone: "friendly",
  systemPrompt: "You are a professional American-English receptionist for City Hair Studio.",
  fallbackResponse: "I don't have verified information about that yet.",
  location: "350 5th Ave, New York, NY 10118",
});
ok("agent with location", !!r.json?.id);

r = await call("POST", "/v1/knowledge/ingest", {
  workspaceId: wsId,
  title: "Salon Pricing",
  markdown: "# Pricing\nStandard haircut is 400 INR. Premium styling is 900 INR.\n\n# Hours\nWe are open Monday to Saturday, 10am to 8pm. Sunday closed.",
});
ok("ingest", (r.json?.chunkCount ?? 0) > 0, `${r.json?.chunkCount} chunks in ${r.ms}ms`);

r = await call("POST", "/v1/conversations", { workspaceId: wsId, channel: "web" });
const convId = r.json?.id;
ok("conversation", !!convId);

async function turn(content) {
  return call("POST", `/v1/conversations/${convId}/messages`, { workspaceId: wsId, content });
}

// 1) Greeting -> fast path, no LLM
r = await turn("hello there");
ok(
  "greeting fast path",
  r.json?.answerSource === "fast-path" && r.json?.verdict?.ok === true,
  `${r.ms}ms source=${r.json?.answerSource} verdict=${r.json?.verdict?.ok} :: "${String(r.json?.answer?.content ?? "").slice(0, 70)}"`,
);

// 1b) Greeting again (warm) for an honest latency number
r = await turn("hey, good morning");
console.log(`      warm greeting: ${r.ms}ms source=${r.json?.answerSource}`);

// 2) Knowledge question -> grounded + Gemini (run twice: cold + warm)
r = await turn("How much is premium styling?");
const grounded = r.json?.verdict?.ok === true;
const mentions900 = /900/.test(String(r.json?.answer?.content ?? ""));
ok(
  "grounded knowledge answer (Gemini)",
  grounded && mentions900 && r.json?.answerSource === "llm",
  `${r.ms}ms source=${r.json?.answerSource} verdict=${r.json?.verdict?.ok} :: "${String(r.json?.answer?.content ?? "").slice(0, 90)}"`,
);
for (let i = 0; i < 2; i++) {
  const warm = await turn("What are your opening hours again?");
  console.log(`      warm knowledge turn ${i + 1}: ${warm.ms}ms verdict=${warm.json?.verdict?.ok} :: "${String(warm.json?.answer?.content ?? "").slice(0, 70)}"`);
}

// 3) Location tool -> instant + maps link
r = await turn("where are you located?");
const maps = (r.json?.toolResults ?? []).find((t) => t.type === "maps");
ok(
  "maps location tool",
  !!maps && r.json?.decision?.route === "use_tools",
  `${r.ms}ms answer="${String(r.json?.answer?.content ?? "").slice(0, 80)}" url=${maps?.url ?? "-"}`,
);

// 4) Booking tool with full details -> BOOK line + calendar link + row
r = await turn("I'd like to book a haircut tomorrow at 5pm, my name is John Doe, call me 555-0134");
const cal = (r.json?.toolResults ?? []).find((t) => t.type === "calendar");
console.log(`      booking turn: ${r.ms}ms route=${r.json?.decision?.route} :: "${String(r.json?.answer?.content ?? "").slice(0, 140)}"`);
if (!cal) {
  // LLM may be collecting details across turns — nudge once more.
  r = await turn("My name is John Doe and I want it tomorrow at 5pm");
}
const cal2 = (r.json?.toolResults ?? []).find((t) => t.type === "calendar");
ok(
  "booking -> calendar tool result",
  !!cal || !!cal2,
  `url=${(cal ?? cal2)?.url ?? "MISSING"} :: "${String(r.json?.answer?.content ?? "").slice(0, 120)}"`,
);

r = await call("GET", `/v1/bookings?workspaceId=${wsId}`);
const booking = r.json?.items?.[0];
ok(
  "booking persisted",
  (r.json?.total ?? 0) >= 1 && !!booking?.customerName,
  `rows=${r.json?.total} name=${booking?.customerName ?? "-"} when=${booking?.startsAt ?? "-"}`,
);

// 5) Chunked text upload (two parts into one document)
const part1 = Buffer.from("# Handbook\nCity Hair Studio opens at 10am.\n").toString("base64");
r = await call("POST", "/v1/knowledge/upload", { workspaceId: wsId, filename: "handbook.txt", contentBase64: part1, title: "Handbook" });
ok("upload part 1", r.status === 201 && !!r.json?.documentId, `${r.status} ${r.json?.chunkCount ?? r.json?.error} chunks in ${r.ms}ms`);
const docId = r.json?.documentId;
if (docId) {
  // Browser chunk loop sends later parts through ingest with documentId (same doc).
  r = await call("POST", "/v1/knowledge/ingest", { workspaceId: wsId, title: "Handbook", markdown: "Parking is free behind the building. Ask reception for towels.", documentId: docId });
  ok("upload part 2 (append)", r.status === 201 && r.json?.documentId === docId, `${r.status} doc=${r.json?.documentId} chunks=${r.json?.chunkCount}`);

  // append path via ingest with documentId (mirrors the browser chunk loop)
  r = await call("POST", "/v1/knowledge/ingest", { workspaceId: wsId, title: "Handbook", markdown: "Reception closes at 9pm sharp.", documentId: docId });
  ok("ingest append to same doc", r.status === 201 && r.json?.documentId === docId, `chunks=${r.json?.chunkCount}`);

  r = await call("POST", "/v1/knowledge/search", { workspaceId: wsId, query: "parking", topK: 3 });
  ok("search finds uploaded part", (r.json?.items ?? []).some((h) => /parking/i.test(h.content)), `hits=${r.json?.items?.length ?? 0}`);
}

console.log(process.exitCode ? "FEATURES E2E FAILED" : "FEATURES E2E DONE");
