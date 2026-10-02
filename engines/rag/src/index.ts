import type { DocumentChunk } from "@voice-agent/types";
import { estimateTokens } from "@voice-agent/shared";

export interface ChunkOptions {
  chunkSize?: number; // chars
  overlap?: number; // chars
  source?: string;
}

/** Normalize business-supplied text: unify newlines, trim, collapse excess blank lines. */
export function normalizeText(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export interface OkfDoc {
  metadata: Record<string, string | number | boolean>;
  body: string;
}

/** Minimal OKF-style Markdown+YAML frontmatter parser (no external dep). */
export function parseOkfMarkdown(md: string): OkfDoc {
  const m = md.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m || m[1] === undefined) return { metadata: {}, body: normalizeText(md) };
  const meta: Record<string, string | number | boolean> = {};
  for (const line of (m[1] as string).split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const k = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    if (/^(true|false)$/i.test(raw)) meta[k] = raw.toLowerCase() === "true";
    else if (raw !== "" && !Number.isNaN(Number(raw))) meta[k] = Number(raw);
    else meta[k] = raw;
  }
  return { metadata: meta, body: normalizeText(m[2] ?? "") };
}

/** Sliding-window chunker with overlap. Real implementation used by ingestion. */
export function chunkText(
  text: string,
  opts: ChunkOptions = {},
  baseMeta: Record<string, string | number | boolean> = {},
  ids: { workspaceId: string; documentId: string },
): DocumentChunk[] {
  const size = opts.chunkSize ?? 800;
  const overlap = Math.min(opts.overlap ?? 120, Math.floor(size / 2));
  const clean = normalizeText(text);
  if (!clean) return [];
  const chunks: DocumentChunk[] = [];
  let start = 0;
  let idx = 0;
  while (start < clean.length) {
    const end = Math.min(start + size, clean.length);
    const content = clean.slice(start, end);
    chunks.push({
      id: `${ids.documentId}:c${idx}`,
      workspaceId: ids.workspaceId,
      documentId: ids.documentId,
      content,
      tokens: estimateTokens(content),
      metadata: { ...baseMeta, chunkIndex: idx, source: opts.source ?? "ingest" },
    });
    if (end >= clean.length) break;
    start = end - overlap;
    idx += 1;
  }
  return chunks;
}

export interface EmbeddingsProvider {
  name: string;
  dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Deterministic local stub for tests/dev when no API key is set. NOT for production quality. */
export class HashEmbeddingsProvider implements EmbeddingsProvider {
  name = "hash-stub";
  constructor(public dimensions = 128) {}
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array(this.dimensions).fill(0);
      for (let i = 0; i < t.length; i++) {
        v[i % this.dimensions] += t.charCodeAt(i) / 255;
      }
      const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
      return v.map((x) => x / norm);
    });
  }
}

export interface EmbeddingsProviderOptions {
  apiKey: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
}

/** OpenAI-compatible /embeddings endpoint (works with OpenAI, Azure-compatible, local gateways). */
export class OpenAiCompatibleEmbeddings implements EmbeddingsProvider {
  name: string;
  constructor(private opts: EmbeddingsProviderOptions) {
    this.name = `openai-compatible:${opts.model ?? "text-embedding-3-small"}`;
  }
  get dimensions(): number {
    return this.opts.dimensions ?? 1536;
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const base = (this.opts.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    const body = JSON.stringify({
      model: this.opts.model ?? "text-embedding-3-small",
      input: texts,
      // OpenAI `dimensions` / Gemini output_dimensionality — keeps storage dims exact
      ...(this.opts.dimensions ? { dimensions: this.opts.dimensions } : {}),
    });
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 300 * 2 ** (attempt - 1)));
      let res: Response;
      try {
        res = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
          body,
          signal: AbortSignal.timeout(15000),
        });
      } catch (err) {
        lastError = err as Error;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`embeddings request failed (${res.status})`);
        continue;
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`embeddings request failed (${res.status}): ${detail.slice(0, 300)}`);
      }
      const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
    }
    throw lastError ?? new Error("embeddings request failed");
  }
}

/** Pad (or truncate) a vector to the storage dimension; zero-padding preserves cosine similarity. */
function fitDimensions(vec: number[], dims: number): number[] {
  if (vec.length === dims) return vec;
  if (vec.length > dims) return vec.slice(0, dims);
  return vec.concat(new Array(dims - vec.length).fill(0));
}

/**
 * Local semantic embeddings via fastembed (ONNX bge-small-en-v1.5, CPU, no API key).
 * Native vectors are padded from 384 -> storage dims (default 1536).
 */
export class LocalSemanticEmbeddings implements EmbeddingsProvider {
  name = "local-fastembed-bge-small";
  private model: import("fastembed").FlagEmbedding | null = null;
  constructor(
    public dimensions = 1536,
    private readonly opts: { cacheDir?: string } = {},
  ) {}

  async init(): Promise<void> {
    if (this.model) return;
    const { FlagEmbedding, EmbeddingModel, ExecutionProvider } = await import("fastembed");
    this.model = await FlagEmbedding.init({
      model: EmbeddingModel.BGESmallENV15,
      executionProviders: [ExecutionProvider.CPU],
      showDownloadProgress: false,
      ...(this.opts.cacheDir ? { cacheDir: this.opts.cacheDir } : {}),
    });
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    await this.init();
    const out: number[][] = [];
    for await (const batch of this.model!.embed(texts, 16)) {
      for (const v of batch) out.push(fitDimensions(v, this.dimensions));
    }
    return out;
  }
}
