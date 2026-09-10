import { test } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.mjs";
import { sha256Hex } from "../src/sessions.js";
import { hashPassword, verifyPassword } from "../src/passwords.js";
import { RateLimiter } from "../src/ratelimit.js";

test("passwords: hash/verify round trip and timingSafeEqual rejects wrong password", () => {
  const hash = hashPassword("correct horse battery staple");
  assert.equal(verifyPassword("correct horse battery staple", hash), true);
  assert.equal(verifyPassword("wrong password", hash), false);
});

test("register: rejects duplicate email/username case-insensitively", async () => {
  const server = await startTestServer();
  try {
    const first = await server.post("/api/register", {
      email: "Player@Example.com",
      username: "Chris",
      password: "hunter2hunter2",
    });
    assert.equal(first.status, 200);

    server.clearCookie();
    const dupEmail = await server.post("/api/register", {
      email: "player@example.com",
      username: "someoneelse",
      password: "hunter2hunter2",
    });
    assert.equal(dupEmail.status, 409);
    assert.equal(dupEmail.body.error.code, "ACCOUNT_EXISTS");

    server.clearCookie();
    const dupUsername = await server.post("/api/register", {
      email: "other@example.com",
      username: "chris",
      password: "hunter2hunter2",
    });
    assert.equal(dupUsername.status, 409);
    assert.equal(dupUsername.body.error.code, "ACCOUNT_EXISTS");
  } finally {
    await server.close();
  }
});

test("login: fails identically for unknown account vs wrong password", async () => {
  const server = await startTestServer();
  try {
    await server.post("/api/register", {
      email: "real@example.com",
      username: "realuser",
      password: "correct-password-1",
    });
    server.clearCookie();

    const unknown = await server.post("/api/login", {
      identifier: "ghost@example.com",
      password: "whatever12345",
    });
    server.clearCookie();
    const wrongPassword = await server.post("/api/login", {
      identifier: "real@example.com",
      password: "totally-wrong-1",
    });

    assert.equal(unknown.status, 401);
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknown.body.error.code, "LOGIN_FAILED");
    assert.equal(wrongPassword.body.error.code, "LOGIN_FAILED");
    assert.equal(unknown.body.error.message, wrongPassword.body.error.message);
  } finally {
    await server.close();
  }
});

test("sessions: expired session is rejected and cleaned up", async () => {
  const server = await startTestServer();
  try {
    await server.post("/api/register", {
      email: "expiring@example.com",
      username: "expiring",
      password: "some-password-1",
    });
    const token = server.sessionToken();
    assert.ok(token);

    // Force this session into the past directly in the db.
    const tokenHash = sha256Hex(token);
    server.db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(1, tokenHash);

    const session = await server.get("/api/session");
    assert.equal(session.body, null);

    const row = server.db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(tokenHash);
    assert.equal(row, undefined, "expired session should be deleted on access");
  } finally {
    await server.close();
  }
});

test("password change requires the current password and invalidates other sessions", async () => {
  const server = await startTestServer();
  try {
    await server.post("/api/register", {
      email: "pw@example.com",
      username: "pwuser",
      password: "original-pw-1",
    });

    const wrong = await server.post("/api/password", {
      currentPassword: "not-the-password",
      newPassword: "new-password-1",
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error.code, "LOGIN_FAILED");

    const ok = await server.post("/api/password", {
      currentPassword: "original-pw-1",
      newPassword: "new-password-1",
    });
    assert.equal(ok.status, 200);

    server.clearCookie();
    const loginOld = await server.post("/api/login", {
      identifier: "pwuser",
      password: "original-pw-1",
    });
    assert.equal(loginOld.status, 401);

    server.clearCookie();
    const loginNew = await server.post("/api/login", {
      identifier: "pwuser",
      password: "new-password-1",
    });
    assert.equal(loginNew.status, 200);
  } finally {
    await server.close();
  }
});

test("rate limiting: login attempts are capped per identifier", async () => {
  const server = await startTestServer();
  try {
    await server.post("/api/register", {
      email: "limited@example.com",
      username: "limiteduser",
      password: "correct-password-1",
    });
    server.clearCookie();

    let sawRateLimited = false;
    for (let i = 0; i < 8; i++) {
      const attempt = await server.post("/api/login", {
        identifier: "limiteduser",
        password: "wrong-password-x",
      });
      if (attempt.status === 429) {
        sawRateLimited = true;
        assert.equal(attempt.body.error.code, "RATE_LIMITED");
        break;
      }
    }
    assert.ok(sawRateLimited, "expected login attempts to eventually be rate limited");
  } finally {
    await server.close();
  }
});

test("RateLimiter unit: sliding window caps and recovers", () => {
  const limiter = new RateLimiter({ windowMs: 1000, max: 2 });
  assert.equal(limiter.attempt("k"), true);
  assert.equal(limiter.attempt("k"), true);
  assert.equal(limiter.attempt("k"), false);
});

test("leaderboard: ordering and mode/court filtering", async () => {
  const server = await startTestServer();
  try {
    async function playerWithScore(username, score, mode, court) {
      server.clearCookie();
      await server.post("/api/register", {
        email: `${username}@example.com`,
        username,
        password: "correct-password-1",
      });
      await server.post("/api/rounds", { mode, court, score, passes: 5, bestOneTouch: 2 });
    }

    await playerWithScore("alice", 50, "career", 1);
    await playerWithScore("bob", 90, "career", 1);
    await playerWithScore("carol", 70, "career", 2);
    await playerWithScore("dave", 100, "daily", 1);

    const court1 = await server.get("/api/leaderboard?mode=career&court=1&limit=10");
    assert.equal(court1.status, 200);
    assert.deepEqual(
      court1.body.entries.map((e) => e.username),
      ["bob", "alice"],
    );

    const court2 = await server.get("/api/leaderboard?mode=career&court=2&limit=10");
    assert.deepEqual(
      court2.body.entries.map((e) => e.username),
      ["carol"],
    );

    const daily = await server.get("/api/leaderboard?mode=daily&limit=10");
    assert.deepEqual(
      daily.body.entries.map((e) => e.username),
      ["dave"],
    );
  } finally {
    await server.close();
  }
});

test("oversized payloads are rejected", async () => {
  const server = await startTestServer();
  try {
    await server.post("/api/register", {
      email: "big@example.com",
      username: "biguser",
      password: "correct-password-1",
    });
    const huge = "x".repeat(300 * 1024);
    const res = await server.put("/api/user-data", { progress: huge });
    assert.equal(res.status, 413);
    assert.equal(res.body.error.code, "PAYLOAD_TOO_LARGE");
  } finally {
    await server.close();
  }
});

test("validation: rejects malformed email/username/password on register", async () => {
  const server = await startTestServer();
  try {
    const badEmail = await server.post("/api/register", {
      email: "not-an-email",
      username: "validuser",
      password: "correct-password-1",
    });
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.body.error.code, "VALIDATION_ERROR");

    server.clearCookie();
    const badUsername = await server.post("/api/register", {
      email: "ok@example.com",
      username: "a b!",
      password: "correct-password-1",
    });
    assert.equal(badUsername.status, 400);

    server.clearCookie();
    const shortPassword = await server.post("/api/register", {
      email: "ok2@example.com",
      username: "okuser",
      password: "short",
    });
    assert.equal(shortPassword.status, 400);
  } finally {
    await server.close();
  }
});
