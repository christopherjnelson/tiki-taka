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
  await adapter.recordRound({ id: "f2402978-1b50-4b8c-9dca-65b82ba2c8a3", score: 12, passes: 3, bestOneTouch: 2 });
  assert.equal(writes[0].row.id, "f2402978-1b50-4b8c-9dca-65b82ba2c8a3");
  assert.deepEqual(writes[0].options, { onConflict: "id", ignoreDuplicates: true });
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
