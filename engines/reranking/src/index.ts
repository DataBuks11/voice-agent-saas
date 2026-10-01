import type { RetrievalResult } from "@voice-agent/types";

export interface RerankerProvider {
  name: string;
  rerank(query: string, docs: RetrievalResult[], topK: number): Promise<RetrievalResult[]>;
}

export class NoopReranker implements RerankerProvider {
  name = "noop";
  async rerank(_q: string, docs: RetrievalResult[], topK: number): Promise<RetrievalResult[]> {
    return docs.slice(0, topK);
  }
}

/** Cheap keyword-overlap reranker: counts shared terms, stable and testable. */
export class KeywordOverlapReranker implements RerankerProvider {
  name = "keyword-overlap";
  async rerank(query: string, docs: RetrievalResult[], topK: number): Promise<RetrievalResult[]> {
    const terms = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    return docs
      .map((d) => {
        const words = d.content.toLowerCase().split(/[^a-z0-9]+/);
        let hits = 0;
        for (const w of words) if (terms.has(w)) hits++;
        return { ...d, score: d.score * 0.5 + (words.length ? hits / words.length : 0) * 0.5 };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
