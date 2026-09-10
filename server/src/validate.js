export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Letters, digits, underscore, hyphen, period only — keeps usernames safe to
// display and to put in a URL/leaderboard row without further escaping.
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,24}$/;

export function cleanEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !EMAIL_RE.test(email))
    throw new ValidationError("Enter a valid email address.");
  return email;
}

export function cleanUsername(value) {
  const username = String(value ?? "").trim();
  if (!USERNAME_RE.test(username))
    throw new ValidationError(
      "Usernames are 2-24 characters: letters, digits, underscore, hyphen, period.",
    );
  return username;
}

export function cleanPassword(value) {
  const password = String(value ?? "");
  if (password.length < 8 || password.length > 256)
    throw new ValidationError("Password must be 8-256 characters.");
  return password;
}

export function cleanIdentifier(value) {
  const identifier = String(value ?? "").trim();
  if (!identifier || identifier.length > 254)
    throw new ValidationError("Enter your email or username.");
  return identifier;
}

const MODE_RE = /^[a-z0-9_-]{1,32}$/i;

export function cleanMode(value) {
  const mode = String(value ?? "").trim();
  if (!MODE_RE.test(mode)) throw new ValidationError("Invalid mode.");
  return mode;
}

export function cleanCourt(value) {
  if (value === undefined || value === null || value === "") return null;
  const court = Number(value);
  if (!Number.isInteger(court) || court < 0 || court > 999)
    throw new ValidationError("Invalid court.");
  return court;
}

export function cleanScoreInt(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1_000_000_000)
    throw new ValidationError(`Invalid ${label}.`);
  return Math.floor(n);
}

export function cleanLimit(value, fallback, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new ValidationError("Invalid limit.");
  return n;
}

// User-editable JSON blob (progress/settings/stats). Bounded so a client
// can't force us to buffer or store something huge.
export const MAX_USER_DATA_BYTES = 64 * 1024;
