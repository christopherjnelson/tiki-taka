-- Discord (and any future OAuth provider) sign-in creates the auth.users row
-- immediately on first login, before the player has ever chosen a public
-- leaderboard name. The original on_auth_user_created trigger required
-- raw_user_meta_data ->> 'username' to be present and valid, and raised an
-- exception otherwise - correct for the email/password form (which always
-- collects a username up front), but it would reject every first-time OAuth
-- sign-in outright, since Discord never supplies one.
--
-- The fix: username stays required for the two rows that need it
-- (public.profiles enforces the same format check either way), but a missing
-- username no longer aborts the whole signup. user_preferences and
-- user_saves are created unconditionally so an OAuth player can load and
-- save progress immediately; public.profiles is skipped and created later,
-- client-side, once the player confirms a name (see completeProfile in
-- packages/data/src/supabase.js). That requires an owner-insert policy on
-- profiles, which did not exist before because only the trigger ever wrote
-- to it.
create or replace function private.create_signup_records()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text := new.raw_user_meta_data ->> 'username';
begin
  if requested_username is not null then
    if requested_username !~ '^[A-Za-z0-9_.-]{2,24}$' then
      raise exception using
        errcode = '22023',
        message = 'Username must be 2-24 letters, digits, dots, hyphens, or underscores.';
    end if;
    insert into public.profiles (id, username)
    values (new.id, requested_username);
  end if;

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

-- profiles previously had no insert policy at all - only the security-definer
-- trigger above ever wrote to it, so a first-time OAuth player (whose row the
-- trigger skipped) could not create their own profile once they picked a
-- name. The unique, case-insensitive username index (see the original
-- schema migration) still rejects a name someone else already has.
create policy profiles_owner_insert
  on public.profiles for insert to authenticated
  with check ((select auth.uid()) = id);

grant insert on public.profiles to authenticated;
