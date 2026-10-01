import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSupabase } from "../lib/supabase.js";
import { verifyMembership } from "../lib/tenant.js";
import { ensureAuthUser } from "../lib/auth.js";

const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(80),
  userId: z.string().uuid(),
});

/**
 * Workspace bootstrap. Supabase Auth signup UI lands in milestone 3;
 * until then the dashboard generates a local user id and creates an
 * owner membership here, which is what all tenant checks verify against.
 */
export async function workspaceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/workspaces", async (req, reply) => {
    const body = createWorkspaceSchema.parse((req as { body: unknown }).body);
    const db = getSupabase();

    const { data: ws, error: wsErr } = await db
      .from("workspaces")
      .insert({ name: body.name })
      .select("id, name, created_at")
      .single();
    if (wsErr) throw Object.assign(new Error(`workspace create failed: ${wsErr.message}`), { status: 500 });

    await ensureAuthUser(db, body.userId);
    const { error: memErr } = await db
      .from("memberships")
      .insert({ workspace_id: ws.id, user_id: body.userId, role: "owner" });
    if (memErr) throw Object.assign(new Error(`membership create failed: ${memErr.message}`), { status: 500 });

    await db.from("profiles").upsert({ id: body.userId, display_name: null }, { onConflict: "id" });

    return reply.status(201).send({ id: ws.id, name: ws.name, createdAt: ws.created_at, role: "owner" });
  });

  app.get("/workspaces", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.userId) throw Object.assign(new Error("userId required"), { status: 400 });
    const db = getSupabase();
    const { data, error } = await db
      .from("memberships")
      .select("role, workspaces(id, name, created_at)")
      .eq("user_id", q.userId);
    if (error) throw Object.assign(new Error(`workspaces list failed: ${error.message}`), { status: 500 });
    const items = (data ?? [])
      .map((row) => {
        const ws = row.workspaces as unknown as { id: string; name: string; created_at: string } | null;
        if (!ws) return null;
        return { id: ws.id, name: ws.name, createdAt: ws.created_at, role: row.role };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return { items, total: items.length };
  });

  app.post("/workspaces/:id/join", async (req, reply) => {
    const body = z.object({ userId: z.string().uuid() }).parse((req as { body: unknown }).body);
    const { id } = req.params as { id: string };
    const db = getSupabase();
    await ensureAuthUser(db, body.userId);
    const { error } = await db.from("memberships").insert({ workspace_id: id, user_id: body.userId, role: "member" });
    if (error && error.code !== "23505") throw Object.assign(new Error(`join failed: ${error.message}`), { status: 500 });
    const ctx = await verifyMembership(body.userId, id);
    return reply.status(201).send(ctx);
  });
}
