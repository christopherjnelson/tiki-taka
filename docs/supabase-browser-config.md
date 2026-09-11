# Supabase browser configuration

The desktop browser build reads `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. Set both at build time to enable the
Supabase data adapter; leave either unset to retain guest-only play, with no
account system offered at all.

Only the project's **publishable** key belongs in either environment variable.
Never put a `service_role` or secret key in the browser, build artifact, test
fixture, or repository.

When serving with `scripts/serve.mjs`, provide the same URL through
`VITE_SUPABASE_URL` (or `SUPABASE_URL`). Its CSP adds only that validated HTTPS
origin to `connect-src`; it does not allow every `*.supabase.co` host. The
desktop document's CSP must also include that exact origin in production.

This adapter needs the RLS-protected `profiles`, `user_saves`,
`user_preferences`, `round_scores`, and `leaderboard_entries` schema defined
by the accompanying Supabase migration. A network failure while a Supabase
session exists is surfaced to the game as an error; it never silently switches
that player to a local guest identity.

## Where the environment file lives

Both variables come from a `.env` at the **repository root**, next to the
tracked `.env.example`. Vite's `envDir` would otherwise follow the config's
`root` and look inside `apps/desktop/`, so `vite.desktop.config.js` points it
at the repository root explicitly. Without that, the values are silently
dropped and the build ships with no sign-in — a missing optional configuration
looks exactly like a deliberate one.

`npm start` (and `npm run dev`) runs Vite through `scripts/dev.mjs`, which
substitutes these variables and prints on boot whether it found a Supabase
project or is running guest-only. Its development Content-Security-Policy is
deliberately looser than production's — Vite needs its own client and a
websocket — and it replaces the document's meta policy only while serving.
Neither the shipped meta tag nor `serve.mjs` is affected.

`scripts/serve.mjs` is a plain static server with no Vite transform, so it
never substitutes these variables. It is how a finished build is served, which
is what the browser suites use:

```sh
npm run build && SERVE_DIR=dist/desktop node --env-file=.env scripts/serve.mjs
```

## Accepted advisor finding: security_definer_view

Supabase's security advisor reports `security_definer_view` (ERROR) against
`public.leaderboard_entries`. **This is intentional and has been accepted.**

The view is deliberately security definer. A public leaderboard has to read
every player's rows, and the alternative — `security_invoker` — requires
granting `anon` SELECT on the underlying `round_scores`. That made the view no
boundary at all: anyone could query the base table directly for `user_id` and
each player's full score history, then join `profiles` to put names to the
ids. Serving the leaderboard through a definer view lets `anon` be revoked
from both base tables, which is the stronger position.

The trade the advisor is naming is real: a definer view runs as its owner and
bypasses RLS, so **anything added to this view's definition is exposed with
those privileges**. Keep it to the seven columns it publishes — `username`,
`mode`, `court`, `score`, `passes`, `best_one_touch`, `created_at`. It must
never select `user_id`, anything from `auth.users`, or another table.

If that constraint ever becomes awkward, replace the view with a
`security definer` function with a pinned `search_path`, which clears the
advisor; that means moving the leaderboard query in
`packages/data/src/supabase.js` from `.from()` to `.rpc()`.
