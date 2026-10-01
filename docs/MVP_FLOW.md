# MVP flow checklist

Milestone 1 must be REAL end-to-end (no fakes):

- [ ] Create workspace + agent via API (tenant isolated)
- [ ] Add business knowledge (text upload → OKF md+yaml → chunks → embeddings → pgvector)
- [ ] Retrieve knowledge (vector search + metadata filter)
- [ ] Ask question via `POST /v1/conversations/:id/messages` → grounded answer with citations
- [ ] TTS synthesis via Chatterbox-compatible adapter (or stub with warning) → audio
- [ ] Voice loop via Pipecat (STT → pipeline → TTS, barge-in) at least locally
- [ ] Harness validates grounding before returning; fallback on low confidence
- [ ] Conversation + usage persisted; analytics queryable

For each milestone: implement → tests → fix → typecheck → docs → report DONE/PARTIAL/REMAINING.
