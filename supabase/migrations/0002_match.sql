-- 0002_match: workspace-filtered vector search RPC used by the API retrieval layer.
-- Run AFTER 0001_init.sql (requires pgvector enabled + chunks table).

create or replace function match_chunks(
  p_workspace_id uuid,
  p_query_embedding vector(1536),
  p_top_k int default 6,
  p_filter jsonb default '{}'
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  score float
)
language sql stable as $$
  select
    c.id,
    c.document_id,
    c.content,
    c.metadata,
    1 - (c.embedding <=> p_query_embedding) as score
  from chunks c
  where c.workspace_id = p_workspace_id
    and c.embedding is not null
    and (p_filter = '{}' or c.metadata @> p_filter)
  order by c.embedding <=> p_query_embedding
  limit p_top_k;
$$;
