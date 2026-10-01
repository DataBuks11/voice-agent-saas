import type { DocumentChunk, RetrievalResult } from "@voice-agent/types";

export interface VectorStore {
  search(workspaceId: string, queryEmbedding: number[], topK: number, filter?: Record<string, string | number | boolean>): Promise<RetrievalResult[]>;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i] as number;
    const bv = b[i] as number;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function matchesFilter(chunk: DocumentChunk, filter?: Record<string, string | number | boolean>): boolean {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => chunk.metadata[k] === v);
}

/** In-memory vector store — used in tests and as reference for Supabase pgvector impl. */
export class InMemoryVectorStore implements VectorStore {
  constructor(private chunks: DocumentChunk[] = []) {}
  add(c: DocumentChunk[]): void { this.chunks.push(...c); }
  async search(workspaceId: string, q: number[], topK: number, filter?: Record<string, string | number | boolean>): Promise<RetrievalResult[]> {
    return this.chunks
      .filter((c) => c.workspaceId === workspaceId && c.embedding && matchesFilter(c, filter))
      .map((c) => ({ ...c, score: cosine(q, c.embedding!) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

/** Merge vector hits with keyword (FTS) hits — simple reciprocal-rank style blend. */
export function hybridMerge(vector: RetrievalResult[], keyword: RetrievalResult[], vectorWeight = 0.7): RetrievalResult[] {
  const map = new Map<string, RetrievalResult>();
  for (const [i, r] of vector.entries()) {
    map.set(r.id, { ...r, score: (map.get(r.id)?.score ?? 0) + vectorWeight * (1 / (i + 1)) });
  }
  for (const [i, r] of keyword.entries()) {
    const prev = map.get(r.id);
    map.set(r.id, { ...r, score: (prev?.score ?? 0) + (1 - vectorWeight) * (1 / (i + 1)) });
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}
