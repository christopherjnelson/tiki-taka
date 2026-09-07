import assert from "node:assert/strict";
import test from "node:test";

import {
  createLocalDataAdapter,
  LOCAL_DATA_KEYS,
} from "../packages/data/src/index.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    dump: () => Object.fromEntries(values),
  };
}

async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code);
}

test("passwordless demo profiles persist and isolate two users and the guest", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage, crypto: {} });
  const guest = await adapter.loadUserData();
  guest.progress.xp = 7;
  await adapter.saveUserData(guest);

  const ada = await adapter.register({ email: "ADA@example.com", username: "Ada" });
  assert.equal(ada.authMode, "local-demo");
  assert.equal((await adapter.getSession()).profile.email, "ada@example.com");
  await adapter.saveUserData({ progress: { version: 1, xp: 12 } });
  await adapter.logout();

  const grace = await adapter.register({ email: "grace@example.com", username: "Grace" });
  assert.notEqual(grace.id, ada.id);
  assert.equal((await adapter.loadUserData()).progress.xp, 0);
  await adapter.saveUserData({ progress: { version: 1, xp: 33 } });
  await adapter.logout();

  assert.equal((await adapter.loadUserData()).progress.xp, 7);
  await adapter.login({ identifier: "ADA" });
  assert.equal((await adapter.loadUserData()).progress.xp, 12);
  await adapter.login({ identifier: "grace@example.com" });
  assert.equal((await adapter.loadUserData()).progress.xp, 33);
  assert.equal((await adapter.getProfile()).username, "Grace");
  assert.ok(storage.getItem(LOCAL_DATA_KEYS.user(ada.id)));
});

test("demo auth validates duplicates and refuses passwords", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage });
  await expectCode(adapter.register({ email: "bad", username: "a" }), "VALIDATION_ERROR");
  await adapter.register({ email: "one@example.com", username: "One" });
  await expectCode(
    adapter.register({ email: "ONE@example.com", username: "Other" }),
    "ACCOUNT_EXISTS",
  );
  await expectCode(adapter.login({ identifier: "missing" }), "LOGIN_FAILED");
  await expectCode(
    adapter.login({ identifier: "One", password: "secret" }),
    "PASSWORD_NOT_SUPPORTED",
  );
  assert.doesNotMatch(JSON.stringify(storage.dump()), /secret|password|verifier|salt/i);
});

test("guest imports legacy progress and settings without assigning them to a new profile", async () => {
  const storage = memoryStorage({
    "tiki-taka.progress.v1": JSON.stringify({ version: 1, xp: 91, unlocked: 2 }),
    "tiki-taka.settings.v1": JSON.stringify({ theme: "light", playView: true }),
  });
  const adapter = createLocalDataAdapter({ storage });
  const guest = await adapter.loadUserData();
  assert.equal(guest.progress.xp, 91);
  assert.equal(guest.settings.theme, "light");
  assert.equal(guest.settings.playView, true);
  assert.ok(storage.getItem(LOCAL_DATA_KEYS.guest));

  await adapter.register({ email: "new@example.com", username: "New player" });
  const user = await adapter.loadUserData();
  assert.equal(user.progress.xp, 0);
  assert.equal(user.settings.theme, "dark");
});

test("round stats aggregate and malformed values normalize", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage });
  const profile = await adapter.register({ email: "stats@example.com", username: "Stats" });
  storage.setItem(LOCAL_DATA_KEYS.user(profile.id), "null");
  assert.equal((await adapter.loadUserData()).stats.games, 0);
  storage.setItem(
    LOCAL_DATA_KEYS.user(profile.id),
    JSON.stringify({
      progress: { version: 1, xp: -4, unlocked: 999 },
      settings: { theme: "purple", bindings: {} },
      stats: { games: -2, bestScore: "bad", totalPasses: 3.9, bestOneTouch: 4.8 },
    }),
  );
  const normalized = await adapter.loadUserData();
  assert.equal(normalized.progress.xp, 0);
  assert.equal(normalized.settings.theme, "dark");
  assert.deepEqual(normalized.stats, {
    games: 0,
    bestScore: 0,
    totalPasses: 3,
    bestOneTouch: 4,
  });
  await adapter.recordRound({ score: 120, passes: 17, bestOneTouch: 8 });
  const stats = await adapter.recordRound({ score: 80, passes: 9, bestOneTouch: 3 });
  assert.deepEqual(stats, {
    games: 2,
    bestScore: 120,
    totalPasses: 29,
    bestOneTouch: 8,
  });
});

test("concurrent round writes are lossless and stay in their captured account", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage });
  const first = await adapter.register({ email: "first@example.com", username: "First" });
  const writes = Array.from({ length: 20 }, (_, index) =>
    adapter.recordRound({ score: index, passes: 2, bestOneTouch: index }),
  );
  await adapter.logout();
  const second = await adapter.register({ email: "second@example.com", username: "Second" });
  await Promise.all(writes);

  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_DATA_KEYS.user(first.id))).stats, {
    games: 20,
    bestScore: 19,
    totalPasses: 40,
    bestOneTouch: 19,
  });
  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_DATA_KEYS.user(second.id))).stats, {
    games: 0,
    bestScore: 0,
    totalPasses: 0,
    bestOneTouch: 0,
  });
});

test("adapter instances keep their owner when another tab switches the global session", async () => {
  const storage = memoryStorage();
  const oldTab = createLocalDataAdapter({ storage });
  const first = await oldTab.register({ email: "tab-a@example.com", username: "Tab A" });
  await oldTab.saveUserData({ progress: { version: 1, xp: 10 } });

  const dormantTab = createLocalDataAdapter({ storage });
  const newTab = createLocalDataAdapter({ storage });
  assert.equal((await newTab.getProfile()).id, first.id);
  const second = await newTab.register({ email: "tab-b@example.com", username: "Tab B" });
  await newTab.saveUserData({ progress: { version: 1, xp: 20 } });

  assert.equal((await dormantTab.getProfile()).id, first.id);
  assert.equal((await oldTab.getProfile()).id, first.id);
  await oldTab.saveUserData({ progress: { version: 1, xp: 11 } });
  await oldTab.recordRound({ score: 75, passes: 6, bestOneTouch: 3 });
  await oldTab.logout();

  const reloadedTab = createLocalDataAdapter({ storage });
  assert.equal((await reloadedTab.getProfile()).id, second.id);
  assert.equal((await reloadedTab.loadUserData()).progress.xp, 20);
  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_DATA_KEYS.user(first.id))).stats, {
    games: 1,
    bestScore: 75,
    totalPasses: 6,
    bestOneTouch: 3,
  });
  assert.equal(JSON.parse(storage.getItem(LOCAL_DATA_KEYS.user(first.id))).progress.xp, 11);
  assert.equal(JSON.parse(storage.getItem(LOCAL_DATA_KEYS.session)).userId, second.id);
});

test("corrupt JSON and hostile account shapes recover as signed-out defaults", async () => {
  const storage = memoryStorage({
    [LOCAL_DATA_KEYS.accounts]:
      '{"__proto__":{"id":"__proto__","email":false,"username":null},"broken":null}',
    [LOCAL_DATA_KEYS.session]: JSON.stringify({ userId: "__proto__" }),
    [LOCAL_DATA_KEYS.guest]: "{not json",
    "tiki-taka.progress.v1": "also broken",
    "tiki-taka.settings.v1": "also broken",
  });
  const adapter = createLocalDataAdapter({ storage });
  assert.equal(await adapter.getSession(), null);
  const data = await adapter.loadUserData();
  assert.equal(data.progress.xp, 0);
  assert.equal(data.settings.theme, "dark");
  assert.equal(data.stats.games, 0);
});

test("storage failures are surfaced with stable errors", async () => {
  const unreadable = createLocalDataAdapter({
    storage: {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {},
      removeItem() {},
    },
  });
  await expectCode(unreadable.getSession(), "STORAGE_ERROR");

  const unwritable = createLocalDataAdapter({
    storage: {
      getItem: () => null,
      setItem() {
        throw new Error("full");
      },
      removeItem() {},
    },
  });
  await expectCode(unwritable.loadUserData(), "STORAGE_ERROR");
});
