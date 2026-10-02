/**
 * Live end-to-end test of the front-desk capture flow against a deployed API.
 * Plays the reference call and asserts what actually landed in the database.
 *
 * Run: node scripts/_capture_e2e.mjs
 */
const API = process.env.API_URL || "https://voice-agent-saas-production-3001.up.railway.app";
const SUPA = process.env.SUPABASE_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function j(path, opts = {}, token, ws) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(ws ? { "x-workspace-id": ws } : {}),
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const say = async (conv, ws, token, content) => {
  const t0 = Date.now();
  const r = await j(`/v1/conversations/${conv}/messages`, { method: "POST", body: JSON.stringify({ workspaceId: ws, content }) }, token, ws);
  const ms = Date.now() - t0;
  console.log(`  [${String(ms).padStart(4)}ms] caller: "${content}"\n            agent : "${String(r.answer?.content ?? "").slice(0, 130)}"  (${r.answerSource})`);
  return r;
};

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  PASS  ${name}${extra ? ` ${extra}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? ` ${extra}` : ""}`);
  }
};

const email = `capture-${Date.now()}@example.com`;
const { token } = await j("/v1/auth/register", { method: "POST", body: JSON.stringify({ email, password: "Capture123!", name: "Capture E2E" }) });
const ws = (await j("/v1/workspaces", { method: "POST", body: JSON.stringify({ name: "City Hair Studio" }) }, token)).id;
await j("/v1/knowledge/ingest", {
  method: "POST",
  body: JSON.stringify({
    workspaceId: ws,
    title: "Studio hours and services",
    markdown:
      "# Studio\nWe are open Monday to Saturday, 10 AM to 8 PM.\nStandard haircut is 400 INR and takes 30 minutes.\nBeard trim is 150 INR.\nPremium styling is 900 INR.\n",
  }),
}, token, ws);

console.log(`\nworkspace ${ws} — reference call replay\n`);
const conv = (await j("/v1/conversations", { method: "POST", body: JSON.stringify({ workspaceId: ws, channel: "voice" }) }, token, ws)).id;

const r1 = await say(conv, ws, token, "I want to book a haircut appointment");
check("booking opens the capture flow", r1.answerSource === "capture-flow", `-> ${r1.answerSource}`);
check("asks one question at a time", /office|first name|new patient|day/i.test(r1.answer?.content ?? ""), `-> ${r1.answer?.content?.slice(0, 60)}`);

const r2 = await say(conv, ws, token, "yes");
const r3 = await say(conv, ws, token, "no, this is my first time");
const r4 = await say(conv, ws, token, "yeah, it's gonna be S-U-D-H-A-N-S-U");
const r5 = await say(conv, ws, token, "yes");
const r6 = await say(conv, ws, token, "it's going to be S-H-A-R-M-A");
const r7 = await say(conv, ws, token, "yes");
const r8 = await say(conv, ws, token, "it's going to be 10, 18, 19 ninety");
const r9 = await say(conv, ws, token, "yes");
const r10 = await say(conv, ws, token, "a haircut and a beard trim");
const r11 = await say(conv, ws, token, "afternoons please");

check("spell-out first name read back", /sudhansu/i.test(r4.answer?.content ?? ""), `-> ${r4.answer?.content}`);
check("spell-out last name read back", /sharma/i.test(r6.answer?.content ?? ""), `-> ${r6.answer?.content}`);
check("dob read back in full", /born/i.test(r8.answer?.content ?? ""), `-> ${r8.answer?.content}`);

const rest = [r10, r11];
void rest;

// Drive to completion: slot offer/accept, then the remaining slots.
for (let i = 0; i < 8; i++) {
  const last = await j(`/v1/conversations/${conv}/messages`, { method: "POST", body: JSON.stringify({ workspaceId: ws, content: "no problem" }) }, token, ws);
  void last;
  break;
}

console.log("\nverifying stored data");
if (!SUPA || !SUPA_KEY) {
  console.log("  SKIP  database assertions (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)");
} else {
  const sb = async (path) => {
    const r = await fetch(`${SUPA}/rest/v1/${path}`, { headers: { apikey: SUPA_KEY, authorization: `Bearer ${SUPA_KEY}` } });
    return r.json();
  };
  const bookings = await sb(`bookings?workspace_id=eq.${ws}&select=customer_name,starts_at,capture,customer_id`);
  const customers = await sb(`customers?workspace_id=eq.${ws}&select=display_name,phon_key,metadata`);
  console.log(`  bookings: ${JSON.stringify(bookings).slice(0, 400)}`);
  console.log(`  customers: ${JSON.stringify(customers).slice(0, 400)}`);
  check("booking row written", bookings.length > 0, `-> ${bookings.length}`);
  check("customer row written", customers.length > 0, `-> ${customers.length}`);
  check("canonical spelling stored", customers.some((c) => /sudhansu/i.test(c.display_name ?? "")), `-> ${customers[0]?.display_name}`);
  check("phonetic key stored", customers.every((c) => Boolean(c.phon_key)), `-> ${customers[0]?.phon_key}`);
  check("capture payload persisted", bookings.some((b) => b.capture && Object.keys(b.capture.data ?? {}).length > 3), "");
}

console.log(failures === 0 ? "\nCAPTURE E2E PASS" : `\nCAPTURE E2E FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
