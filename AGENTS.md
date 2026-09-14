# Repository Guidance for AI Agents

Tiki Taka is an arcade soccer possession browser game built with JavaScript, Canvas 2D, and Web Audio. It runs without a required backend and defaults to guest-only local storage.

This repository uses a multi-package architecture. There is no source freeze: all packages and applications are freely editable.

---

## Architecture and Package Boundaries

- **`packages/engine/`**: Pure headless simulation, game loop math, AI, tactics, scoring, and progress calculations.
  - **CRITICAL CONSTRAINT**: Strictly **ZERO DOM or browser globals** (`window`, `document`, `navigator`, `localStorage`, `AudioContext`). Must run cleanly inside Node.js.
  - Determinism: Uses seeded PRNG (`xorshift128+`). Given identical seed and inputs, match simulation must reproduce exactly.
- **`packages/presentation/`**: Canvas 2D court/player rendering and Web Audio procedural sound synthesis.
- **`packages/data/`**: Data persistence provider. Default device-local storage (`tiki-taka.local-data.v1.guest`) with optional Supabase client adapter for cloud saves and leaderboards.
- **`apps/desktop/`**: Desktop browser client. Holds DOM lifecycle, menu views (`#home-view`, `#arena-view`), HUD, keyboard/mouse/gamepad bindings, and audio playback.
- **`src/`**: Compatibility re-exports for external/regression import stability. **Preserve export identities.**
- **`scripts/`**: Build and server scripts (`build.mjs`, `dev.mjs`, `serve.mjs`).

---

## Environment and Commands

Requires **Node.js 22.12 or newer** (Node 24 recommended).

### Essential Commands
- **Run unit tests**: `npm test` (Runs `node --test tests/*.test.mjs`, ~350ms).
- **Production build**: `npm run build` (Vite build into `dist/desktop/`, generates service worker and copies assets).
- **Development server**: `npm start` or `npm run dev` (`node scripts/dev.mjs` at `http://localhost:5173`).
- **Run all desktop browser tests**: `npm run test:web` (Runs the 6 desktop Playwright suites).
- **Individual browser suites**:
  - `npm run test:interface` — desktop UI, dialogs, responsive sizing.
  - `npm run test:one-touch` — one-touch input queueing, timing windows, olé HUD readouts.
  - `npm run test:navigation` — menu transitions, view state history, keyboard navigation.
  - `npm run test:desktop-account` — guest saves, account modal, and Supabase auth flows.
  - `npm run test:audio` — procedural synthesis, mute toggles, soundtrack playback.
  - `npm run test:browser` — primary gameplay and match loop tests.

### Browser Testing Caveats
- Playwright browser tests test against `scripts/serve.mjs`. If testing built output, always run `npm run build` first.
- Mobile/coarse-pointer layouts are frozen: do NOT run `npm run test:mobile-layouts` unless intentionally modifying that area.
- Failed browser tests save screenshot and trace artifacts to `test-results/`.

---

## Coding and Repository Rules

1. **Version numbers**: Release version lives in root `package.json` only. Add the release entry to `CHANGELOG.md` in the same commit so the build-time in-app changelog stays current.
2. **Untracked files**: `dist/`, `test-results/`, `.tooling/`, `.env`, and local caches must remain untracked. Never commit them.
3. **No runtime bloat**: Core gameplay uses Canvas 2D and Web Audio. Do not add heavy web frameworks or external UI dependencies unless explicitly requested.
4. **Supabase optionality**: When `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` are unset, the game runs guest-only and hides account UI. Signed-in accounts gracefully fall back to local storage when offline without corrupting remote saves.
5. **No License Grant**: This is a commercial game repository. No license grant is provided.
