/**
 * Slot-capture conversation flow (mirrors a real front-desk call).
 *
 * Every captured detail is spoken back and confirmed before it is written, so a
 * mangled STT transcript or a "Sudhansu"/"Sudhanshu" spelling never lands in the
 * database as a new person. Missing information is skipped gracefully instead of
 * stalling the call, and one utterance can both answer the pending question and
 * raise a new one (mid-sentence overlap while the agent is still speaking).
 */

import { digitsFromSpoken, findSpellOutRun, isAffirmative, isNegative, titleCase } from "./phonetics.js";

export type SlotKind = "confirm" | "name" | "date" | "time_pref" | "digits" | "text" | "slot";

export interface SlotDef {
  key: string;
  kind: SlotKind;
  prompt: string;
  /** Spoken back for confirmation; omit to skip the confirm step. */
  readback?: (value: string, data: CaptureData) => string;
  optional?: boolean;
  digits?: number;
  /** Canonical value -> pattern, tried before the kind's default extraction. */
  patterns?: Record<string, RegExp>;
  /** Absent-by-design variants ("I don't have it", "skip"). */
  absentPhrases?: RegExp;
  /** Plausible-age window for date slots; implausible parses fall back to the LLM. */
  minAgeYears?: number;
  maxAgeYears?: number;
  /** When true the reply asks for one thing only (never two questions). */
  singleQuestion?: boolean;
}

export type CaptureData = Record<string, string>;

export interface CaptureState {
  active: boolean;
  intent: string;
  step: number;
  status: "capturing" | "confirming" | "done" | "abandoned";
  pendingKey?: string;
  pendingValue?: string;
  pendingIso?: string;
  data: CaptureData;
  skipped: string[];
  updatedAt: string;
}

export const emptyState = (intent = "booking"): CaptureState => ({
  active: false,
  intent,
  step: 0,
  status: "done",
  data: {},
  skipped: [],
  updatedAt: new Date().toISOString(),
});

const ABSENT = /\b(don'?t have|do ?n'?t have|did ?n'?t bring|not (with )?me|no idea|don'?t know|does ?n'?t (have|matter)|skip|forget it|can'?t find|left (it|them) at home|not available|that'?s (everything|all)|nothing else|no more|that'?s it)\b/i;

/* ------------------------------------------------------------------ flows */

export const newPatientFlow = (opts: { office?: string; service?: string } = {}): SlotDef[] => [
  {
    key: "office",
    kind: "confirm",
    prompt: opts.office
      ? `Are you calling about our ${opts.office} office?`
      : "Are you calling about our main office?",
    patterns: { yes: /^(yes|yeah|yep|yup|sure|right|correct|ok|okay)\b/i },
  },
  {
    key: "patient_status",
    kind: "confirm",
    prompt: "Are you a new patient, or have you visited us before?",
    patterns: {
      new: /\b(new|first time|never been|haven'?t been|first visit|new patient)\b/i,
      returning: /\b(before|been here|returning|regular|already (been|come)|seen before)\b/i,
    },
  },
  {
    key: "first_name",
    kind: "name",
    prompt: "Could I get your first name, spelled out for me?",
    readback: (v) => `So your first name is ${v}. Is that right?`,
  },
  {
    key: "last_name",
    kind: "name",
    prompt: "And your last name, spelled out please?",
    readback: (v) => `Thank you. ${v} — is that correct?`,
  },
  {
    key: "dob",
    kind: "date",
    prompt: "And your date of birth?",
    readback: (v) => `Just to confirm — you're born ${v}. Is that right?`,
    minAgeYears: 16,
    maxAgeYears: 110,
  },
  {
    key: "visit_reason",
    kind: "text",
    prompt: opts.service
      ? `I can book that. What exactly would you like looked at — ${opts.service}?`
      : "What would you like to book today?",
    singleQuestion: true,
  },
  {
    key: "time_pref",
    kind: "time_pref",
    prompt: "Do you usually prefer mornings or afternoons?",
    patterns: { mornings: /\b(morning|early)/i, afternoons: /\b(afternoon|mid ?day)/i, evenings: /\b(evening|night)/i },
  },
  {
    key: "appointment",
    kind: "slot",
    prompt: "What day and time works best for you?",
    readback: (v) => `So that's ${v.replace(/[.?!]+\s*$/, "")}. Shall I lock that in?`,
    singleQuestion: true,
  },
  {
    key: "zip",
    kind: "digits",
    digits: 5,
    prompt: "Could I get the five-digit zip code?",
    absentPhrases: ABSENT,
    optional: true,
  },
  {
    key: "insurance_company",
    kind: "text",
    prompt: "Will you be using insurance for this visit? If so, which company?",
    patterns: { self_pay: /\b(no insurance|self ?pay|pay (it )?myself|cash|paying myself|without insurance)\b/i },
    absentPhrases: ABSENT,
    optional: true,
    singleQuestion: true,
  },
  {
    key: "member_id",
    kind: "text",
    prompt: "And the member ID on the card, please?",
    absentPhrases: ABSENT,
    optional: true,
  },
  {
    key: "plan_holder",
    kind: "confirm",
    prompt: "Is the plan under your own name?",
    patterns: {
      yes: /\b(yes|yeah|yep|under my (own )?name|it'?s (under )?my name|my own name|same name|my name)\b/i,
      no: /\b(not mine|someone else|my (husband|wife|father|mother|son|daughter|brother|sister)|spouse|parent)\b/i,
    },
    absentPhrases: ABSENT,
    optional: true,
  },
];

/**
 * Patient / deceased-body intake (hospital, ambulance, dead-body shifting).
 * Same confirm-everything discipline, different slots: who is calling, for whom,
 * where, and when — the details a real family call needs.
 */
export const patientIntakeFlow = (opts: { office?: string; service?: string } = {}): SlotDef[] => [
  {
    key: "caller_relation",
    kind: "text",
    prompt: opts.service
      ? `I am sorry for your loss. Is this for ${opts.service}?`
      : "I am sorry for your loss. Is this for the patient, or a relative?",
    singleQuestion: true,
  },
  {
    key: "patient_name",
    kind: "name",
    prompt: "Could I get the patient's name, spelled out for me?",
    readback: (v) => `So the patient's name is ${v}. Is that correct?`,
  },
  {
    key: "patient_age",
    kind: "text",
    prompt: "And how old is the patient?",
    readback: (v) => `Noted — ${v}.`,
    singleQuestion: true,
  },
  {
    key: "hospital",
    kind: "text",
    prompt: "Which hospital or address are they at?",
    readback: (v) => `Thank you. ${v} — is that right?`,
  },
  {
    key: "caller_phone",
    kind: "digits",
    prompt: "And a phone number where we can call you right now?",
    readback: (v) => `I have ${v}. We will call you on this number.`,
    singleQuestion: true,
  },
  {
    key: "appointment",
    kind: "slot",
    prompt: "When should our team reach you?",
    readback: (v) => `So that's ${v.replace(/[.?!]+\s*$/, "")}. Shall I lock that in?`,
    singleQuestion: true,
  },
  {
    key: "notes",
    kind: "text",
    prompt: "Is there anything else we should know before we send the team?",
    absentPhrases: ABSENT,
    optional: true,
  },
];

export const flowForIntent = (intent: string, opts: { office?: string; service?: string } = {}): SlotDef[] => {
  if (intent === "patient_intake") return patientIntakeFlow(opts);
  return newPatientFlow(opts);
};

/* --------------------------------------------------------- value extraction */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const prettyDate = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
};

const prettySlot = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const hh = d.getHours();
  const mm = d.getMinutes();
  const suffix = hh >= 12 ? "p.m." : "a.m.";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${date} at ${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${suffix}`;
};

export function normalizeDate(
  text: string,
  opts: { minAgeYears?: number; maxAgeYears?: number } = {},
): string | null {
  const t = text.toLowerCase();
  const now = new Date();
  const thisYear = now.getFullYear();
  const sane = (iso: string | null): string | null => {
    if (!iso) return null;
    const year = Number(iso.slice(0, 4));
    // STT often drops a century ("nineteen ninety" -> "1990" -> "90"): hand
    // ambiguous years to the model instead of inventing a birthday.
    if (!Number.isFinite(year) || year < 1900 || year > thisYear) return null;
    if (opts.minAgeYears != null || opts.maxAgeYears != null) {
      const age = (now.getTime() - new Date(iso).getTime()) / (365.2425 * 86400000);
      const min = opts.minAgeYears ?? 0;
      const max = opts.maxAgeYears ?? 130;
      if (age < min || age > max) return null;
    }
    return iso;
  };
  const explicit = t.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit) return sane(`${explicit[1]}-${explicit[2]}-${explicit[3]}`);

  const monthIdx = MONTHS.findIndex((m) => t.includes(m));
  const dayMatch = t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
  const yearMatch = t.match(/\b(19|20)\d{2}\b/);

  if (monthIdx >= 0 && dayMatch) {
    const year = yearMatch ? Number(yearMatch[0]) : thisYear;
    return sane(`${year}-${String(monthIdx + 1).padStart(2, "0")}-${String(Number(dayMatch[1])).padStart(2, "0")}`);
  }
  const spoken = digitsFromSpoken(t);
  if (spoken && spoken.length >= 6) {
    if (spoken.length === 8) return sane(`${spoken.slice(4)}-${spoken.slice(0, 2)}-${spoken.slice(2, 4)}`);
    if (spoken.length === 6) return sane(`19${spoken.slice(4)}-${spoken.slice(0, 2)}-${spoken.slice(2, 4)}`);
  }
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return sane(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }
  return null;
}

const stripLead = (text: string): string =>
  text
    .replace(/^\s*(it'?s|its|my name is|name is|this is|i'?m|i am|that'?s|that is)\s+/i, "")
    .replace(/[.?!]+\s*$/, "")
    .trim();

const NAME_STOPWORDS = new Set([
  "a", "an", "the", "yes", "no", "yeah", "yep", "nope", "ok", "okay", "sure", "thanks", "thank",
  "hi", "hello", "hey", "my", "name", "is", "it", "its", "im", "am", "and", "of", "to", "for",
  "cleaning", "appointment", "checkup", "check", "doctor", "dentist", "visit", "call", "book",
  "booking", "schedule", "time", "day", "date", "today", "tomorrow", "monday", "tuesday",
  "wednesday", "thursday", "friday", "saturday", "sunday", "morning", "afternoon", "evening",
  "card", "insurance", "id", "zip", "code", "number", "gonna", "lets", "let", "here",
]);

const MONTH_WORDS = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const WEEKDAY_WORDS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

/** Dates, times and numbers are never names — "January 12th 1990" is a DOB answer. */
const looksLikeDateOrNumber = (text: string): boolean =>
  MONTH_WORDS.test(text) ||
  WEEKDAY_WORDS.test(text) ||
  /\b(19|20)\d{2}\b/.test(text) ||
  /\b\d{1,2}\s*(st|nd|rd|th)\b/i.test(text) ||
  /\b\d{1,2}\s*[:/]\s*\d{2}\b/.test(text) ||
  /^\W*\d+/.test(text.trim());

const isPlausibleName = (value: string): boolean => {
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  if (words.every((w) => NAME_STOPWORDS.has(w))) return false;
  if (words.some((w) => w.length > 22)) return false;
  if (words.some((w) => /^\d/.test(w))) return false;
  if (looksLikeDateOrNumber(value)) return false;
  return true;
};

/** Uppercase lone letters so "M-a-y-a P-a-t-e-l" reads as a spelled-out run. */
const upcaseSpellLetters = (text: string): string =>
  text.replace(/(^|[\s\-.,])[a-z](?=[\s\-.,]|$)/g, (m, p: string) => `${p}${m.slice(p.length).toUpperCase()}`);

export function extractName(text: string): string | null {
  if (looksLikeDateOrNumber(text)) return null;
  const spelled = findSpellOutRun(upcaseSpellLetters(text));
  if (spelled && isPlausibleName(spelled.letters)) return spelled.letters;
  const stripped = stripLead(text);
  const words = stripped.split(/\s+/).filter((w) => /^[\p{L}'-]+$/u.test(w) && w.length <= 22);
  if (!words.length) return null;
  const meaningful = words.filter((w) => !NAME_STOPWORDS.has(w.toLowerCase()));
  if (!meaningful.length) return null;
  const candidate = titleCase(meaningful.slice(0, 3).join(" "));
  return isPlausibleName(candidate) ? candidate : null;
}

export function extractTimePref(text: string): string | null {
  const t = text.toLowerCase();
  if (/\b(morning|early|before (9|10|11|12|noon))\b/.test(t)) return "mornings";
  if (/\b(evening|night|after \d|late)\b/.test(t)) return "evenings";
  if (/\b(afternoon|mid ?day|post ?lunch)\b/.test(t)) return "afternoons";
  return null;
}

export function extractDigits(text: string, expected?: number): string | null {
  const raw = text.match(/\b\d{3,}\b/);
  if (raw) return expected && raw[0].length !== expected ? raw[0] : raw[0];
  const spoken = digitsFromSpoken(text);
  if (spoken) return spoken;
  return null;
}

/** Free-text slot: strip filler, reject obvious non-answers. */
export function extractText(text: string): string | null {
  const v = stripLead(text);
  if (!v || v.length < 2 || v.length > 140) return null;
  if (isQuestionLike(text)) return null;
  if (/^(too (late|early)|can (you|we) (do|have)|do you have|anything earlier|not really|no thanks|nothing)\b/i.test(v)) return null;
  return v;
}

export interface ExtractionContext {
  /** Canonicalizer for names (phonetic/homophone resolution). */
  canonicalName?: (spoken: string) => Promise<string>;
  /** LLM fallback for messy utterances; JSON {value, present, iso?}. */
  llm?: (
    slot: SlotDef,
    text: string,
    data: CaptureData,
  ) => Promise<{ value?: string | null; present?: boolean; iso?: string | null } | null>;
}

const WEEKDAY_OFFSETS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/**
 * Turn a spoken slot ("Wednesday at 3 p.m.", "next Tuesday morning") into a
 * concrete local datetime. Used when the model did not return an ISO value.
 */
export function resolveSlotIso(spoken: string, now: Date = new Date()): string | null {
  const text = spoken.toLowerCase();
  const isoDate = normalizeDate(text);
  let year = now.getFullYear();
  let month = now.getMonth() + 1;
  let day = now.getDate();

  const explicit = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (explicit) {
    year = Number(explicit[1]);
    month = Number(explicit[2]);
    day = Number(explicit[3]);
  } else if (isoDate) {
    year = Number(isoDate.slice(0, 4));
    month = Number(isoDate.slice(5, 7));
    day = Number(isoDate.slice(8, 10));
  } else {
    const named = Object.keys(WEEKDAY_OFFSETS).find((d) => text.includes(d));
    if (named) {
      const target = WEEKDAY_OFFSETS[named] ?? 0;
      const delta = (target - now.getDay() + 7) % 7 || 7;
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + delta);
      year = next.getFullYear();
      month = next.getMonth() + 1;
      day = next.getDate();
    }
  }

  let hour = 9;
  let minute = 0;
  const time = text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/);
  if (time) {
    hour = Number(time[1]);
    minute = Number(time[2] ?? 0);
    const meridiem = (time[3] ?? "").replace(/\./g, "");
    if (meridiem.startsWith("p") && hour < 12) hour += 12;
    if (meridiem.startsWith("a") && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return null;
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}`;
}

const SLOT_CUE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|next|\d{1,2}\s*[:.]?\d{0,2}\s*(a\.?m\.?|p\.?m\.?)?|morning|afternoon|evening|mid ?day|noon)\b/i;

export function parseSlotIso(text: string): string | null {
  if (!SLOT_CUE.test(text)) return null;
  return resolveSlotIso(text);
}

export async function extractSlotValue(
  slot: SlotDef,
  text: string,
  data: CaptureData,
  ctx: ExtractionContext = {},
): Promise<{ value: string | null; present: boolean; iso: string | null }> {
  if (slot.absentPhrases?.test(text)) return { value: null, present: false, iso: null };

  // Slot-specific patterns win (new vs returning patient, mornings vs afternoons).
  if (slot.patterns) {
    for (const [value, pattern] of Object.entries(slot.patterns)) {
      if (pattern.test(text)) return { value, present: true, iso: null };
    }
  }

  let value: string | null = null;
  switch (slot.kind) {
    case "confirm":
      value = isAffirmative(text) ? "yes" : isNegative(text) ? "no" : null;
      break;
    case "name": {
      const raw = extractName(text);
      if (raw) value = ctx.canonicalName ? await ctx.canonicalName(raw) : raw;
      break;
    }
    case "date": {
      const ageWindow: { minAgeYears?: number; maxAgeYears?: number } = {};
      if (slot.minAgeYears != null) ageWindow.minAgeYears = slot.minAgeYears;
      if (slot.maxAgeYears != null) ageWindow.maxAgeYears = slot.maxAgeYears;
      const iso = normalizeDate(text, ageWindow);
      value = iso ? prettyDate(iso) : null;
      break;
    }
    case "time_pref":
      value = extractTimePref(text);
      break;
    case "digits":
      value = extractDigits(text, slot.digits);
      break;
    case "slot": {
      // Deterministic first: "tomorrow at 5 pm" / "Wednesday morning" is a
      // parse, not a judgement call. The model is only asked to *offer* slots.
      const iso = parseSlotIso(text);
      if (iso) {
        value = prettySlot(iso);
        return { value, present: true, iso };
      }
      break;
    }
    default:
      value = extractText(text);
      break;
  }
  if (value) return { value, present: true, iso: null };

  if (ctx.llm) {
    const fallback = await ctx.llm(slot, text, data);
    if (fallback && fallback.value) {
      // A name slot only accepts a name — "January 12th 1990" must re-ask, not
      // silently become someone's surname.
      if (slot.kind === "name" && !isPlausibleName(fallback.value)) {
        return { value: null, present: false, iso: null };
      }
      return { value: fallback.value, present: fallback.present !== false, iso: fallback.iso ?? null };
    }
  }
  return { value: null, present: false, iso: null };
}

/* --------------------------------------------------------------- transitions */

export interface Advance {
  state: CaptureState;
  /** Spoken reply for this turn (deterministic — no LLM latency). */
  reply: string;
  /** Set when the caller must run an LLM turn for this step (slot offering). */
  needsLlmSlot?: boolean;
  done?: boolean;
}

const save = (state: CaptureState): CaptureState => ({ ...state, updatedAt: new Date().toISOString() });

/** exactOptionalPropertyTypes: drop pending fields instead of assigning undefined. */
const withoutPending = (state: CaptureState): CaptureState => {
  const clone: Record<string, unknown> = { ...state };
  delete clone.pendingKey;
  delete clone.pendingValue;
  delete clone.pendingIso;
  return clone as unknown as CaptureState;
};

export function startFlow(flow: SlotDef[], intent: string): CaptureState {
  return save({
    active: true,
    intent,
    step: 0,
    status: "capturing",
    data: {},
    skipped: [],
    updatedAt: new Date().toISOString(),
  });
}

export const currentSlot = (flow: SlotDef[], state: CaptureState): SlotDef | null =>
  state.active && state.step < flow.length ? flow[state.step] ?? null : null;

export const nextPrompt = (flow: SlotDef[], state: CaptureState): string => currentSlot(flow, state)?.prompt ?? "";

/** Handle "no I don't have it" / "skip" for the pending slot. */
function skipSlot(state: CaptureState): Advance {
  const next: CaptureState = save({ ...withoutPending(state), status: "capturing", step: state.step + 1 });
  return { state: next, reply: "" };
}

/**
 * Apply one user utterance to the flow.
 * Handles: confirmation of a pending read-back, rejections, absent answers,
 * new values, and multi-intent overlap (answer + extra question).
 */
export async function applyAnswer(
  flow: SlotDef[],
  state: CaptureState,
  text: string,
  ctx: ExtractionContext = {},
): Promise<Advance> {
  if (!state.active) return { state, reply: "" };
  const slot = currentSlot(flow, state);
  if (!slot) {
    return { state: save({ ...state, active: false, status: "done" }), reply: "", done: true };
  }

  if (state.status === "confirming" && state.pendingKey) {
    const head = text.split(/[?.!,]/)[0]?.slice(0, 40) ?? text;
    if (isAffirmative(head)) {
      const confirmedIso = state.pendingIso;
      const next = save({
        ...withoutPending(state),
        ...(confirmedIso ? { pendingIso: confirmedIso } : {}),
        data: {
          ...state.data,
          [state.pendingKey]: state.pendingValue ?? "",
          ...(state.pendingKey === "appointment" && confirmedIso ? { appointment_iso: confirmedIso } : {}),
        },
        status: "capturing",
        step: state.step + 1,
      });
      const upcoming = currentSlot(flow, next);
      if (!upcoming) {
        return { state: save({ ...next, active: false, status: "done" }), reply: closingMessage(next.data), done: true };
      }
      if (upcoming.kind === "slot") {
        return { state: next, reply: upcoming.prompt, needsLlmSlot: true };
      }
      return { state: next, reply: upcoming.prompt.trim() };
    }
    if (isNegative(head) && !/earlier|later|another|different|instead|not good|too (late|early)/i.test(text)) {
      const retry = save({ ...withoutPending(state), status: "capturing" });
      return { state: retry, reply: `Sorry about that — could you tell me again? ${slot.prompt}`.trim() };
    }
    // Rejection that names a better option ("too late, anything earlier?")
    // or an answer plus a new question — fall through and re-read the slot.
  }

  const { value, present, iso } = await extractSlotValue(slot, text, state.data, ctx);
  const slotIso = slot.kind === "slot" && value ? iso ?? resolveSlotIso(value) : iso;
  if (!present) {
    if (slot.absentPhrases?.test(text)) {
      const skipped = save({ ...state, skipped: [...new Set([...state.skipped, slot.key])], step: state.step + 1 });
      const upcoming = currentSlot(flow, skipped);
      if (!upcoming) return { state: save({ ...skipped, active: false, status: "done" }), reply: closingMessage(skipped.data), done: true };
      return { state: skipped, reply: upcoming.prompt.trim(), needsLlmSlot: upcoming.kind === "slot" };
    }
    const nack = save({ ...state });
    const clarify = slot.optional ? "No problem." : "";
    return { state: nack, reply: `${clarify} ${slot.prompt}`.trim() };
  }

  const store = (v: string): Advance => {
    const next = save({
      ...withoutPending(state),
      data: { ...state.data, [slot.key]: v },
      status: "capturing",
      step: state.step + 1,
    });
    const upcoming = currentSlot(flow, next);
    if (!upcoming) return { state: save({ ...next, active: false, status: "done" }), reply: closingMessage(next.data), done: true };
    if (upcoming.kind === "slot") return { state: next, reply: upcoming.prompt.trim(), needsLlmSlot: true };
    return { state: next, reply: upcoming.prompt };
  };

  if (!value) {
    const nack = save({ ...state });
    return { state: nack, reply: slot.prompt.trim() };
  }
  if (slot.readback) {
    const captured = value;
    const withIso: CaptureState = slotIso ? { ...state, pendingIso: slotIso } : state;
    const pending = save({ ...withIso, status: "confirming", pendingKey: slot.key, pendingValue: captured });
    return { state: pending, reply: slot.readback(captured, state.data) };
  }
  return store(value);
}

/** The agent offers a concrete slot; the customer has not accepted yet. */
export function offerSlot(state: CaptureState, iso: string, spoken: string): Advance {
  return {
    state: save({
      ...state,
      status: "confirming",
      pendingKey: "appointment",
      pendingValue: spoken || prettySlot(iso),
      pendingIso: iso,
    }),
    reply: "",
  };
}

/**
 * The customer asked a question instead of answering the pending slot
 * ("how much is a cleaning?" mid-flow) — answer it and keep the flow paused.
 */
export function isQuestionLike(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t.length < 6) return false;
  return /^(how|what|when|where|who|why|which|do you|does|can i|is it|are you|will you|would you|could you|will it|how much)\b/.test(t);
}

export const acceptSlotValue = (state: CaptureState, iso: string, spoken: string): string => {
  state.pendingIso = iso;
  state.pendingValue = spoken || prettySlot(iso);
  return state.pendingValue;
};

export function closingMessage(data: CaptureData): string {
  const who = [data.first_name, data.last_name].filter(Boolean).join(" ");
  const when = data.appointment ? ` on ${data.appointment.replace(/[.?!]+\s*$/, "")}` : "";
  const base = `You're all set${who ? `, ${who}` : ""}${when}. We'll see you then!`;
  return `${base} Is there anything else I can help you with today?`;
}

export const summarize = (state: CaptureState): string =>
  Object.entries(state.data)
    .filter(([k]) => k !== "office")
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

export const isSlotOfferDay = (text: string): boolean =>
  WEEKDAYS.some((d) => text.toLowerCase().includes(d)) || /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(text);
