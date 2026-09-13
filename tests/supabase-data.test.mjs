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

test("Supabase adapter's leaderboard selects and maps the bonus-counter columns", async () => {
  let selected;
  const client = {
    auth: { getSession: async () => ({ data: { session: null }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from(table) {
      if (table !== "leaderboard_entries") throw new Error(`unexpected table ${table}`);
      const query = {
        select: (columns) => { selected = columns; return query; },
        eq: () => query,
        order: () => query,
        limit: async () => ({
          data: [{ username: "player", score: 10, passes: 3, best_one_touch: 2, triangles: 1, oles: 2, splits: 3, zones: 4, created_at: "now" }],
          error: null,
        }),
      };
      return query;
    },
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const board = await adapter.getLeaderboard({ mode: "career" });
  assert.match(selected, /\btriangles\b/);
  assert.match(selected, /\boles\b/);
  assert.match(selected, /\bsplits\b/);
  assert.match(selected, /\bzones\b/);
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
  const filters = [];
  const user = { id: "user-1", email: "player@example.com", user_metadata: { username: "player" } };
  const row = { username: "player", mode: "career", court: 0, score: 900, passes: 12, best_one_touch: 4, difficulty: "ruthless", created_at: "2026-09-11T00:00:00Z" };
  function queryFor(rows) {
    const query = {
      eq(field, value) { filters.push([field, value]); return query; },
      order() { return query; },
      limit: async () => ({ data: rows, error: null }),
    };
    return query;
  }
  const client = {
    auth: { getSession: async () => ({ data: { session: { user } }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }) },
    from: (table) => table === "leaderboard_entries" ? { select: () => queryFor([row]) } : (() => { throw new Error(`unexpected table ${table}`); })(),
  };
  const adapter = createSupabaseDataAdapter({ client, storage: memoryStorage() });
  const result = await adapter.getLeaderboard({ mode: "career", court: 0, difficulty: "ruthless" });
  assert.deepEqual(filters, [["mode", "career"], ["court", 0], ["difficulty", "ruthless"]]);
  assert.equal(result.difficulty, "ruthless");
  assert.deepEqual(result.entries[0], { username: "player", score: 900, passes: 12, bestOneTouch: 4, triangles: 0, oles: 0, splits: 0, zones: 0, difficulty: "ruthless", createdAt: "2026-09-11T00:00:00Z" });
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
