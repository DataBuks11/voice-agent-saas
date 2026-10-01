import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1),
  API_PORT: z.coerce.number().default(3001),
  API_HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  LLM_PROVIDER: z.string().default("openai-compatible"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_BASE_URL: z.string().default(""),
  EMBEDDING_PROVIDER: z.string().default("openai-compatible"),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1536),
  STT_PROVIDER: z.string().default("whisper-compatible"),
  RAG_CHUNK_SIZE: z.coerce.number().default(800),
  RAG_CHUNK_OVERLAP: z.coerce.number().default(120),
  RAG_TOP_K: z.coerce.number().default(6),
  CONTEXT_MAX_TOKENS: z.coerce.number().default(6000),
  MEMORY_SHORT_TERM_TURNS: z.coerce.number().default(20),
  JWT_SECRET: z.string().default("dev-secret-change-me"),
  ADMIN_TOKEN: z.string().default(""),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error("Invalid configuration: " + parsed.error.message);
  }
  return parsed.data;
}
