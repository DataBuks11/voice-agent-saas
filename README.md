# AI Voice Agent SaaS — generic, multi-tenant, provider-agnostic

Production-oriented monorepo. No business / industry hardcoded. All behavior is driven by
tenant configuration + ingested knowledge + retrieval + memory + tools.

## End-to-end MVP path

```
Dashboard → Create Agent → Add Business Knowledge → Ingest (OKF → chunk → embed → pgvector)
→ Ask Question → Retrieve → Context Engine → Decision Layer → Tools/WebSearch? → LLM
→ Response Harness → TTS (Chatterbox-compatible) → Pipecat → Voice response
```

## Repo layout

```
apps/web        React+TS+Vite+Tailwind dashboard
apps/api        Node+TS+Fastify multi-tenant API
services/voice  Python + Pipecat realtime voice runtime
engines/*       decision, context, rag, retrieval, reranking, harness, memory, orchestration
packages/types  shared TS types (tenant, agent, knowledge, conversation, memory, tools)
packages/config typed env validation (no secrets committed)
packages/shared logging, errors, pagination, tenant helpers
supabase/       pgvector schema + RLS + seed
knowledge/okf   OKF-style Markdown+YAML examples (generic only)
tests/          unit, integration, rag, voice, hallucination, e2e
docs/           architecture, setup, MVP flow
docker/         local dev compose
```

## Rules

- TypeScript strict, Python type hints.
- Provider abstractions only: LLM / STT / TTS / Embeddings / WebSearch / Reranker.
- `DATABASE_URL` / service-role key never exposed to frontend.
- RLS on every tenant-owned table.
- Do not claim a feature complete until tested end-to-end.
