import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Agent, ConversationMessage, Decision, RetrievalResult, HarnessVerdict, ToolDefinition } from "@voice-agent/types";
import { ruleFallback } from "@voice-agent/decision";
import { buildContext } from "@voice-agent/context";
import { validateResponse } from "@voice-agent/harness";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";
import { embedAll } from "../lib/embeddings.js";
import { complete, completeStream } from "../lib/llm.js";

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

const systemWithStyle = (base: string) => `${base}\n\n${todayInfo()}\n\n${VOICE_STYLE}`;

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

/** Instant local reply for greetings — zero network, zero LLM latency. */
function smallTalkReply(agent: Agent, content: string): string {
  const t = content.toLowerCase();
  if (/\b(bye|goodbye|good night|see you|talk later)\b/.test(t)) {
    return "Thanks for calling — have a great day!";
  }
  if (/\b(thank|thanks|appreciate)\b/.test(t)) {
    return "You're very welcome! Is there anything else I can help you with?";
  }
  return `Hi, thanks for reaching out to ${agent.name}! This is the front desk — how can I help you today?`;
}

const mapsUrl = (location: string) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;

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
    return reply.status(201).send({ id: data.id, workspaceId: body.workspaceId, channel: data.channel, createdAt: data.created_at });
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
    const db = getSupabase();
    const t0 = Date.now();
    let embedMs = 0;
    let llmMs = 0;
    const tEmbed = Date.now();

    // Everything independent races in parallel: agent lookup, doc count, short-term
    // history and the query embedding — fast paths just discard what they don't need.
    const [agent, docCountRes, histRows, queryVector] = await Promise.all([
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
        .limit(Number(process.env.MEMORY_SHORT_TERM_TURNS ?? 20)),
      embedAll([body.content])
        .then((vectors) => {
          embedMs = Date.now() - tEmbed;
          return vectors[0] ?? null;
        })
        .catch((err: Error) => {
          console.error(`query embed failed, retrieval will be skipped: ${err.message}`);
          return null;
        }),
    ]);
    const docCount = docCountRes.count ?? 0;
    const decision: Decision = ruleFallback(body.content, docCount > 0, PLATFORM_TOOLS.map((t) => t.name));

    const history: ConversationMessage[] = (histRows.data ?? [])
      .reverse()
      .map((m) => ({
        id: String(m.id),
        conversationId,
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
    if (needsRetrieval && docCount > 0 && queryVector) {
      const { data: hits, error: searchErr } = await db.rpc("match_chunks", {
        p_workspace_id: body.workspaceId,
        p_query_embedding: queryVector,
        p_top_k: Number(process.env.RAG_TOP_K ?? 6),
        p_filter: {},
      });
      if (searchErr) throw Object.assign(new Error(`retrieval failed: ${searchErr.message}`), { status: 500 });
      retrieved = (hits ?? []).map((h: Record<string, unknown>) => ({
        id: String(h.id),
        workspaceId: body.workspaceId,
        documentId: String(h.document_id),
        content: String(h.content),
        tokens: 0,
        metadata: (h.metadata ?? {}) as Record<string, string | number | boolean>,
        score: Number(h.score),
      }));
    }

    let answerText: string;
    let verdict: HarnessVerdict;
    let answerSource: string;
    let contextInfo = { usedTokens: 0, truncated: false, includedChunkIds: [] as string[] };
    const toolResults: ToolResult[] = [];
    let streamed = false;

    const tool = decision.route === "use_tools" ? decision.requiredTools?.[0] : undefined;

    if (decision.route === "small_talk") {
      // Fast path: instant, local, no LLM — greetings must reply with zero delay.
      answerText = smallTalkReply(agent, body.content);
      verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
      answerSource = "fast-path";
    } else if (tool === "book_appointment") {
      const ctx = buildContext({
        agent,
        businessProfile: {},
        history,
        retrieved,
        customerMemory: [],
        maxTokens: agent.maxTokens || Number(process.env.CONTEXT_MAX_TOKENS ?? 6000),
      });
      const tLlm = Date.now();
      const llmResult = await complete({
        system: systemWithStyle(ctx.systemPrompt),
        context: `${ctx.contextText}\n\n${BOOKING_INSTRUCTIONS}`,
        user: body.content,
        fallback: agent.fallbackResponse,
      });
      llmMs = Date.now() - tLlm;
      const booking = extractBooking(llmResult.text);
      answerText = booking ? booking.rest : llmResult.text;
      answerSource = llmResult.source;
      contextInfo = { usedTokens: ctx.usedTokens, truncated: ctx.truncated, includedChunkIds: ctx.includedChunkIds };
      if (booking) {
        const calUrl = calendarUrl(`${agent.name} — appointment with ${booking.name}`, booking.startsAt, `Contact: ${booking.contact || "-"}`);
        const { error: bookErr } = await db.from("bookings").insert({
          workspace_id: body.workspaceId,
          conversation_id: conversationId,
          customer_name: booking.name,
          contact: booking.contact,
          starts_at: booking.startsAt,
          notes: "",
          source: "agent",
        });
        if (bookErr) console.error(`booking insert failed: ${bookErr.message}`);
        if (calUrl) toolResults.push({ type: "calendar", label: "Add to Google Calendar", url: calUrl });
        if (!answerText) answerText = "You're all set — I've noted your booking details.";
      }
      // Tool turns are conversational actions, not factual claims — skip grounding.
      verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
    } else if (tool === "get_location" && agent.location) {
      answerText = `You can find us at ${agent.location}.`;
      toolResults.push({ type: "maps", label: "Open in Google Maps", url: mapsUrl(agent.location) });
      verdict = { ok: true, confidence: 1, issues: [], safeText: answerText };
      answerSource = "tool";
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
        system: systemWithStyle(ctx.systemPrompt),
        context: ctx.contextText,
        user: body.content,
        fallback: agent.fallbackResponse,
      };
      contextInfo = { usedTokens: ctx.usedTokens, truncated: ctx.truncated, includedChunkIds: ctx.includedChunkIds };
      if (retrieved.length === 0) {
        // Nothing grounded to answer from (no docs / embed failed / no hit):
        // never call the LLM — instant, hallucination-proof fallback.
        answerText = agent.fallbackResponse;
        verdict = { ok: false, confidence: 0, issues: ["no knowledge context retrieved"], safeText: answerText };
        answerSource = "fallback";
      } else {
        if (body.stream) {
          // First token paints live; final event below carries the harness verdict
          // (which may replace the preview with the safe/fallback text).
          streamed = true;
          reply.hijack();
          reply.raw.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
        }
        const writeDelta = (d: string) => {
          try {
            reply.raw.write(`data: ${JSON.stringify({ type: "delta", text: d })}\n\n`);
          } catch {
            // client disconnected mid-stream
          }
        };
        const tLlm = Date.now();
        const llmResult = streamed ? await completeStream(opts, writeDelta) : await complete(opts);
        llmMs = Date.now() - tLlm;
        verdict = validateResponse(llmResult.text, retrieved, {
          fallbackResponse: agent.fallbackResponse,
        });
        answerText = verdict.safeText;
        answerSource = llmResult.source;
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
    const responsePayload = {
      conversationId,
      decision,
      verdict: { ok: verdict.ok, confidence: verdict.confidence, issues: verdict.issues },
      answer: { ...savedAssistant, createdAt: savedAssistant?.created_at ?? now },
      userMessage: { ...savedUser, createdAt: savedUser?.created_at ?? now },
      answerSource,
      toolResults,
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
