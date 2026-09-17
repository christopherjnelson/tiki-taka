-- Endless records were never announced.
--
-- Endless is one global ladder rather than a venue on the circuit, so its
-- rounds are saved with court = null (see the completedRound builder in
-- apps/desktop/src/main.js). The notifier shipped in
-- 20260916213356_discord_record_notify.sql was written when every scored
-- round had a court, so it opens by discarding anything without one:
--
--   if new.court is null ... then return new; end if;
--
-- That is the whole bug: five Endless runs, including one that beat the
-- standing best by a clear margin, wrote their rows and said nothing.
--
-- A null court is now a board of its own rather than a disqualification.
-- `is not distinct from` is what makes that work: `court = new.court` is
-- NULL, not TRUE, when both sides are null, so the ordinary equality would
-- have matched no prior rows and every Endless run would have looked like the
-- first one on an empty board - silent for a different reason.

create or replace function public.notify_discord_on_record()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  secret text;
  prior_count integer;
  prior_best integer;
  prior_holder text;
  holder text;
begin
  -- A placed round with a real score. A court is no longer required: Endless
  -- has none, and its board is keyed by (mode, difficulty, court is null).
  if new.score is null or new.score <= 0 then
    return new;
  end if;

  select count(*), max(score)
    into prior_count, prior_best
    from public.round_scores
   where mode = new.mode
     and difficulty = new.difficulty
     and court is not distinct from new.court
     and score > 0
     and id <> new.id;

  -- The first score on an empty board is not a record. This also keeps a
  -- leaderboard clear from firing one notification per board on the next
  -- round of play.
  if coalesce(prior_count, 0) = 0 then
    return new;
  end if;

  if new.score <= prior_best then
    return new;
  end if;

  select p.username
    into prior_holder
    from public.round_scores rs
    join public.profiles p on p.id = rs.user_id
   where rs.mode = new.mode
     and rs.difficulty = new.difficulty
     and rs.court is not distinct from new.court
     and rs.score = prior_best
     and rs.id <> new.id
   order by rs.created_at, rs.id
   limit 1;

  select username into holder from public.profiles where id = new.user_id;

  select value into secret from public.integration_config where key = 'record_hook_secret';
  if secret is null then
    raise warning 'record notification skipped: no record_hook_secret configured';
    return new;
  end if;

  -- net.http_post queues the request and returns, so a slow or dead Discord
  -- never delays the player's score write.
  perform net.http_post(
    url := 'https://ibbprhuqzlbajuaeplgt.supabase.co/functions/v1/discord-record-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-record-secret', secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', 'round_scores',
      'record', to_jsonb(new),
      'username', holder,
      'previous_best', prior_best,
      'previous_holder', prior_holder
    ),
    timeout_milliseconds := 5000
  );

  return new;
end;
$function$;

-- The trigger itself is unchanged; it already points at this function.

-- Manual verification queries (run after applying this migration):
--
-- 1. An endless board with prior rows sees its best, rather than nothing:
-- select count(*), max(score) from public.round_scores
--   where mode = 'endless' and difficulty = 'standard'
--     and court is not distinct from null and score > 0;
--
-- 2. After the next endless personal best, a queued request exists:
-- select id, status_code, left(coalesce(content,''), 160), created
--   from net._http_response order by id desc limit 3;
