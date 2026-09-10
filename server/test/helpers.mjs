import { createServer } from "node:http";
import { openDatabase } from "../src/db.js";
import { createStore } from "../src/store.js";
import { createApp } from "../src/app.js";

// Spins up a fresh in-memory-db server on a random port for one test.
// Returns a `client` helper that keeps a cookie jar (like a browser tab)
// across calls, plus `close()` to tear everything down.
export async function startTestServer({ isSecure = () => false } = {}) {
  const db = openDatabase(":memory:");
  const store = createStore(db);
  const app = createApp({ store, allowedOrigins: ["*"], isSecure });
  const server = createServer((req, res) => void app.handle(req, res));
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  let cookie = null;
  async function request(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let json = null;
    const text = await res.text();
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: res.status, body: json, res };
  }

  return {
    store,
    db,
    base,
    clearCookie: () => (cookie = null),
    sessionToken: () => (cookie ? cookie.split("=")[1] : null),
    get: (path) => request("GET", path),
    post: (path, body) => request("POST", path, body ?? {}),
    put: (path, body) => request("PUT", path, body ?? {}),
    close: () => {
      app.stop();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
