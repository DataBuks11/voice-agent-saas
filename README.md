# AI Voice Agent SaaS — generic, multi-tenant, provider-agnostic

Production-oriented monorepo. No business / industry hardcoded. All behavior is driven by
tenant configuration + ingested knowledge + retrieval + memory + tools.

**Live:** Web dashboard · https://voice-agent-saas-web.vercel.app/app/
**API** · https://voice-agent-saas-production-3001.up.railway.app/health
**Voice WS** · wss://voice-runtime-production-dc24.up.railway.app

## 5-minute demo

1. Open https://voice-agent-saas-web.vercel.app/app/ → register → name your workspace.
2. **Agents → New agent**: set name, personality, and *Business address* (powers Google Maps).
3. **Knowledge**: paste markdown (or **Upload document** — .md/.txt stream in 600KB parts = any
   size; PDF/DOCX parsed server-side up to 20MB) → Ingest & embed → try
   `Search (cosine)`.
4. **Conversations**: ask `how much is a haircut?` → grounded answer with
   *answer source / decision / harness verdict / retrieval* visible in the turn trace.
   Ask `where are you located?` (maps chip) and `book me tomorrow at 5pm for John Doe`
   (calendar chip + row in **Dashboard → Bookings**).
5. **Voice**: press Start call → speak. Mic → 16kHz PCM → energy VAD (450ms) → STT →
   grounded turn → sentence-streamed TTS. Interrupt by talking over it.
6. Demo script for clients: `node scripts/showcase.mjs` — runs all of the above against
   the live API with latencies and exits non-zero on any failure.

## What makes it trustworthy

- **Zero hallucination**: every knowledge answer passes a response harness
  (grounded / verdict / confidence). Unverifiable → fallback answer, never an invented fact.
- **Instant greeting**: `small_talk` fast path — no retrieval, no LLM (~1s).
- **Gemini everywhere** (OpenAI-compatible): `gemini-2.5-flash` for answers,
  `gemini-embedding-001` (1536d) for embeddings — both drop-in replaceable via env.
- **Structured turn logs**: each turn emits `{"evt":"turn", embedMs, llmMs, totalMs, …}`.

## Measured latency (production, warm)

| Turn | Latency |
|---|---|
| Greeting (fast path) | ~0.9–1.3s |
| Grounded knowledge answer | ~1.7–3.2s |
| Knowledge search (embed + pgvector) | ~1.0s |
| Booking → calendar link | ~3s |
| Voice end-to-end (prod WS) | ~5s to first answer audio |

## End-to-end MVP path

```
Dashboard → Create Agent → Add Business Knowledge → Ingest (OKF → chunk → embed → pgvector)
→ Ask Question → Retrieve → Context Engine → Decision Layer → Tools/WebSearch? → LLM
→ Response Harness → TTS → WebSocket voice response
```

## Repo layout

```
apps/web        React+TS+Vite dashboard (landing theme, knowledge, conversations, voice)
apps/api        Node+TS+Fastify multi-tenant API
services/voice  Python WebSocket voice runtime (keyless local STT/TTS, hosted optional)
engines/*       decision, context, rag, retrieval, reranking, harness, memory, orchestration
packages/*      shared types / typed env config / logging+errors
supabase/       migrations (auto-applied at API boot) — pgvector, RLS, bookings, agents.location
scripts/        showcase.mjs (live demo), _e2e / _features_e2e / _web_e2e / _voice_e2e harnesses
knowledge/okf   OKF-style Markdown+YAML examples (generic only)
docs/           architecture, setup, MVP flow, deploy
```

## Configuration (env)

Provider-agnostic: leave a key empty and the pipeline degrades safely (keyless/local or
grounded fallback) — never fails a turn.

| Concern | Key env vars | Notes |
|---|---|---|
| LLM | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_MAX_TOKENS`, `LLM_REASONING_EFFORT` | Gemini OpenAI-compat example in `.env.example` |
| Embeddings | `EMBEDDING_BASE_URL`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY`, `EMBEDDING_DIMENSIONS` | all chunks in a workspace must share one provider; after switching run `scripts/_reembed.cjs` |
| STT (voice) | `STT_API_KEY`, `STT_MODEL`, `STT_BASE_URL` | no key → local faster-whisper; key → hosted whisper |
| TTS (voice) | `TTS_API_KEY`, `TTS_MODEL`, `TTS_VOICE` | no key → local piper; key → OpenAI-compatible `/audio/speech` (pcm) |
| Rate limit | `RATE_LIMIT_MAX` (default 600/min/IP), `RATE_LIMIT_AUTH_MAX` (30/min), `RATE_LIMIT_DISABLED` | auth+admin stricter |
| Uploads | `BODY_LIMIT` (default 48MB) | PDF/DOCX cap 20MB enforced in route |
| Booking / Maps | agent `location` field, `BUSINESS_TIMEZONE` | calendar via Google Calendar template link (no OAuth) |

## Tests

```bash
pnpm typecheck            # TS strict across the monorepo
pnpm test                 # unit + engine tests
pnpm test:python          # voice VAD/pipeline/provider tests
node scripts/showcase.mjs # live capability demo (prod API)
node scripts/_features_e2e.mjs
node scripts/_e2e.mjs
node scripts/_web_e2e.mjs            # browser harness (Vercel)
python scripts/_voice_e2e.py         # local WS; --url wss://… for prod
```

## Deploy

`main` auto-deploys: Railway (API + voice-runtime) and Vercel (web).
Migrations apply at API boot from `supabase/migrations/`. See `docs/DEPLOY.md`.

## Rules

- TypeScript strict, Python type hints.
- Provider abstractions only: LLM / STT / TTS / Embeddings / WebSearch / Reranker.
- `DATABASE_URL` / service-role key never exposed to frontend.
- RLS on every tenant-owned table.
- Do not claim a feature complete until tested end-to-end.
