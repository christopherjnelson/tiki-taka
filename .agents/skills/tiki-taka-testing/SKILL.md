---
name: tiki-taka-testing
description: >-
  Use this skill to run and diagnose test suites for Tiki Taka, including Node.js
  unit tests, production build verification, and Playwright desktop browser integration tests.
---

# Tiki Taka Testing & Verification Runbook

Follow these procedures to validate code changes, run focused tests, and debug failures.

---

## 1. Quick Verification (Fast Path)

Before committing changes to any engine, data, or presentation module, run the fast unit test suite and production build:

```sh
# 1. Run Node.js unit tests (~350ms)
npm test

# 2. Verify static production build
npm run build
```

Both commands must exit with code 0.

---

## 2. Running Targeted Tests

### Unit Tests
Run a single unit test file during iteration:
```sh
node --test tests/game.test.mjs
node --test tests/data.test.mjs
node --test tests/settings.test.mjs
node --test tests/supabase-data.test.mjs
```

### Browser Integration Tests (Playwright)
Run the specific browser suite corresponding to your changes:

| Area of Change | Recommended Test Command |
| :--- | :--- |
| **Match Loop / Turnover / Flow** | `npm run test:browser` |
| **HUD / Responsive Layouts / Modals** | `npm run test:interface` |
| **One-Touch Timing / Input Queue** | `npm run test:one-touch` |
| **Views / Hash State / Key Navigation** | `npm run test:navigation` |
| **Guest Save / Supabase Auth Dialog** | `npm run test:desktop-account` |
| **Synthesized Audio / Music Playlist** | `npm run test:audio` |

To run all desktop browser suites together:
```sh
npm run test:web
```

---

## 3. Diagnosing Browser Test Failures

When a browser test fails:
1. **Check the failure logs**: The terminal output prints the exact assertion failure and stack trace.
2. **Inspect screenshots**: Failed tests write screenshots directly to `test-results/`. View the generated PNGs to inspect DOM layout or UI state at the moment of failure.
3. **Run with visible browser**: Run headed to watch the test execute live:
   ```sh
   HEADED=1 npm run test:interface
   ```
4. **Build stale assets**: If UI tests fail unexpectedly after modifying code, ensure you rebuild the assets:
   ```sh
   npm run build
   ```

---

## 4. Mobile Layouts (Optional)

Mobile layouts are frozen and do not block desktop PRs. If intentionally working on mobile layout regressions:
```sh
npm run test:mobile-layouts
```
