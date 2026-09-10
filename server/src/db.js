import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_data (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  mode TEXT NOT NULL,
  court INTEGER,
  score INTEGER NOT NULL,
  passes INTEGER NOT NULL,
  best_one_touch INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_board ON scores(mode, court, score DESC);
`;

// Opens (creating if needed) the sqlite database at `path` and applies the
// schema and pragmas the server depends on. `:memory:` is accepted as-is for
// tests, which never touch the filesystem.
export function openDatabase(path) {
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
