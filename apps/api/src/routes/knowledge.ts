import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeText, parseOkfMarkdown, chunkText } from "@voice-agent/rag";

const ingestSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  title: z.string().default("untitled"),
  markdown: z.string().min(1),
});

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // Real pipeline step 1: normalize → OKF parse → chunk. Embeddings + pgvector insert in m2.
  app.post("/knowledge/ingest", async (req, reply) => {
    const body = ingestSchema.parse((req as { body: unknown }).body);
    const { metadata, body: clean } = parseOkfMarkdown(body.markdown);
    const normalized = normalizeText(clean);
    const chunks = chunkText(normalized, { chunkSize: 800, overlap: 120 }, metadata, {
      workspaceId: body.workspaceId,
      documentId: "pending",
    });
    return reply.status(201).send({
      title: body.title,
      metadata,
      chunkCount: chunks.length,
      preview: chunks.slice(0, 2),
      note: "embeddings+pgvector persistence lands in milestone 2",
    });
  });
}
