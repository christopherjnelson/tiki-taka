# Contributing

## Setup and checks

Use Node.js 22.12 or newer (Node 24 recommended), then install the locked dependencies and start both browser interfaces:

```sh
npm ci
npm start
```

Desktop runs at <http://localhost:5173>; mobile preview runs at <http://localhost:5173/mobile/>. Use `HOST=0.0.0.0 npm start` only on a trusted network.

Every change should pass the source-freeze check, unit tests, and production build:

```sh
npm run test:mobile-freeze
npm test
npm run build
```

Install Playwright's browsers once, then run all six browser suites:

```sh
npx playwright install chromium
npm run test:web
```

`test:web` includes gameplay, interface, navigation, one-touch, mobile, and desktop-account coverage. Each suite also has a standalone script, including `npm run test:desktop-account`, for focused iteration.

Firefox coverage for the primary gameplay suite is available separately:

```sh
npx playwright install firefox
BROWSER=firefox npm run test:browser
```

Browser automation does not replace tests on physical Android devices or real gamepads.

## Desktop app

Use `npm run electron:dev` for development. Package and launch Linux output with:

```sh
npm run electron:pack
./scripts/launch-desktop.sh
```

Close a running packaged game before rebuilding it. `npm run test:electron` uses a private Xvfb display, icewm, and temporary user data; Xvfb and icewm must be installed. See [Steam testing](docs/STEAM-TESTING.md) for hands-on Steam Input checks.

## Version numbers

Three locations state the release version and must stay in sync: root `package.json`, `apps/electron/package.json`, and `versionName` (with `versionCode`) in `apps/mobile/android/app/build.gradle`.

`apps/electron/package.json` is the one electron-builder reads, because `electron-builder.yml` sets `directories.app` to `apps/electron`; its version becomes the packaged artifact name.

The Android file is inside the mobile freeze, so bumping it means deliberately reopening that freeze. Read [the freeze record](docs/MOBILE-FREEZE.md) first.

## Android and the mobile freeze

Mobile 1.1.1 and the shared engine are frozen. Read [the freeze record](docs/MOBILE-FREEZE.md) before changing `apps/mobile/`, `packages/`, or shared mobile assets. Desktop-only work must pass:

```sh
node scripts/check-mobile-freeze.mjs
```

The checker must not silently regenerate its baseline. To use the existing Android project:

```sh
npm run mobile:sync
npm run mobile:android
```

For a debug APK, install Java 21 and Android SDK 36, configure `JAVA_HOME` and `ANDROID_HOME` if needed, and run `npm run mobile:build`. Output appears at `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.

Do not commit SDKs, signing material, generated APKs, Gradle caches, `local.properties`, Capacitor web output, or build directories. Keep the Gradle wrapper script and wrapper JAR tracked with native source.

## Local data and generated output

Profiles are passwordless, device-local demos. No authentication service is present. Test with disposable values; clearing browser or app storage removes profiles and progress. Browser, Electron, and installed Android builds use separate storage contexts.

Build products belong in ignored `dist/`, `release/`, and Android build directories. Test reports belong in `test-results/`; local SDKs and tools belong in `.tooling/`. Do not commit browser profiles, Electron user data, screenshots, traces, logs, or caches.

This is a commercial game repository. No license grant is provided.

## Continuous integration

[GitHub Actions CI](.github/workflows/ci.yml) runs three jobs on pushes to `main` and pull requests: web build and tests, packaged Electron smoke testing on a private display, and an Android debug build. Successful package jobs retain the Linux AppImage and Android debug APK as workflow artifacts for 14 days.

The CI APK is signed with a temporary runner debug key and may not install over a workstation-signed build. See [the mobile freeze record](docs/MOBILE-FREEZE.md) before using an APK to update a phone whose local data must be retained.
