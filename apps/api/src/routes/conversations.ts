import type { FastifyInstance } from "fastify";
import { z } from "zod";

const messageSchema = z.object({
  workspaceId: z.string().uuid(),
  content: z.string().min(1),
});

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  // Full RAG→decision→LLM→harness path is wired in milestone 2 (orchestration).
  app.post("/conversations/:id/messages", async (req, reply) => {
    const body = messageSchema.parse((req as { body: unknown }).body);
    return reply.status(501).send({
      error: "conversation pipeline not yet wired (milestone 2)",
      received: { conversationId: (req.params as { id: string }).id, ...body },
    });
  });
}
