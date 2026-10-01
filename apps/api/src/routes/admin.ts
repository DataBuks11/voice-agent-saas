import type { FastifyInstance } from "fastify";
import { runMigrations } from "../lib/migrate.js";

/**
 * Admin operations guarded by the ADMIN_TOKEN env var.
 * POST /v1/admin/migrate  -> apply pending SQL migrations (x-admin-token header).
 * Kept because the app talks to Supabase over REST (no direct DB access from dev machines).
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post("/admin/migrate", async (req, reply) => {
    const secret = process.env.ADMIN_TOKEN ?? "";
    if (!secret) throw Object.assign(new Error("ADMIN_TOKEN not configured"), { status: 503 });
    const headers = req.headers as Record<string, string | undefined>;
    if ((headers["x-admin-token"] ?? "") !== secret) {
      throw Object.assign(new Error("forbidden"), { status: 403 });
    }
    const result = await runMigrations(process.env.DATABASE_URL ?? "");
    return reply.send(result);
  });
}
