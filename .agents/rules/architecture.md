# Architecture Rules & Package Boundaries

Tiki Taka is designed with strict separation of concerns across its modular packages:

```
tiki-taka/
├── apps/
│   └── desktop/         # Browser interface, DOM, main loop, event handlers, audio player, CSS
├── packages/
│   ├── engine/          # Headless game simulation, AI, tactics, scoring, venues, progress
│   ├── presentation/    # Canvas 2D court/player renderer and Web Audio sound synthesizer
│   └── data/            # Data provider API: guest localStorage and Supabase adapter
├── src/                 # Compatibility re-exports (must mirror shared package exports)
├── scripts/             # Dev server, static file server, and build pipeline
└── tests/               # Unit and Playwright browser integration suites
```

---

## Strict Package Isolation Rules

### 1. `packages/engine/` — Zero Browser Globals
- The game engine must remain **100% headless and decoupled from browser APIs**.
- **Prohibited**: Never use or import `window`, `document`, `navigator`, `localStorage`, `sessionStorage`, `AudioContext`, `Image`, or `canvas` inside `packages/engine/`.
- The engine must execute cleanly in a pure Node.js runtime (`node --test`).
- All state updates and inputs must be passed as plain data objects or method arguments into the `Game` class.

### 2. `packages/presentation/` — Rendering and Synthesis
- Responsible only for displaying the simulation on HTML5 Canvas 2D and synthesizing sounds via the Web Audio API.
- Must not contain game state logic, score calculations, or match rules; it only reflects state provided by `Game`.

### 3. `packages/data/` — Storage and Cloud Synchronization
- Exposes a unified data provider interface with `selectDataAdapter()`.
- Supports guest-only localStorage storage and Supabase cloud persistence.
- Handles corrupt or missing data gracefully, normalizing keys with safe defaults.

### 4. `apps/desktop/` — Web Application Entry Point
- Manages DOM lifecycle, responsive canvas sizing, input capturing (gamepad, keyboard, mouse, touch), settings dialogs, modal menus, and soundtrack playback.
- Mounts and drives the engine simulation loop.

### 5. `src/` — Legacy Compatibility Re-exports
- Files like `src/game.js`, `src/audio.js`, `src/renderer.js`, `src/settings.js`, `src/progress.js` re-export from the shared packages.
- These must remain intact to prevent breaking backwards compatibility with legacy tests or external importers.

---

## Release and Versioning Rules
- The version string is declared in root `package.json` only.
- Do not maintain duplicate version strings in sub-packages or application source files.

---

## Untracked Artifacts Rule
The following directories and files are generated during builds or testing and must stay untracked:
- `dist/` (build output)
- `test-results/` (browser test screenshots and traces)
- `.tooling/` (local developer tool downloads)
- `.env` and `.env.*` (local environment configurations, except `.env.example`)
- Machine-local Android builds (`apps/mobile/android/`)
