import {
  defaultSettings,
  freshProgress,
  isReadableProgress,
  normalizeSettings,
  readProgress,
} from "../../engine/src/index.js";
import { createConfiguredSupabaseDataAdapter, fetchPublicLeaderboard } from "./supabase.js";
export { createSupabaseDataAdapter, createConfiguredSupabaseDataAdapter } from "./supabase.js";

const PREFIX = "tiki-taka.local-data.v1";
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
  totalTriangles: 0,
  totalOles: 0,
  totalSplits: 0,
  totalZones: 0,
});

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
  totalTriangles: integer(value?.totalTriangles),
  totalOles: integer(value?.totalOles),
  totalSplits: integer(value?.totalSplits),
  totalZones: integer(value?.totalZones),
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

// Guest-only browser persistence. There is no account system here anymore —
// a signed-out player's progress, settings and stats live in browser storage
// under one fixed key, exactly as a guest's data always has. This is the
// adapter used when Supabase is not configured (see selectDataAdapter below)
// and it is also what the Supabase adapter falls back to while signed out or
// briefly unreachable, so its behavior must stay unchanged.
export function createLocalDataAdapter({ storage } = {}) {
  if (!storage) throw new LocalDataError("STORAGE_REQUIRED", "Storage must be provided.");

  const read = (key, fallback) => {
    let raw;
    try {
      raw = storage.getItem(key);
    } catch {
      throw new LocalDataError("STORAGE_ERROR", "Local data could not be read.");
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
      throw new LocalDataError("STORAGE_ERROR", "Local data could not be saved.");
    }
  };

  const loadGuest = () => {
    const stored = read(GUEST_KEY, null);
    if (stored) {
      // The same hazard the Supabase adapter guards against exists here too:
      // a stale cached tab, or a rolled-back deploy, can find a progress
      // object stamped with a version this build has never heard of. Folding
      // it down to freshProgress() and calling that "loaded" is exactly what
      // then lets the very next autosave (see saveUserData below, which
      // starts from this same loadGuest()) write the empty fresh progress
      // straight over the real save under this one fixed key.
      if (stored.progress != null && !isReadableProgress(stored.progress))
        throw new LocalDataError(
          "PROGRESS_TOO_NEW",
          "This save was written by a newer version of Tiki Taka. Reload the page to update before playing further, or this device's progress will not be saved.",
        );
      return normalizeData(stored);
    }
    // One-time migration from the pre-adapter storage keys.
    const migrated = normalizeData({
      progress: read("tiki-taka.progress.v1", freshProgress()),
      settings: read("tiki-taka.settings.v1", defaultSettings()),
      stats: statsDefaults(),
    });
    write(GUEST_KEY, migrated);
    return migrated;
  };

  const loadUserData = async () => loadGuest();

  return {
    kind: "guest",
    loadUserData,
    async saveUserData(update = {}) {
      const current = loadGuest();
      const next = normalizeData({
        progress: update.progress ?? current.progress,
        settings: update.settings ?? current.settings,
        stats: update.stats ?? current.stats,
        preferences: update.preferences ?? current.preferences,
      });
      write(GUEST_KEY, next);
      return next;
    },
    async recordRound(round = {}) {
      const current = loadGuest();
      current.stats = {
        games: current.stats.games + 1,
        bestScore: Math.max(current.stats.bestScore, number(round.score)),
        totalPasses: current.stats.totalPasses + integer(round.passes),
        bestOneTouch: Math.max(current.stats.bestOneTouch, integer(round.bestOneTouch)),
        totalTriangles: current.stats.totalTriangles + integer(round.triangles),
        totalOles: current.stats.totalOles + integer(round.oles),
        totalSplits: current.stats.totalSplits + integer(round.splits),
        totalZones: current.stats.totalZones + integer(round.zones),
      };
      write(GUEST_KEY, current);
      return current.stats;
    },
  };
}

export const LOCAL_DATA_KEYS = {
  guest: GUEST_KEY,
};

// Wraps the real Supabase adapter behind the exact same shape ("supabase"
// kind, every method the real one has) without paying for it: constructing
// the real adapter dynamically imports @supabase/supabase-js (see
// createConfiguredSupabaseDataAdapter), a ~56 KiB gzipped vendor chunk that a
// guest who never signs in has no reason to fetch. main.js decides whether
// this browser is *worth* checking eagerly (a stored session, or an OAuth
// provider redirecting back - see selectDataAdapter's `eager`) and only
// bypasses this wrapper in that case; everywhere else, the import happens
// the moment something actually needs the library - register(), login(),
// signInWithDiscord(), completeProfile() - and never before.
//
// Every other call degrades to something correct without it:
//   - getSession()/getProfile() report signed-out rather than importing the
//     library just to confirm what main.js's own storage check already
//     suggested.
//   - loadUserData()/saveUserData()/recordRound() run against the same local
//     guest adapter the no-Supabase-configured build uses, so a guest's
//     progress, settings and local stats work exactly as before - and the
//     moment a real sign-in happens, later calls flow through the real
//     adapter instead, picking up the account's data the normal way (main.js
//     already reloads the data context after every sign-in).
//   - getLeaderboard() never needs the client at all: it is a public,
//     read-only table, so it goes straight to PostgREST (see
//     fetchPublicLeaderboard in supabase.js) whether or not the real adapter
//     has loaded. Routing it through the client would force the chunk to
//     load for every guest the instant the home screen's leaderboard
//     refreshes, which would defeat this entire change.
//   - onAuthStateChange() queues the listener instead of subscribing; wiring
//     up a listener for changes that, by definition, cannot happen without
//     the library already being loaded must not itself trigger the load.
function createDeferredSupabaseDataAdapter({ url, publishableKey, storage, crypto = globalThis.crypto } = {}) {
  const guest = createLocalDataAdapter({ storage, crypto });
  let real = null;
  let loading = null;
  let queuedListeners = [];
  function ensureReal() {
    if (real) return Promise.resolve(real);
    if (!loading)
      loading = createConfiguredSupabaseDataAdapter({ url, publishableKey, storage, crypto }).then((adapter) => {
        real = adapter;
        for (const listener of queuedListeners) real.onAuthStateChange(listener);
        queuedListeners = [];
        return adapter;
      });
    return loading;
  }
  return {
    kind: "supabase",
    async register(...args) {
      return (await ensureReal()).register(...args);
    },
    async login(...args) {
      return (await ensureReal()).login(...args);
    },
    async logout() {
      // Never loaded this session means never signed in this session -
      // nothing to sign out of, and nothing worth importing the library for.
      if (!real) return;
      return real.logout();
    },
    async getSession() {
      return real ? real.getSession() : null;
    },
    async getProfile() {
      return real ? real.getProfile() : null;
    },
    async signInWithDiscord(...args) {
      return (await ensureReal()).signInWithDiscord(...args);
    },
    async completeProfile(...args) {
      return (await ensureReal()).completeProfile(...args);
    },
    onAuthStateChange(listener) {
      if (real) return real.onAuthStateChange(listener);
      queuedListeners.push(listener);
      return () => {
        queuedListeners = queuedListeners.filter((entry) => entry !== listener);
      };
    },
    async loadUserData() {
      return real ? real.loadUserData() : guest.loadUserData();
    },
    async saveUserData(update = {}) {
      return real ? real.saveUserData(update) : guest.saveUserData(update);
    },
    async recordRound(round = {}) {
      return real ? real.recordRound(round) : guest.recordRound(round);
    },
    async getLeaderboard(options = {}) {
      return fetchPublicLeaderboard({ url, publishableKey, ...options });
    },
  };
}

// Runtime adapter selection: with no Supabase configuration present, a player
// sees no difference from a plain local-storage game — there is no accounts
// service to offer, so the result is the guest-only adapter above. Call this
// once at boot instead of constructing an adapter directly.
//
// `eager`, set by main.js from a cheap local check (a stored Supabase session
// key, or the URL showing an OAuth provider redirecting back), decides
// whether to construct the real adapter now - so a returning signed-in
// player's session restores without an extra round trip - or hand back the
// deferred wrapper above, which behaves identically but never imports the
// Supabase client library until something actually needs it.
export async function selectDataAdapter({
  supabaseUrl,
  supabasePublishableKey,
  supabaseClient,
  storage,
  crypto = globalThis.crypto,
  eager = false,
} = {}) {
  if (supabaseUrl || supabasePublishableKey || supabaseClient) {
    if (!supabaseClient && (!supabaseUrl || !supabasePublishableKey))
      return createLocalDataAdapter({ storage });
    if (supabaseClient || eager)
      return createConfiguredSupabaseDataAdapter({
        url: supabaseUrl,
        publishableKey: supabasePublishableKey,
        client: supabaseClient,
        storage,
        crypto,
      });
    return createDeferredSupabaseDataAdapter({
      url: supabaseUrl,
      publishableKey: supabasePublishableKey,
      storage,
      crypto,
    });
  }
  return createLocalDataAdapter({ storage });
}
