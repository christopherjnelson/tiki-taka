-- Three selectable difficulty tiers (relaxed, standard, ruthless) multiply
-- each court's target/speed/defenders. Rounds were recorded without any
-- record of which tier was played, so the leaderboard could not be filtered
-- by tier and mixed relaxed and ruthless scores together. Add the column
-- with a safe default so existing rows (all played before tiers existed,
-- effectively at today's numbers) remain valid without a backfill, and
-- extend the leaderboard view to expose and index it.

alter table public.round_scores
  add column difficulty text not null default 'standard';

alter table public.round_scores
  add constraint round_scores_difficulty_format_check
    check (difficulty in ('relaxed', 'standard', 'ruthless'));

-- Supports a selected mode, tier, and court, ordered as the leaderboard
-- displays it - mirrors round_scores_leaderboard_mode_court_idx above.
create index round_scores_leaderboard_mode_difficulty_court_idx
  on public.round_scores (mode, difficulty, court, score desc, created_at asc);

-- The leaderboard view was made security definer (security_invoker = false)
-- by 20260910135539_restrict_leaderboard_base_table_access.sql, specifically
-- so anon/authenticated no longer need direct SELECT on round_scores or
-- profiles to read the leaderboard. Recreating the view here must keep that
-- posture: reverting to security_invoker = true would require re-granting
-- base-table access and reopen the bug that migration fixed (anon reading
-- every player's full round_scores history, including user_id, by bypassing
-- the view). CREATE OR REPLACE VIEW requires every existing column to keep
-- its name, type, AND position, and only permits appending new columns at
-- the end of the list - so difficulty is appended last, after the bonus
-- counters added by 20260911000000_add_round_bonus_stats.sql, even though
-- the client (see getLeaderboard in
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
  round_scores.zones,
  round_scores.difficulty
from public.round_scores
join public.profiles on profiles.id = round_scores.user_id;

revoke all on table public.leaderboard_entries from public, anon, authenticated, service_role;
grant select on public.leaderboard_entries to anon, authenticated;

-- Manual verification queries (run after applying this migration):
--
-- 1. Confirm the new column and its constraint exist with a safe default:
-- select column_name, data_type, column_default, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'round_scores'
--     and column_name = 'difficulty';
-- select conname from pg_constraint
--   where conrelid = 'public.round_scores'::regclass
--     and conname = 'round_scores_difficulty_format_check';
--
-- 2. Confirm the view is still security definer (not invoker) and grants
--    were not silently dropped by the recreate:
-- select relname, reloptions from pg_class where relname = 'leaderboard_entries';
-- select grantee, table_name, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'leaderboard_entries'
--   order by grantee, privilege_type;
-- select has_table_privilege('anon', 'public.round_scores', 'select') as anon_can_read_base_table;
--
-- 3. Confirm existing rows survived with the safe default:
-- select count(*) from public.round_scores where difficulty = 'standard';
--
-- 4. Confirm the filtered leaderboard plan can use the new index:
-- explain (costs off) select * from public.leaderboard_entries
--   where mode = 'career' and difficulty = 'ruthless' and court = 1
--   order by score desc, created_at asc limit 10;
