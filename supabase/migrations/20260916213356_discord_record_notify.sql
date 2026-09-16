-- Notify Discord when a round beats the standing global best for its board.
--
-- A "board" is (mode, difficulty, court), so a new mode gets its own records
-- without touching this trigger. The gate lives here rather than in the edge
-- function so that the common case — a round that is not a record — costs one
-- indexed lookup and no HTTP request at all. Records are logarithmic in
-- attempts, so this stays quiet as play volume grows.

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
  -- Same shape the world tour leaderboard counts: a placed round on a real
  -- court. Practice rounds and zero scores never hold a record.
  if new.court is null or new.score is null or new.score <= 0 then
    return new;
  end if;

  select count(*), max(score)
    into prior_count, prior_best
    from public.round_scores
   where mode = new.mode
     and difficulty = new.difficulty
     and court = new.court
     and court is not null
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
     and rs.court = new.court
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

drop trigger if exists round_scores_discord_record_notify on public.round_scores;

create trigger round_scores_discord_record_notify
after insert on public.round_scores
for each row
execute function public.notify_discord_on_record();
