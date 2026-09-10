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

test("guest progress persists under one fixed storage key", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage });
  assert.equal(adapter.kind, "guest");
  const guest = await adapter.loadUserData();
  guest.progress.xp = 7;
  await adapter.saveUserData(guest);
  assert.equal((await adapter.loadUserData()).progress.xp, 7);
  assert.ok(storage.getItem(LOCAL_DATA_KEYS.guest));

  // A second adapter instance over the same storage sees the same save —
  // there is only ever one guest scope, no per-account isolation.
  const second = createLocalDataAdapter({ storage });
  assert.equal((await second.loadUserData()).progress.xp, 7);
});

test("guest imports legacy progress and settings on first load", async () => {
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
});

test("round stats aggregate and malformed values normalize", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage });
  storage.setItem(LOCAL_DATA_KEYS.guest, "null");
  assert.equal((await adapter.loadUserData()).stats.games, 0);
  storage.setItem(
    LOCAL_DATA_KEYS.guest,
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

test("concurrent round writes against the same guest scope are lossless", async () => {
  const storage = memoryStorage();
  const adapter = createLocalDataAdapter({ storage });
  const writes = Array.from({ length: 20 }, (_, index) =>
    adapter.recordRound({ score: index, passes: 2, bestOneTouch: index }),
  );
  await Promise.all(writes);

  assert.deepEqual(JSON.parse(storage.getItem(LOCAL_DATA_KEYS.guest)).stats, {
    games: 20,
    bestScore: 19,
    totalPasses: 40,
    bestOneTouch: 19,
  });
});

test("corrupt JSON recovers as guest defaults", async () => {
  const storage = memoryStorage({
    [LOCAL_DATA_KEYS.guest]: "{not json",
    "tiki-taka.progress.v1": "also broken",
    "tiki-taka.settings.v1": "also broken",
  });
  const adapter = createLocalDataAdapter({ storage });
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
  await expectCode(unreadable.loadUserData(), "STORAGE_ERROR");

  const unwritable = createLocalDataAdapter({
    storage: {
      getItem: () => null,
      setItem() {
        throw new Error("full");
      },
      removeItem() {},
    },
  });
  await expectCode(unwritable.saveUserData({ progress: { version: 1, xp: 1 } }), "STORAGE_ERROR");
});
