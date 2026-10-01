import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeText, parseOkfMarkdown, chunkText } from "@voice-agent/rag";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";
import { embedAll } from "../lib/embeddings.js";

const ingestSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  title: z.string().default("untitled"),
  markdown: z.string().min(1),
});

const searchSchema = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).default(6),
});

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  // Full pipeline: normalize -> OKF parse -> chunk -> embed -> persist to pgvector.
  app.post("/knowledge/ingest", async (req, reply) => {
    const body = ingestSchema.parse((req as { body: unknown }).body);
    const tenant = await requireTenant(req);
    if (tenant.workspaceId !== body.workspaceId) {
      throw Object.assign(new Error("workspaceId does not match x-workspace-id"), { status: 403 });
    }
    const { metadata, body: clean } = parseOkfMarkdown(body.markdown);
    const normalized = normalizeText(clean);
    const db = getSupabase();

    const { data: source, error: srcErr } = await db
      .from("knowledge_sources")
      .insert({ workspace_id: body.workspaceId, agent_id: body.agentId ?? null, kind: "text", status: "processing" })
      .select("id")
      .single();
    if (srcErr) throw Object.assign(new Error(`source create failed: ${srcErr.message}`), { status: 500 });

    const { data: doc, error: docErr } = await db
      .from("documents")
      .insert({
        workspace_id: body.workspaceId,
        source_id: source.id,
        title: body.title,
        metadata: metadata as Record<string, string | number | boolean>,
      })
      .select("id")
      .single();
    if (docErr) throw Object.assign(new Error(`document create failed: ${docErr.message}`), { status: 500 });

    const chunks = chunkText(
      normalized,
      { chunkSize: Number(process.env.RAG_CHUNK_SIZE ?? 800), overlap: Number(process.env.RAG_CHUNK_OVERLAP ?? 120) },
      metadata as Record<string, string | number | boolean>,
      { workspaceId: body.workspaceId, documentId: doc.id },
    );

    if (chunks.length) {
      const vectors = await embedAll(chunks.map((c) => c.content));
      const rows = chunks.map((c, i) => ({
        workspace_id: body.workspaceId,
        document_id: doc.id,
        content: c.content,
        tokens: c.tokens,
        metadata: c.metadata,
        embedding: vectors[i],
      }));
      const { error: chunkErr } = await db.from("chunks").insert(rows);
      if (chunkErr) {
        await db.from("knowledge_sources").update({ status: "failed" }).eq("id", source.id);
        throw Object.assign(new Error(`chunk insert failed: ${chunkErr.message}`), { status: 500 });
      }
    }

    await db.from("knowledge_sources").update({ status: "ready" }).eq("id", source.id);

    return reply.status(201).send({
      sourceId: source.id,
      documentId: doc.id,
      title: body.title,
      metadata,
      chunkCount: chunks.length,
      embeddingProvider: (await import("../lib/embeddings.js")).getEmbedder().name,
      preview: chunks.slice(0, 2).map((c) => ({ tokens: c.tokens, text: c.content.slice(0, 160) })),
    });
  });

  app.get("/knowledge/documents", async (req) => {
    const q = (req as { query: Record<string, string> }).query;
    if (!q.workspaceId) throw Object.assign(new Error("workspaceId required"), { status: 400 });
    await requireTenant(req);
    const db = getSupabase();
    const { data, error } = await db
      .from("documents")
      .select("id, title, metadata, created_at, source_id")
      .eq("workspace_id", q.workspaceId)
      .order("created_at", { ascending: false });
    if (error) throw Object.assign(new Error(`documents list failed: ${error.message}`), { status: 500 });

    const ids = (data ?? []).map((d) => d.id as string);
    let counts: Record<string, number> = {};
    if (ids.length) {
      const { data: chunkRows } = await db.from("chunks").select("document_id").in("document_id", ids);
      for (const row of chunkRows ?? []) {
        const key = String(row.document_id);
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    const items = (data ?? []).map((d) => ({
      id: d.id,
      title: d.title,
      metadata: d.metadata,
      createdAt: d.created_at,
      chunkCount: counts[d.id as string] ?? 0,
    }));
    return { items, total: items.length };
  });

  // Vector search via match_chunks RPC (pgvector cosine distance).
  app.post("/knowledge/search", async (req) => {
    const body = searchSchema.parse((req as { body: unknown }).body);
    await requireTenant(req);
    const db = getSupabase();
    const [queryVector] = await embedAll([body.query]);
    const { data, error } = await db.rpc("match_chunks", {
      p_workspace_id: body.workspaceId,
      p_query_embedding: queryVector,
      p_top_k: body.topK,
      p_filter: {},
    });
    if (error) throw Object.assign(new Error(`search failed: ${error.message}`), { status: 500 });
    return { items: data ?? [], total: (data ?? []).length };
  });
}
