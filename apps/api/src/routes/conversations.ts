import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Agent, ConversationMessage, Decision, RetrievalResult, HarnessVerdict } from "@voice-agent/types";
import { ruleFallback } from "@voice-agent/decision";
import { buildContext } from "@voice-agent/context";
import { validateResponse } from "@voice-agent/harness";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";
import { embedAll } from "../lib/embeddings.js";
import { complete } from "../lib/llm.js";

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
});

const DEFAULT_AGENT: Agent = {
  id: "default",
  workspaceId: "",
  name: "Business Assistant",
  language: "en",
  tone: "professional",
  systemPrompt: "You are a helpful business voice assistant. Only answer from provided knowledge.",
  fallbackResponse: "I don't have verified information about that yet.",
  maxTokens: 6000,
  temperature: 0.4,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

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
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
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

    const agent = await loadAgent(body.workspaceId, body.agentId);

    const { data: histRows } = await db
      .from("messages")
      .select("id, role, content, citations, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(Number(process.env.MEMORY_SHORT_TERM_TURNS ?? 20));
    const history: ConversationMessage[] = (histRows ?? [])
      .reverse()
      .map((m) => ({
        id: String(m.id),
        conversationId,
        role: m.role as ConversationMessage["role"],
        content: String(m.content),
        citations: (m.citations ?? []) as string[],
        createdAt: String(m.created_at),
      }));

    const { count: docCount } = await db
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", body.workspaceId);

    const decision: Decision = ruleFallback(body.content, (docCount ?? 0) > 0, []);

    let retrieved: RetrievalResult[] = [];
    if (decision.route === "answer_from_knowledge" || decision.route === "web_search") {
      const [queryVector] = await embedAll([body.content]);
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

    const ctx = buildContext({
      agent,
      businessProfile: {},
      history,
      retrieved,
      customerMemory: [],
      maxTokens: agent.maxTokens || Number(process.env.CONTEXT_MAX_TOKENS ?? 6000),
    });

    const llmResult = await complete({
      system: ctx.systemPrompt,
      context: ctx.contextText,
      user: body.content,
      fallback: agent.fallbackResponse,
    });

    const verdict: HarnessVerdict = validateResponse(llmResult.text, retrieved, {
      fallbackResponse: agent.fallbackResponse,
    });

    const now = new Date().toISOString();
    const userMsg = { workspace_id: body.workspaceId, conversation_id: conversationId, role: "user", content: body.content, citations: [] };
    const assistantMsg = {
      workspace_id: body.workspaceId,
      conversation_id: conversationId,
      role: "assistant",
      content: verdict.safeText,
      citations: retrieved.map((r) => r.id),
    };
    const { data: saved, error: saveErr } = await db.from("messages").insert([userMsg, assistantMsg]).select("id, role, content, citations, created_at");
    if (saveErr) throw Object.assign(new Error(`message persist failed: ${saveErr.message}`), { status: 500 });

    const [savedUser, savedAssistant] = saved ?? [];
    return reply.status(201).send({
      conversationId,
      decision,
      verdict: { ok: verdict.ok, confidence: verdict.confidence, issues: verdict.issues },
      answer: { ...savedAssistant, createdAt: savedAssistant?.created_at ?? now },
      userMessage: { ...savedUser, createdAt: savedUser?.created_at ?? now },
      answerSource: llmResult.source,
      retrieved: retrieved.map((r) => ({ id: r.id, documentId: r.documentId, score: r.score, text: r.content.slice(0, 200) })),
      context: { usedTokens: ctx.usedTokens, truncated: ctx.truncated, includedChunkIds: ctx.includedChunkIds },
    });
  });
}
