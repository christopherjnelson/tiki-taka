# Testing Rules & Verification Guide

Tiki Taka features a robust, multi-layer testing architecture: Node.js native unit tests, production build verification, and Playwright desktop browser suites.

---

## 1. Node.js Unit Tests (`npm test`)

- **Command**: `npm test` (Runs `node --test tests/*.test.mjs`)
- **Execution Time**: ~350ms
- **Target**: Pure Node.js test runner covering engine mechanics, progress storage normalization, settings serialization, Supabase adapter fallbacks, and deterministic match reproduction.
- **Rule**: Run `npm test` before committing any code changes. Any modification to `packages/engine/` or `packages/data/` must maintain 100% test passage.
- **Single Test**: Run an individual file using `node --test tests/<filename>.test.mjs`.

---

## 2. Production Build Check (`npm run build`)

- **Command**: `npm run build` (Executes `node scripts/build.mjs`)
- **Target**: Compiles Vite bundle into `dist/desktop/`, copies webmanifest/icons/soundtrack, and synthesizes `sw.js` with SHA-256 asset hash precaching.
- **Rule**: Run `npm run build` to ensure module imports, bundle assets, and service worker generation remain error-free.

---

## 3. Playwright Desktop Browser Suites

- **Full Desktop Suite**: `npm run test:web` (Runs all 6 desktop browser suites sequentially).
- **Target Suites**:
  1. `npm run test:browser` — Core match loop, controls, turnovers, flow multipliers, pause/resume.
  2. `npm run test:interface` — HUD layout, view sizing, court selection, modal dialogs.
  3. `npm run test:navigation` — Hash navigation, menu key bindings, view transitions (`#home-view` vs `#arena-view`).
  4. `npm run test:one-touch` — Timing tolerances, queueing passes during flight, olé readout.
  5. `npm run test:desktop-account` — Guest progress vs Supabase accounts, sign-in dialog, retry IDs.
  6. `npm run test:audio` — Synthesized sound triggers, volume controls, playlist sequencing.

### Browser Testing Environment Rules:
- **Server Spawning**: Browser suites automatically spawn `scripts/serve.mjs` on an ephemeral port using `tests/free-port.mjs`.
- **Pre-build Requirement**: Because `serve.mjs` serves static assets, running `npm run build` prior to browser testing ensures that the browser is testing the latest bundled assets.
- **Failure Artifacts**: When browser assertions fail, screenshots and trace logs are saved to `test-results/`. Always inspect these files when diagnosing UI test failures.
- **Mobile Layouts Policy**: Mobile and coarse-pointer views are frozen. `npm run test:mobile-layouts` is strictly optional and non-blocking for desktop development.
