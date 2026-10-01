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
