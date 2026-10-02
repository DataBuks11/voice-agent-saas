import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Agent, ConversationMessage, Decision, RetrievalResult, HarnessVerdict, ToolDefinition } from "@voice-agent/types";
import { ruleFallback } from "@voice-agent/decision";
import { buildContext } from "@voice-agent/context";
import { validateResponse } from "@voice-agent/harness";
import { KeywordOverlapReranker } from "@voice-agent/reranking";
import {
  nextOffers,
  normalizeAvailability,
  parseSlotPreference,
  spokenSlot,
  type AvailabilityConfig,
} from "../lib/availability.js";
import { parseSlotIso } from "../lib/captureFlow.js";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";
import { embedAll } from "../lib/embeddings.js";
import { cacheGet, cachePut, complete, completeStream } from "../lib/llm.js";
import {
  applyAnswer,
  currentSlot,
  flowForIntent,
  isQuestionLike,
  offerSlot,
  startFlow,
  type Advance,
  type CaptureState,
  type ExtractionContext,
  type SlotDef,
} from "../lib/captureFlow.js";
import { canonicalName, clearCaptureState, loadCaptureState, persistCapture, saveCaptureState } from "../lib/captureStore.js";

const createConversationSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  customerId: z.string().uuid().optional(),
  channel: z.string().default("voice"),
});

const messageSchema = z.object({
  workspaceId: z.string().uuid(),
  content: z.string().min(1),
  agentId: z.string().uuid().optional(),
  /** Ask for an SSE stream (first token ~600ms); server falls back to JSON on fast paths. */
  stream: z.boolean().optional(),
  /** Speculative turn from a partial transcript: warms the answer, never persisted. */
  draft: z.boolean().optional(),
});

/** Platform tools advertised to the decision engine. */
const PLATFORM_TOOLS: ToolDefinition[] = [
  { name: "book_appointment", description: "Book an appointment/meeting on the business calendar", inputSchema: {} },
  { name: "get_location", description: "Return the business address with a Google Maps link", inputSchema: {} },
];

const DEFAULT_AGENT: Agent = {
  id: "default",
  workspaceId: "",
  name: "Business Assistant",
  language: "en",
  tone: "professional",
  systemPrompt:
    "You are a professional American-English receptionist. Be warm, natural and concise. Only answer from provided knowledge.",
  fallbackResponse: "I don't have verified information about that yet.",
  maxTokens: 6000,
  temperature: 0.4,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const VOICE_STYLE = `# Voice style
- You are a warm, professional American-English receptionist — natural conversational tone, like a real front desk.
- Keep every reply to 1-2 short sentences so the spoken response can start instantly.
- Never invent facts, prices, hours, availability or policies. Answer ONLY from the knowledge above; if it is not covered, say you will check with the team.
- Plain speech only: no URLs, markdown, emoji or stage directions — the reply is read aloud by text-to-speech.`;

const BOOKING_INSTRUCTIONS = `# Tool: book_appointment
You can book appointments for the customer.
- Collect a preferred date/time and the customer's name (and a phone/email as contact if offered). Ask for at most ONE missing detail per turn, briefly.
- The moment you have both a date/time and a name, start your reply with exactly one machine line as the FIRST line (uppercase, pipe-separated):
BOOK|YYYY-MM-DD HH:MM|name|contact
then continue with a short, warm spoken confirmation. Use only details the customer gave — never invent them.
- If any detail is missing, do NOT output the BOOK line; just ask naturally.`;

/** Current business date so "tomorrow 5pm" resolves correctly. */
function todayInfo(): string {
  const tz = process.env.BUSINESS_TIMEZONE || "UTC";
  try {
    const d = new Date();
    const date = d.toLocaleDateString("en-CA", { timeZone: tz });
    const day = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
    return `Today's date is ${date} (${day}).`;
  } catch {
    return `Today's date is ${new Date().toISOString().slice(0, 10)}.`;
  }
}

const systemWithStyle = (base: string, language = "en") => {
  const lang = (language || "en").toLowerCase();
  const langRule =
    lang.startsWith("hi")
      ? "- Reply in natural Hindi (Devanagari is fine), the way a receptionist speaks in India. Keep it to 1-2 short sentences."
      : lang.startsWith("es")
        ? "- Reply in natural Spanish, 1-2 short sentences."
        : lang.startsWith("ar")
          ? "- Reply in natural Arabic, 1-2 short sentences."
          : "";
  return `${base}\n\n${todayInfo()}\n\n${VOICE_STYLE}${langRule ? `\n${langRule}` : ""}`;
};

/** Workspace has no documents yet — chat like a helpful assistant, never invent business facts. */
const UNGROUNDED_NOTE = `# Knowledge status
No business documents have been uploaded yet — there is nothing to look facts up in.
- Be a warm, natural, helpful general assistant and keep the conversation flowing (like a friendly chatbot).
- For specific business facts (prices, hours, address, policies, availability), say you'll get those details from the team — never invent them.`;

const SLOT_OFFER_INSTRUCTIONS = `# Slot offering (booking tool, availability step)
- Offer ONE concrete appointment slot (max two), based only on hours/availability stated in the knowledge above. If nothing is known, ask the customer for a day and time instead — never invent availability.
- Put each offered slot as its own machine line FIRST, then the spoken sentence:
OFFER|YYYY-MM-DD HH:MM
- If the customer already said a day/time, restate it as a single OFFER line and ask them to confirm.
- Never claim the booking is confirmed here; the customer confirms after hearing it read back.`;

const SLOT_EXTRACT_INSTRUCTIONS = `You extract one captured booking detail from a front-desk call.
Answer with ONLY compact JSON, no markdown: {"value": <string or null>, "present": true|false, "iso": "YYYY-MM-DD HH:MM" | null}
- value: exactly what the customer gave, cleaned up (names in proper case, dates as "Month D, YYYY", times as "3:00 p.m.", digits as digits).
- iso: ONLY for a day+time the customer actually gave (appointment slot), resolved against today's date. Null otherwise.
- present false when the customer says they do not have it, or when they ignored the question.`;

interface SlotExtractResult {
  value?: string | null;
  present?: boolean;
  iso?: string | null;
}

const parseJsonLoose = (raw: string): unknown => {
  const cleaned = raw.replace(/```json?/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

/** LLM fallback when regex extraction cannot read the answer (noisy STT, Hinglish). */
async function slotExtractLlm(slot: SlotDef, text: string, data: Record<string, string>): Promise<SlotExtractResult | null> {
  const result = await complete({
    system: SLOT_EXTRACT_INSTRUCTIONS,
    context: "",
    user: `${todayInfo()}\nPending question: ${slot.prompt}\nAlready captured: ${JSON.stringify(data)}\nCustomer said: "${text}"`,
    fallback: "",
  });
  if (!result.text) return null;
  const parsed = parseJsonLoose(result.text) as SlotExtractResult | null;
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.iso && !/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(parsed.iso)) delete parsed.iso;
  return parsed;
}

/** LLM turn that offers a concrete appointment slot, parsed back into the flow. */
async function runSlotOfferTurn(
  system: string,
  history: ConversationMessage[],
  state: CaptureState,
  userText: string,
): Promise<{ spoken: string; offers: string[] }> {
  const transcript = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Customer" : "Receptionist"}: ${m.content}`)
    .join("\n");
  const result = await complete({
    system: `${system}\n\n${SLOT_OFFER_INSTRUCTIONS}`,
    context: transcript,
    user: userText,
    fallback: "",
  });
  const offers: string[] = [];
  const spoken: string[] = [];
  for (const line of result.text.split(/\r?\n/)) {
    const offer = line.trim().match(/^OFFER\|\s*(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*$/i);
    if (offer) {
      offers.push(`${offer[1]} ${offer[2]}`);
      continue;
    }
    if (line.trim()) spoken.push(line.trim());
  }
  void state;
  return { spoken: spoken.join(" "), offers };
}

/**
 * Speculative draft: answer the partial transcript the recogniser produced and
 * keep it in the cache, so when the final transcript lands the caller hears the
 * reply immediately instead of paying another ~2s of model time.
 */
async function warmDraft(
  body: { content: string },
  agent: Agent,
  history: ConversationMessage[],
  docCount: number,
): Promise<void> {
  if (docCount === 0) return; // nothing to ground on; the real turn is a chatbot reply
  if (body.content.trim().split(/\s+/).length < 3) return;
  try {
    const db = getSupabase();
    const embedding = await embedAll([body.content]).catch(() => null);
    let contextText = "";
    if (embedding?.[0]) {
      const { data: hits } = await db.rpc("match_chunks", {
        p_workspace_id: agent.workspaceId,
        p_query_embedding: embedding[0],
        p_top_k: Number(process.env.RAG_TOP_K ?? 6),
        p_filter: {},
      });
      const mapped = (hits ?? []) as Record<string, unknown>[];
      const minScore = Number(process.env.RAG_MIN_SCORE ?? 0.12);
      const strong = mapped.filter((h) => Number(h.score) >= minScore);
      if (strong.length) {
        contextText = strong
          .slice(0, 3)
          .map((h) => String(h.content))
          .join("\n\n");
      }
    }
    const result = await complete({
      system: systemWithStyle(agent.systemPrompt, agent.language),
      context: contextText,
      user: body.content,
      fallback: "",
      maxTokens: 120,
    });
    if (result.text) cachePut(body.content, result.text, result.source);
    console.log(`draft cached (${result.source}, ${result.text.length} chars)`);
  } catch (err) {
    console.error(`draft warm failed: ${(err as Error).message}`);
  }
}

/** Add a booked slot to the agent's diary so the engine stops offering it. */
async function markSlotBooked(agentId: string, iso: string): Promise<void> {
  const db = getSupabase();
  const { data } = await db.from("agents").select("booked_slots").eq("id", agentId).maybeSingle();
  const current = ((data as Record<string, unknown> | null)?.booked_slots ?? []) as unknown;
  const list = Array.isArray(current) ? current.map(String) : [];
  const value = iso.slice(0, 16);
  if (list.includes(value)) return;
  list.push(value);
  const trimmed = list.slice(-400);
  const { error } = await db.from("agents").update({ booked_slots: trimmed }).eq("id", agentId);
  if (error) console.error(`booked slot update failed: ${error.message}`);
}

/** "That's too late" / "anything earlier?" / "some other day". */
function isSlotRejection(text: string): boolean {
  return /\b(too late|earlier|not possible|can'?t make|another day|different day|some other|next day|not that (day|time)|any other)\b/i.test(text);
}

/** Slot-by-slot progress for the UI: [{key,label,value,state}] with state = done|skipped|pending. */
function captureProgress(flow: SlotDef[], state: CaptureState): Array<{ key: string; label: string; value: string; state: "done" | "skipped" | "pending" }> {
  const labels: Record<string, string> = {
    office: "Office",
    patient_status: "Patient",
    first_name: "First name",
    last_name: "Last name",
    dob: "Date of birth",
    visit_reason: "Reason",
    time_pref: "Preference",
    appointment: "Appointment",
    zip: "Zip code",
    insurance_company: "Insurance",
    member_id: "Member ID",
    plan_holder: "Plan holder",
  };
  return flow.map((slot) => {
    const skipped = state.skipped.includes(slot.key);
    const value = state.data[slot.key] ?? "";
    const done = Boolean(value) || skipped;
    return {
      key: slot.key,
      label: labels[slot.key] ?? slot.key,
      value: skipped ? "not available" : value,
      state: skipped ? "skipped" : value ? "done" : "pending",
    };
  });
}

/** Persist the declined list on the flow state (JSON-in-string keeps the row simple). */
function saveDeclined(state: CaptureState, declined: string[]): CaptureState {
  return {
    ...state,
    status: "capturing",
    data: { ...state.data, declined_slots: JSON.stringify(declined.slice(-8)) },
    step: state.step,
  };
}

/**
 * The moment the flow reaches the appointment slot, offer concrete times instead
 * of asking an open question — this is what a real receptionist does.
 */
async function offerIfSlot(
  advance: Advance,
  availability: AvailabilityConfig,
  part: string | undefined,
  declined: string[],
): Promise<Advance> {
  if (!advance.needsLlmSlot) return advance;
  const offers = nextOffers(availability, {
    part: part === "mornings" || part === "afternoons" || part === "evenings" ? part : "any",
    exclude: declined,
    limit: 2,
  });
  if (!offers.length) return advance;
  const first = offers[0]!;
  const next = offerSlot(advance.state, first.iso, spokenSlot(first.iso));
  return {
    ...next,
    reply:
      offers.length > 1
        ? `Would ${spokenSlot(first.iso)} or ${spokenSlot(offers[1]!.iso)} work for you?`
        : `Would ${spokenSlot(first.iso)} work for you?`,
  };
}

const STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "why", "how", "is", "are", "was", "were", "do", "does",
  "did", "can", "could", "should", "would", "will", "the", "a", "an", "of", "and", "or", "to", "in",
  "on", "for", "with", "about", "me", "my", "i", "you", "please", "tell", "give", "any", "some",
]);

const questionTokens = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));

/** Front-desk vs patient-intake: a call about a patient or a death needs the
 *  intake slots (relative, patient, hospital, callback) rather than a haircut. */
function pickIntent(text: string): "patient_intake" | "new_patient_booking" {
  return /(patient|death|dead ?body|deceased|body shifting|ambulance|hospital|funeral|last rites|cremation|shmashan)/i.test(text)
    ? "patient_intake"
    : "new_patient_booking";
}

const HEADING_STOPWORDS = new Set([
  "a","an","the","of","in","on","to","for","and","or","but","with","from","by","as","at","it",
  "its","this","that","these","those","you","your","i","we","they","he","she","his","her","our",
  "their","my","me","us","them",
]);

/** Words that turn a fragment into a statement. */
const HEADING_VERBS = new Set([
  "is","are","was","were","be","been","am","has","have","had","can","could","will","would",
  "shall","should","must","may","might","do","does","did","need","needs","require","requires",
  "include","includes","contain","contains","mean","means","refer","refers","cost","costs",
]);

/**
 * "Count Number of Lines in a File" overlaps the question word for word, but it is
 * a heading, not an answer. A capitalised noun phrase with no verb reads as
 * nonsense when spoken, so let the model phrase it instead.
 */
export function looksLikeHeading(sentence: string): boolean {
  const words = sentence.split(/\s+/).filter(Boolean);
  if (words.length > 9) return false; // long text is prose even without an auxiliary
  if (words.some((w) => HEADING_VERBS.has(w.toLowerCase().replace(/[^a-z]/g, "")))) return false;
  const content = words.filter((w) => !HEADING_STOPWORDS.has(w.toLowerCase()));
  if (!content.length) return true;
  const capitalised = content.filter((w) => /^[A-Z]/.test(w)).length;
  return capitalised / content.length >= 0.6;
}

export function extractiveAnswer(question: string, hits: RetrievalResult[], minRatio: number): string | null {
  if (!hits.length) return null;
  const qTokens = new Set(questionTokens(question));
  if (qTokens.size < 2) return null;
  const title = String(hits[0]?.metadata?.doc_title ?? "");
  let best: { text: string; ratio: number; shared: number } | null = null;
  for (const hit of hits.slice(0, 3)) {
    for (const raw of hit.content.split(/(?<=[.!?])\s+|\n+/)) {
      let sentence = raw.replace(/^[-*#\s]+/, "").trim();
      // The retrieved text is prefixed with the document title for context; drop it.
      if (title && sentence.toLowerCase().startsWith(title.toLowerCase())) {
        sentence = sentence.slice(title.length).replace(/^\s*[:\-]\s*/, "").trim();
      }
      const words = sentence.split(/\s+/).filter(Boolean);
      const minWords = Number(process.env.RAG_EXTRACTIVE_MIN_WORDS ?? 5);
      if (words.length < minWords || words.length > 45) continue;
      // Skip code-ish fragments: they read as gibberish when spoken aloud.
      if (/["'`]\s*[,)]|[{}();]|\w+\s*\(/.test(sentence)) continue;
      if (looksLikeHeading(sentence)) continue;
      const tokens = questionTokens(sentence);
      if (!tokens.length) continue;
      const shared = tokens.filter((t) => qTokens.has(t)).length;
      if (shared < 2) continue;
      const ratio = shared / Math.min(qTokens.size, tokens.length);
      if (!best || ratio > best.ratio) best = { text: sentence, ratio, shared };
    }
  }
  if (!best) return null;
  const threshold = Number(process.env.RAG_EXTRACTIVE_RATIO ?? minRatio);
  // Needs either a clear majority of the question's words or an exact-ish match.
  if (best.ratio < threshold && best.ratio < 0.9) return null;
  return best.text;
}

/** Factual-looking content: prices, times, quantities, policies. */
const looksFactual = (text: string): boolean =>
  /\d|\brupees?\b|\binr\b|\brs\.?\s?\d|\b(am|pm)\b|\b(price|cost|timing|hours?|open|closed|policy|available|discount|fee|charges?)\b/i.test(
    text,
  );

/** Knowledge-sourced one-liner used when the model is too slow for a live call. */
function groundedFallbackText(opts: { context: string; fallback: string }, fallback: string): string {
  const blocks = [...opts.context.matchAll(/# Knowledge \[([^\]]+) score=([0-9.]+)\]\n([\s\S]*?)(?=\n# Knowledge \[|\n# Conversation|$)/g)];
  const best = blocks[0]?.[3]?.trim() ?? "";
  if (!best) return "";
  const sentence = best.split(/(?<=[.!?])\s+/).filter(Boolean)[0] ?? "";
  return sentence.slice(0, 220) || fallback;
}

/** Slots the caller has already turned down, so we never repeat one. */
function parseDeclined(data: Record<string, string>): string[] {
  const raw = data.declined_slots;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/**
 * Deterministic offer: honour the caller's stated part of day, skip what they
 * already turned down, and move earlier when they say "too late".
 */
async function engineOffer(
  cfg: AvailabilityConfig,
  pref: ReturnType<typeof parseSlotPreference>,
  declined: string[],
  storedPart?: string,
): Promise<{ iso: string }[]> {
  const part = pref.part !== "any" ? pref.part : storedPart === "mornings" || storedPart === "afternoons" || storedPart === "evenings" ? storedPart : "any";
  const lastDeclined = declined[declined.length - 1];
  const offers = nextOffers(cfg, {
    part: part as "mornings" | "afternoons" | "evenings" | "any",
    exclude: declined,
    ...(pref.wantsEarlier && lastDeclined
      ? { sameDay: lastDeclined.slice(0, 10), beforeIso: lastDeclined }
      : {}),
    limit: 2,
  });
  return offers.map((o) => ({ iso: o.iso }));
}

function humanSlot(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const hh = d.getHours();
  const mm = d.getMinutes();
  const suffix = hh >= 12 ? "p.m." : "a.m.";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${date} at ${h12}${mm ? `:${String(mm).padStart(2, "0")}` : ""} ${suffix}`;
}

/**
 * Nothing in the knowledge base matches this question. Stay useful: small talk
 * gets a natural reply, and specific facts get an honest "I'll check with the
 * team" instead of a canned refusal.
 */
const NO_CONTEXT_NOTE = `# Knowledge
The knowledge base has documents, but none of them cover this question.
- Small talk, greetings, or questions about you/your role: answer naturally and warmly in one short sentence.
- Anything about the business (prices, hours, policies, availability, services): say the detail isn't in your notes and offer to check with the team.
- Never invent a specific fact, price, time or policy.`;

async function loadAgent(workspaceId: string, agentId: string | undefined): Promise<Agent> {
  const db = getSupabase();
  const query = db.from("agents").select().eq("workspace_id", workspaceId);
  const { data } = agentId ? await query.eq("id", agentId).maybeSingle() : await query.order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!data) return { ...DEFAULT_AGENT, workspaceId };
  const r = data as Record<string, unknown>;
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    name: String(r.name),
    language: String(r.language),
    tone: String(r.tone),
    systemPrompt: String(r.system_prompt),
    fallbackResponse: String(r.fallback_response),
    maxTokens: Number(r.max_tokens),
    temperature: Number(r.temperature),
    location: String(r.location ?? ""),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

/** Business hours + already-booked slots for the slot-offer engine. */
async function loadAvailability(agent: Agent): Promise<AvailabilityConfig> {
  const db = getSupabase();
  const { data } = await db
    .from("agents")
    .select("availability,booked_slots")
    .eq("id", agent.id)
    .maybeSingle();
  const row = (data ?? {}) as Record<string, unknown>;
  return normalizeAvailability({ ...(row.availability ?? {}), booked: row.booked_slots ?? [] });
}

/** Instant local reply for greetings — zero network, zero LLM latency. */
function smallTalkReply(agent: Agent, content: string): string {
  const t = content.toLowerCase();
  if (/\b(bye|goodbye|good night|see you|talk later)\b/.test(t)) {
    return "Thanks for calling — have a great day!";
  }
  if (/\b(thank|thanks|appreciate)\b/.test(t)) {
    return "You're very welcome! Is there anything else I can help you with?";
  }
  if (/\b(how are you|how's it going|how do you do)\b/.test(t)) {
    return "I'm doing great, thanks for asking! What can I help you with today?";
  }
  return `Hi, thanks for reaching out to ${agent.name}! This is the front desk — how can I help you today?`;
}

const mapsUrl = (location: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;

/**
 * @fastify/cors only decorates non-hijacked replies — the SSE branch writes raw
 * headers, so it must echo these itself (same allow-list as index.ts).
 */
const SSE_ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS ?? "https://voice-agent-saas-web.vercel.app,http://localhost:5173,http://localhost:3001")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
);

/** Floating-time Google Calendar template link (no OAuth needed). */
function calendarUrl(title: string, startsAt: string, details: string): string | null {
  const m = startsAt.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + 30 * 60000);
  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}00`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${fmt(start)}/${fmt(end)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Pull the machine BOOK line out of an LLM reply. Returns null when not booking yet. */
function extractBooking(text: string): { startsAt: string; name: string; contact: string; rest: string } | null {
  const m = text.match(/^\s*BOOK\|([^|\n]+)\|([^|\n]+)\|([^\n]*)\n?/);
  if (!m) return null;
  return { startsAt: (m[1] ?? "").trim(), name: (m[2] ?? "").trim(), contact: (m[3] ?? "").trim(), rest: text.slice(m[0].length).trim() };
}

interface ToolResult {
  type: "calendar" | "maps";
  label: string;
  url: string;
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/conversations", async (req, reply) => {
    const body = createConversationSchema.parse((req as { body: unknown }).body);
    const tenant = await requireTenant(req);
    if (tenant.workspaceId !== body.workspaceId) {
      throw Object.assign(new Error("workspaceId does not match x-workspace-id"), { status: 403 });
    }
    const db = getSupabase();
    const { data, error } = await db
      .from("conversations")
      .insert({
        workspace_id: body.workspaceId,
        agent_id: body.agentId ?? null,
        customer_id: body.customerId ?? null,
        channel: body.channel,
      })
      .select()
      .single();
    if (error) throw Object.assign(new Error(`conversation create failed: ${error.message}`), { status: 500 });
    // The voice runtime matches its STT/TTS to the agent's language.
    const agentRow = await loadAgent(body.workspaceId, body.agentId);
    return reply
      .status(201)
      .send({
        id: data.id,
        workspaceId: body.workspaceId,
        channel: data.channel,
        createdAt: data.created_at,
        language: agentRow.language,
      });
  });

  app.get("/conversations", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    await requireTenant(req);
    const db = getSupabase();
    const { data, error } = await db
      .from("conversations")
      .select("id, channel, created_at, agent_id")
      .eq("workspace_id", q.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw Object.assign(new Error(`conversations list failed: ${error.message}`), { status: 500 });
    const items = (data ?? []).map((c) => ({ id: c.id, channel: c.channel, agentId: c.agent_id, createdAt: c.created_at }));
    return { items, total: items.length };
  });

  app.get("/conversations/:id/messages", async (req) => {
    const { id } = req.params as { id: string };
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    await requireTenant(req);
    const db = getSupabase();
    const { data, error } = await db
      .from("messages")
      .select("id, role, content, citations, created_at")
      .eq("conversation_id", id)
      .eq("workspace_id", q.workspaceId)
      .order("created_at", { ascending: true });
    if (error) throw Object.assign(new Error(`messages list failed: ${error.message}`), { status: 500 });
    const items = (data ?? []).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      citations: m.citations,
      createdAt: m.created_at,
    }));
    return { items, total: items.length };
  });

  // Full turn: decide -> retrieve (pgvector) -> context -> LLM/grounded -> harness -> persist.
  app.post("/conversations/:id/messages", async (req, reply) => {
    const body = messageSchema.parse((req as { body: unknown }).body);
    const { id: conversationId } = req.params as { id: string };
    const tenant = await requireTenant(req);
    if (tenant.workspaceId !== body.workspaceId) {
      throw Object.assign(new Error("workspaceId does not match x-workspace-id"), { status: 403 });
    }
    // Streaming clients get an SSE connection from the first byte: fast paths paint
    // their whole answer as one delta BEFORE persisting, knowledge turns stream tokens.
    const streamed = body.stream === true;
    const writeDelta = (text: string) => {
      if (!streamed || !text) return;
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: "delta", text })}\n\n`);
      } catch {
        // client disconnected mid-turn
      }
    };
    if (streamed) {
      reply.hijack();
      const origin = req.headers.origin;
      const cors: Record<string, string> = origin && SSE_ALLOWED_ORIGINS.has(origin)
        ? { "access-control-allow-origin": origin, vary: "Origin" }
        : {};
      reply.raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
        ...cors,
      });
    }
    const streamFail = (err: Error) => {
      console.error(`streamed turn failed: ${err.message}`);
      try {
        reply.raw.write(`data: ${JSON.stringify({ type: "error", message: err.message })}\n\n`);
      } catch {
        // client already gone
      }
      try {
        reply.raw.end();
      } catch {
        // client already gone
      }
      return reply;
    };
    const draft = body.draft === true;
  const channel = String((req.headers["x-voice-channel"] ?? (req.query as Record<string, string> | undefined)?.channel ?? "web")).toLowerCase();
    const db = getSupabase();
    const t0 = Date.now();
    let embedMs = 0;
    let llmMs = 0;
    const tEmbed = Date.now();

    // Query embedding starts racing immediately but is only AWAITED when the
    // decision actually needs retrieval — greetings/fallback never wait on it.
    const embedPromise = embedAll([body.content])
      .then((vectors) => {
        embedMs = Date.now() - tEmbed;
        return vectors[0] ?? null;
      })
      .catch((err: Error) => {
        console.error(`query embed failed, retrieval will be skipped: ${err.message}`);
        embedMs = Date.now() - tEmbed;
        return null;
      });

    // Agent lookup, doc count, short-term history and any in-progress capture flow
    // all race in parallel (DB-local).
    const [agent, docCountRes, histRows, captureState] = await Promise.all([
      loadAgent(body.workspaceId, body.agentId),
      db
        .from("documents")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", body.workspaceId),
      db
        .from("messages")
        .select("id, role, content, citations, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(Number(process.env.MEMORY_SHORT_TURNS ?? 20)),
      loadCaptureState(conversationId, body.workspaceId),
    ]);
    const docCount = docCountRes.count ?? 0;
    const decision: Decision = ruleFallback(body.content, docCount > 0, PLATFORM_TOOLS.map((t) => t.name));

    const history: ConversationMessage[] = (histRows.data ?? [])
      .reverse()
      .map((m) => ({
        id: String(m.id),
        conversationId,
      language: agent.language,
        role: m.role as ConversationMessage["role"],
        content: String(m.content),
        citations: (m.citations ?? []) as string[],
        createdAt: String(m.created_at),
      }));

    let retrieved: RetrievalResult[] = [];
    const toolForRoute = decision.route === "use_tools" ? decision.requiredTools?.[0] : undefined;
    const needsRetrieval =
      decision.route === "answer_from_knowledge" ||
      decision.route === "web_search" ||
      toolForRoute === "book_appointment" ||
      (toolForRoute === "get_location" && !agent.location);
    if (needsRetrieval && docCount > 0) {
      const queryVector = await embedPromise;
      if (queryVector) {
        const { data: hits, error: searchErr } = await db.rpc("match_chunks", {
          p_workspace_id: body.workspaceId,
          p_query_embedding: queryVector,
          p_top_k: Number(process.env.RAG_TOP_K ?? 6),
          p_filter: {},
        });
        if (searchErr) {
          const err = Object.assign(new Error(`retrieval failed: ${searchErr.message}`), { status: 500 });
          if (streamed) return streamFail(err as Error);
          throw err;
        }
        retrieved = (hits ?? []).map((h: Record<string, unknown>) => {
          const meta = (h.metadata ?? {}) as Record<string, string | number | boolean>;
          const vectorScore = Number(h.score);
          const title = String(meta.doc_title ?? "");
          return {
            id: String(h.id),
            workspaceId: body.workspaceId,
            documentId: String(h.document_id),
            content: title ? `${title}: ${String(h.content)}` : String(h.content),
            tokens: 0,
            metadata: { ...meta, vector_score: vectorScore },
            score: vectorScore,
          } satisfies RetrievalResult;
        });
        // Below-threshold hits are noise, not evidence: grounding on them is how
        // an agent ends up inventing an answer.
        const minScore = Number(process.env.RAG_MIN_SCORE ?? 0.12);
        const strong = retrieved.filter((r) => Number(r.metadata.vector_score) >= minScore);
        const pool = strong.length ? strong : retrieved.filter((r) => Number(r.metadata.vector_score) >= minScore * 0.8);
        retrieved = await new KeywordOverlapReranker().rerank(body.content, pool, Number(process.env.RAG_RERANK_TOP_K ?? 4));
        console.log(
          `retrieval: hits=${pool.length + (retrieved.length - pool.length)} strong=${strong.length} kept=${retrieved.length} topScore=${retrieved[0]?.metadata.vector_score ?? "n/a"} min=${minScore}`,
        );
      }
    }

    let answerText = "";
    let verdict: HarnessVerdict = { ok: true, confidence: 1, issues: [], safeText: "" };
    let answerSource = "";
    let contextInfo = { usedTokens: 0, truncated: false, includedChunkIds: [] as string[] };
    const toolResults: ToolResult[] = [];

    const tool = decision.route === "use_tools" ? decision.requiredTools?.[0] : undefined;

    // ---- Front-desk capture flow (stateful slot filling with read-back confirmation)
    const flow = captureState?.active
      ? flowForIntent(captureState.intent, agent.location ? { office: agent.location } : {})
      : [];
    const flowSlot = flow.length ? currentSlot(flow, captureState!) : null;
    const flowActive = Boolean(flowSlot) || captureState?.status === "confirming";
    const startsBooking = tool === "book_appointment" && !flowActive;
    const availability = flowActive ? await loadAvailability(agent) : normalizeAvailability({});
    const extractionCtx: ExtractionContext = {
      canonicalName: async (spoken) => (await canonicalName(body.workspaceId, spoken)).canonical,
      llm: (slot, text, data) => slotExtractLlm(slot, text, data),
    };

    if (draft) {
      // Speculative turn: answer from cache when we can, otherwise compute and
      // cache it without persisting anything. The real turn then hits the cache.
      const warmed = cacheGet(body.content, 0.99, "warm");
      if (warmed) return reply.send({ draft: true, cached: true });
      await warmDraft(body, agent, history, docCount);
      return reply.send({ draft: true, cached: false });
    }

    if (flowActive && captureState) {
      const system = systemWithStyle(agent.systemPrompt, agent.language);
      let advance: Advance | null = null;

      // Availability step: the engine decides which slots exist, so the agent can
      // never invent availability; the model only speaks the offer.
      // Any refusal of a proposed time counts: "no" as well as "too late".
      const appointmentRejected =
        captureState.status === "confirming" &&
        captureState.pendingKey === "appointment" &&
        Boolean(captureState.pendingIso) &&
        (isSlotRejection(body.content) || /^(no|nope|nah)/i.test(body.content.trim()));
      if (appointmentRejected && captureState.pendingIso) {
        // "That's too late" / "anything earlier?" -> remember it and re-offer.
        const declined = parseDeclined(captureState.data);
        declined.push(captureState.pendingIso);
        const pref = parseSlotPreference(body.content, null);
        const rejected = saveDeclined(captureState, declined);
        const offered = await engineOffer(availability, pref, declined, captureState.data.time_pref ?? "any");
        await saveCaptureState(conversationId, body.workspaceId, rejected);
        if (offered.length) {
          advance = offerSlot(rejected, offered[0]!.iso, spokenSlot(offered[0]!.iso));
          answerText =
            offered.length > 1
              ? `No problem — how about ${spokenSlot(offered[0]!.iso)} or ${spokenSlot(offered[1]!.iso)}?`
              : `No problem — does ${spokenSlot(offered[0]!.iso)} work for you?`;
        } else {
          advance = await applyAnswer(flow, rejected, body.content, extractionCtx);
          answerText = advance.reply;
        }
      } else if (flowSlot?.kind === "slot" && captureState.status === "capturing" && !captureState.pendingKey) {
        const pref = parseSlotPreference(body.content, parseSlotIso(body.content));
        const declined = parseDeclined(captureState.data);
        const offered = await engineOffer(availability, pref, declined, captureState.data.time_pref ?? "any");
        if (offered.length) {
          const first = offered[0]!;
          advance = offerSlot(captureState, first.iso, spokenSlot(first.iso));
          answerText =
            offered.length > 1
              ? `Would ${spokenSlot(first.iso)} or ${spokenSlot(offered[1]!.iso)} work for you?`
              : `Would ${spokenSlot(first.iso)} work for you?`;
        } else {
          const offerTurn = await runSlotOfferTurn(system, history, captureState, body.content);
          const iso = offerTurn.offers[0];
          if (iso) {
            advance = offerSlot(captureState, iso, humanSlot(iso));
            answerText = `${offerTurn.spoken}`.trim() || `Would ${humanSlot(iso)} work for you?`;
          } else {
            advance = await applyAnswer(flow, captureState, body.content, extractionCtx);
            answerText = advance.reply;
          }
        }
      } else if (isQuestionLike(body.content) && !/^(yes|yeah|yep|no|nope|ok|okay|sure)\b/i.test(body.content.trim())) {
        // Mid-flow question: answer it, keep every captured slot.
        const ctx = buildContext({
          agent,
          businessProfile: {},
          history,
          retrieved,
          customerMemory: [],
          maxTokens: agent.maxTokens || Number(process.env.CONTEXT_MAX_TOKENS ?? 6000),
        });
        const llmResult = streamed
          ? await completeStream({ system, context: ctx.contextText, user: body.content, fallback: agent.fallbackResponse }, writeDelta)
          : await complete({ system, context: ctx.contextText, user: body.content, fallback: agent.fallbackResponse });
        answerText = llmResult.text;
        verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
        answerSource = "llm-capture-pause";
        advance = null;
      } else {
        advance = await applyAnswer(flow, captureState, body.content, extractionCtx);
        advance = await offerIfSlot(advance, availability, captureState.data.time_pref, parseDeclined(captureState.data));
        answerText = advance.reply;
      }

      if (advance) {
        const nextState = advance.state;
        await saveCaptureState(conversationId, body.workspaceId, nextState);
        answerText = answerText || advance.reply;
        verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
        answerSource = "capture-flow";
        if (advance.done || !nextState.active) {
          const startsAt = nextState.data.appointment_iso ?? nextState.pendingIso ?? nextState.data.appointment ?? "";
          const { customerId, bookingId } = await persistCapture({
            workspaceId: body.workspaceId,
            conversationId,
            customerName: [nextState.data.first_name, nextState.data.last_name].filter(Boolean).join(" "),
            contact: nextState.data.phone ?? nextState.data.contact ?? "",
            startsAt,
            notes: `booked via ${nextState.intent}`,
            capture: nextState,
          });
          console.log(
            `capture complete: booking=${bookingId ?? "none"} customer=${customerId ?? "none"} skipped=[${nextState.skipped.join(",")}]`,
          );
          if (startsAt) await markSlotBooked(agent.id, startsAt);
          const calUrl = calendarUrl(
            `${agent.name} — appointment with ${[nextState.data.first_name, nextState.data.last_name].filter(Boolean).join(" ") || "guest"}`,
            startsAt || new Date().toISOString().slice(0, 16),
            `Captured: ${Object.entries(nextState.data).map(([k, v]) => `${k}: ${v}`).join("; ")}`,
          );
          if (calUrl) toolResults.push({ type: "calendar", label: "Add to Google Calendar", url: calUrl });
          await clearCaptureState(conversationId);
        }
      }
      if (!verdict) verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
      writeDelta(answerText);
    } else if (startsBooking) {
      const intent = pickIntent(body.content);
      const bookingFlowOpts = agent.location ? { office: agent.location } : {};
      const bookingFlow = flowForIntent(intent, bookingFlowOpts);
      const fresh = startFlow(bookingFlow, intent);
      await saveCaptureState(conversationId, body.workspaceId, fresh);
      answerText = currentSlot(bookingFlow, fresh)?.prompt ?? "Of course — let's get you booked.";
      verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
      answerSource = "capture-flow";
      writeDelta(answerText);
    } else if (decision.route === "small_talk") {
      // Fast path: instant, local, no LLM — greetings must reply with zero delay.
      answerText = smallTalkReply(agent, body.content);
      verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
      answerSource = "fast-path";
      writeDelta(answerText);
    } else if (tool === "get_location" && agent.location) {
      answerText = `You can find us at ${agent.location}.`;
      toolResults.push({ type: "maps", label: "Open in Google Maps", url: mapsUrl(agent.location) });
      verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
      answerSource = "tool";
      writeDelta(answerText);
    } else {
      // Knowledge / escalate / web_search / location-without-configured-address.
      const ctx = buildContext({
        agent,
        businessProfile: {},
        history,
        retrieved,
        customerMemory: [],
        maxTokens: agent.maxTokens || Number(process.env.CONTEXT_MAX_TOKENS ?? 6000),
      });
      const opts = {
        system: systemWithStyle(ctx.systemPrompt, agent.language),
        context: ctx.contextText,
        user: body.content,
        fallback: agent.fallbackResponse,
      };
      contextInfo = { usedTokens: ctx.usedTokens, truncated: ctx.truncated, includedChunkIds: ctx.includedChunkIds };
if (retrieved.length === 0 && docCount > 0) {
        // Documents exist but nothing matched this question. Refusing outright is
        // what made the agent sound broken ("I don't have verified information"
        // to "what are you doing"), so the model answers conversationally and only
        // says it lacks the detail when the caller asked for a specific fact.
        const honest = await complete({
          system: `${systemWithStyle(agent.systemPrompt, agent.language)}\n\n${NO_CONTEXT_NOTE}`,
          context: ctx.contextText,
          user: body.content,
          fallback: agent.fallbackResponse,
        });
        answerText = honest.text;
        verdict = { ok: true, confidence: 0.4, issues: ["no matching knowledge for this question"], safeText: answerText };
        answerSource = honest.source === "llm" ? "llm-no-context" : "fallback";
        writeDelta(answerText);
      } else {
        // Ungrounded (no docs yet): chat like a normal assistant, never invent facts.
        // Grounded (retrieved > 0): stream live, harness verdict replaces preview if needed.
        const ungrounded = docCount === 0;
        const llmOpts = ungrounded ? { ...opts, system: `${opts.system}\n\n${UNGROUNDED_NOTE}` } : opts;
        const tLlm = Date.now();
        const cacheScope = `docs${docCount}`;

        if (!ungrounded) {
          // Direct-from-document answer when one sentence clearly matches: no model
          // call at all, which is what makes factual lookups feel instant.
          const instant = extractiveAnswer(body.content, retrieved, 0.5);
          if (instant) {
            answerText = instant;
            verdict = validateResponse(instant, retrieved, { fallbackResponse: agent.fallbackResponse });
            answerSource = "extractive";
            writeDelta(answerText);
          }
        }

        if (answerSource !== "extractive") {
          // A draft of the same question already warmed this answer: reuse it.
          const drafted = ungrounded ? null : cacheGet(body.content, 0.72, cacheScope);
          const llmResult = drafted
            ? { text: drafted, source: "llm" as const }
            : streamed
              ? await completeStream(llmOpts, writeDelta)
              : await complete(llmOpts);
          if (drafted && streamed) writeDelta(drafted);
          llmMs = Date.now() - tLlm;
          answerText = llmResult.text;
          if (llmResult.source === "llm") cachePut(body.content, llmResult.text, llmResult.source, cacheScope);

          // Voice callers cannot wait 8 seconds for a token: past the budget we take
          // the grounded extractive answer instead (still sourced from knowledge).
          const voiceBudget = Number(process.env.LLM_VOICE_BUDGET_MS ?? 3000);
          if (channel === "voice" && !draft && llmMs > voiceBudget && retrieved.length > 0) {
            const grounded = groundedFallbackText(opts, agent.fallbackResponse);
            if (grounded) {
              answerText = grounded;
              console.log(`llm over voice budget (${llmMs}ms) -> grounded extractive answer`);
            }
          }

          if (ungrounded) {
            verdict = { ok: true, confidence: 0.5, issues: ["ungrounded — no documents uploaded"], safeText: answerText };
            answerSource = "llm-ungrounded";
          } else {
            verdict = validateResponse(llmResult.text, retrieved, { fallbackResponse: agent.fallbackResponse });
            // The harness swaps in the canned refusal when an answer is not grounded.
            // That is right for facts and wrong for small talk ("what are you
            // doing"), so a non-factual reply is kept as the model phrased it.
            if (answerText === agent.fallbackResponse && !looksFactual(llmResult.text)) {
              answerText = llmResult.text;
              verdict = { ok: true, confidence: 0.5, issues: ["conversational reply, not knowledge-grounded"], safeText: answerText };
            }
            answerSource = llmResult.source;
          }
        }
      }
    }

    const now = new Date().toISOString();
    const userMsg = { workspace_id: body.workspaceId, conversation_id: conversationId, role: "user", content: body.content, citations: [] };
    const assistantMsg = {
      workspace_id: body.workspaceId,
      conversation_id: conversationId,
      role: "assistant",
      content: answerText,
      citations: retrieved.map((r) => r.id),
    };
    const { data: saved, error: saveErr } = await db.from("messages").insert([userMsg, assistantMsg]).select("id, role, content, citations, created_at");
    if (saveErr && !streamed) throw Object.assign(new Error(`message persist failed: ${saveErr.message}`), { status: 500 });

    const [savedUser, savedAssistant] = saved ?? [];
    // Structured turn timing — grep "evt":"turn" in logs to watch latency stages.
    console.log(
      JSON.stringify({
        evt: "turn",
        conv: conversationId.slice(0, 8),
        route: decision.route,
        src: answerSource,
        ok: verdict.ok,
        retrieved: retrieved.length,
        embedMs,
        llmMs,
        totalMs: Date.now() - t0,
        ...(streamed ? { stream: true } : {}),
      }),
    );
    // Slot-free view of the capture flow so the UI can render live progress
    // (name / DOB / slot / zip / insurance) without re-deriving anything.
    const finalState = await loadCaptureState(conversationId, body.workspaceId);
    const captureView = finalState
      ? {
          active: finalState.active,
          intent: finalState.intent,
          status: finalState.status,
          step: finalState.step,
          data: finalState.data,
          skipped: finalState.skipped,
          pending: finalState.pendingKey ?? null,
          slots: captureProgress(flow, finalState),
        }
      : null;

    const responsePayload = {
      conversationId,
      decision,
      verdict: { ok: verdict.ok, confidence: verdict.confidence, issues: verdict.issues },
      answer: { ...savedAssistant, createdAt: savedAssistant?.created_at ?? now },
      userMessage: { ...savedUser, createdAt: savedUser?.created_at ?? now },
      answerSource,
      toolResults,
      capture: captureView,
      retrieved: retrieved.map((r) => ({ id: r.id, documentId: r.documentId, score: r.score, text: r.content.slice(0, 200) })),
      context: contextInfo,
    };
    if (streamed) {
      try {
        if (saveErr) throw new Error(`message persist failed: ${saveErr.message}`);
        reply.raw.write(`data: ${JSON.stringify({ type: "final", ...responsePayload })}\n\n`);
      } catch (err) {
        console.error(`stream finalize failed: ${(err as Error).message}`);
        try {
          reply.raw.write(`data: ${JSON.stringify({ type: "error", message: (err as Error).message })}\n\n`);
        } catch {
          // client already gone
        }
      } finally {
        try {
          reply.raw.end();
        } catch {
          // client already gone
        }
      }
      return reply;
    }
    return reply.status(201).send(responsePayload);
  });
}
