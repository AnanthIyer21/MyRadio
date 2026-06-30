-- MyRadio — Postgres schema (run in the Supabase SQL editor).
-- One row per user; all taste/learning state lives in a JSONB blob so it maps 1:1 to the
-- profile object the backend already builds (name, topics, keywords, rewards, affinity,
-- seenNews, playedMusic, lengths, contentMix, …). No schema churn as the profile evolves.

create table if not exists profiles (
  user_id    text primary key,                 -- Supabase auth uid (or device-uuid pre-login)
  email      text,
  data       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Row-level security: a logged-in user can touch ONLY their own row. The backend uses the
-- service-role key (which bypasses RLS) for trusted server writes; these policies protect
-- any direct client access via the anon key.
alter table profiles enable row level security;

drop policy if exists "own profile read"   on profiles;
drop policy if exists "own profile insert" on profiles;
drop policy if exists "own profile update" on profiles;

create policy "own profile read"   on profiles for select using (auth.uid()::text = user_id);
create policy "own profile insert" on profiles for insert with check (auth.uid()::text = user_id);
create policy "own profile update" on profiles for update using (auth.uid()::text = user_id);

-- keep updated_at fresh
create or replace function touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before update on profiles
  for each row execute function touch_updated_at();
