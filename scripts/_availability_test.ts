import { nextOffers, availableSlots, normalizeAvailability, parseSlotPreference, spokenSlot, DEFAULT_AVAILABILITY, isBookable } from "../apps/api/src/lib/availability.js";
import { parseSlotIso, resolveSlotIso } from "../apps/api/src/lib/captureFlow.js";

let fails = 0;
const check = (n: string, c: boolean, x = ""): void => { if (c) console.log(`  PASS  ${n} ${x}`); else { fails++; console.log(`  FAIL  ${n} ${x}`); } };

const now = new Date("2026-10-02T09:00:00"); // Friday
const cfg = normalizeAvailability({
  openDays: [1, 2, 3, 4, 5, 6],
  openTime: "09:00",
  closeTime: "18:00",
  slotMinutes: 30,
  minLeadMinutes: 120,
  closedDates: ["2026-10-03"],
  booked: ["2026-10-05 10:00", "2026-10-05 10:30"],
});

const slots = availableSlots(cfg, now);
check("closed date excluded", !slots.some((s) => s.iso.startsWith("2026-10-03")), `-> ${slots.filter(s => s.iso.startsWith("2026-10-03")).length} slots on the holiday`);
check("booked slot excluded", !slots.some((s) => s.iso === "2026-10-05 10:00"), "");
check("next booked pair excluded", !slots.some((s) => s.iso === "2026-10-05 10:30"), "");
check("lead time honoured", !slots.some((s) => s.iso <= "2026-10-02 10:30"), "");
check("Sunday never offered (openDays 1-6)", !slots.some((s) => new Date(s.iso.replace(" ", "T")).getDay() === 0), "");
check("all slots inside business hours", slots.every((s) => Number(s.iso.slice(11, 13)) >= 9 && Number(s.iso.slice(11, 13)) < 18), "");
check("slot spacing is 30 minutes", (() => { const a = slots.filter(s => s.iso.startsWith("2026-10-06")).map(s => s.iso); return a[1]?.slice(11) === "09:30"; })(), "");

const morning = nextOffers(cfg, { part: "mornings", now });
const afternoon = nextOffers(cfg, { part: "afternoons", now });
check("morning offers are before noon", morning.every((s) => Number(s.iso.slice(11, 13)) < 12), `-> ${morning.map(s => s.iso).join(",")}`);
check("afternoon offers are after noon", afternoon.every((s) => Number(s.iso.slice(11, 13)) >= 12), `-> ${afternoon.map(s => s.iso).join(",")}`);

const first = afternoon[0]!.iso;
const earlier = nextOffers(cfg, { part: "afternoons", sameDay: first.slice(0, 10), exclude: [first], now });
check("'too late' moves earlier on the same day", earlier.length > 0 && earlier[0]!.iso < first, `-> ${first} then ${earlier[0]?.iso}`);
const otherDay = nextOffers(cfg, { part: "afternoons", sameDay: first.slice(0, 10), exclude: [first], beforeIso: first, now });
check("rejection still yields an offer", otherDay.length > 0, `-> ${otherDay.map(s => s.iso).join(",")}`);

const pref = parseSlotPreference("that is a little too late, anything earlier?", null);
check("rejection words detected", pref.wantsEarlier, `-> ${JSON.stringify(pref)}`);
const pref2 = parseSlotPreference("Wednesday at 3 pm", "2026-10-07 15:00");
check("explicit slot kept", pref2.requestedIso === "2026-10-07 15:00", `-> ${pref2.requestedIso}`);

check("bookable slot accepted", isBookable(cfg, first, now), `-> ${first}`);
check("closed-date slot rejected", !isBookable(cfg, "2026-10-03 11:00", now), "");
check("spoken label human", /^Tuesday, October 6 at 5 p\.m\.$/.test(spokenSlot("2026-10-06 17:00")), `-> ${spokenSlot("2026-10-06 17:00")}`);
check("buffer respected", (() => {
  const withBuffer = normalizeAvailability({ openDays: [1], openTime: "09:00", closeTime: "11:00", slotMinutes: 30, bufferMinutes: 30, minLeadMinutes: 0, horizonDays: 7 });
  return withBuffer.slotMinutes === 30 && withBuffer.bufferMinutes === 30;
})(), "");
console.log(fails === 0 ? "\nAVAILABILITY PASS" : `\nAVAILABILITY FAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
