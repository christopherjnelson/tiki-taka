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

Play in a desktop browser with keyboard, mouse, or a standard gamepad. The production build caches its assets after the first online load and is installable where the browser supports it; service workers require localhost or HTTPS.

## Game overview

Control the ball carrier while three teammates find supporting positions. Pass before the press closes in. An interception or tackle costs a life and resets the formation; the third turnover ends most rounds.

Build a flow multiplier with consecutive passes and queue passes for one-touch combinations. Triangles, wall passes, and bonus-zone receptions earn Focus, which briefly slows the court and match clock. World Tour, Free practice, Endless, and the date-seeded Daily Circuit each offer a different structure.

See the [gameplay guide](docs/GAMEPLAY.md) for scoring, controls, modes, progression, tactics, accessibility, and offline behavior.

## Local demo profiles and saves

The account interface is a local demo. Registration accepts an email and username, but there are no passwords, verification emails, server accounts, or real authentication. Profiles, settings, progress, and stats remain in browser storage on that device. They do not synchronize, and clearing site data removes them.

Pages on the same origin share profiles. The data-provider API is an integration point for a future authenticated backend; the repository does not include one.

## Repository layout

- `apps/desktop/` — the browser interface and controls.
- `packages/engine/` — simulation, AI, modes, progression, and settings.
- `packages/presentation/` — shared renderer and synthesized audio.
- `packages/data/` — data-provider API and local demo implementation.
- `src/` — compatibility exports retained for regression coverage.
- `tests/` — Node and browser integration tests.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. No license grant is provided for this repository.
