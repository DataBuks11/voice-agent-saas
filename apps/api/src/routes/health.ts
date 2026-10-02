import type { FastifyInstance } from "fastify";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async (req) => ({
    ok: true,
    service: "api",
    ts: new Date().toISOString(),
    stats: req.server.stats,
  }));
}
