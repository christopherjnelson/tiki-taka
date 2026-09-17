# Tiki Taka

A single-player arcade soccer possession game in an enclosed court. There are no shots or goals: move into space, connect passes, and make the next touch count.

Tiki Taka is a browser game built with vanilla JavaScript, Canvas 2D, and Web Audio. It runs guest-first without a required backend, with optional Supabase accounts.

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

The build creates a static site in `dist/desktop/`, including a generated service worker. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full browser test matrix, including:

```sh
npx playwright install chromium
npm run test:web
```

`test:web` covers desktop gameplay, interface, navigation, one-touch, desktop-account, and audio. `npm run test:mobile-smoke` is a fast phone-layout check; `npm run test:mobile-layouts` re-runs the full gameplay suites at phone sizes and is left to CI.

## Ways to play

Play in a desktop browser with keyboard, mouse, or a standard gamepad. The game is also playable on a phone in both orientations — the arena renders a rotated court in portrait. The production build precaches its app shell after the first online load and is installable where the browser supports it; service workers require localhost or HTTPS. The soundtrack is not part of that precache or the build itself: tracks are fetched from a runtime manifest alongside the served app and cached after first use, so new music can ship without a new release.

## Game overview

Control the ball carrier while three teammates find supporting positions. Pass before the press closes in. An interception or tackle costs a life and resets the formation; the third turnover ends most rounds.

Build a flow multiplier with consecutive passes and queue passes for one-touch combinations. Triangles, wall passes, and bonus-zone receptions earn Energy, the shared reserve behind Focus (slowing the court) and Boost. Home offers four modes:

- **World tour** — six fixed venues, three difficulty tiers, stars and progression.
- **King of the Court** — four players, one ball, scored on squares taken rather than flow. Not yet playable; shown on Home as coming soon.
- **Endless** — its own court (Still Water, the one venue that is not on the tour), one difficulty, and a clock that counts up. Nothing is scored but the seconds you last: a third defender joins at 0:45, a fourth at 1:45, a fifth at 3:15, and the press keeps quickening after that. The first mistake ends the run.
- **Free practice** — no turnover limit, for learning the rhythm.

(An earlier date-seeded Daily Circuit mode has been removed.)

See the [gameplay guide](docs/GAMEPLAY.md) for scoring, controls, progression, tactics, accessibility, and offline behavior.

## Guest saves and accounts

By default, with no Supabase configuration present, there is no account system at all: the game is guest-only. Settings, progress, and stats live in browser storage on that device, do not synchronize, and are removed if site data is cleared. The account entry point in the header is hidden in this state — there's nothing for it to lead to.

Pages on the same origin share this guest storage.

### Supabase accounts

Supabase is the only authentication path, optional and configured at build time (see [docs/supabase-browser-config.md](docs/supabase-browser-config.md)). When `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are present, the account entry point appears and offers Discord sign-in and email/password registration and sign-in, plus a home leaderboard — honestly labeled as client-reported, since all game logic runs in the browser and scores aren't currently verifiable. A signed-out player, or one whose Supabase session is briefly unreachable, still plays on the guest save above.

## Repository layout

- `apps/desktop/` — the browser interface: DOM, main loop, event handlers, audio player, CSS.
- `packages/engine/` — pure simulation, game math, AI, tactics, scoring, progress, venues.
- `packages/presentation/` — Canvas 2D renderer and procedural audio synthesizer.
- `packages/data/` — data-provider API: guest-only local storage and the Supabase adapter.
- `scripts/` — dev server, build, and static-serve scripts.
- `src/` — compatibility exports retained for regression coverage.
- `tests/` — Node test runner unit tests and Playwright browser integration tests.

## Releases

The release version lives only in root `package.json`; bump it and add the release's entry to `CHANGELOG.md` in the same commit — the in-app changelog is baked from that file at build time. Tag the merged release commit `vX.Y.Z` to match, and push the tag: the [Release artifact workflow](.github/workflows/release.yml) checks it out, runs the required tests and budget checks, builds the production site, and uploads the versioned archive that is the sole input for production deployment. See [CONTRIBUTING.md](CONTRIBUTING.md#releases) for the full procedure.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. No license grant is provided for this repository.
