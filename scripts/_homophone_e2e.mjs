const API = "https://voice-agent-saas-production-3001.up.railway.app";
async function j(path, opts = {}, token, ws) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${API}${path}`, { ...opts, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ws ? { "x-workspace-id": ws } : {}) } });
      const t = await res.text();
      if (!res.ok) throw new Error(`${path} -> ${res.status}: ${t.slice(0, 200)}`);
      return t ? JSON.parse(t) : null;
    } catch (e) { if (i === 3) throw e; await new Promise(r => setTimeout(r, 600 * (i + 1))); }
  }
}
const { token } = await j("/v1/auth/register", { method: "POST", body: JSON.stringify({ email: `homo-${Date.now()}@example.com`, password: "HomoTest123!", name: "Homo" }) });
const ws = (await j("/v1/workspaces", { method: "POST", body: JSON.stringify({ name: "Homophone Clinic" }) }, token)).id;

async function book(nameSpelling, dob, when) {
  const conv = (await j("/v1/conversations", { method: "POST", body: JSON.stringify({ workspaceId: ws, channel: "voice" }) }, token, ws)).id;
  let n = 0;
  const say = async (c) => {
    const r = await j(`/v1/conversations/${conv}/messages`, { method: "POST", body: JSON.stringify({ workspaceId: ws, content: c }) }, token, ws);
    console.log(`   ${nameSpelling} #${String(++n).padStart(2)} caller:"${c}" -> "${String(r.answer?.content ?? "").slice(0, 88)}"`);
    return r;
  };
  await say("I need to book an appointment");
  await say("yes");
  await say("new patient");
  const r = await say(nameSpelling);
  await say("yes");
  await say("Sharma");
  await say("yes");
  await say(dob);
  await say("yes");
  await say("a consultation");
  await say("afternoons");
  await say(when);
  await say("yes");
  await say("110001");
  await say("self pay");
  await say("I don't have my card");
  await say("under my own name");
  return r;
}
await book("S-U-D-H-A-N-S-U", "March 2nd 1988", "tomorrow at 4 pm");
await book("Sudhanshu", "April 9th 1991", "tomorrow at 5 pm");

const b = await j(`/v1/bookings?workspaceId=${ws}`, {}, token, ws);
const rows = b.items ?? [];
console.log(`bookings=${rows.length}`);
for (const r of rows) console.log(`  name="${r.customerName}" when=${r.startsAt} customer=${r.customerId} dob=${r.capture?.data?.dob} skipped=${JSON.stringify(r.capture?.skipped)}`);
const ids = new Set(rows.map(r => r.customerId).filter(Boolean));
let fails = 0;
const ck = (n, c, x = "") => { if (c) console.log(`  PASS  ${n} ${x}`); else { fails++; console.log(`  FAIL  ${n} ${x}`); } };
ck("two bookings written", rows.length === 2, `-> ${rows.length}`);
ck("both resolve to ONE customer row (homophone dedupe)", ids.size === 1, `-> ${ids.size} distinct customerId(s)`);
ck("one consistent spelling on every booking", new Set(rows.map(r => r.customerName)).size === 1, `-> ${rows.map(r => r.customerName).join(" | ")}`);
ck("each booking keeps its own captured DOB", new Set(rows.map(r => r.capture?.data?.dob)).size === 2, `-> ${rows.map(r => r.capture?.data?.dob).join(" | ")}`);
ck("skipped slots recorded", rows.every(r => (r.capture?.skipped ?? []).includes("member_id")), `-> ${JSON.stringify(rows[0]?.capture?.skipped)}`);
console.log(fails === 0 ? "\nHOMOPHONE DEDUPE PASS" : `\nHOMOPHONE DEDUPE FAIL (${fails})`);
