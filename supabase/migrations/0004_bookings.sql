-- 0004_bookings: appointment bookings (Google Calendar link tool) + agent location (Maps tool)

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  customer_name text not null default '',
  contact text not null default '',
  starts_at text not null default '',
  notes text not null default '',
  status text not null default 'confirmed' check (status in ('confirmed','cancelled','completed')),
  source text not null default 'chat',
  created_at timestamptz not null default now()
);
create index if not exists bookings_workspace_idx on bookings (workspace_id, created_at desc);

alter table agents add column if not exists location text not null default '';

alter table bookings enable row level security;
drop policy if exists tenant_isolation on bookings;
create policy tenant_isolation on bookings for all
  using (is_workspace_member(workspace_id)) with check (is_workspace_member(workspace_id));
