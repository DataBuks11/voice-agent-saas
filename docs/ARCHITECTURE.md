# Architecture

## Request flow (voice + text share the same intelligence path)

```
USER
 │
 ▼
Pipecat (services/voice: transport, VAD, barge-in)
 │
 ├─ STT (Whisper-compatible) → transcript
 └─ Conversation state
        │
        ▼
 Context Engine (engines/context)
   - conversation history (short-term memory)
   - business profile + agent config
   - retrieved knowledge (RAG)
   - long-term customer memory
   - token budget enforcement
        │
        ▼
 RAG (engines/rag + retrieval + reranking)
   - pgvector cosine search + metadata filter + optional hybrid + rerank abstraction
        │
        ▼
 Decision / Routing (engines/decision, Laya-compatible abstraction + rules fallback)
   - classify: answer_from_knowledge | use_tools | web_search | escalate | small_talk
   - cheap path first; expensive LLM only when needed
        │
   ┌────┴─────┐
   ▼          ▼
 Tools    Web Search (abstractions, per-tenant permissions)
   │          │
   └────┬─────┘
        ▼
 LLM (provider abstraction, never hardcoded vendor)
        │
        ▼
 Response Harness (engines/harness)
   - grounding check, unsupported-claim detection, policy check, fallback, confidence
        │
        ▼
 TTS (Chatterbox-compatible) → Pipecat → USER
        │
        ▼
 Persist: conversations, messages, memories, usage, analytics
```

## Multi-tenancy

Every domain table has `workspace_id`. API resolves workspace from authenticated
membership (`x-workspace-id` header must belong to caller). RLS policies enforce
`auth.uid() ∈ workspace members` or service-role bypass on server only.

Tables: profiles, workspaces, memberships, agents, agent_configs, knowledge_sources,
documents, chunks (pgvector), conversations, messages, customers, memories, tools,
tool_permissions, usage_events, api_keys.

## Provider-agnostic boundaries

Each external capability lives behind a TS or Python interface with ≥2 adapters
(real + stub/local). Adding a vendor = new adapter file, no core rewrite.

- `engines/rag`: EmbeddingsProvider, VectorStore (Supabase pgvector impl)
- `services/voice`: STTProvider, TTSProvider, LLMProvider
- `engines/decision`: DecisionProvider + RuleFallback
- `engines/reranking`: RerankerProvider (noop + heuristic)
- `engines/retrieval`: hybrid BM25+vector merge (pgvector + postgres FTS)
- tools: ToolRegistry + WebSearchProvider
