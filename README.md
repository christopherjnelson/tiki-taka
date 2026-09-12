# Tiki Taka

A single-player arcade soccer possession game in an enclosed court. There are no shots or goals: move into space, connect passes, and make the next touch count.

Tiki Taka is a browser game built with JavaScript, Canvas 2D, and Web Audio. It runs without a backend and stores progress locally.

## Quick start

Use Node.js 22.12 or newer (Node 24 recommended):

```sh
npm ci
npm start
```

Open the game at <http://localhost:5173>.

## Build and test

```sh
npm test
npm run build
```

The build creates a static site in `dist/desktop/`, including a generated service worker. See [CONTRIBUTING.md](CONTRIBUTING.md) for the browser test matrix.

## Ways to play

Play in a desktop browser with keyboard, mouse, or a standard gamepad. Desktop is the current supported interface target; the existing mobile/coarse-pointer interface is frozen while desktop UI and performance are developed, and may be revisited later. The production build precaches its app shell after the first online load, caches audio after first use, and is installable where the browser supports it; service workers require localhost or HTTPS.

## Game overview

Control the ball carrier while three teammates find supporting positions. Pass before the press closes in. An interception or tackle costs a life and resets the formation; the third turnover ends most rounds.

Build a flow multiplier with consecutive passes and queue passes for one-touch combinations. Triangles, wall passes, and bonus-zone receptions earn Focus, which briefly slows the court and match clock. World Tour, Free practice, Endless, and the date-seeded Daily Circuit each offer a different structure.

See the [gameplay guide](docs/GAMEPLAY.md) for scoring, controls, modes, progression, tactics, accessibility, and offline behavior.

## Guest saves and accounts

By default, with no Supabase configuration present, there is no account system at all: the game is guest-only. Settings, progress, and stats live in browser storage on that device, do not synchronize, and are removed if site data is cleared. The account entry point in the header is hidden in this state — there's nothing for it to lead to.

Pages on the same origin share this guest storage.

### Supabase accounts

Supabase is the only authentication path. When `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are configured at build time (see [docs/supabase-browser-config.md](docs/supabase-browser-config.md)), the account entry point appears and offers real registration and sign-in, with a leaderboard — honestly labeled as client-reported, since all game logic runs in the browser and scores aren't currently verifiable. A signed-out player, or one whose Supabase session is briefly unreachable, still plays on the guest save above.

## Repository layout

- `apps/desktop/` — the browser interface and controls.
- `packages/engine/` — simulation, AI, modes, progression, and settings.
- `packages/presentation/` — shared renderer and synthesized audio.
- `packages/data/` — data-provider API: guest-only local storage and the Supabase adapter.
- `src/` — compatibility exports retained for regression coverage.
- `tests/` — Node and browser integration tests.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. No license grant is provided for this repository.
