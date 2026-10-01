-- 0001_init: multi-tenant SaaS + pgvector + RLS
-- Run in Supabase SQL editor or via supabase CLI.
-- Extension name is "vector" (not "pgvector") on Supabase.
create extension if not exists "vector";
create extension if not exists "pgcrypto";

-- Workspaces / memberships
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','admin','member')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- Agents
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  language text not null default 'en',
  tone text not null default 'professional',
  system_prompt text not null default 'You are a helpful business voice assistant. Only answer from provided knowledge.',
  fallback_response text not null default 'I don''t have verified information about that yet.',
  max_tokens int not null default 6000,
  temperature numeric not null default 0.4,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Knowledge
create table if not exists knowledge_sources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  kind text not null check (kind in ('upload','text','url')),
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  source_id uuid references knowledge_sources(id) on delete set null,
  title text not null default 'untitled',
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- 1536 dims default (text-embedding-3-small); adjust if you change model.
create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  content text not null,
  tokens int not null default 0,
  metadata jsonb not null default '{}',
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index if not exists chunks_workspace_idx on chunks (workspace_id);
create index if not exists chunks_embedding_idx on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Customers / conversations / memory
create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  display_name text,
  phone text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  channel text not null default 'voice',
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user','assistant','system','tool')),
  content text not null,
  citations jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists messages_conv_idx on messages (conversation_id, created_at);

create table if not exists memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  customer_id uuid references customers(id) on delete cascade,
  kind text not null default 'fact',
  content text not null,
  created_at timestamptz not null default now()
);

-- Tools / usage / api keys
create table if not exists tools (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  input_schema jsonb not null default '{}',
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table if not exists usage_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  kind text not null,
  tokens int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null,
  key_hash text not null,
  created_at timestamptz not null default now()
);

-- RLS
alter table workspaces enable row level security;
alter table memberships enable row level security;
alter table profiles enable row level security;
alter table agents enable row level security;
alter table knowledge_sources enable row level security;
alter table documents enable row level security;
alter table chunks enable row level security;
alter table customers enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table memories enable row level security;
alter table tools enable row level security;
alter table usage_events enable row level security;
alter table api_keys enable row level security;

-- Helper: is member of workspace?
create or replace function is_workspace_member(wid uuid)
returns boolean language sql stable as $$
  select exists (select 1 from memberships m where m.workspace_id = wid and m.user_id = auth.uid())
$$;

-- Policies: members canCRUD rows in their workspaces. Service role bypasses RLS.
do $$
declare t text;
begin
  foreach t in array array['workspaces','agents','knowledge_sources','documents','chunks','customers','conversations','messages','memories','tools','usage_events','api_keys'] loop
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I for all using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id))', t);
  end loop;
end $$;

drop policy if exists own_membership on memberships;
create policy own_membership on memberships for all
  using (user_id = auth.uid() or is_workspace_member(workspace_id))
  with check (user_id = auth.uid() or is_workspace_member(workspace_id));

drop policy if exists own_profile on profiles;
create policy own_profile on profiles for all
  using (id = auth.uid()) with check (id = auth.uid());
