import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";

const agentSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  language: z.string().default("en"),
  tone: z.string().default("professional"),
  systemPrompt: z.string().default("You are a professional American-English receptionist. Be warm, natural and concise. Only answer from provided knowledge."),
  fallbackResponse: z.string().default("I don't have verified information about that yet."),
  location: z.string().default(""),
});

const rowToAgent = (r: Record<string, unknown>) => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  language: r.language,
  tone: r.tone,
  systemPrompt: r.system_prompt,
  fallbackResponse: r.fallback_response,
  location: r.location ?? "",
  maxTokens: r.max_tokens,
  temperature: r.temperature,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/agents", async (req, reply) => {
    const body = agentSchema.parse((req as { body: unknown }).body);
    const tenant = await requireTenant(req);
    if (tenant.workspaceId !== body.workspaceId) {
      throw Object.assign(new Error("workspaceId does not match x-workspace-id"), { status: 403 });
    }
    const db = getSupabase();
    const { data, error } = await db
      .from("agents")
      .insert({
        workspace_id: body.workspaceId,
        name: body.name,
        language: body.language,
        tone: body.tone,
        system_prompt: body.systemPrompt,
        fallback_response: body.fallbackResponse,
        location: body.location,
      })
      .select()
      .single();
    if (error) throw Object.assign(new Error(`agent create failed: ${error.message}`), { status: 500 });
    return reply.status(201).send(rowToAgent(data as Record<string, unknown>));
  });

  app.get("/agents", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    await requireTenant(req);
    const db = getSupabase();
    const { data, error } = await db
      .from("agents")
      .select()
      .eq("workspace_id", q.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw Object.assign(new Error(`agents list failed: ${error.message}`), { status: 500 });
    const items = (data ?? []).map(rowToAgent);
    return { items, total: items.length };
  });

  /**
   * Speech dictionary for STT biasing: agent names, document titles and known
   * customers. Feeding these back into the recogniser fixes names at decode
   * time ("Sudhansu" -> "Sudhanshu") instead of patching text afterwards.
   */
  app.get("/agents/speech-dictionary", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    const tenant = await requireTenant(req);
    const db = getSupabase();
    const terms = new Set<string>();
    const add = (v: unknown): void => {
      const s = String(v ?? "").trim();
      if (s && s.length <= 48) terms.add(s);
    };
    const [agents, docs, customers] = await Promise.all([
      db.from("agents").select("name").eq("workspace_id", tenant.workspaceId).limit(10),
      db.from("documents").select("title").eq("workspace_id", tenant.workspaceId).limit(30),
      db
        .from("customers")
        .select("display_name")
        .eq("workspace_id", tenant.workspaceId)
        .order("created_at", { ascending: false })
        .limit(80),
    ]);
    for (const row of (agents.data ?? []) as Record<string, unknown>[]) add(row.name);
    for (const row of (docs.data ?? []) as Record<string, unknown>[]) add(row.title);
    for (const row of (customers.data ?? []) as Record<string, unknown>[]) add(row.display_name);
    return { terms: [...terms].slice(0, 120) };
  });

  app.get("/agents/:id", async (req) => {
    const { id } = req.params as { id: string };
    await requireTenant(req);
    const db = getSupabase();
    const { data, error } = await db.from("agents").select().eq("id", id).maybeSingle();
    if (error) throw Object.assign(new Error(`agent fetch failed: ${error.message}`), { status: 500 });
    if (!data) throw Object.assign(new Error("agent not found"), { status: 404 });
    return rowToAgent(data as Record<string, unknown>);
  });
}
