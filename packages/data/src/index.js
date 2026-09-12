import {
  defaultSettings,
  freshProgress,
  normalizeSettings,
  readProgress,
} from "../../engine/src/index.js";
import { createConfiguredSupabaseDataAdapter } from "./supabase.js";
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
    if (stored) return normalizeData(stored);
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

// Runtime adapter selection: with no Supabase configuration present, a player
// sees no difference from a plain local-storage game — there is no accounts
// service to offer, so the result is the guest-only adapter above. Call this
// once at boot instead of constructing an adapter directly.
export async function selectDataAdapter({
  supabaseUrl,
  supabasePublishableKey,
  supabaseClient,
  storage,
  crypto = globalThis.crypto,
} = {}) {
  if (supabaseUrl || supabasePublishableKey || supabaseClient) {
    if (!supabaseClient && (!supabaseUrl || !supabasePublishableKey))
      return createLocalDataAdapter({ storage });
    return createConfiguredSupabaseDataAdapter({
      url: supabaseUrl,
      publishableKey: supabasePublishableKey,
      client: supabaseClient,
      storage,
      crypto,
    });
  }
  return createLocalDataAdapter({ storage });
}
