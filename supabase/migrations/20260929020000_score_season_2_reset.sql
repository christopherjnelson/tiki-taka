-- 0.6.0 starts a new scoring season (see SCORE_SEASON in
-- packages/engine/src/progress.js). 0.5.0 made every bonus feed a decaying
-- multiplier and turned Endless into Extra Time, so scores and run lengths
-- recorded before it cannot be reached any more and would hold the top of
-- every board for good. The client drops local personal bests from earlier
-- seasons on load; this clears the server boards to match.
--
-- The rows are moved, not destroyed: private.round_scores_season_1 keeps every
-- one, so the old boards can be restored with
--   insert into public.round_scores select * from private.round_scores_season_1;
-- The private schema has no grants to anon or authenticated, so the archive is
-- not readable from the browser.
--
-- The record notifier treats an empty board as a record to be taken, so the
-- first score on each board after this posts one Discord record, as it did
-- when Extra Time's board was new.

create table private.round_scores_season_1 as
  table public.round_scores;

delete from public.round_scores;

-- Manual verification queries (run after applying this migration):
-- select count(*) from private.round_scores_season_1;  -- the old row count
-- select count(*) from public.round_scores;            -- 0
-- select count(*) from public.leaderboard_entries;     -- 0
