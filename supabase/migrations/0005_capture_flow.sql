-- 0005_capture_flow: front-desk slot capture state + pronunciation-safe customers

create table if not exists capture_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  intent text not null default 'booking',
  status text not null default 'capturing' check (status in ('capturing','confirming','done','abandoned')),
  step int not null default 0,
  data jsonb not null default '{}',
  skipped jsonb not null default '[]',
  customer_id uuid references customers(id) on delete set null,
  created_at timestamstz not null default now(),
  updated_at timestamstz not null default now()
);
create unique index if not exists capture_sessions_conversation_idx on capture_sessions (conversation_id);
create index if not exists capture_sessions_workspace_idx on capture_sessions (workspace_id, updated_at desc);

alter table capture_sessions enable row level security;
drop policy if exists tenant_isolation on capture_sessions;
create policy tenant_isolation on capture_sessions for all
  using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));

-- Canonical-name matching: phon_key groups spelling variants of the same person
-- ("Sudhansu" and "Sudhanshu" share a key) so they resolve to one customer row.
alter table customers add column if not exists phon_key text not null default '';
create index if not exists customers_workspace_phon_idx on customers (workspace_id, phon_key)
  where phon_key <> '';

alter table bookings add column if not exists capture jsonb not null default '{}';
alter table bookings add column if not exists customer_id uuid references customers(id) on delete set null;
