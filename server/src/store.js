import { randomUUID } from "node:crypto";
import { hashPassword, verifyPassword, DUMMY_HASH } from "./passwords.js";
import { newSessionToken, sha256Hex, SESSION_TTL_MS } from "./sessions.js";

export class ConflictError extends Error {}

const emptyUserData = () =>
  JSON.stringify({
    progress: null,
    settings: null,
    stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 },
  });

// Wraps a node:sqlite DatabaseSync with the operations the API needs.
// Deliberately thin: one method per request shape, no ORM.
export function createStore(db) {
  const stmt = (sql) => db.prepare(sql);

  const insertUser = stmt(
    "INSERT INTO users (id, email, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  const getUserByEmailOrUsername = stmt(
    "SELECT * FROM users WHERE email = ? COLLATE NOCASE OR username = ? COLLATE NOCASE",
  );
  const getUserById = stmt("SELECT * FROM users WHERE id = ?");
  const insertUserData = stmt(
    "INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)",
  );
  const updateUserData = stmt(
    "UPDATE user_data SET payload = ?, updated_at = ? WHERE user_id = ?",
  );
  const getUserData = stmt("SELECT payload FROM user_data WHERE user_id = ?");
  const updatePasswordHash = stmt("UPDATE users SET password_hash = ? WHERE id = ?");

  const insertSession = stmt(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  );
  const getSessionByHash = stmt("SELECT * FROM sessions WHERE token_hash = ?");
  const deleteSessionByHash = stmt("DELETE FROM sessions WHERE token_hash = ?");
  const deleteExpiredSessions = stmt("DELETE FROM sessions WHERE expires_at < ?");
  const deleteSessionsForUser = stmt("DELETE FROM sessions WHERE user_id = ?");

  const insertScore = stmt(
    "INSERT INTO scores (user_id, mode, court, score, passes, best_one_touch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const leaderboardByModeCourt = stmt(
    `SELECT scores.score, scores.passes, scores.best_one_touch, scores.created_at, users.username
     FROM scores JOIN users ON users.id = scores.user_id
     WHERE scores.mode = ? AND scores.court = ?
     ORDER BY scores.score DESC, scores.created_at ASC LIMIT ?`,
  );
  const leaderboardByMode = stmt(
    `SELECT scores.score, scores.passes, scores.best_one_touch, scores.created_at, users.username
     FROM scores JOIN users ON users.id = scores.user_id
     WHERE scores.mode = ?
     ORDER BY scores.score DESC, scores.created_at ASC LIMIT ?`,
  );

  function register({ email, username, password }) {
    const existing = getUserByEmailOrUsername.get(email, username);
    if (existing) throw new ConflictError("An account with that email or username already exists.");
    const id = randomUUID();
    const now = Date.now();
    insertUser.run(id, email, username, hashPassword(password), now);
    insertUserData.run(id, emptyUserData(), now);
    return getUserById.get(id);
  }

  // Returns the user row on success, or null on failure. Always runs a
  // scrypt hash (real or dummy) so unknown-account and wrong-password take
  // the same code path and roughly the same time — see auth.js callers.
  function verifyLogin(identifier, password) {
    const user = getUserByEmailOrUsername.get(identifier, identifier);
    const hash = user ? user.password_hash : DUMMY_HASH;
    const ok = verifyPassword(password, hash);
    if (!user || !ok) return null;
    return user;
  }

  function changePassword(userId, currentPassword, newPassword) {
    const user = getUserById.get(userId);
    if (!user) return false;
    if (!verifyPassword(currentPassword, user.password_hash)) return false;
    updatePasswordHash.run(hashPassword(newPassword), userId);
    // Invalidate other sessions so a stolen session can't ride out a
    // password change; the caller re-issues a fresh session for this one.
    deleteSessionsForUser.run(userId);
    return true;
  }

  function createSession(userId) {
    const { token, tokenHash } = newSessionToken();
    const now = Date.now();
    insertSession.run(tokenHash, userId, now, now + SESSION_TTL_MS);
    return token;
  }

  function resolveSession(token) {
    if (!token) return null;
    const tokenHash = sha256Hex(token);
    const session = getSessionByHash.get(tokenHash);
    if (!session) return null;
    if (session.expires_at < Date.now()) {
      deleteSessionByHash.run(tokenHash);
      return null;
    }
    const user = getUserById.get(session.user_id);
    if (!user) return null;
    return user;
  }

  function destroySession(token) {
    if (!token) return;
    deleteSessionByHash.run(sha256Hex(token));
  }

  function sweepExpiredSessions() {
    deleteExpiredSessions.run(Date.now());
  }

  function loadUserData(userId) {
    const row = getUserData.get(userId);
    return row ? JSON.parse(row.payload) : JSON.parse(emptyUserData());
  }

  function saveUserData(userId, data) {
    const payload = JSON.stringify(data);
    const now = Date.now();
    const result = updateUserData.run(payload, now, userId);
    if (result.changes === 0) insertUserData.run(userId, payload, now);
    return data;
  }

  function recordRound(userId, round) {
    const now = Date.now();
    insertScore.run(userId, round.mode, round.court, round.score, round.passes, round.bestOneTouch, now);
    const current = loadUserData(userId);
    const stats = current.stats || { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 };
    const nextStats = {
      games: stats.games + 1,
      bestScore: Math.max(stats.bestScore, round.score),
      totalPasses: stats.totalPasses + round.passes,
      bestOneTouch: Math.max(stats.bestOneTouch, round.bestOneTouch),
    };
    saveUserData(userId, { ...current, stats: nextStats });
    return nextStats;
  }

  function leaderboard({ mode, court, limit }) {
    const rows =
      court === null || court === undefined
        ? leaderboardByMode.all(mode, limit)
        : leaderboardByModeCourt.all(mode, court, limit);
    return rows.map((row) => ({
      username: row.username,
      score: row.score,
      passes: row.passes,
      bestOneTouch: row.best_one_touch,
      createdAt: row.created_at,
    }));
  }

  return {
    register,
    verifyLogin,
    changePassword,
    createSession,
    resolveSession,
    destroySession,
    sweepExpiredSessions,
    loadUserData,
    saveUserData,
    recordRound,
    leaderboard,
  };
}

export function publicProfile(user) {
  return { id: user.id, email: user.email, username: user.username, authMode: "server" };
}
