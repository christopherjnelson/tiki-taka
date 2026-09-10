import {
  defaultSettings,
  freshProgress,
  normalizeSettings,
  readProgress,
} from "../../engine/src/index.js";
import { createConfiguredSupabaseDataAdapter } from "./supabase.js";
export { createSupabaseDataAdapter, createConfiguredSupabaseDataAdapter } from "./supabase.js";

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

const preferencesDefaults = () => ({ scoreSaveChoice: "ask" });

function cleanPreferences(value) {
  const scoreSaveChoice = value?.scoreSaveChoice;
  return {
    scoreSaveChoice:
      scoreSaveChoice === "always" || scoreSaveChoice === "never" ? scoreSaveChoice : "ask",
  };
}

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
    preferences: cleanPreferences(value?.preferences),
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
        preferences: update.preferences ?? current.preferences,
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

// Same shape as createLocalDataAdapter (register/login/logout/getSession/
// getProfile/loadUserData/saveUserData/recordRound), backed by the optional
// accounts server (see server/README.md) instead of localStorage — with one
// difference the local adapter doesn't need: this one only has real accounts
// to talk to the server about. A player who never registers/logs in still
// needs somewhere to keep guest progress, so this adapter keeps a private
// createLocalDataAdapter around (never registered/logged in on, so it always
// stays on the guest scope) and uses it whenever there is no server session.
// That is also exactly what keeps the game working if the server is
// misconfigured or briefly unreachable: any network failure surfaces as a
// LocalDataError the same way a local storage failure would, and callers
// that catch it (see the runtime adapter selection helper below) fall back
// to a plain createLocalDataAdapter for the rest of the session.
export function createRemoteDataAdapter({
  apiBase,
  fetch: fetchImpl = globalThis.fetch,
  storage,
  crypto = globalThis.crypto,
} = {}) {
  if (!apiBase) throw new LocalDataError("STORAGE_REQUIRED", "API base URL must be configured.");
  if (!fetchImpl) throw new LocalDataError("STORAGE_REQUIRED", "fetch is not available.");
  const base = apiBase.replace(/\/$/, "");
  const guest = createLocalDataAdapter({ storage, crypto });

  let profile = null;
  let checked = false;

  async function call(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        credentials: "include",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new LocalDataError("STORAGE_ERROR", "The accounts server could not be reached.");
    }
    let json = null;
    let text = "";
    try {
      text = await response.text();
    } catch {
      // fall through with an empty body
    }
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (!response.ok) {
      const code = json?.error?.code || "STORAGE_ERROR";
      const message = json?.error?.message || "The accounts server returned an error.";
      throw new LocalDataError(code, message);
    }
    return json;
  }

  const forgetSession = () => {
    profile = null;
    checked = true;
  };

  // Runs a request that requires a signed-in session, falling back to the
  // guest (local) scope both when we already know no one is signed in and
  // when the server unexpectedly says our session is gone.
  async function withSession(remoteCall, guestCall) {
    if (!checked) {
      profile = (await call("/api/session"))?.profile || null;
      checked = true;
    }
    if (!profile) return guestCall();
    try {
      return await remoteCall();
    } catch (error) {
      if (error.code === "UNAUTHORIZED") {
        forgetSession();
        return guestCall();
      }
      throw error;
    }
  }

  return {
    kind: "server",
    async register({ email, username, password } = {}) {
      const result = await call("/api/register", { method: "POST", body: { email, username, password } });
      profile = result;
      checked = true;
      return result;
    },
    async login({ identifier, password } = {}) {
      const result = await call("/api/login", { method: "POST", body: { identifier, password } });
      profile = result;
      checked = true;
      return result;
    },
    async logout() {
      try {
        await call("/api/logout", { method: "POST" });
      } finally {
        forgetSession();
      }
    },
    async getSession() {
      const result = await call("/api/session");
      profile = result?.profile || null;
      checked = true;
      return result;
    },
    async getProfile() {
      const result = await call("/api/profile");
      profile = result;
      checked = true;
      return result;
    },
    async loadUserData() {
      return withSession(() => call("/api/user-data"), () => guest.loadUserData());
    },
    async saveUserData(update = {}) {
      return withSession(
        () => call("/api/user-data", { method: "PUT", body: update }),
        () => guest.saveUserData(update),
      );
    },
    async recordRound(round = {}) {
      const body = {
        mode: round.mode ?? "career",
        court: round.court ?? null,
        score: round.score ?? 0,
        passes: round.passes ?? 0,
        bestOneTouch: round.bestOneTouch ?? 0,
      };
      return withSession(
        () => call("/api/rounds", { method: "POST", body }),
        () => guest.recordRound(round),
      );
    },
    // Not part of the local-adapter contract: only meaningful once there is
    // a server to ask. The leaderboard UI feature-detects this method.
    async getLeaderboard({ mode = "career", court, limit } = {}) {
      const params = new URLSearchParams({ mode });
      if (court !== undefined && court !== null) params.set("court", String(court));
      if (limit) params.set("limit", String(limit));
      return call(`/api/leaderboard?${params.toString()}`);
    },
  };
}

// Runtime adapter selection: a player with no backend configured, or whose
// configured backend is unreachable, must see no difference from the plain
// local-storage game. Call this once at boot instead of constructing an
// adapter directly. `apiBase` is expected to come from the app's own runtime
// configuration (e.g. a build-time constant or a same-origin `/api`); when
// it is falsy, or the server doesn't answer, this resolves to a local
// adapter and the caller never needs to know the difference.
export async function selectDataAdapter({
  apiBase,
  supabaseUrl,
  supabasePublishableKey,
  supabaseClient,
  storage,
  crypto = globalThis.crypto,
  fetch: fetchImpl = globalThis.fetch,
} = {}) {
  if (supabaseUrl || supabasePublishableKey || supabaseClient) {
    if (!supabaseClient && (!supabaseUrl || !supabasePublishableKey))
      return createLocalDataAdapter({ storage, crypto });
    return createConfiguredSupabaseDataAdapter({
      url: supabaseUrl,
      publishableKey: supabasePublishableKey,
      client: supabaseClient,
      storage,
      crypto,
    });
  }
  if (!apiBase) return createLocalDataAdapter({ storage, crypto });
  const remote = createRemoteDataAdapter({ apiBase, storage, crypto, fetch: fetchImpl });
  try {
    await remote.getSession();
    return remote;
  } catch {
    return createLocalDataAdapter({ storage, crypto });
  }
}
