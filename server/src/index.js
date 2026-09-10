import { createServer } from "node:http";
import { openDatabase } from "./db.js";
import { createStore } from "./store.js";
import { createApp } from "./app.js";

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || "./data/tiki-taka.sqlite";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const db = openDatabase(DB_PATH);
const store = createStore(db);

// Secure cookies are required off localhost; nginx terminates TLS in front
// of this process in production (see server/README.md), so we trust the
// Host header here rather than checking req.socket.encrypted.
function isSecure(req) {
  const host = (req.headers.host || "").split(":")[0];
  return host !== "localhost" && host !== "127.0.0.1" && host !== "::1";
}

const app = createApp({ store, allowedOrigins: ALLOWED_ORIGINS, isSecure });

const server = createServer((req, res) => {
  void app.handle(req, res);
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`tiki-taka accounts server listening on :${PORT} (db: ${DB_PATH})`);
});

function shutdown() {
  app.stop();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
