# Production deployment

Production changes only when a published GitHub Release successfully completes
the tagged build and `deploy` job. Manual dispatch rebuilds the artifact but
deliberately does not deploy it.

## One-time droplet setup

Run as root from this repository:

```sh
useradd --system --create-home --home-dir /var/lib/tiki-deploy --shell /bin/bash tiki-deploy
install -d -o root -g root -m 0755 /srv/tiki-taka
install -d -o root -g tiki-deploy -m 0750 /srv/tiki-taka/bin
install -d -o tiki-deploy -g tiki-deploy -m 0750 /srv/tiki-taka/{incoming,records}
install -d -o tiki-deploy -g tiki-deploy -m 0755 /srv/tiki-taka/releases
install -o root -g tiki-deploy -m 0750 deploy/prepare-incoming deploy/activate-release deploy/rollback-release /srv/tiki-taka/bin/
install -d -o tiki-deploy -g tiki-deploy -m 0700 /var/lib/tiki-deploy/.ssh
install -o tiki-deploy -g tiki-deploy -m 0600 /dev/null /var/lib/tiki-deploy/.ssh/authorized_keys
```

Add only the dedicated public deployment key to `authorized_keys`. Do not use
the administrator key or existing API service account. The deploy user has no
sudo permission. Validation scripts are root-owned and not writable by it.

Before switching Nginx, copy the current site into a bootstrap release, create
`/srv/tiki-taka/current`, install `deploy/nginx-tiki-taka.conf` at the existing
site path, run `nginx -t`, reload Nginx, and verify HTTPS. Keep the old vhost and
web root until rollback is tested.

## GitHub `production` environment

Environment variables:

- `DEPLOY_HOST` — production SSH hostname or IP
- `DEPLOY_USER` — dedicated deploy account
- `DEPLOY_PORT` — optional; omitted means 22

Environment secrets:

- `DEPLOY_SSH_PRIVATE_KEY` — dedicated private key
- `DEPLOY_KNOWN_HOSTS` — pinned host-key line verified out of band
- `DISCORD_DEPLOY_WEBHOOK_URL` — Discord webhook used only after successful deployment

The downstream notification job summarizes commits since the previous stable
tag, links the full comparison if Discord's embed limit is reached, disables
mentions from commit text, and can be retried without redeploying.

Repository build variables remain `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY`. Never configure a Supabase secret or
service-role key in this browser build. Consider required reviewers on the
production environment.

## Exact rollback

```sh
readlink /srv/tiki-taka/current
find /srv/tiki-taka/releases -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort
/srv/tiki-taka/bin/rollback-release v0.3.0-0123456789ab-123456789.1
```

Replace the example with the exact prior target from the latest private record.
Test in fresh and existing browser profiles: a browser controlled by the newer
service worker may retain its cache until the restored worker activates. Confirm
the restored `sw.js` activates and reload after `controllerchange`.

## Verification

```sh
curl -fsSIL https://tiki-taka.chris.guru/
curl -fsSIL https://tiki-taka.chris.guru/sw.js
curl -fsSIL https://tiki-taka.chris.guru/manifest.webmanifest
curl -fsSIL https://tiki-taka.chris.guru/assets/REPLACE_WITH_HASHED_ASSET
curl -fsSIL https://tiki-taka.chris.guru/assets/REPLACE_WITH_WOFF2
curl -fsS -H 'Range: bytes=0-1023' -D - -o /dev/null https://tiki-taka.chris.guru/audio/REPLACE_WITH_AUDIO
curl -fsS https://tiki-taka.chris.guru/ | grep -E 'ALPHA|v0\.3\.0|REPLACE_WITH_SHORT_SHA|REPLACE_WITH_RUN_ATTEMPT'
```

In a fresh browser profile, verify service-worker registration, authentication
and leaderboard calls, offline-after-first-fetch audio, and no mixed-content or
CSP errors. Network requests must target only this origin and
`https://ibbprhuqzlbajuaeplgt.supabase.co`.
