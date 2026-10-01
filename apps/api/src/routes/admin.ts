import type { FastifyInstance, FastifyRequest } from "fastify";
import { runMigrations } from "../lib/migrate.js";
import { getEmbedder } from "../lib/embeddings.js";

function requireToken(req: FastifyRequest): void {
  const secret = process.env.ADMIN_TOKEN ?? "";
  if (!secret) throw Object.assign(new Error("ADMIN_TOKEN not configured"), { status: 503 });
  const headers = req.headers as Record<string, string | undefined>;
  if ((headers["x-admin-token"] ?? "") !== secret) {
    throw Object.assign(new Error("forbidden"), { status: 403 });
  }
}

/**
 * Admin operations guarded by the ADMIN_TOKEN env var.
 * POST /v1/admin/migrate       -> apply pending SQL migrations (x-admin-token header).
 * GET  /v1/admin/diagnostics   -> embeddings provider + config snapshot.
 * Kept because the app talks to Supabase over REST (no direct DB access from dev machines).
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.post("/admin/migrate", async (req, reply) => {
    requireToken(req);
    const result = await runMigrations(process.env.DATABASE_URL ?? "");
    return reply.send(result);
  });

  app.get("/admin/diagnostics", async (req, reply) => {
    requireToken(req);
    const provider = await getEmbedder().catch((e) => ({ name: `error: ${e.message}`, dimensions: 0 }));
    return reply.send({
      embeddings: { provider: provider.name, dimensions: provider.dimensions },
      llm: {
        baseUrl: process.env.LLM_BASE_URL || "(default openai)",
        model: process.env.LLM_MODEL || "",
        keySet: Boolean(process.env.LLM_API_KEY),
      },
      auth: { jwtSecretSet: Boolean(process.env.JWT_SECRET), adminTokenSet: Boolean(process.env.ADMIN_TOKEN) },
      node: process.version,
      cwd: process.cwd(),
    });
  });
}
