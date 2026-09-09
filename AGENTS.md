# Repository guidance

- Browser interfaces live in `apps/desktop/` and `apps/mobile/`; both consume shared code from `packages/engine/`, `packages/presentation/`, and `packages/data/`. Electron packaging lives in `apps/electron/` and `scripts/`.
- Use Node.js 22.12 or newer. Run `npm test` and `npm run build` for general changes; select the relevant Playwright suites listed in `CONTRIBUTING.md` for interface changes.
- `npm run test:electron` uses a private Xvfb/icewm display and temporary user data. Keep automated test output separate from the user's running packaged game, and close a running package before rebuilding it.
- Generated builds, local SDKs, caches, signing keys, APKs, and user data stay untracked. Preserve Gradle wrapper files and native project source.
- This repository does not provide a license grant.
