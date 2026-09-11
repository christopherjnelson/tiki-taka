-- The public leaderboard view was security_invoker, so serving it required
-- anon to hold SELECT on the underlying round_scores table. That let anon
-- bypass the view entirely and read user_id alongside every player's full
-- score history, then join the public profiles table to map ids to names.
--
-- Make the view security definer so it can serve the leaderboard on its own,
-- and take the base-table access back. The application never needed it: the
-- only direct reads of either table are of the caller's own rows.

alter view public.leaderboard_entries set (security_invoker = false);

grant select on table public.leaderboard_entries to anon, authenticated;

revoke select on table public.round_scores from anon;
revoke select on table public.profiles from anon;

-- Round history is the owner's business; the leaderboard is the view's.
drop policy if exists round_scores_public_read on public.round_scores;

create policy round_scores_owner_read on public.round_scores
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists profiles_public_read on public.profiles;

create policy profiles_owner_read on public.profiles
  for select to authenticated
  using ((select auth.uid()) = id);
