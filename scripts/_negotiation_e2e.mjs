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
const { token } = await j("/v1/auth/register", { method: "POST", body: JSON.stringify({ email: `nego-${Date.now()}@example.com`, password: "NegoTest123!", name: "Nego" }) });
const ws = (await j("/v1/workspaces", { method: "POST", body: JSON.stringify({ name: "Sunrise Dental" }) }, token)).id;
await j("/v1/agents", { method: "POST", body: JSON.stringify({ workspaceId: ws, name: "Sunrise Dental", language: "en", tone: "friendly", systemPrompt: "You are the front desk at Sunrise Dental.", location: "West Covina" }) }, token, ws);
const conv = (await j("/v1/conversations", { method: "POST", body: JSON.stringify({ workspaceId: ws, channel: "web" }) }, token, ws)).id;
const say = async (c) => {
  const r = await j(`/v1/conversations/${conv}/messages`, { method: "POST", body: JSON.stringify({ workspaceId: ws, content: c }) }, token, ws);
  const cap = r.capture;
  const done = cap?.slots?.filter(s => s.state !== "pending").length ?? 0;
  console.log(`"${c.slice(0, 40)}"\n   -> "${String(r.answer?.content ?? "").slice(0, 100)}"  [slots ${done}/${cap?.slots?.length ?? 0} status=${cap?.status ?? "-"} pending=${cap?.pending ?? "-"} declined=${(cap?.data?.declined_slots ?? "none").slice(0, 40)}]`);
  return r;
};
await say("I'd like to book an appointment");
await say("yes");
await say("new patient");
await say("M-A-Y-A P-A-T-E-L");
await say("yes");
await say("P-A-T-E-L");
await say("yes");
await say("January 12th 1990");
await say("yes");
await say("a cleaning");
const offer1 = await say("afternoons");
await say("no, I'm free any day");
const rej = await say("that's a little too late, do you have anything earlier?");
const rej2 = await say("hmm, that morning time won't work for me either, any other day?");
const lock = await say("yes");
await say("94107");
await say("self pay");
await say("I don't have my card with me");
const fin = await say("it's under my own name");
const b = await j(`/v1/bookings?workspaceId=${ws}`, {}, token, ws);
const row = b.items?.[0];
console.log(`\nBOOKING: ${row?.customerName} @ ${row?.startsAt} customer=${row?.customerId} zip=${row?.capture?.data?.zip} skipped=${JSON.stringify(row?.capture?.skipped)}`);
let fails = 0;
const ck = (n, c, x = "") => { if (c) console.log(`  PASS  ${n} ${x}`); else { fails++; console.log(`  FAIL  ${n} ${x}`); } };
ck("engine offered a real slot", /would .*work for you/i.test(offer1.answer?.content ?? ""), `-> ${offer1.answer?.content?.slice(0, 70)}`);
ck("'too late' produced a fresh re-offer", /would .*work for you/i.test(rej.answer?.content ?? ""), `-> ${rej.answer?.content?.slice(0, 80)}`);
ck("third negotiation records the decline and re-offers", /no problem/i.test(rej2.answer?.content ?? ""), `-> ${rej2.answer?.content?.slice(0, 80)}`);
ck("declined slot remembered", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(rej2.capture?.data?.declined_slots ?? "")), `-> ${rej2.capture?.data?.declined_slots}`);
ck("booking locked with an ISO slot", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(row?.startsAt ?? ""), `-> ${row?.startsAt}`);
ck("captured details stored", Boolean(row?.capture?.data?.zip) && (row?.capture?.skipped ?? []).includes("member_id"), `zip=${row?.capture?.data?.zip}`);
console.log(fails === 0 ? "\nNEGOTIATION E2E PASS" : `\nNEGOTIATION E2E FAIL (${fails})`);
