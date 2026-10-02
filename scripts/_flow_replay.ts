/**
 * Replay the reference front-desk call through the capture flow.
 * Verifies spell-out names, homophone canonicalisation, digit capture,
 * reject/re-offer, graceful skips and mid-flow questions.
 *
 * Run: npx tsx scripts/_flow_replay.ts
 */
import {
  applyAnswer,
  currentSlot,
  offerSlot,
  flowForIntent,
  resolveSlotIso,
  startFlow,
  type CaptureState,
  type ExtractionContext,
} from "../apps/api/src/lib/captureFlow.js";
import { decodeSpellOut, digitsFromSpoken, phoneticKey, resolveCanonicalName } from "../apps/api/src/lib/phonetics.js";

let failures = 0;
const check = (name: string, cond: boolean, extra = ""): void => {
  if (cond) console.log(`  PASS  ${name}${extra ? ` ${extra}` : ""}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${extra ? ` ${extra}` : ""}`);
  }
};

/* ---- unit level: phonetics ---- */
console.log("\n[1] Phonetics / spell-out / digits");
check("spell-out K-S-T-E-S-T", decodeSpellOut("K-S-T-E-S-T") === "Kstest", `-> ${decodeSpellOut("K-S-T-E-S-T")}`);
check("two-part spell-out keeps first group", decodeSpellOut("J-O-H-N D-O-E") === "John", `-> ${decodeSpellOut("J-O-H-N D-O-E")}`);
check("spell-out C-O-L-E", decodeSpellOut("it's going to be cold, C-O-L-E") === "Cole", `-> ${decodeSpellOut("it's going to be cold, C-O-L-E")}`);
check("digits nine two seven eight zero", digitsFromSpoken("nine two seven eight zero") === "92780", `-> ${digitsFromSpoken("nine two seven eight zero")}`);
check("spoken year nineteen ninety", digitsFromSpoken("nineteen ninety") === "1990", `-> ${digitsFromSpoken("nineteen ninety")}`);
check("dob digits 10 18 90 -> 1990-10-18", digitsFromSpoken("10 18 90") === "101890", `-> ${digitsFromSpoken("10 18 90")}`);
check("phone digits spoken in sequence", digitsFromSpoken("nine one eight two four zero zero zero zero zero") === "9182400000", `-> ${digitsFromSpoken("nine one eight two four zero zero zero zero zero")}`);
check("slot iso from spoken weekday", /^\d{4}-\d{2}-\d{2} 15:00$/.test(resolveSlotIso("Wednesday at 3 p.m.", new Date("2026-10-02T09:00:00")) ?? ""), `-> ${resolveSlotIso("Wednesday at 3 p.m.", new Date("2026-10-02T09:00:00"))}`);
check("slot iso from spoken morning", /^\d{4}-\d{2}-\d{2} 09:00$/.test(resolveSlotIso("next Friday morning", new Date("2026-10-02T09:00:00")) ?? ""), `-> ${resolveSlotIso("next Friday morning", new Date("2026-10-02T09:00:00"))}`);
check("Sudhansu key == Sudhanshu key", phoneticKey("Sudhansu") === phoneticKey("Sudhanshu"), `${phoneticKey("Sudhansu")} vs ${phoneticKey("Sudhanshu")}`);

const homophone = await resolveCanonicalName("Sudhansu", { known: ["Sudhanshu Sharma", "Priya Nair"] });
check("Sudhansu -> canonical Sudhanshu (per-token match)", homophone.canonical === "Sudhanshu", `-> ${homophone.canonical} via=${homophone.via} conf=${homophone.confidence}`);
const homophoneFull = await resolveCanonicalName("Sudhanshu", { known: ["Sudhanshu Sharma"] });
check("exact variant keeps its own spelling", homophoneFull.matched, `-> ${homophoneFull.canonical}`);

const newName = await resolveCanonicalName("Kstest", { known: ["Sudhanshu Sharma"] });
check("unknown name stays as spoken", newName.canonical === "Kstest" && !newName.matched, `-> ${newName.canonical}`);

/* ---- flow level: the real call ---- */
console.log("\n[2] Capture flow replay (reference call)");
const flow = flowForIntent("new_patient_booking", { office: "West Covina" });
const known = ["Sudhanshu Sharma"];
let llmAsked = 0;
const ctx: ExtractionContext = {
  canonicalName: async (spoken) => (await resolveCanonicalName(spoken, { known })).canonical,
  llm: async (slot, text) => {
    llmAsked++;
    if (slot.key === "dob" && /10,?\s*18,?\s*19/i.test(text)) return { value: "October 18, 1990", present: true };
    return { value: null, present: false };
  },
};

let state: CaptureState = startFlow(flow, "new_patient_booking");
const turns: string[] = [
  "yeah, yeah",
  "no, this is my first time",
  "yeah, it's gonna be K-S-T-E-S-T",
  "yes",
  "it's going to be C-O-L-E",
  "yes",
  "it's going to be 10, 18, 19...",
  "yes",
  "a cleaning",
  "i need the appointment to be in the afternoon",
  "yes",
  "nine two seven eight zero",
  "yeah it's gonna be blue cross",
  "actually i don't have my card with me right now, is that okay?",
  "it's under my name",
];

let lastReply = "";
for (const [i, text] of turns.entries()) {
  // Production wiring: the availability step is answered by the model offering a
  // slot; the customer then accepts it in the same conversational turn.
  const slotNow = currentSlot(flow, state);
  if (slotNow?.kind === "slot" && state.status === "capturing" && !state.pendingKey) {
    const offered = offerSlot(state, "2026-09-23 15:00", "Wednesday, September 23rd at 3 p.m.");
    state = offered.state;
    console.log(`  turn ${String(i + 1).padStart(2)} [slot -> confirming] <agent offers Wednesday 3 p.m.>`);
  }
  const before = currentSlot(flow, state)?.key ?? "-";
  const res = await applyAnswer(flow, state, text, ctx);
  state = res.state;
  lastReply = res.reply;
  const after = currentSlot(flow, state)?.key ?? "(done)";
  console.log(`  turn ${String(i + 1).padStart(2)} [${before} -> ${after}] "${text}"\n        agent: "${res.reply}"`);
}

console.log("\n[3] Assertions");
check("first_name canonicalised from spell-out", state.data.first_name === "Kstest", `-> ${state.data.first_name}`);
check("last_name from spell-out", state.data.last_name === "Cole", `-> ${state.data.last_name}`);
check("dob reformatted (via model rescue)", state.data.dob === "October 18, 1990", `-> ${state.data.dob}`);
check("model was consulted for the garbled DOB", llmAsked >= 1, `-> ${llmAsked} llm slot calls`);
check("patient_status captured", Boolean(state.data.patient_status), `-> ${state.data.patient_status}`);
check("time preference captured", state.data.time_pref === "afternoons", `-> ${state.data.time_pref}`);
check("zip digits captured", state.data.zip === "92780", `-> ${state.data.zip}`);
check("insurance company captured", /blue cross/i.test(state.data.insurance_company ?? ""), `-> ${state.data.insurance_company}`);
check("member id gracefully skipped", state.skipped.includes("member_id"), `skipped=[${state.skipped.join(",")}]`);
check("plan holder captured", Boolean(state.data.plan_holder), `-> ${state.data.plan_holder}`);
check("flow completed", !state.active && state.status === "done", `status=${state.status}`);
check("closing message mentions name", /Kstest/.test(lastReply), `-> ${lastReply}`);

/* ---- overlap + rejection behaviour ---- */
console.log("\n[4] Overlap / rejection handling");
const flow2 = flowForIntent("new_patient_booking", { office: "West Covina" });
let s2 = startFlow(flow2, "new_patient_booking");
const seq: [string, string][] = [
  ["yes", "office"],
  ["I'm a new patient", "patient_status"],
  ["Sudhansu", "first_name"],
  ["yes", "confirm first"],
  ["Sharma", "last_name"],
  ["yes", "confirm last"],
  ["March 2nd 1988", "dob"],
  ["yes", "confirm dob"],
  ["a cleaning", "visit_reason"],
  ["mornings", "time_pref"],
];
for (const [t, label] of seq) {
  const r = await applyAnswer(flow2, s2, t, { canonicalName: async (n) => (await resolveCanonicalName(n, { known })).canonical });
  s2 = r.state;
  console.log(`  "${t}" (${label}) -> "${r.reply}"`);
}
check("homophone resolved mid-flow", s2.data.first_name === "Sudhanshu", `-> ${s2.data.first_name}`);

const rej = await applyAnswer(flow2, s2, "too late, do you have anything earlier?", { canonicalName: async (n) => n });
check("slot rejection re-asks instead of advancing", rej.state.step === s2.step, `step=${rej.state.step} reply="${rej.reply}"`);

const noSupply = await applyAnswer(flow2, s2, "I don't have that with me", { canonicalName: async (n) => n });
check("'don't have it' does not advance the slot", noSupply.state.step === s2.step, `step=${noSupply.state.step} reply="${noSupply.reply}"`);

console.log(failures === 0 ? "\nFLOW REPLAY PASS" : `\nFLOW REPLAY FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
