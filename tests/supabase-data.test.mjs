import assert from "node:assert/strict";
import test from "node:test";

import { createSupabaseDataAdapter, selectDataAdapter } from "../packages/data/src/index.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

function thenable(result) {
  return { then: (resolve, reject) => Promise.resolve(result).then(resolve, reject) };
}

function profileQuery(result = { data: { id: "user-1", username: "player" }, error: null }) {
  return { select: () => ({ eq: () => ({ maybeSingle: async () => result }) }) };
}

test("Supabase adapter uses email/password auth and supplies username as signup metadata", async () => {
  let signup;
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signUp: async (input) => { signup = input; return { data: { user, session: { user } }, error: null }; },
      signInWithPassword: async () => ({ data: { user, session: { user } }, error: null }),
      signOut: async () => ({ error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: () => profileQuery(),
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const profile = await adapter.register({ email: " PLAYER@example.com ", username: "player", password: "password-1" });
  assert.deepEqual(signup, { email: "player@example.com", password: "password-1", options: { data: { username: "player" } } });
  assert.equal(profile.authMode, "supabase");
  await assert.rejects(adapter.register({ email: "other@example.com", username: "x".repeat(25), password: "password-1" }), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(adapter.register({ email: "other@example.com", username: "not allowed!", password: "password-1" }), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(adapter.login({ identifier: "player", password: "password-1" }), (error) => error.code === "VALIDATION_ERROR");
});

test("Supabase adapter does not turn an unreachable signed-in account into a guest", async () => {
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: (table) => table === "user_saves"
      ? profileQuery({ data: null, error: { message: "network unavailable" } })
      : table === "profiles"
        ? profileQuery()
        : { select: () => ({ eq: () => thenable({ data: [], error: null }) }) },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  await assert.rejects(adapter.loadUserData(), (error) => error.code === "STORAGE_ERROR");
});

test("Supabase adapter preserves a caller round id for idempotent score retries", async () => {
  const writes = [];
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "round_scores") return {
        upsert: async (row, options) => { writes.push({ row, options }); return { error: null }; },
        select: () => ({ eq: () => thenable({ data: [], error: null }) }),
      };
      throw new Error(`unexpected table ${table}`);
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  await adapter.recordRound({ id: "f2402978-1b50-4b8c-9dca-65b82ba2c8a3", score: 12, passes: 3, bestOneTouch: 2, triangles: 1, oles: 2, splits: 3, zones: 4 });
  assert.equal(writes[0].row.id, "f2402978-1b50-4b8c-9dca-65b82ba2c8a3");
  assert.deepEqual(writes[0].options, { onConflict: "id", ignoreDuplicates: true });
  assert.equal(writes[0].row.triangles, 1);
  assert.equal(writes[0].row.oles, 2);
  assert.equal(writes[0].row.splits, 3);
  assert.equal(writes[0].row.zones, 4);
});

test("Supabase adapter defaults missing bonus counters to zero, never NaN or null (columns are NOT NULL)", async () => {
  const writes = [];
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "round_scores") return {
        upsert: async (row, options) => { writes.push({ row, options }); return { error: null }; },
        select: () => ({ eq: () => thenable({ data: [], error: null }) }),
      };
      throw new Error(`unexpected table ${table}`);
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  // Simulates a round object queued for retry before these fields existed.
  await adapter.recordRound({ score: 12, passes: 3, bestOneTouch: 2 });
  assert.equal(writes[0].row.triangles, 0);
  assert.equal(writes[0].row.oles, 0);
  assert.equal(writes[0].row.splits, 0);
  assert.equal(writes[0].row.zones, 0);
  await adapter.recordRound({ score: 5, passes: 1, bestOneTouch: 1, triangles: "bad", oles: null, splits: NaN, zones: undefined });
  assert.equal(writes[1].row.triangles, 0);
  assert.equal(writes[1].row.oles, 0);
  assert.equal(writes[1].row.splits, 0);
  assert.equal(writes[1].row.zones, 0);
});

test("Supabase adapter aggregates bonus-counter totals across rounds and normalizes malformed rows", async () => {
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const rows = [
    { score: 10, passes: 2, best_one_touch: 1, triangles: 1, oles: 1, splits: 0, zones: 2 },
    { score: 20, passes: 4, best_one_touch: 3, triangles: "bad", oles: null, splits: NaN, zones: undefined },
  ];
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "round_scores") return {
        select: () => ({ eq: () => thenable({ data: rows, error: null }) }),
        upsert: async () => ({ error: null }),
      };
      throw new Error(`unexpected table ${table}`);
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const stats = await adapter.recordRound({ score: 0, passes: 0, bestOneTouch: 0 });
  assert.equal(stats.totalTriangles, 1);
  assert.equal(stats.totalOles, 1);
  assert.equal(stats.totalSplits, 0);
  assert.equal(stats.totalZones, 2);
});

// getLeaderboard talks straight to PostgREST rather than through the client
// (see fetchPublicLeaderboard in packages/data/src/supabase.js) - the one
// call this adapter must serve without the Supabase library ever having
// loaded (createDeferredSupabaseDataAdapter in packages/data/src/index.js
// calls it directly, with no adapter at all). These tests stub global fetch
// instead of the client's query builder.
function withFetch(handler, run) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

test("Supabase adapter's leaderboard selects and maps the bonus-counter columns", async () => {
  let requestUrl;
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  };
  const adapter = createSupabaseDataAdapter({ client, url: "https://proj.supabase.co", publishableKey: "anon-key", storage: memoryStorage() });
  const board = await withFetch(async (url) => {
    requestUrl = url;
    return new Response(JSON.stringify([{ username: "player", score: 10, passes: 3, best_one_touch: 2, triangles: 1, oles: 2, splits: 3, zones: 4, created_at: "now" }]), { status: 200 });
  }, () => adapter.getLeaderboard({ mode: "career" }));
  const select = new URL(requestUrl).searchParams.get("select");
  assert.match(select, /\btriangles\b/);
  assert.match(select, /\boles\b/);
  assert.match(select, /\bsplits\b/);
  assert.match(select, /\bzones\b/);
  assert.deepEqual(board.entries[0], {
    username: "player",
    score: 10,
    passes: 3,
    bestOneTouch: 2,
    triangles: 1,
    oles: 2,
    splits: 3,
    zones: 4,
    difficulty: "standard",
    createdAt: "now",
  });
});

test("Supabase adapter threads difficulty into the round payload and defaults an invalid value to standard", async () => {
  const writes = [];
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "round_scores") return {
        upsert: async (row) => { writes.push(row); return { error: null }; },
        select: () => ({ eq: () => thenable({ data: [], error: null }) }),
      };
      throw new Error(`unexpected table ${table}`);
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  await adapter.recordRound({ score: 1, difficulty: "ruthless" });
  assert.equal(writes[0].difficulty, "ruthless");
  await adapter.recordRound({ score: 1, difficulty: "nightmare" });
  assert.equal(writes[1].difficulty, "standard");
  await adapter.recordRound({ score: 1 });
  assert.equal(writes[2].difficulty, "standard");
});

test("getLeaderboard selects and maps difficulty, and accepts an optional difficulty filter", async () => {
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const row = { username: "player", mode: "career", court: 0, score: 900, passes: 12, best_one_touch: 4, difficulty: "ruthless", created_at: "2026-09-11T00:00:00Z" };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  };
  const adapter = createSupabaseDataAdapter({ client, url: "https://proj.supabase.co", publishableKey: "anon-key", storage: memoryStorage() });
  let requestUrl;
  const result = await withFetch(async (url) => {
    requestUrl = url;
    return new Response(JSON.stringify([row]), { status: 200 });
  }, () => adapter.getLeaderboard({ mode: "career", court: 0, difficulty: "ruthless" }));
  const params = new URL(requestUrl).searchParams;
  assert.equal(params.get("mode"), "eq.career");
  assert.equal(params.get("court"), "eq.0");
  assert.equal(params.get("difficulty"), "eq.ruthless");
  assert.equal(result.difficulty, "ruthless");
  assert.deepEqual(result.entries[0], { username: "player", score: 900, passes: 12, bestOneTouch: 4, triangles: 0, oles: 0, splits: 0, zones: 0, difficulty: "ruthless", createdAt: "2026-09-11T00:00:00Z" });
});

test("getLeaderboard forwards an optional AbortSignal without requiring it", async () => {
  const controller = new AbortController();
  let receivedSignal;
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
  };
  const adapter = createSupabaseDataAdapter({ client, url: "https://proj.supabase.co", publishableKey: "anon-key", storage: memoryStorage() });

  await withFetch(async (_url, init) => {
    receivedSignal = init?.signal;
    return new Response(JSON.stringify([]), { status: 200 });
  }, () => adapter.getLeaderboard({ signal: controller.signal }));

  assert.equal(receivedSignal, controller.signal);
});

test("Supabase adapter generates a UUIDv4 retry id without crypto.randomUUID", async () => {
  const writes = [];
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: (table) => table === "round_scores" ? {
      upsert: async (row) => { writes.push(row); return { error: null }; },
      select: () => ({ eq: () => thenable({ data: [], error: null }) }),
    } : (() => { throw new Error(`unexpected table ${table}`); })(),
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage(), crypto: { getRandomValues: (bytes) => bytes.fill(0) } });
  await adapter.recordRound({ score: 1 });
  assert.match(writes[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("runtime selection accepts an injected Supabase client without browser credentials", async () => {
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: () => profileQuery(),
  };
  const adapter = await selectDataAdapter({ storage: memoryStorage(), supabaseClient: client });
  assert.equal(adapter.kind, "supabase");
  assert.equal(await adapter.getSession(), null);
});

test("a brand-new account never stores an empty save, and an empty row still loads", async () => {
  // A fresh signup has no user_saves row. Writing `{}` for it produced a save
  // whose progress had no tactic, which threw on the first render and then
  // failed identically on every reload, because the broken row persisted.
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const writes = [];
  const clientFor = (existingSave) => ({
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "user_saves") return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existingSave, error: null }) }) }),
        upsert: (row) => { writes.push(row); return { select: () => ({ single: async () => ({ data: row, error: null }) }) }; },
      };
      if (table === "profiles") return profileQuery();
      if (table === "user_preferences") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      return { select: () => ({ eq: () => thenable({ data: [], error: null }) }) };
    },
  });

  const adapter = createSupabaseDataAdapter({ client: clientFor(null), storage: memoryStorage() });
  const saved = await adapter.saveUserData({});
  assert.equal(writes[0].progress.tactic, "balanced", "a new account must be written a complete progress object");
  assert.equal(writes[0].progress.version, 2);
  assert.ok(writes[0].settings.bindings, "settings must be written complete too");
  assert.equal(saved.progress.tactic, "balanced");

  // Rows already broken by the old behaviour must repair themselves on load
  // rather than keep throwing.
  const repaired = createSupabaseDataAdapter({ client: clientFor({ progress: {}, settings: {} }), storage: memoryStorage() });
  const data = await repaired.loadUserData();
  assert.equal(data.progress.tactic, "balanced");
  assert.equal(data.progress.version, 2);
  assert.ok(Number.isFinite(data.progress.unlocked));
});

test("an old client refuses to save over a row it cannot read, and does not present it as fresh", async () => {
  // Regression for a real incident: 0.4.1 moved progress from version 1 to
  // version 2. A pre-0.4.1 client loaded a version-2 row it did not
  // recognise, normalizeProgress() folded it down to freshProgress(), and
  // saveUserData() wrote that empty progress straight over the real row -
  // erasing every unlocked court and star. This test drives the exact same
  // shape of client against the fix: the row claims a version this build has
  // never heard of (simulating an even-newer future format the same way the
  // real incident simulated version 2 against a pre-0.4.1 build).
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const futureProgress = { version: 99, xp: 50000, unlocked: 7, courts: { 6: { standard: { stars: 3, best: 900 } } }, records: {}, sound: true, tactic: "maestro", difficulty: "ruthless", lastCourt: 6 };
  const clientFor = (existingSave) => ({
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "user_saves") return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existingSave, error: null }) }) }),
        upsert: () => { throw new Error("must never upsert a row this build cannot read"); },
      };
      if (table === "profiles") return profileQuery();
      if (table === "user_preferences") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      return { select: () => ({ eq: () => thenable({ data: [], error: null }) }) };
    },
  });

  // loadUserData must not present the unreadable row as an empty fresh
  // profile - that is indistinguishable from having actually lost it, and
  // it is exactly the state that would then get autosaved back over the
  // real row.
  const loader = createSupabaseDataAdapter({ client: clientFor({ progress: futureProgress, settings: {} }), storage: memoryStorage() });
  await assert.rejects(loader.loadUserData(), (error) => error.code === "PROGRESS_TOO_NEW");

  // saveUserData must refuse outright - the row survives untouched. The
  // stubbed upsert throws if it is ever called, so a passing test proves no
  // write was attempted at all, not just that the written value was
  // acceptable.
  const saver = createSupabaseDataAdapter({ client: clientFor({ progress: futureProgress, settings: {} }), storage: memoryStorage() });
  await assert.rejects(saver.saveUserData({}), (error) => error.code === "PROGRESS_TOO_NEW");

  // Even an unrelated update (settings only, no progress touched by the
  // caller) must be refused too: saveUserData would otherwise normalize the
  // untouched existing progress down to fresh as a side effect of writing
  // the settings change.
  const settingsSaver = createSupabaseDataAdapter({ client: clientFor({ progress: futureProgress, settings: {} }), storage: memoryStorage() });
  await assert.rejects(settingsSaver.saveUserData({ settings: { theme: "light" } }), (error) => error.code === "PROGRESS_TOO_NEW");
});

test("a save with no existing row, or an existing row this build understands, still writes normally", async () => {
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const writes = [];
  const clientFor = (existingSave) => ({
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table === "user_saves") return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: existingSave, error: null }) }) }),
        upsert: (row) => { writes.push(row); return { select: () => ({ single: async () => ({ data: row, error: null }) }) }; },
      };
      if (table === "profiles") return profileQuery();
      if (table === "user_preferences") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) };
      return { select: () => ({ eq: () => thenable({ data: [], error: null }) }) };
    },
  });
  const readable = createSupabaseDataAdapter({ client: clientFor({ progress: { version: 2, xp: 12, unlocked: 1, courts: {}, records: {}, sound: true, tactic: "balanced", difficulty: "standard", lastCourt: 0 }, settings: {} }), storage: memoryStorage() });
  await readable.saveUserData({ settings: { theme: "light" } });
  assert.equal(writes[0].progress.xp, 12, "a version this build understands must be preserved, not reset");
});

test("register() reports an existing account with a message pointing at Discord, not a generic 'already registered'", async () => {
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signUp: async () => ({ data: null, error: { message: "User already registered" } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  await assert.rejects(
    adapter.register({ email: "existing@example.com", username: "player", password: "password-1" }),
    (error) => error.code === "ACCOUNT_EXISTS" && /Discord/.test(error.message),
  );
});

test("login() reports invalid credentials with a message pointing at Discord for a password-less OAuth-only account", async () => {
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithPassword: async () => ({ data: null, error: { message: "Invalid login credentials" } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  await assert.rejects(
    adapter.login({ identifier: "existing@example.com", password: "wrong" }),
    (error) => error.code === "LOGIN_FAILED" && /Discord/.test(error.message),
  );
});

test("signInWithDiscord calls signInWithOAuth with the discord provider and forwards options", async () => {
  let call;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      signInWithOAuth: async (input) => { call = input; return { data: { provider: "discord", url: "https://discord.example/authorize" }, error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const result = await adapter.signInWithDiscord({ redirectTo: "https://game.example/" });
  assert.deepEqual(call, { provider: "discord", options: { redirectTo: "https://game.example/" } });
  assert.equal(result.url, "https://discord.example/authorize");
  await assert.rejects(
    createSupabaseDataAdapter({
      client: { auth: { ...client.auth, signInWithOAuth: async () => ({ data: null, error: { message: "provider disabled" } }) } },
      storage: memoryStorage(),
    }).signInWithDiscord({}),
    (error) => error.code === "STORAGE_ERROR",
  );
});

test("a signed-in user with no profiles row is reported as needing a username, with a sanitized Discord-derived suggestion", async () => {
  const user = {
    id: "user-1",
    email: "player@example.com",
    user_metadata: { global_name: "Söme Discord Name!! 123" },
  };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: () => profileQuery({ data: null, error: null }),
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const session = await adapter.getSession();
  assert.equal(session.profile, null);
  assert.equal(session.needsUsername, true);
  assert.equal(session.user.id, "user-1");
  assert.match(session.user.suggestedUsername, /^[A-Za-z0-9_.-]{2,24}$/);
});

test("a signed-in user with an existing profiles row is not asked for a username", async () => {
  const user = { id: "user-1", email: "player@example.com", user_metadata: {} };
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: () => profileQuery({ data: { id: "user-1", username: "ReturningPlayer" }, error: null }),
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const session = await adapter.getSession();
  assert.equal(session.needsUsername, undefined);
  assert.equal(session.profile.username, "ReturningPlayer");
});

test("completeProfile inserts the chosen username and rejects an invalid or already-taken one", async () => {
  const user = { id: "user-1", email: "player@example.com", user_metadata: {} };
  let inserted;
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: (table) => {
      if (table !== "profiles") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row) => {
          inserted = row;
          return {
            select: () => ({
              single: async () =>
                row.username === "Taken"
                  ? { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "profiles_username_case_insensitive_key"' } }
                  : { data: row, error: null },
            }),
          };
        },
      };
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const profile = await adapter.completeProfile({ username: "NewPlayer" });
  assert.deepEqual(inserted, { id: "user-1", username: "NewPlayer" });
  assert.equal(profile.username, "NewPlayer");
  await assert.rejects(adapter.completeProfile({ username: "a" }), (error) => error.code === "VALIDATION_ERROR");
  await assert.rejects(adapter.completeProfile({ username: "Taken" }), (error) => error.code === "USERNAME_TAKEN");
});

test("onAuthStateChange reports needsUsername for a session with no profile row", async () => {
  const user = { id: "user-2", email: "new@example.com", user_metadata: {} };
  let handler;
  const client = {
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: (fn) => { handler = fn; return { data: { subscription: { unsubscribe() {} } } }; },
    },
    from: () => profileQuery({ data: null, error: null }),
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const seen = [];
  adapter.onAuthStateChange((session) => seen.push(session));
  handler("SIGNED_IN", { user });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(seen[0].needsUsername, true);
  assert.equal(seen[0].user.id, "user-2");
});
