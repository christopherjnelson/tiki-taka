# Contributing

## Setup and checks

Use Node.js 22.12 or newer (Node 24 recommended), then install the locked dependencies and start the dev server:

```sh
npm ci
npm start
```

The game runs at <http://localhost:5173>. Use `HOST=0.0.0.0 npm start` only on a trusted network.

Every change should pass the unit tests and the production build:

```sh
npm test
npm run build
```

Install Playwright's browsers once, then run all six browser suites:

```sh
npx playwright install chromium
npm run test:web
```

`test:web` covers gameplay, interface, navigation, one-touch, desktop-account, and audio. Each suite also has a standalone script, such as `npm run test:desktop-account`, for focused iteration.

Firefox coverage for the primary gameplay suite is available separately:

```sh
npx playwright install firefox
BROWSER=firefox npm run test:browser
```

Browser automation does not replace testing with a real gamepad.

## Source layout

`apps/desktop/` holds the browser interface; `packages/engine/`, `packages/presentation/`, and `packages/data/` hold the shared simulation, renderer, and data provider. All of it is freely editable — there is no source freeze.

## Version numbers

The release version lives in root `package.json` only.

## Local data and generated output

Profiles are passwordless, device-local demos. No authentication service is present. Test with disposable values; clearing browser storage removes profiles and progress.

Build products belong in ignored `dist/`. Test reports belong in `test-results/`; local tools belong in `.tooling/`. Do not commit browser profiles, screenshots, traces, logs, or caches.

This is a commercial game repository. No license grant is provided.

## Continuous integration

[GitHub Actions CI](.github/workflows/ci.yml) runs one job on pushes to `main` and pull requests: unit tests, the production build, and the browser suites. Failed runs retain browser screenshots as workflow artifacts for 7 days.
