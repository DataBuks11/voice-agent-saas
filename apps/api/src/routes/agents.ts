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
