import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalizeText, parseOkfMarkdown, chunkText } from "@voice-agent/rag";
import { getSupabase } from "../lib/supabase.js";
import { requireTenant } from "../lib/tenant.js";
import { embedAll, getEmbedder } from "../lib/embeddings.js";

const ingestSchema = z.object({
  workspaceId: z.string().uuid(),
  agentId: z.string().uuid().optional(),
  title: z.string().default("untitled"),
  markdown: z.string().min(1),
  // Append chunks into an existing document (used by chunked large-file uploads).
  documentId: z.string().uuid().optional(),
});

const uploadSchema = z.object({
  workspaceId: z.string().uuid(),
  filename: z.string().min(1).max(300),
  contentBase64: z.string().min(1),
  title: z.string().max(300).optional(),
});

const searchSchema = z.object({
  workspaceId: z.string().uuid(),
  query: z.string().min(1),
  topK: z.number().int().min(1).max(50).default(6),
});

const TEXT_EXT = /\.(md|markdown|txt|text|csv|tsv|json|log|rst|adoc|html?)$/i;
const PDF_EXT = /\.pdf$/i;
const DOCX_EXT = /\.docx$/i;

async function extractText(filename: string, buf: Buffer): Promise<string> {
  if (TEXT_EXT.test(filename) || !filename.includes(".")) return buf.toString("utf8");
  if (PDF_EXT.test(filename)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const doc = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(doc, { mergePages: true });
    return text ?? "";
  }
  if (DOCX_EXT.test(filename)) {
    const mammoth = (await import("mammoth")) as unknown as {
      extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
    };
    const { value } = await mammoth.extractRawText({ buffer: buf });
    return value ?? "";
  }
  throw Object.assign(
    new Error(`unsupported file type "${filename}" — use .md, .txt, .pdf or .docx`),
    { status: 400 },
  );
}

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  /** normalize -> OKF parse -> chunk -> embed -> persist. Returns chunk count. */
  async function persistMarkdown(workspaceId: string, documentId: string, markdown: string): Promise<number> {
    const db = getSupabase();
    const { metadata, body: clean } = parseOkfMarkdown(markdown);
    const normalized = normalizeText(clean);
    const chunks = chunkText(
      normalized,
      { chunkSize: Number(process.env.RAG_CHUNK_SIZE ?? 800), overlap: Number(process.env.RAG_CHUNK_OVERLAP ?? 120) },
      metadata as Record<string, string | number | boolean>,
      { workspaceId, documentId },
    );
    if (chunks.length) {
      const vectors = await embedAll(chunks.map((c) => c.content));
      const rows = chunks.map((c, i) => ({
        workspace_id: workspaceId,
        document_id: documentId,
        content: c.content,
        tokens: c.tokens,
        metadata: c.metadata,
        embedding: vectors[i],
      }));
      const { error: chunkErr } = await db.from("chunks").insert(rows);
      if (chunkErr) throw Object.assign(new Error(`chunk insert failed: ${chunkErr.message}`), { status: 500 });
    }
    return chunks.length;
  }

  // Full pipeline: normalize -> OKF parse -> chunk -> embed -> persist to pgvector.
  app.post("/knowledge/ingest", async (req, reply) => {
    const body = ingestSchema.parse((req as { body: unknown }).body);
    const tenant = await requireTenant(req);
    if (tenant.workspaceId !== body.workspaceId) {
      throw Object.assign(new Error("workspaceId does not match x-workspace-id"), { status: 403 });
    }
    const db = getSupabase();
    const { metadata } = parseOkfMarkdown(body.markdown);

    let documentId = body.documentId;
    let sourceId: string | null = null;

    if (documentId) {
      // Appending to an existing document (chunked upload part N).
      const { data: doc, error: docErr } = await db
        .from("documents")
        .select("id, source_id")
        .eq("id", documentId)
        .eq("workspace_id", body.workspaceId)
        .maybeSingle();
      if (docErr || !doc) throw Object.assign(new Error("document not found"), { status: 404 });
      sourceId = (doc.source_id as string) ?? null;
    } else {
      const { data: source, error: srcErr } = await db
        .from("knowledge_sources")
        .insert({ workspace_id: body.workspaceId, agent_id: body.agentId ?? null, kind: "text", status: "processing" })
        .select("id")
        .single();
      if (srcErr) throw Object.assign(new Error(`source create failed: ${srcErr.message}`), { status: 500 });
      sourceId = source.id;

      const { data: doc, error: docErr } = await db
        .from("documents")
        .insert({
          workspace_id: body.workspaceId,
          source_id: sourceId,
          title: body.title,
          metadata: metadata as Record<string, string | number | boolean>,
        })
        .select("id")
        .single();
      if (docErr) throw Object.assign(new Error(`document create failed: ${docErr.message}`), { status: 500 });
      documentId = doc.id;
    }
    if (!documentId) throw Object.assign(new Error("document id missing"), { status: 500 });

    const chunkCount = await persistMarkdown(body.workspaceId, documentId, body.markdown);

    if (sourceId && !body.documentId) {
      await db.from("knowledge_sources").update({ status: "ready" }).eq("id", sourceId);
    }

    return reply.status(201).send({
      sourceId,
      documentId,
      title: body.title,
      metadata,
      chunkCount,
      embeddingProvider: (await getEmbedder()).name,
      preview: [],
    });
  });

  // File upload: .md/.txt (any size via chunked parts) + .pdf/.docx (parsed server-side).
  app.post("/knowledge/upload", async (req, reply) => {
    const body = uploadSchema.parse((req as { body: unknown }).body);
    const tenant = await requireTenant(req);
    if (tenant.workspaceId !== body.workspaceId) {
      throw Object.assign(new Error("workspaceId does not match x-workspace-id"), { status: 403 });
    }
    const db = getSupabase();

    let buf: Buffer;
    try {
      buf = Buffer.from(body.contentBase64, "base64");
    } catch {
      throw Object.assign(new Error("invalid base64 payload"), { status: 400 });
    }
    if (!buf.length) throw Object.assign(new Error("empty file"), { status: 400 });

    const text = await extractText(body.filename, buf);
    if (!text.trim()) {
      throw Object.assign(new Error("no extractable text found in file (is it a scanned image?)"), { status: 422 });
    }

    const { data: source, error: srcErr } = await db
      .from("knowledge_sources")
      .insert({ workspace_id: body.workspaceId, agent_id: null, kind: "upload", status: "processing" })
      .select("id")
      .single();
    if (srcErr) throw Object.assign(new Error(`source create failed: ${srcErr.message}`), { status: 500 });

    const { data: doc, error: docErr } = await db
      .from("documents")
      .insert({
        workspace_id: body.workspaceId,
        source_id: source.id,
        title: body.title || body.filename,
        metadata: { filename: body.filename, bytes: buf.length },
      })
      .select("id")
      .single();
    if (docErr) throw Object.assign(new Error(`document create failed: ${docErr.message}`), { status: 500 });

    try {
      const chunkCount = await persistMarkdown(body.workspaceId, doc.id, text);
      await db.from("knowledge_sources").update({ status: "ready" }).eq("id", source.id);
      return reply.status(201).send({
        sourceId: source.id,
        documentId: doc.id,
        title: body.title || body.filename,
        chunkCount,
        embeddingProvider: (await getEmbedder()).name,
      });
    } catch (err) {
      await db.from("knowledge_sources").update({ status: "failed" }).eq("id", source.id);
      throw err;
    }
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
