import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";

import { createRemoteDataAdapter, createLocalDataAdapter } from "../packages/data/src/index.js";
import { openDatabase } from "../server/src/db.js";
import { createStore } from "../server/src/store.js";
import { createApp } from "../server/src/app.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

async function startServer() {
  const db = openDatabase(":memory:");
  const store = createStore(db);
  const app = createApp({ store, allowedOrigins: ["*"], isSecure: () => false });
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  return {
    apiBase: `http://127.0.0.1:${port}`,
    close: () => {
      app.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// node's global fetch does not persist cookies across calls the way a
// browser does, so this cookie-jar fetch stands in for the browser's
// automatic cookie handling that `credentials: "include"` relies on.
function cookieJarFetch() {
  let cookie = null;
  const wrapped = async (url, options = {}) => {
    const headers = new Headers(options.headers || {});
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(url, { ...options, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
  return wrapped;
}

test("remote adapter: register/login/logout round trip against a real server", async () => {
  const server = await startServer();
  try {
    const adapter = createRemoteDataAdapter({
      apiBase: server.apiBase,
      fetch: cookieJarFetch(),
      storage: memoryStorage(),
    });
    const profile = await adapter.register({
      email: "player@example.com",
      username: "player1",
      password: "correct-password-1",
    });
    assert.equal(profile.username, "player1");
    assert.equal(profile.authMode, "server");
    assert.equal((await adapter.getSession()).profile.username, "player1");

    await adapter.logout();
    assert.equal(await adapter.getSession(), null);

    const loggedIn = await adapter.login({ identifier: "player1", password: "correct-password-1" });
    assert.equal(loggedIn.id, profile.id);
  } finally {
    await server.close();
  }
});

test("remote adapter: register/login errors carry LocalDataError-shaped codes", async () => {
  const server = await startServer();
  try {
    const adapter = createRemoteDataAdapter({
      apiBase: server.apiBase,
      fetch: cookieJarFetch(),
      storage: memoryStorage(),
    });
    await adapter.register({
      email: "dupe@example.com",
      username: "dupeuser",
      password: "correct-password-1",
    });
    await assert.rejects(
      adapter.register({ email: "dupe@example.com", username: "other", password: "correct-password-1" }),
      (error) => error.name === "LocalDataError" && error.code === "ACCOUNT_EXISTS",
    );
    await assert.rejects(
      adapter.login({ identifier: "nobody", password: "whatever12345" }),
      (error) => error.name === "LocalDataError" && error.code === "LOGIN_FAILED",
    );
  } finally {
    await server.close();
  }
});

test("remote adapter: user data and rounds are scoped to the signed-in account", async () => {
  const server = await startServer();
  try {
    const adapter = createRemoteDataAdapter({
      apiBase: server.apiBase,
      fetch: cookieJarFetch(),
      storage: memoryStorage(),
    });
    await adapter.register({
      email: "scoped@example.com",
      username: "scopeduser",
      password: "correct-password-1",
    });
    await adapter.saveUserData({ progress: { version: 1, xp: 42 } });
    const stats = await adapter.recordRound({ mode: "career", court: 1, score: 99, passes: 5, bestOneTouch: 2 });
    assert.equal(stats.games, 1);
    assert.equal(stats.bestScore, 99);

    const data = await adapter.loadUserData();
    assert.equal(data.progress.xp, 42);
    assert.equal(data.stats.bestScore, 99);

    const board = await adapter.getLeaderboard({ mode: "career", court: 1 });
    assert.equal(board.entries[0].username, "scopeduser");
    assert.equal(board.entries[0].score, 99);
  } finally {
    await server.close();
  }
});

test("remote adapter: falls back to local guest storage when no session exists", async () => {
  const server = await startServer();
  try {
    const storage = memoryStorage();
    const adapter = createRemoteDataAdapter({ apiBase: server.apiBase, fetch: cookieJarFetch(), storage });
    const before = await adapter.loadUserData();
    assert.equal(before.stats.games, 0);
    await adapter.saveUserData({ progress: { version: 1, xp: 5 } });
    await adapter.recordRound({ score: 10, passes: 1, bestOneTouch: 1 });

    // Same shape a plain local adapter over the same storage would produce.
    const local = createLocalDataAdapter({ storage });
    const guestData = await local.loadUserData();
    assert.equal(guestData.progress.xp, 5);
    assert.equal(guestData.stats.games, 1);
  } finally {
    await server.close();
  }
});

test("remote adapter: unreachable server surfaces a STORAGE_ERROR LocalDataError", async () => {
  const adapter = createRemoteDataAdapter({
    apiBase: "http://127.0.0.1:1", // nothing listens here
    fetch: globalThis.fetch,
    storage: memoryStorage(),
  });
  await assert.rejects(
    adapter.getSession(),
    (error) => error.name === "LocalDataError" && error.code === "STORAGE_ERROR",
  );
});
