-- Browser-facing identity data deliberately excludes auth.users.email. The auth
-- trigger creates the public profile and private defaults atomically at signup.
create schema if not exists private;
revoke all on schema private from public;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  created_at timestamptz not null default now(),
  constraint profiles_username_format_check
    check (username ~ '^[A-Za-z0-9_.-]{2,24}$')
);

create unique index profiles_username_case_insensitive_key
  on public.profiles (lower(username));

create table public.user_preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  score_save_choice text not null default 'ask',
  updated_at timestamptz not null default now(),
  constraint user_preferences_score_save_choice_check
    check (score_save_choice in ('ask', 'always', 'never'))
);

create table public.user_saves (
  user_id uuid primary key references auth.users (id) on delete cascade,
  progress jsonb not null default '{}'::jsonb,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_saves_progress_object_check
    check (jsonb_typeof(progress) = 'object'),
  constraint user_saves_settings_object_check
    check (jsonb_typeof(settings) = 'object'),
  constraint user_saves_payload_size_check
    check (octet_length(progress::text) + octet_length(settings::text) <= 65536)
);

create table public.round_scores (
  -- Callers generate this UUID before the first request. Repeating it is a
  -- retry, never a second score; use INSERT ... ON CONFLICT DO NOTHING.
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  mode text not null,
  court integer,
  score integer not null,
  passes integer not null,
  best_one_touch integer not null,
  created_at timestamptz not null default now(),
  constraint round_scores_mode_format_check
    check (mode ~ '^[A-Za-z0-9_-]{1,32}$'),
  constraint round_scores_court_range_check
    check (court is null or court between 0 and 999),
  constraint round_scores_score_range_check
    check (score between 0 and 1000000000),
  constraint round_scores_passes_range_check
    check (passes between 0 and 1000000000),
  constraint round_scores_best_one_touch_range_check
    check (best_one_touch between 0 and 1000000000)
);

-- The foreign-key index also makes per-player aggregate stats fast.
create index round_scores_user_id_idx on public.round_scores (user_id);
-- Supports a selected mode and court, ordered as the leaderboard displays it.
create index round_scores_leaderboard_mode_court_idx
  on public.round_scores (mode, court, score desc, created_at asc);
-- Supports the all-courts leaderboard for a selected mode.
create index round_scores_leaderboard_mode_idx
  on public.round_scores (mode, score desc, created_at asc);

-- raw_user_meta_data is used only to carry the requested display name into an
-- atomic signup trigger. It is never used for authorization decisions.
create function private.create_signup_records()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text := new.raw_user_meta_data ->> 'username';
begin
  if requested_username is null
     or requested_username !~ '^[A-Za-z0-9_.-]{2,24}$' then
    raise exception using
      errcode = '22023',
      message = 'Username must be 2-24 letters, digits, dots, hyphens, or underscores.';
  end if;

  insert into public.profiles (id, username)
  values (new.id, requested_username);

  insert into public.user_preferences (user_id)
  values (new.id);

  insert into public.user_saves (user_id)
  values (new.id);

  return new;
exception
  when unique_violation then
    -- Supabase Auth returns a generic signup failure for trigger exceptions.
    -- The client should validate locally and normalize this to "username unavailable".
    raise exception using errcode = '23505', message = 'Username is unavailable.';
end;
$$;

revoke all on function private.create_signup_records() from public, anon, authenticated, service_role;

create function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function private.touch_updated_at() from public, anon, authenticated, service_role;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure private.create_signup_records();

create trigger user_preferences_set_updated_at
  before update on public.user_preferences
  for each row execute procedure private.touch_updated_at();

create trigger user_saves_set_updated_at
  before update on public.user_saves
  for each row execute procedure private.touch_updated_at();

alter table public.profiles enable row level security;
alter table public.user_preferences enable row level security;
alter table public.user_saves enable row level security;
alter table public.round_scores enable row level security;

-- Username and leaderboard submissions are intentionally public. Profiles have
-- no email or private preferences, and round scores are client-reported anyway.
create policy profiles_public_read
  on public.profiles for select to anon, authenticated using (true);

create policy user_preferences_owner_read
  on public.user_preferences for select to authenticated
  using ((select auth.uid()) = user_id);
create policy user_preferences_owner_insert
  on public.user_preferences for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy user_preferences_owner_update
  on public.user_preferences for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy user_saves_owner_read
  on public.user_saves for select to authenticated
  using ((select auth.uid()) = user_id);
create policy user_saves_owner_insert
  on public.user_saves for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy user_saves_owner_update
  on public.user_saves for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy round_scores_public_read
  on public.round_scores for select to anon, authenticated using (true);
create policy round_scores_owner_insert
  on public.round_scores for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- Explicit grants are required when Data API table auto-exposure is disabled.
revoke all on table public.profiles from public, anon, authenticated, service_role;
revoke all on table public.user_preferences from public, anon, authenticated, service_role;
revoke all on table public.user_saves from public, anon, authenticated, service_role;
revoke all on table public.round_scores from public, anon, authenticated, service_role;
grant usage on schema public to anon, authenticated;
grant select on public.profiles to anon, authenticated;
grant select, insert, update on public.user_preferences to authenticated;
grant select, insert, update on public.user_saves to authenticated;
grant select on public.round_scores to anon, authenticated;
grant insert on public.round_scores to authenticated;

-- The browser-facing leaderboard shape intentionally omits user IDs and email.
-- security_invoker keeps the underlying tables' grants and RLS in force.
create view public.leaderboard_entries
with (security_invoker = true)
as
select
  profiles.username,
  round_scores.mode,
  round_scores.court,
  round_scores.score,
  round_scores.passes,
  round_scores.best_one_touch,
  round_scores.created_at
from public.round_scores
join public.profiles on profiles.id = round_scores.user_id;

revoke all on table public.leaderboard_entries from public, anon, authenticated, service_role;
grant select on public.leaderboard_entries to anon, authenticated;

-- Manual verification queries (run after applying this migration):
--
-- 1. Inspect RLS and grants:
-- select tablename, rowsecurity from pg_tables where schemaname = 'public'
--   and tablename in ('profiles', 'user_preferences', 'user_saves', 'round_scores');
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name in
--     ('profiles', 'user_preferences', 'user_saves', 'round_scores', 'leaderboard_entries')
--   order by table_name, grantee, privilege_type;
--
-- 2. Verify the trigger is private and cannot be invoked directly:
-- select has_function_privilege('anon', 'private.create_signup_records()', 'execute') as anon_can_execute,
--        has_function_privilege('authenticated', 'private.create_signup_records()', 'execute') as authenticated_can_execute;
--
-- 3. Verify the leaderboard plan can use its selected index:
-- explain (costs off) select * from public.leaderboard_entries
--   where mode = 'career' and court = 1 order by score desc, created_at asc limit 10;
