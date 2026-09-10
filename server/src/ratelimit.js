// A small in-memory sliding-window rate limiter. Good enough for a single
// Node process fronting a small VPS deployment; not shared across processes.
//
// Chosen limits:
//   - login:    10 attempts per IP per 5 minutes, and 5 attempts per
//               identifier (email/username, lowercased) per 5 minutes —
//               stops both a distributed guess against one account and a
//               single IP hammering many accounts.
//   - register: 5 accounts per IP per hour.
//   - password change: 10 attempts per user per hour.
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map(); // key -> array of timestamps
  }

  // Returns true if the action is allowed (and records the attempt).
  attempt(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    let hits = this.hits.get(key);
    if (!hits) {
      hits = [];
      this.hits.set(key, hits);
    }
    while (hits.length && hits[0] < cutoff) hits.shift();
    if (hits.length >= this.max) return false;
    hits.push(now);
    return true;
  }

  // Periodic cleanup so the map doesn't grow unboundedly with one-shot IPs.
  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, hits] of this.hits) {
      while (hits.length && hits[0] < cutoff) hits.shift();
      if (hits.length === 0) this.hits.delete(key);
    }
  }
}

export const LOGIN_IP_LIMIT = { windowMs: 5 * 60 * 1000, max: 10 };
export const LOGIN_IDENTIFIER_LIMIT = { windowMs: 5 * 60 * 1000, max: 5 };
export const REGISTER_IP_LIMIT = { windowMs: 60 * 60 * 1000, max: 5 };
export const PASSWORD_CHANGE_LIMIT = { windowMs: 60 * 60 * 1000, max: 10 };
