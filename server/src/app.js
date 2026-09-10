import {
  cleanEmail,
  cleanUsername,
  cleanPassword,
  cleanIdentifier,
  cleanMode,
  cleanCourt,
  cleanScoreInt,
  cleanLimit,
  ValidationError,
  MAX_USER_DATA_BYTES,
} from "./validate.js";
import { publicProfile, ConflictError } from "./store.js";
import {
  SESSION_COOKIE,
  buildSessionCookie,
  expiredSessionCookie,
  parseCookies,
} from "./sessions.js";
import {
  RateLimiter,
  LOGIN_IP_LIMIT,
  LOGIN_IDENTIFIER_LIMIT,
  REGISTER_IP_LIMIT,
  PASSWORD_CHANGE_LIMIT,
} from "./ratelimit.js";

const MAX_BODY_BYTES = 256 * 1024; // hard cap on any request body we will buffer

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    ...extraHeaders,
  });
  res.end(data);
}

// Reads a request body up to MAX_BODY_BYTES. Rather than destroying the
// socket the instant the cap is crossed (which races the client's own send
// and surfaces as an ECONNRESET instead of a clean 413), we keep draining
// the stream — without retaining the extra bytes — until it ends, then
// reject. The connection closes normally once the 413 response is sent.
function drainAndReject(req, reject, error) {
  req.on("data", () => {});
  req.on("end", () => reject(error));
  req.on("error", () => reject(error));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] || 0);
    const tooLarge = new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
    if (declared > MAX_BODY_BYTES) {
      drainAndReject(req, reject, tooLarge);
      return;
    }
    let size = 0;
    let overflowed = false;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflowed = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (overflowed) {
        reject(tooLarge);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", () => reject(new ApiError(400, "VALIDATION_ERROR", "Could not read request body.")));
  });
}

async function readBody(req) {
  const raw = await readRawBody(req);
  if (raw.length === 0) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ApiError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
  }
}

function clientIp(req) {
  // No trust-proxy chain configured (single Node process behind nginx as a
  // plain reverse proxy) — X-Forwarded-For is honored only for the one-hop
  // case, which matches the deployment documented in server/README.md.
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

export function createApp({ store, allowedOrigins = [], isSecure = () => true, now = () => Date.now() } = {}) {
  const loginIpLimiter = new RateLimiter(LOGIN_IP_LIMIT);
  const loginIdLimiter = new RateLimiter(LOGIN_IDENTIFIER_LIMIT);
  const registerIpLimiter = new RateLimiter(REGISTER_IP_LIMIT);
  const passwordLimiter = new RateLimiter(PASSWORD_CHANGE_LIMIT);
  const sweepTimer = setInterval(() => {
    loginIpLimiter.sweep();
    loginIdLimiter.sweep();
    registerIpLimiter.sweep();
    passwordLimiter.sweep();
    store.sweepExpiredSessions();
  }, 10 * 60 * 1000);
  sweepTimer.unref?.();

  function corsHeaders(req) {
    const origin = req.headers.origin;
    if (!origin) return {};
    if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        Vary: "Origin",
      };
    }
    return { Vary: "Origin" };
  }

  function sessionFromRequest(req) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) return { token: null, user: null };
    return { token, user: store.resolveSession(token) };
  }

  function withSessionCookie(req, res, token) {
    res.setHeader("Set-Cookie", buildSessionCookie(token, { secure: isSecure(req) }));
  }

  async function handle(req, res) {
    const headers = corsHeaders(req);
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, "http://internal");
    const path = url.pathname;

    try {
      if (path === "/api/register" && req.method === "POST") {
        const ip = clientIp(req);
        if (!registerIpLimiter.attempt(ip))
          throw new ApiError(429, "RATE_LIMITED", "Too many registrations from this address. Try again later.");
        const body = await readBody(req);
        const email = cleanEmail(body.email);
        const username = cleanUsername(body.username);
        const password = cleanPassword(body.password);
        let user;
        try {
          user = store.register({ email, username, password });
        } catch (error) {
          if (error instanceof ConflictError)
            throw new ApiError(409, "ACCOUNT_EXISTS", "An account with that email or username already exists.");
          throw error;
        }
        const token = store.createSession(user.id);
        withSessionCookie(req, res, token);
        sendJson(res, 200, publicProfile(user));
        return;
      }

      if (path === "/api/login" && req.method === "POST") {
        const ip = clientIp(req);
        const body = await readBody(req);
        const identifier = cleanIdentifier(body.identifier);
        const idKey = identifier.toLowerCase();
        const ipOk = loginIpLimiter.attempt(ip);
        const idOk = loginIdLimiter.attempt(idKey);
        if (!ipOk || !idOk)
          throw new ApiError(429, "RATE_LIMITED", "Too many login attempts. Try again later.");
        const password = String(body.password ?? "");
        const user = store.verifyLogin(identifier, password);
        if (!user) throw new ApiError(401, "LOGIN_FAILED", "That email/username or password is incorrect.");
        const token = store.createSession(user.id);
        withSessionCookie(req, res, token);
        sendJson(res, 200, publicProfile(user));
        return;
      }

      if (path === "/api/logout" && req.method === "POST") {
        const { token } = sessionFromRequest(req);
        if (token) store.destroySession(token);
        res.setHeader("Set-Cookie", expiredSessionCookie({ secure: isSecure(req) }));
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/api/session" && req.method === "GET") {
        const { user } = sessionFromRequest(req);
        sendJson(res, 200, user ? { profile: publicProfile(user) } : null);
        return;
      }

      if (path === "/api/profile" && req.method === "GET") {
        const { user } = sessionFromRequest(req);
        sendJson(res, 200, user ? publicProfile(user) : null);
        return;
      }

      if (path === "/api/password" && req.method === "POST") {
        const { user } = sessionFromRequest(req);
        if (!user) throw new ApiError(401, "UNAUTHORIZED", "Sign in to change your password.");
        if (!passwordLimiter.attempt(user.id))
          throw new ApiError(429, "RATE_LIMITED", "Too many attempts. Try again later.");
        const body = await readBody(req);
        const currentPassword = String(body.currentPassword ?? "");
        const newPassword = cleanPassword(body.newPassword);
        const ok = store.changePassword(user.id, currentPassword, newPassword);
        if (!ok) throw new ApiError(401, "LOGIN_FAILED", "Current password is incorrect.");
        const token = store.createSession(user.id);
        withSessionCookie(req, res, token);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (path === "/api/user-data" && req.method === "GET") {
        const { user } = sessionFromRequest(req);
        if (!user) throw new ApiError(401, "UNAUTHORIZED", "Sign in to load your data.");
        sendJson(res, 200, store.loadUserData(user.id));
        return;
      }

      if (path === "/api/user-data" && req.method === "PUT") {
        const { user } = sessionFromRequest(req);
        if (!user) throw new ApiError(401, "UNAUTHORIZED", "Sign in to save your data.");
        const raw = await readRawBody(req);
        if (raw.length > MAX_USER_DATA_BYTES)
          throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Saved data is too large.");
        let body;
        try {
          body = JSON.parse(raw.toString("utf8") || "{}");
        } catch {
          throw new ApiError(400, "VALIDATION_ERROR", "Request body must be valid JSON.");
        }
        const saved = store.saveUserData(user.id, {
          progress: body.progress ?? null,
          settings: body.settings ?? null,
          stats: body.stats ?? null,
        });
        sendJson(res, 200, saved);
        return;
      }

      if (path === "/api/rounds" && req.method === "POST") {
        const { user } = sessionFromRequest(req);
        if (!user) throw new ApiError(401, "UNAUTHORIZED", "Sign in to record a round.");
        const body = await readBody(req);
        const round = {
          mode: cleanMode(body.mode),
          court: cleanCourt(body.court),
          score: cleanScoreInt(body.score, "score"),
          passes: cleanScoreInt(body.passes, "passes"),
          bestOneTouch: cleanScoreInt(body.bestOneTouch, "bestOneTouch"),
        };
        const stats = store.recordRound(user.id, round);
        sendJson(res, 200, stats);
        return;
      }

      if (path === "/api/leaderboard" && req.method === "GET") {
        const mode = cleanMode(url.searchParams.get("mode") || "career");
        const court = cleanCourt(url.searchParams.get("court"));
        const limit = cleanLimit(url.searchParams.get("limit"), 10, 100);
        const rows = store.leaderboard({ mode, court, limit });
        sendJson(res, 200, { mode, court, entries: rows });
        return;
      }

      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, 400, { error: { code: "VALIDATION_ERROR", message: error.message } });
        return;
      }
      if (error instanceof ApiError) {
        sendJson(res, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      // eslint-disable-next-line no-console
      console.error(error);
      sendJson(res, 500, { error: { code: "STORAGE_ERROR", message: "Something went wrong." } });
    }
  }

  return { handle, stop: () => clearInterval(sweepTimer) };
}
