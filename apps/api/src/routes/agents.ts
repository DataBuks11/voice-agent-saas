import type { FastifyInstance } from "fastify";
import { z } from "zod";

const agentSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1),
  language: z.string().default("en"),
  tone: z.string().default("professional"),
  systemPrompt: z.string().default("You are a helpful business voice assistant."),
  fallbackResponse: z.string().default("I don't have verified information about that yet."),
});

// NOTE: Supabase persistence is wired in milestone 2. These handlers validate
// tenant-scoped input and return a typed shape so the dashboard can build
// against a stable contract without fake data.
export async function agentRoutes(app: FastifyInstance): Promise<void> {
  app.post("/agents", async (req, reply) => {
    const body = agentSchema.parse((req as { body: unknown }).body);
    // TODO(m2): verify membership via Supabase Auth + insert into agents table.
    return reply.status(201).send({ id: "pending-persistence", ...body });
  });

  app.get("/agents", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    return { items: [], total: 0 };
  });
}
