import { HashEmbeddingsProvider, OpenAiCompatibleEmbeddings, type EmbeddingsProvider } from "@voice-agent/rag";

let cached: EmbeddingsProvider | null = null;

/**
 * Embeddings provider:
 * - EMBEDDING_API_KEY set  -> OpenAI-compatible /v1/embeddings (production quality)
 * - otherwise              -> deterministic local hash stub so the pipeline still runs end-to-end
 * Dimensions must match chunks.embedding vector(1536).
 */
export function getEmbedder(): EmbeddingsProvider {
  if (cached) return cached;
  const apiKey = process.env.EMBEDDING_API_KEY ?? "";
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
  cached = apiKey
    ? new OpenAiCompatibleEmbeddings({
        apiKey,
        model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
        dimensions,
        baseUrl: process.env.EMBEDDING_BASE_URL || "",
      })
    : new HashEmbeddingsProvider(dimensions);
  return cached;
}

/** Embed in batches to stay under request size limits; returns vectors in input order. */
export async function embedAll(texts: string[], batchSize = 32): Promise<number[][]> {
  const provider = getEmbedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    out.push(...(await provider.embed(batch)));
  }
  return out;
}
