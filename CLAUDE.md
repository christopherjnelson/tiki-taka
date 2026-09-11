# CLAUDE.md - Tiki Taka Development Guide

Tiki Taka is an arcade soccer possession browser game (no shots or goals: keep possession, move into space, make passes, build flow). Built with vanilla JavaScript (ESM), Canvas 2D, and Web Audio. Runs guest-first without a required backend, with optional Supabase accounts.

## Quick Commands

- **Unit tests**: `npm test` (Runs `node --test tests/*.test.mjs` - fast, ~350ms)
- **Single unit test**: `node --test tests/game.test.mjs`
- **Build**: `npm run build` (Builds static site to `dist/desktop/`)
- **Dev server**: `npm start` (Vite on `http://localhost:5173`)
- **Desktop browser tests (Playwright)**: `npm run test:web`
  - Or single suite: `npm run test:interface`, `npm run test:one-touch`, `npm run test:navigation`, `npm run test:desktop-account`, `npm run test:audio`, `npm run test:browser`
- **Install dependencies**: `npm ci`
- **Install Playwright Chromium**: `npx playwright install chromium`

*Note: Mobile layouts are frozen (`npm run test:mobile-layouts`). Do not gate desktop UI changes on mobile suites.*

## Architecture & Code Organization

```
apps/desktop/            # Browser interface, DOM, main loop, event handlers, audio player, CSS
packages/engine/         # Pure simulation, game math, AI, tactics, scoring, progress, venues
packages/presentation/   # Canvas 2D renderer, procedural audio synthesizer
packages/data/           # Storage provider: guest localStorage + Supabase client adapter
scripts/                 # Dev server (dev.mjs), build (build.mjs), static serve (serve.mjs)
src/                     # Compatibility re-exports (keep export identities identical)
tests/                   # Node test runner unit tests and Playwright browser integration tests
```

## Critical Development Rules

1. **Pure Engine Isolation**: `packages/engine/` must NEVER import or reference browser globals (`window`, `document`, `navigator`, `localStorage`, `AudioContext`). It must run cleanly in headless Node.js tests.
2. **Determinism**: The engine uses seeded PRNG (`xorshift128+`). Given identical seed and inputs, match simulation must reproduce exactly.
3. **No Unnecessary Dependencies**: The game is built with vanilla JavaScript, Canvas 2D, and Web Audio. Do not introduce frontend frameworks (React, Vue, Tailwind, etc.).
4. **Code Style**:
   - 2-space indentation, LF line endings, UTF-8 (`.editorconfig`).
   - Standard ES Modules (`import`/`export`).
   - Clean, readable variable names; keep simulation math organized in pure helper functions.
5. **Data & Accounts**:
   - Default is guest-only device-local storage.
   - Supabase is optional (configured via `.env`). Account UI is hidden if credentials are not present.
   - Normalization functions (`normalizeProgress`, `normalizeSettings`) must safely recover from invalid/partial data.
6. **Version Numbers**: Update only in root `package.json`.
7. **Untracked Artifacts**: Never commit `dist/`, `test-results/`, `.tooling/`, `.env`, or caches.
