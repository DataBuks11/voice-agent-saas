import { flowForIntent, applyAnswer, startFlow } from "../apps/api/src/lib/captureFlow.js";
import { resolveCanonicalName } from "../apps/api/src/lib/phonetics.js";
import { nextOffers, normalizeAvailability, spokenSlot } from "../apps/api/src/lib/availability.js";

let fails = 0;
const check = (n: string, c: boolean, x = ""): void => { if (c) console.log(`  PASS  ${n} ${x}`); else { fails++; console.log(`  FAIL  ${n} ${x}`); } };

// ---- patient / deceased-body intake ----
console.log("\n[A] patient intake flow (Hindi-style call)");
const intake = flowForIntent("patient_intake", { service: "body shifting" });
const ctx = { canonicalName: async (n: string) => (await resolveCanonicalName(n, { known: ["Sudhanshu Sharma"] })).canonical };
let s = startFlow(intake, "patient_intake");
const script = ["for the patient", "S-U-D-H-A-N-S-U", "yes", "62 years", "yes", "City Hospital, Sector 12", "yes", "nine eight seven six five four three two one", "yes", "tomorrow at 9 am", "yes", "no that's everything"];
for (const [i, line] of script.entries()) {
  const r = await applyAnswer(intake, s, line, ctx);
  s = r.state;
  console.log(`  #${String(i + 1).padStart(2)} "${line.slice(0, 34)}" -> "${r.reply.slice(0, 86)}"`);
}
check("patient name captured from spell-out", s.data.patient_name === "Sudhanshu", `-> ${s.data.patient_name}`);
check("hospital captured", /City Hospital/i.test(s.data.hospital ?? ""), `-> ${s.data.hospital}`);
check("callback number captured", s.data.caller_phone === "987654321", `-> ${s.data.caller_phone}`);
check("notes gracefully skipped", s.skipped.includes("notes"), `skipped=[${s.skipped.join(",")}]`);
check("flow completed", !s.active && s.status === "done", `-> ${s.status}`);

// ---- rejection loop against the engine, exactly like the recording ----
console.log("\n[B] recording-style slot negotiation");
const cfg = normalizeAvailability({
  openDays: [1, 2, 3, 4, 5, 6], openTime: "09:00", closeTime: "18:00",
  slotMinutes: 30, minLeadMinutes: 60, closedDates: ["2026-10-03"],
});
const now = new Date("2026-10-02T09:00:00");
const declined: string[] = [];
const first = nextOffers(cfg, { part: "afternoons", now, limit: 1 })[0]!;
check("first offer exists", Boolean(first.iso), `-> ${first.iso}`);
const earlier = nextOffers(cfg, { part: "afternoons", now, exclude: [...declined, first.iso], sameDay: first.iso.slice(0, 10), beforeIso: first.iso, limit: 2 });
check("re-offer moves earlier after 'too late'", earlier.length > 0 && earlier[0]!.iso < first.iso, `-> ${first.iso} -> ${earlier.map((e) => e.iso).join(", ")}`);
const morningInstead = nextOffers(cfg, { part: "afternoons", now, exclude: [...declined, first.iso], sameDay: first.iso.slice(0, 10), beforeIso: earlier[0]?.iso, limit: 1 });
check("third offer still available", morningInstead.length > 0, `-> ${morningInstead.map((e) => e.iso).join(", ")}`);
check("spoken label matches the recording style", /^[A-Z][a-z]+, October \d+ at \d{1,2}(:\d{2})? (a|p)\.m\.$/.test(spokenSlot(first.iso)), `-> ${spokenSlot(first.iso)}`);
console.log(fails === 0 ? "\nDOMAIN + ENGINE PASS" : `\nDOMAIN + ENGINE FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
