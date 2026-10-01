-- 0003_simple_auth.sql
-- Simple credential authentication: email + password, no Supabase Auth,
-- no OTP, no email verification. The API issues its own JWTs.

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text not null,
  display_name text,
  created_at timestamptz not null default now()
);

-- app users are only touched by the API (service role); block direct access.
alter table app_users enable row level security;

-- memberships/profiles no longer reference auth.users.
alter table memberships drop constraint if exists memberships_user_id_fkey;
alter table profiles drop constraint if exists profiles_id_fkey;
