# tiki-taka accounts server

Optional accounts + leaderboard API for tiki-taka. Plain `node`, zero npm
dependencies — only `node:http`, `node:sqlite`, and `node:crypto`. Requires
Node 24+ (built for the version already required by the root project).

The web app works completely without this server: with no API base URL
configured, or if the API is unreachable, the client falls back to its local
(browser-storage) adapter and plays exactly as it does today. Standing this
server up is entirely optional.

## Running locally

```
node server/src/index.js
# or
npm run server
```

To run the web dev server and the API together:

```
npm run dev:full
```

## Environment variables

| Variable         | Default                     | Meaning                                                          |
| ---------------- | ---------------------------- | ----------------------------------------------------------------- |
| `PORT`           | `8787`                       | Port the API listens on.                                          |
| `DB_PATH`        | `./data/tiki-taka.sqlite`    | Path to the SQLite database file (created if missing).            |
| `ALLOWED_ORIGIN` | *(empty)*                    | Comma-separated list of origins allowed to call the API with credentials (e.g. `https://tiki-taka.example.com`). Use `*` only for local development. |

The client (`packages/data/src/index.js`, `createRemoteDataAdapter`, selected
at boot by `selectDataAdapter()`) is pointed at this server by a
`<meta name="tiki-taka-api-base">` tag in `apps/desktop/index.html`. It ships
empty, which is what keeps the game fully playable with no server: with no
API base configured, or if the configured one doesn't answer, the app falls
back to the local (browser-storage) adapter and behaves exactly as it does
today. The adapter always calls `<api-base><endpoint>` where `<endpoint>`
already starts with `/api/...` (see the table below) — so set that tag's
`content` to the **origin only**, with no path and no trailing slash (e.g.
`https://tiki-taka.example.com`), not to `/api` itself.

With the nginx block below (static site and `/api/` proxy on the same host),
that origin is the site's own origin — the request stays same-origin, so
there's no CORS to configure and `connect-src 'self'` in the page's CSP needs
no change. `ALLOWED_ORIGIN` only matters for a cross-origin deployment (API
on a different host than the static site); this server has no other
knowledge of where the static site is hosted.

## Database

SQLite, WAL mode, foreign keys on. Schema is created automatically on first
run (see `server/src/db.js`). Tables: `users`, `sessions`, `user_data`,
`scores`.

Identity is immutable: there is no endpoint to change email or username.
Password change is the only account mutation, and it always requires the
current password (no email-based reset — that would require sending mail,
which this server deliberately does not do).

## Security notes

- Passwords: `scryptSync` (N=32768, r=8, p=1), random 32-byte salt per user,
  64-byte derived key, compared with `timingSafeEqual`.
- Sessions: an opaque 32-byte random token is set in an `HttpOnly`,
  `SameSite=Lax`, `Path=/` cookie (plus `Secure` off localhost); only its
  SHA-256 is stored server-side. Sessions expire after 30 days and are
  rejected (and swept) once expired.
- Login returns the same error and a similar-latency response whether the
  account doesn't exist or the password is wrong, so the API cannot be used
  to enumerate accounts.
- Rate limits (in-memory, per process — see `server/src/ratelimit.js`):
  - Login: 10 attempts per IP / 5 minutes, and 5 attempts per identifier
    (email or username, lowercased) / 5 minutes.
  - Register: 5 accounts per IP / hour.
  - Password change: 10 attempts per account / hour.
- Every request body is size-bounded (256 KB hard cap; 64 KB for saved user
  data) and rejected with `413` rather than buffered past the limit.
- No file uploads, no profile images, no static file serving from this API.

Scores are honesty-based: all game logic runs client-side, so this server
cannot verify a submitted score is legitimate. The leaderboard UI says so.

## Endpoints

All requests/responses are JSON. Session is carried via the `tt_session`
cookie (`credentials: "include"` on the client).

| Method | Path              | Auth | Body                                              | Notes |
| ------ | ----------------- | ---- | -------------------------------------------------- | ----- |
| POST   | `/api/register`   | no   | `{ email, username, password }`                    | Creates account + session. |
| POST   | `/api/login`      | no   | `{ identifier, password }`                          | `identifier` is email or username. |
| POST   | `/api/logout`     | no   | —                                                    | Clears the session. |
| GET    | `/api/session`    | no   | —                                                    | `{ profile } \| null`. |
| GET    | `/api/profile`    | no   | —                                                    | `profile \| null`. |
| POST   | `/api/password`   | yes  | `{ currentPassword, newPassword }`                  | Rotates session token, invalidates other sessions. |
| GET    | `/api/user-data`  | yes  | —                                                    | `{ progress, settings, stats }`. |
| PUT    | `/api/user-data`  | yes  | `{ progress?, settings?, stats? }`                  | Full replace of the fields given. |
| POST   | `/api/rounds`     | yes  | `{ mode, court, score, passes, bestOneTouch }`      | Records a leaderboard entry and updates stats. |
| GET    | `/api/leaderboard`| no   | query: `mode`, `court?`, `limit?` (default 10, max 100) | `{ mode, court, entries: [...] }`. |

## Deploying behind nginx on a VPS

Run the server as a small systemd service (or any process supervisor) bound
to a local port, and put nginx in front for TLS + routing alongside the
static site:

```nginx
server {
    listen 443 ssl;
    server_name tiki-taka.example.com;

    # Static site
    location / {
        root /var/www/tiki-taka;
        try_files $uri $uri/ /index.html;
    }

    # Accounts/leaderboard API
    location /api/ {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Example systemd unit (`/etc/systemd/system/tiki-taka-api.service`):

```ini
[Unit]
Description=tiki-taka accounts server
After=network.target

[Service]
Environment=PORT=8787
Environment=DB_PATH=/var/lib/tiki-taka/tiki-taka.sqlite
Environment=ALLOWED_ORIGIN=https://tiki-taka.example.com
ExecStart=/usr/bin/node /opt/tiki-taka/server/src/index.js
Restart=on-failure
User=tiki-taka

[Install]
WantedBy=multi-user.target
```

Because nginx terminates TLS, the API process sees plain HTTP; it decides
whether to mark its session cookie `Secure` by looking at the `Host` header
(anything other than `localhost`/`127.0.0.1` gets `Secure`), which is correct
for this single-hop proxy setup. Don't expose port 8787 directly to the
internet.

## Backups

The database is written under WAL, so **do not** `cp` the `.sqlite` file
while the server is running — WAL means the main file alone is not a
consistent snapshot, and a live copy can be corrupt or missing recent writes.

Use SQLite's own online backup instead, e.g. via the `sqlite3` CLI:

```
sqlite3 /var/lib/tiki-taka/tiki-taka.sqlite ".backup '/var/backups/tiki-taka/$(date +%F).sqlite'"
```

Run that on a cron/timer, and keep a handful of rotating daily snapshots off
the VPS (rsync/rclone to remote storage). `.backup` takes a consistent
snapshot even while the server is writing.
