import {
  defaultSettings,
  freshProgress,
  normalizeSettings,
  readProgress,
} from "../../engine/src/index.js";

const PREFIX = "tiki-taka.local-data.v1";
const ACCOUNTS_KEY = `${PREFIX}.accounts`;
const SESSION_KEY = `${PREFIX}.session`;
const GUEST_KEY = `${PREFIX}.guest`;

export class LocalDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LocalDataError";
    this.code = code;
  }
}

const statsDefaults = () => ({
  games: 0,
  bestScore: 0,
  totalPasses: 0,
  bestOneTouch: 0,
});

const cleanStats = (value) => ({
  games: integer(value?.games),
  bestScore: number(value?.bestScore),
  totalPasses: integer(value?.totalPasses),
  bestOneTouch: integer(value?.bestOneTouch),
});

function number(value) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function integer(value) {
  return Math.floor(number(value));
}

function normalizeProgress(value) {
  return readProgress({
    getItem: () => JSON.stringify(value),
  });
}

function normalizeData(value) {
  return {
    progress: normalizeProgress(value?.progress),
    settings: normalizeSettings(value?.settings),
    stats: cleanStats(value?.stats),
  };
}

export function createLocalDataAdapter({ storage, crypto = globalThis.crypto } = {}) {
  if (!storage) throw new LocalDataError("STORAGE_REQUIRED", "Storage must be provided.");

  const read = (key, fallback) => {
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      throw new LocalDataError("STORAGE_ERROR", "Local demo data could not be read.");
    }
    if (raw === null) return fallback;
    try {
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch {
      throw new LocalDataError("STORAGE_ERROR", "Local demo data could not be saved.");
    }
  };
  const accounts = () => {
    const value = read(ACCOUNTS_KEY, {});
    const result = Object.create(null);
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    for (const [id, account] of Object.entries(value)) {
      if (
        !account ||
        typeof account !== "object" ||
        account.id !== id ||
        typeof account.email !== "string" ||
        typeof account.username !== "string"
      )
        continue;
      result[id] = account;
    }
    return result;
  };
  const publicProfile = (account) => ({
    id: account.id,
    email: account.email,
    username: account.username,
    authMode: "local-demo",
  });
  let ownerId;
  let ownerCaptured = false;
  let ownerCaptureError = null;
  const captureOwner = () => {
    if (ownerCaptured) {
      if (ownerCaptureError) throw ownerCaptureError;
      return;
    }
    try {
      const id = read(SESSION_KEY, null)?.userId;
      const all = accounts();
      ownerId = typeof id === "string" && Object.hasOwn(all, id) ? id : null;
    } catch (error) {
      ownerCaptureError = error;
    }
    ownerCaptured = true;
    if (ownerCaptureError) throw ownerCaptureError;
  };
  const activeAccount = () => {
    captureOwner();
    if (!ownerId) return null;
    const all = accounts();
    return Object.hasOwn(all, ownerId) ? all[ownerId] : null;
  };
  const loadGuest = () => {
    const stored = read(GUEST_KEY, null);
    if (stored) return normalizeData(stored);
    const migrated = normalizeData({
      progress: read("tiki-taka.progress.v1", freshProgress()),
      settings: read("tiki-taka.settings.v1", defaultSettings()),
      stats: statsDefaults(),
    });
    write(GUEST_KEY, migrated);
    return migrated;
  };

  const capturedScope = () => {
    captureOwner();
    return ownerId ? `${PREFIX}.user.${ownerId}` : GUEST_KEY;
  };
  const loadAtScope = (key) =>
    key === GUEST_KEY ? loadGuest() : normalizeData(read(key, null));
  const loadUserData = async () => loadAtScope(capturedScope());

  const rejectPassword = (password) => {
    if (password !== undefined && password !== "")
      throw new LocalDataError(
        "PASSWORD_NOT_SUPPORTED",
        "Local demo profiles are passwordless and are not real accounts.",
      );
  };

  const makeId = () => {
    if (crypto?.randomUUID) return crypto.randomUUID();
    const random = Math.random().toString(36).slice(2);
    return `demo-${Date.now().toString(36)}-${random}`;
  };

  // Capture at construction so another same-origin tab cannot redirect this instance.
  try {
    captureOwner();
  } catch {
    // Keep construction side-effect free; the first API call surfaces the storage error.
  }

  return {
    kind: "local-demo",
    async register({ email, username, password } = {}) {
      rejectPassword(password);
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanUsername = String(username || "").trim();
      if (
        !/^\S+@\S+\.\S+$/.test(cleanEmail) ||
        cleanEmail.length > 254 ||
        cleanUsername.length < 2 ||
        cleanUsername.length > 40
      )
        throw new LocalDataError(
          "VALIDATION_ERROR",
          "Use an email and a username of at least 2 characters.",
        );
      const all = accounts();
      if (
        Object.values(all).some(
          (item) =>
            item.email.toLowerCase() === cleanEmail ||
            item.username.toLowerCase() === cleanUsername.toLowerCase(),
        )
      )
        throw new LocalDataError("ACCOUNT_EXISTS", "That local demo account already exists.");
      const account = {
        id: makeId(),
        email: cleanEmail,
        username: cleanUsername,
      };
      all[account.id] = account;
      write(ACCOUNTS_KEY, all);
      write(`${PREFIX}.user.${account.id}`, normalizeData());
      write(SESSION_KEY, { userId: account.id });
      ownerId = account.id;
      ownerCaptured = true;
      ownerCaptureError = null;
      return publicProfile(account);
    },
    async login({ identifier, password } = {}) {
      rejectPassword(password);
      const lookup = String(identifier || "").trim().toLowerCase();
      const account = Object.values(accounts()).find(
        (item) => item.email === lookup || item.username.toLowerCase() === lookup,
      );
      if (!account) throw new LocalDataError("LOGIN_FAILED", "Local demo profile was not found.");
      write(SESSION_KEY, { userId: account.id });
      ownerId = account.id;
      ownerCaptured = true;
      ownerCaptureError = null;
      return publicProfile(account);
    },
    async logout() {
      captureOwner();
      try {
        if (read(SESSION_KEY, null)?.userId === ownerId) storage.removeItem(SESSION_KEY);
      } catch {
        throw new LocalDataError("STORAGE_ERROR", "Local demo session could not be cleared.");
      }
      ownerId = null;
      ownerCaptured = true;
      ownerCaptureError = null;
    },
    async getSession() {
      const account = activeAccount();
      return account ? { profile: publicProfile(account) } : null;
    },
    async getProfile() {
      const account = activeAccount();
      return account ? publicProfile(account) : null;
    },
    loadUserData,
    async saveUserData(update = {}) {
      const key = capturedScope();
      const current = loadAtScope(key);
      const next = normalizeData({
        progress: update.progress ?? current.progress,
        settings: update.settings ?? current.settings,
        stats: update.stats ?? current.stats,
      });
      write(key, next);
      return next;
    },
    async recordRound(round = {}) {
      const key = capturedScope();
      const current = loadAtScope(key);
      current.stats = {
        games: current.stats.games + 1,
        bestScore: Math.max(current.stats.bestScore, number(round.score)),
        totalPasses: current.stats.totalPasses + integer(round.passes),
        bestOneTouch: Math.max(current.stats.bestOneTouch, integer(round.bestOneTouch)),
      };
      write(key, current);
      return current.stats;
    },
  };
}

export const LOCAL_DATA_KEYS = {
  accounts: ACCOUNTS_KEY,
  session: SESSION_KEY,
  guest: GUEST_KEY,
  user: (id) => `${PREFIX}.user.${id}`,
};
