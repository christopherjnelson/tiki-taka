# Repository guidance

- Tiki Taka ships as a browser game only. The interface lives in `apps/desktop/`; it consumes shared code from `packages/engine/`, `packages/presentation/`, and `packages/data/`. Build and dev-server scripts live in `scripts/`.
- Use Node.js 22.12 or newer. Run `npm test` and `npm run build` for general changes; select the relevant Playwright suites listed in `CONTRIBUTING.md` for interface changes.
- There is no source freeze; `packages/` is edited like any other directory.
- Generated builds, caches, and user data stay untracked.
- This repository does not provide a license grant.
