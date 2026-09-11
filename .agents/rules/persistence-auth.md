# Persistence, Settings, & Authentication Rules

This document outlines storage schemas, data recovery, and Supabase integration rules in `packages/data/` and `packages/engine/src/progress.js`.

---

## 1. Local Storage Architecture

Tiki Taka is designed to be fully functional offline with guest persistence:

- **Storage Key**: `tiki-taka.local-data.v1.guest`
- **Legacy Migration Keys**: `tiki-taka.progress.v1` and `tiki-taka.settings.v1` are read and imported automatically if present.
- **Fail-Safe Recovery**:
  - `normalizeProgress()`: If JSON is corrupt, unreadable, or missing properties, defaults are applied safely without throwing exceptions.
  - `normalizeSettings()`: Reconciles key bindings, sound settings, and theme preferences against valid options (`defaultSettings()`).
  - Storage write errors (e.g., private browsing quota exceeded) are caught and surfaced via `LocalDataError`.

---

## 2. Supabase Integration Rules

Supabase provides optional online accounts, cross-device sync, and global leaderboards.

### Configuration
- Supabase credentials must only be injected via environment variables:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_PUBLISHABLE_KEY`
- When either variable is missing, the game operates exclusively in guest mode. The account entry point in the header is hidden.

### Content Security Policy (CSP)
- The production app restricts outbound network requests with strict CSP headers.
- Both `scripts/dev.mjs` and `scripts/serve.mjs` inspect `VITE_SUPABASE_URL` and dynamically whitelist only the exact Supabase project origin in `connect-src`. Never open `connect-src` to wildcards.

### Offline & Fallback Guarantees
- A player signed in to Supabase who loses internet connectivity must continue to play uninterrupted on their local cache.
- Local saves must never overwrite remote records with empty or regressed data.
- Round score submissions use caller-generated UUIDv4 retry tokens (`callerRoundId`) to ensure idempotent retries.

### Test Isolation
- In browser testing, mock the data adapter without making external HTTP requests by injecting:
  ```js
  globalThis.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__
  ```
