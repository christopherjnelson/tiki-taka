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
