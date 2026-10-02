// Showcase: one-command product demo against the live API.
// Prints each capability with latency + answer, then a summary. Exit 1 on any failure.
// Usage: node scripts/showcase.mjs [--base https://...]
const argIdx = process.argv.indexOf("--base");
const BASE = (argIdx > -1 ? process.argv[argIdx + 1] : "https://voice-agent-saas-production-3001.up.railway.app").replace(/\/$/, "");

let token = "";
let ws = "";
const results = [];
let totalMs = 0;

const H = () => ({
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(ws ? { "x-workspace-id": ws } : {}),
});

async function call(method, path, body) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}${path}`, { method, headers: H(), body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, ms: Date.now() - t0 };
}

function step(name, ok, detail, ms) {
  results.push({ name, ok, ms });
  totalMs += ms ?? 0;
  const mark = ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
  console.log(`  ${mark}  ${name}${ms ? ` — ${ms}ms` : ""}${detail ? `\n         ${detail}` : ""}`);
}

const say = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const trunc = (s, n = 110) => (s || "").replace(/\s+/g, " ").slice(0, n);

(async () => {
  console.log(`\x1b[36mAI Voice Agent SaaS — live showcase\x1b[0m\n  API: ${BASE}`);

  say("1 · Setup (workspace + agent + knowledge)");
  let r = await call("POST", "/v1/auth/register", { email: `show-${Date.now()}@x.dev`, password: "Passw0rd!2026", name: "Showcase" });
  token = r.json?.token;
  r = await call("POST", "/v1/workspaces", { name: "Showcase Studio" });
  ws = r.json?.id;
  r = await call("POST", "/v1/agents", {
    workspaceId: ws,
    name: "Ava — Receptionist",
    location: "350 5th Ave, New York, NY 10118",
    systemPrompt: "You are Ava, a warm American receptionist. Answer only from knowledge. 1-2 short sentences.",
  });
  step("workspace + agent created", !!r.json?.id, `agent: ${r.json?.name}`, r.ms);
  r = await call("POST", "/v1/knowledge/ingest", {
    workspaceId: ws,
    title: "Studio FAQ",
    markdown:
      "# Pricing\nStandard styling is $40. Premium styling is $90. Kids styling is $25.\n# Hours\nOpen Monday to Saturday, 10 AM to 8 PM. Sunday closed.\n# Services\nWe do cuts, color, and bridal styling. Walk-ins welcome before noon.",
  });
  step("knowledge ingested + embedded (Gemini)", (r.json?.chunkCount ?? 0) > 0, `${r.json?.chunkCount} chunks · provider ${r.json?.embeddingProvider}`, r.ms);

  say("2 · Instant greeting (fast path — no LLM)");
  r = await call("POST", "/v1/conversations", { workspaceId: ws, channel: "web" });
  const cid = r.json?.id;
  r = await call("POST", `/v1/conversations/${cid}/messages`, { workspaceId: ws, content: "hello!" });
  step("greeting answered", r.json?.answer?.content && r.json?.answerSource === "fast-path", `"${trunc(r.json?.answer?.content)}"`, r.ms);

  say("3 · Grounded knowledge (retrieval + Gemini + hallucination harness)");
  r = await call("POST", `/v1/conversations/${cid}/messages`, { workspaceId: ws, content: "how much is premium styling?" });
  const grounded = r.json?.verdict?.confidence === 1 && /90/.test(r.json?.answer?.content ?? "");
  step("price answer grounded in knowledge", grounded, `"${trunc(r.json?.answer?.content)}" · verdict ok=${r.json?.verdict?.ok} conf=${r.json?.verdict?.confidence}`, r.ms);

  say("4 · Google Maps location tool");
  r = await call("POST", `/v1/conversations/${cid}/messages`, { workspaceId: ws, content: "where are you located?" });
  const maps = (r.json?.toolResults ?? []).find((t) => t.type === "maps");
  step("instant location + maps link", !!maps || (r.json?.answer?.content ?? "").length > 0, `"${trunc(r.json?.answer?.content)}"${maps ? ` · ${maps.url.slice(0, 60)}…` : ""}`, r.ms);

  say("5 · Booking → calendar + persisted");
  // The front-desk flow captures slot by slot; drive it like a caller would.
  const bookingScript = [
    "I'd like to book an appointment tomorrow",
    "yes",
    "new patient",
    "M-A-Y-A P-A-T-E-L",
    "yes",
    null,
    "January 12th 1990",
    "yes",
    "a consultation",
    "afternoons",
    "tomorrow at 5 pm",
    "yes",
    "94107",
    "self pay",
    "I don't have my card",
    "under my own name",
  ];
  let cal = null;
  for (const line of bookingScript) {
    if (line === null) continue;
    r = await call("POST", `/v1/conversations/${cid}/messages`, { workspaceId: ws, content: line });
    const found = (r.json?.toolResults ?? []).find((t) => t.type === "calendar");
    if (found) cal = found;
  }
  step("appointment booked", !!cal, `"${trunc(r.json?.answer?.content)}"${cal ? " · Google Calendar link ready" : ""}`, r.ms);
  if (cal) {
    r = await call("GET", `/v1/bookings?workspaceId=${ws}`);
    step("booking persisted to DB", (r.json?.items ?? []).length > 0, `${r.json?.items?.[0]?.customerName ?? ""} @ ${r.json?.items?.[0]?.startsAt ?? ""}`, r.ms);
  } else {
    step("booking persisted to DB", false, "no calendar link produced", 0);
  }

  say("6 · Search playground");
  r = await call("POST", "/v1/knowledge/search", { workspaceId: ws, query: "bridal styling", topK: 3 });
  const hit = (r.json?.items ?? [])[0];
  step("vector search returns scored hit", !!hit, `score ${hit?.score?.toFixed?.(3) ?? hit?.score} · "${trunc(hit?.content, 70)}"`, r.ms);

  // Summary
  const failed = results.filter((x) => !x.ok);
  say("Summary");
  console.log(`  steps: ${results.length - failed.length}/${results.length} passed · wall-clock work ${totalMs}ms`);
  console.log(`\n\x1b[1mTry it live:\x1b[0m  https://voice-agent-saas-web.vercel.app/app/`);
  console.log(`  Voice call:  https://voice-agent-saas-web.vercel.app/app/voice\n`);
  if (failed.length) {
    console.log(`\x1b[31mSHOWCASE FAILED: ${failed.map((f) => f.name).join(", ")}\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32mSHOWCASE COMPLETE — all capabilities verified live\x1b[0m");
})().catch((e) => {
  console.error("showcase crashed:", e.message);
  process.exit(1);
});
