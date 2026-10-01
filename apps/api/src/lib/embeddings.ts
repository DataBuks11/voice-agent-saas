import {
  HashEmbeddingsProvider,
  LocalSemanticEmbeddings,
  OpenAiCompatibleEmbeddings,
  type EmbeddingsProvider,
} from "@voice-agent/rag";

let providerPromise: Promise<EmbeddingsProvider> | null = null;
let lastCreateError: string | null = null;

/**
 * Embeddings provider (decided once per process, then cached):
 * - EMBEDDING_API_KEY set      -> OpenAI-compatible /v1/embeddings (production quality)
 * - EMBEDDING_PROVIDER=hash    -> deterministic local hash stub (tests only)
 * - otherwise                  -> local semantic model (fastembed bge-small, no key,
 *                                 native 384d padded to storage dims 1536)
 * On local model failure it falls back to the hash stub so the pipeline never dies.
 */
async function createProvider(): Promise<EmbeddingsProvider> {
  const apiKey = process.env.EMBEDDING_API_KEY ?? "";
  const dimensions = Number(process.env.EMBEDDING_DIMENSIONS ?? 1536);
  if (apiKey) {
    return new OpenAiCompatibleEmbeddings({
      apiKey,
      model: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
      dimensions,
      baseUrl: process.env.EMBEDDING_BASE_URL || "",
    });
  }
  if ((process.env.EMBEDDING_PROVIDER ?? "") === "hash") {
    return new HashEmbeddingsProvider(dimensions);
  }
  try {
    const local = new LocalSemanticEmbeddings(dimensions);
    await local.init();
    return local;
  } catch (err) {
    lastCreateError = (err as Error).message;
    console.warn(`[embeddings] local semantic model failed, using hash-stub: ${lastCreateError}`);
    return new HashEmbeddingsProvider(dimensions);
  }
}

export function getEmbedder(): Promise<EmbeddingsProvider> {
  if (!providerPromise) providerPromise = createProvider();
  return providerPromise;
}

/** Decide the provider early (download model at boot instead of first request). */
export function warmupEmbeddings(): void {
  getEmbedder().catch(() => undefined);
}

export function getLastEmbeddingError(): string | null {
  return lastCreateError;
}

/** Embed in batches to stay under request size limits; returns vectors in input order. */
export async function embedAll(texts: string[], batchSize = 32): Promise<number[][]> {
  const provider = await getEmbedder();
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    out.push(...(await provider.embed(batch)));
  }
  return out;
}
