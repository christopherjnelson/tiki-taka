import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// Parameters chosen to be memory-hard but still fast enough for a login
// request on modest VPS hardware (well under 100ms). Stored alongside every
// hash so they can be tuned later without invalidating existing passwords.
const N = 32768;
const r = 8;
const p = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 32;

// Format: scrypt$N$r$p$saltHex$hashHex
export function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const paramN = Number(parts[1]);
  const paramR = Number(parts[2]);
  const paramP = Number(parts[3]);
  const salt = Buffer.from(parts[4], "hex");
  const expected = Buffer.from(parts[5], "hex");
  if (!Number.isFinite(paramN) || !Number.isFinite(paramR) || !Number.isFinite(paramP)) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  let derived;
  try {
    derived = scryptSync(password, salt, expected.length, {
      N: paramN,
      r: paramR,
      p: paramP,
      maxmem: 64 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// A constant-shape hash used to keep the login timing profile for "no such
// account" identical to "wrong password" — see verifyOrDummy in auth.js.
export const DUMMY_HASH = hashPassword(randomBytes(16).toString("hex"));
