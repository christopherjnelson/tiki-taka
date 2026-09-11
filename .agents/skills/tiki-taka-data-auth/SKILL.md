---
name: tiki-taka-data-auth
description: >-
  Use this skill when modifying local storage persistence, progress/settings schemas,
  or Supabase authentication and cloud leaderboard integration.
---

# Data Persistence & Supabase Integration Runbook

Follow these procedures when modifying storage adapters, progress schemas, or Supabase integration in `packages/data/`.

---

## 1. Local Storage Normalization

All guest data is read and written through `packages/data/src/index.js` using `createLocalDataAdapter()`.

### Safe Deserialization
When modifying progress or settings objects, ensure `normalizeProgress()` (`packages/engine/src/progress.js`) and `normalizeSettings()` (`packages/engine/src/settings.js`) safely handle:
- Older schema versions or missing keys.
- Corrupted JSON payloads.
- Out-of-bounds numbers (use clamping).

Verify normalization logic:
```sh
node --test tests/progress.test.mjs
node --test tests/settings.test.mjs
node --test tests/data.test.mjs
```

---

## 2. Supabase Integration & Testing

Supabase authentication and leaderboards live in `packages/data/src/supabase.js`.

### Environment Setup
To test against a live Supabase project, supply `.env` at repository root:
```ini
VITE_SUPABASE_URL=https://<your-project>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your-publishable-key>
```

### Mock Testing
Unit tests do not require a live Supabase connection:
```sh
node --test tests/supabase-data.test.mjs
```

In browser tests, inject `globalThis.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__` to provide a mock adapter without making network requests. Run:
```sh
npm run test:desktop-account
```

---

## 3. Pre-Commit Checklist
Before completing data changes:
1. Run all data-related tests:
   ```sh
   npm test
   ```
2. Verify production build:
   ```sh
   npm run build
   ```
3. Run desktop account browser suite:
   ```sh
   npm run test:desktop-account
   ```
