import { randomBytes, createHash } from "node:crypto";

export const SESSION_COOKIE = "tt_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

// Returns { token, tokenHash } — `token` is what the client gets (in the
// cookie), `tokenHash` is what we persist. The raw token is never stored.
export function newSessionToken() {
  const token = randomBytes(32).toString("hex");
  return { token, tokenHash: sha256Hex(token) };
}

export function buildSessionCookie(token, { secure, maxAgeMs = SESSION_TTL_MS } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function expiredSessionCookie({ secure } = {}) {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}
