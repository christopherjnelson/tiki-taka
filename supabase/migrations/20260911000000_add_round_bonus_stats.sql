-- Per-round bonus-action counts (triangles, olés, split-the-press, bonus-zone
-- receptions) were tracked in the engine but discarded before this point;
-- only score, passes, and best_one_touch survived to storage. Add the four
-- counters as NOT NULL DEFAULT 0 so existing rows remain valid without a
-- backfill, and extend the leaderboard view to expose them.

alter table public.round_scores
  add column triangles integer not null default 0,
  add column oles integer not null default 0,
  add column splits integer not null default 0,
  add column zones integer not null default 0;

alter table public.round_scores
  add constraint round_scores_triangles_range_check
    check (triangles between 0 and 1000000000),
  add constraint round_scores_oles_range_check
    check (oles between 0 and 1000000000),
  add constraint round_scores_splits_range_check
    check (splits between 0 and 1000000000),
  add constraint round_scores_zones_range_check
    check (zones between 0 and 1000000000);

-- The leaderboard view was made security definer (security_invoker = false)
-- by 20260910135539_restrict_leaderboard_base_table_access.sql, specifically
-- so anon/authenticated no longer need direct SELECT on round_scores or
-- profiles to read the leaderboard. Recreating the view here must keep that
-- posture: reverting to security_invoker = true would require re-granting
-- base-table access and reopen the bug that migration fixed (anon reading
-- every player's full round_scores history, including user_id, by bypassing
-- the view). CREATE OR REPLACE VIEW requires every existing column to keep
-- its name, type, AND position, and only permits appending new columns at
-- the end of the list — so the four new columns are added after
-- created_at, not before it, even though the client (see getLeaderboard in
-- packages/data/src/supabase.js) selects and maps strictly by name and does
-- not care about column order. The security option is restated explicitly
-- below rather than relied upon implicitly, and the grants are re-applied
-- regardless of whether CREATE OR REPLACE VIEW would have kept them, since
-- recreating a view is exactly the kind of change that must not silently
-- drop a grant.
create or replace view public.leaderboard_entries
with (security_invoker = false)
as
select
  profiles.username,
  round_scores.mode,
  round_scores.court,
  round_scores.score,
  round_scores.passes,
  round_scores.best_one_touch,
  round_scores.created_at,
  round_scores.triangles,
  round_scores.oles,
  round_scores.splits,
  round_scores.zones
from public.round_scores
join public.profiles on profiles.id = round_scores.user_id;

revoke all on table public.leaderboard_entries from public, anon, authenticated, service_role;
grant select on public.leaderboard_entries to anon, authenticated;

-- Manual verification queries (run after applying this migration):
--
-- 1. Confirm the new columns and their constraints exist with safe defaults:
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'round_scores'
--     and column_name in ('triangles', 'oles', 'splits', 'zones');
-- select conname from pg_constraint
--   where conrelid = 'public.round_scores'::regclass
--     and conname like 'round_scores_%_range_check';
--
-- 2. Confirm the view is still security definer (not invoker) and grants
--    were not silently dropped by the recreate:
-- select relname, reloptions from pg_class where relname = 'leaderboard_entries';
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'leaderboard_entries'
--   order by grantee, privilege_type;
-- select has_table_privilege('anon', 'public.round_scores', 'select') as anon_can_read_base_table;
--
-- 3. Confirm existing rows survived with zeroed new columns:
-- select count(*) from public.round_scores where triangles = 0 and oles = 0
--   and splits = 0 and zones = 0;
