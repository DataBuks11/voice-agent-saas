-- 0008_fts_and_knowledge: Fast full-text search and title indexing for RAG knowledge chunks
-- Safe and idempotent: can be executed multiple times without error.

-- 1. Full-text search GIN index on chunks content for instant keyword matching
create index if not exists chunks_content_fts_idx on chunks using gin (to_tsvector('english', content));

-- 2. Fast workspace and document lookup index
create index if not exists documents_workspace_title_idx on documents (workspace_id, title);
create index if not exists chunks_workspace_doc_idx on chunks (workspace_id, document_id);

-- 3. Optional helper function for full-text search fallback
create or replace function search_chunks_text(
  p_workspace_id uuid,
  p_query text,
  p_limit int default 8
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  metadata jsonb
)
language sql stable as $$
  select
    c.id,
    c.document_id,
    c.content,
    c.metadata
  from chunks c
  where c.workspace_id = p_workspace_id
    and (
      to_tsvector('english', c.content) @@ plainto_tsquery('english', p_query)
      or c.content ilike '%' || p_query || '%'
    )
  order by c.created_at desc
  limit p_limit;
$$;
