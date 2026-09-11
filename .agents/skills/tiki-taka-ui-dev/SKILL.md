---
name: tiki-taka-ui-dev
description: >-
  Use this skill when developing desktop interface views, canvas rendering, CSS styling,
  HUD elements, input controllers, or performing visual validation for Tiki Taka.
---

# Desktop UI & Presentation Runbook

Follow these procedures when modifying the DOM interface, CSS styles, controls, or canvas rendering.

---

## 1. Local Development Server

Start the Vite development server:
```sh
npm start
# or
node scripts/dev.mjs
```
The game will be available at `http://localhost:5173`.
- `scripts/dev.mjs` applies a development CSP that enables Vite HMR and connects to Supabase (if configured).

---

## 2. Interface Structure & Routing

- **Main Entrypoint**: `apps/desktop/src/main.js`
- **Stylesheet**: `apps/desktop/src/style.css`
- **HTML Shell**: `apps/desktop/index.html`

### Views and Navigation State:
- `#home-view`: The title screen and mode selection hub (World Tour, Free Practice, Endless, Daily Circuit).
- `#arena-view`: The live gameplay court canvas and HUD.
- **Cold Load Rule**: A cold load always opens `#home-view`, even if the URL contains `#play`. To enter the arena in tests, use the helper `gotoArena(page, baseURL)` from `tests/open-arena.mjs`.

---

## 3. Visual Verification Tools

Use the local scratch scripts to inspect visual layouts and capture screenshots:

### Screenshot Capture
Capture a headless screenshot of the running dev server:
```sh
# Usage: node .shot.mjs [output.png] [width] [height]
node .shot.mjs screenshot.png 1680 945
```

### Layout Measurement
Inspect element bounding boxes:
```sh
# Usage: node .measure.mjs [width] [height] [selectors...]
node .measure.mjs 1680 945 .home-stage .home-courts
```

---

## 4. UI Testing & Verification

After modifying UI components or CSS:
1. Run the interface browser test suite:
   ```sh
   npm run test:interface
   ```
2. Run the navigation suite:
   ```sh
   npm run test:navigation
   ```
3. Verify that the production build succeeds:
   ```sh
   npm run build
   ```
