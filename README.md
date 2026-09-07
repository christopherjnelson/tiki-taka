# Tiki Taka

A single-player arcade soccer possession game in an enclosed court. There are no shots or goals: move into space, connect passes, and make the next touch count.

Tiki Taka uses JavaScript, Canvas 2D, and Web Audio. Its desktop and mobile interfaces share one game engine and renderer. It runs without a backend and stores progress locally.

## Quick start

Use Node.js 22.12 or newer (Node 24 recommended):

```sh
npm ci
npm start
```

Open the desktop game at <http://localhost:5173> or the mobile preview at <http://localhost:5173/mobile/>.

To test on a phone connected to the same trusted network, run `HOST=0.0.0.0 npm start`, then visit `http://YOUR_COMPUTER_LAN_IP:5173/mobile/`. The server may require an inbound TCP 5173 firewall rule for the local subnet.

## Build and test

```sh
npm test
npm run build
```

The build creates independent static sites in `dist/desktop/` and `dist/mobile/`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete browser test matrix, Electron packaging, and Android prerequisites.

## Ways to play

- **Browser:** desktop and touch interfaces, installable where the browser supports it.
- **Linux desktop:** run `npm run electron:pack`, then `./scripts/launch-desktop.sh`. See [Steam testing](docs/STEAM-TESTING.md) for local Steam Input setup.
- **Android:** run `npm run mobile:sync`, then `npm run mobile:android` to open the generated project in Android Studio. The installed app bundles its assets and works without the development server.

The production desktop site caches assets after the first online load. Service workers require localhost or HTTPS. Native desktop and Android packages bundle the application directly.

## Game overview

Control the ball carrier while three teammates find supporting positions. Pass before the press closes in. An interception or tackle costs a life and resets the formation; the third turnover ends most rounds.

Build a flow multiplier with consecutive passes and queue passes for one-touch combinations. Triangles, wall passes, and bonus-zone receptions earn Focus, which briefly slows the court and match clock. World Tour, Free practice, Endless, and the date-seeded Daily Circuit each offer a different structure.

See the [gameplay guide](docs/GAMEPLAY.md) for scoring, controls, modes, progression, tactics, accessibility, and offline behavior.

## Local demo profiles and saves

The account interface is a local demo. Registration accepts an email and username, but there are no passwords, verification emails, server accounts, or real authentication. Profiles, settings, progress, and stats remain in browser or app storage on that device. They do not synchronize, and clearing site or app data removes them.

Browser pages on the same origin share profiles. The Electron app and installed Android app each use separate storage. The data-provider API is an integration point for a future authenticated backend; the repository does not include one.

## Repository layout

- `apps/desktop/` — desktop interface and controls.
- `apps/mobile/` — touch interface, Capacitor configuration, and Android project.
- `apps/electron/` — native desktop window and isolated storage.
- `packages/engine/` — simulation, AI, modes, progression, and settings.
- `packages/presentation/` — shared renderer and synthesized audio.
- `packages/data/` — data-provider API and local demo implementation.
- `src/` — compatibility exports retained for regression coverage.
- `tests/` — Node and browser integration tests.

Mobile version 1.1.1 and the shared engine have a recorded 47-file freeze. Before changing shared gameplay or mobile source, read [the mobile freeze record](docs/MOBILE-FREEZE.md). Desktop shell and packaging work must keep `node scripts/check-mobile-freeze.mjs` passing.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes. No license grant is provided for this repository.
