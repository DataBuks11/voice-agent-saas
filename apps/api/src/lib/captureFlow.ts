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

const ABSENT = /\b(don'?t have|do ?n'?t have|did ?n'?t bring|not (with )?me|no idea|don'?t know|does ?n'?t (have|matter)|skip|forget it|can'?t find|left (it|them) at home|not available)\b/i;

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
    readback: (v) => `So that's ${v}. Shall I lock that in?`,
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

export const flowForIntent = (intent: string, opts: { office?: string; service?: string } = {}): SlotDef[] =>
  intent === "new_patient_booking" ? newPatientFlow(opts) : newPatientFlow(opts);

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

const isPlausibleName = (value: string): boolean => {
  const words = value.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  if (words.every((w) => NAME_STOPWORDS.has(w))) return false;
  if (words.some((w) => w.length > 22)) return false;
  return true;
};

export function extractName(text: string): string | null {
  const spelled = findSpellOutRun(text);
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
  /** LLM fallback for messy utterances; must return JSON {value, present}. */
  llm?: (slot: SlotDef, text: string, data: CaptureData) => Promise<{ value?: string | null; present?: boolean } | null>;
}

export async function extractSlotValue(
  slot: SlotDef,
  text: string,
  data: CaptureData,
  ctx: ExtractionContext = {},
): Promise<{ value: string | null; present: boolean }> {
  if (slot.absentPhrases?.test(text)) return { value: null, present: false };

  // Slot-specific patterns win (new vs returning patient, mornings vs afternoons).
  if (slot.patterns) {
    for (const [value, pattern] of Object.entries(slot.patterns)) {
      if (pattern.test(text)) return { value, present: true };
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
    case "slot":
      value = null; // produced by the LLM offer line
      break;
    default:
      value = extractText(text);
      break;
  }
  if (value) return { value, present: true };

  if (ctx.llm) {
    const fallback = await ctx.llm(slot, text, data);
    if (fallback && fallback.value) return { value: fallback.value, present: fallback.present !== false };
  }
  return { value: null, present: false };
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
      const next = save({
        ...withoutPending(state),
        data: { ...state.data, [state.pendingKey]: state.pendingValue ?? "" },
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

  const { value, present } = await extractSlotValue(slot, text, state.data, ctx);
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
    const pending = save({ ...state, status: "confirming", pendingKey: slot.key, pendingValue: captured });
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
  const when = data.appointment ? ` on ${data.appointment}` : "";
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
