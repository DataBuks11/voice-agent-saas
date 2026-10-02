import type { FastifyInstance } from "fastify";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";

export async function bookingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/bookings", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    await requireTenant(req);
    const db = getSupabase();
    const { data, error } = await db
      .from("bookings")
      .select("id, conversation_id, customer_name, contact, starts_at, notes, status, source, created_at")
      .eq("workspace_id", q.workspaceId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw Object.assign(new Error(`bookings list failed: ${error.message}`), { status: 500 });
    const items = (data ?? []).map((b) => ({
      id: b.id,
      conversationId: b.conversation_id,
      customerName: b.customer_name,
      contact: b.contact,
      startsAt: b.starts_at,
      notes: b.notes,
      status: b.status,
      source: b.source,
      createdAt: b.created_at,
    }));
    return { items, total: items.length };
  });
}
