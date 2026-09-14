import { defaultSettings, isReadableProgress, normalizeProgress, normalizeSettings, DIFFICULTIES } from "../../engine/src/index.js";

import {
  LocalDataError,
  createLocalDataAdapter,
} from "./index.js";

const DEFAULT_STATS = () => ({
  games: 0,
  bestScore: 0,
  totalPasses: 0,
  bestOneTouch: 0,
  totalTriangles: 0,
  totalOles: 0,
  totalSplits: 0,
  totalZones: 0,
});
const isEmail = (value) => /^\S+@\S+\.\S+$/.test(String(value || "").trim());
const USERNAME_RE = /^[A-Za-z0-9_.-]{2,24}$/;
const number = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
const integer = (value) => Math.floor(number(value));
const DIFFICULTY_IDS = DIFFICULTIES.map((tier) => tier.id);
const difficulty = (value) => (DIFFICULTY_IDS.includes(value) ? value : "standard");

function normalizePreferences(value) {
  const choice = value?.scoreSaveChoice ?? value?.score_save_choice;
  return { scoreSaveChoice: choice === "always" || choice === "never" ? choice : "ask" };
}

function normalizeData({ save, preferences, stats } = {}) {
  return {
    // A save row can be absent, empty, or written by an older build, and `??`
    // only catches the absent case — an empty object passes straight through
    // and reaches the game missing every field it relies on. Normalize rather
    // than default, so a malformed row repairs itself on load instead of
    // failing the same way on every reload.
    progress: normalizeProgress(save?.progress),
    settings: normalizeSettings(save?.settings ?? defaultSettings()),
    stats: stats ?? DEFAULT_STATS(),
    preferences: normalizePreferences(preferences),
  };
}

function profileFromUser(user, profile) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? "",
    username: profile?.username ?? user.user_metadata?.username ?? "",
    authMode: "supabase",
  };
}

// Discord never gives a leaderboard-suitable name directly - the closest
// fields are these, roughly best-to-worst for what a person actually
// recognises as "their name". Sanitized down to the same charset the
// profiles table enforces so the prompt can prefill with something that
// will actually validate; a player is always free to change it.
function suggestedUsername(user) {
  const meta = user?.user_metadata || {};
  const raw = meta.global_name || meta.full_name || meta.user_name || meta.preferred_username || meta.name || "";
  const cleaned = String(raw).trim().replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 24);
  return cleaned.length >= 2 ? cleaned : "";
}

function errorFrom(error, fallback = "Supabase could not complete that request.") {
  if (error instanceof LocalDataError) return error;
  const message = error?.message || fallback;
  if (error?.code === "USERNAME_TAKEN" || /username.*(taken|exists|duplicate)|duplicate.*username/i.test(message))
    return new LocalDataError("USERNAME_TAKEN", "That username is already in use.");
  // Supabase never tells the client which sign-in method an existing account
  // uses (it would leak account existence to an attacker), so this message
  // cannot say "that email is a Discord account" for certain - only point at
  // the possibility, since a password account with that email is just as
  // likely.
  if (error?.code === "23505" || /already registered|already exists|duplicate/i.test(message))
    return new LocalDataError("ACCOUNT_EXISTS", "An account already exists for that email. If you signed up with Discord, use Continue with Discord above - otherwise sign in below.");
  if (/invalid login credentials|invalid.*credentials/i.test(message))
    return new LocalDataError("LOGIN_FAILED", "That email or password is incorrect. If you originally signed in with Discord, use Continue with Discord above instead.");
  if (/not authenticated|jwt|session.*missing|unauthorized/i.test(message))
    return new LocalDataError("UNAUTHORIZED", "Sign in to access your saved game.");
  return new LocalDataError("STORAGE_ERROR", message);
}

function throwIfError(error, fallback) {
  if (error) throw errorFrom(error, fallback);
}

// Thrown instead of silently normalising a stored progress row to a fresh
// one, whenever that row's version is newer than this build understands.
// Loaders surface it so the app can tell the player the truth; saveUserData
// uses it to refuse a write that would otherwise erase that row (see
// isReadableProgress in packages/engine/src/progress.js for why).
function progressTooNewError() {
  return new LocalDataError(
    "PROGRESS_TOO_NEW",
    "Your save was written by a newer version of Tiki Taka. Reload the page to update before playing further, or this device's progress will not be saved.",
  );
}

function newRoundId(crypto) {
  if (crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  // RFC 4122 version 4 UUID. This fallback keeps retry ids valid for the
  // uuid primary key even on older browsers without randomUUID().
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function maybeSingle(query, fallback) {
  const result = await query.maybeSingle();
  // PostgREST represents zero rows as a successful null data result.
  if (result.error && result.error.code !== "PGRST116") throw result.error;
  return result.data ?? fallback;
}

/**
 * Browser-only Supabase implementation of the data-adapter contract.
 *
 * The client receives only the project's URL and publishable key. It expects
 * RLS-protected public tables: profiles, user_saves, user_preferences, and
 * round_scores. It intentionally never turns a known signed-in account into a
 * guest after a network failure; callers can retain a pending round and retry.
 */
export function createSupabaseDataAdapter({
  url,
  publishableKey,
  storage,
  crypto = globalThis.crypto,
  client,
} = {}) {
  if (!storage) throw new LocalDataError("STORAGE_REQUIRED", "Storage must be provided.");
  if (!client) throw new LocalDataError("STORAGE_REQUIRED", "A Supabase browser client must be provided.");
  const supabase = client;
  const guest = createLocalDataAdapter({ storage, crypto });
  let currentUser = undefined;
  let currentProfile = null;

  async function sessionUser() {
    if (currentUser !== undefined) return currentUser;
    let result;
    try {
      result = await supabase.auth.getSession();
    } catch (error) {
      throw errorFrom(error, "Supabase could not restore your session.");
    }
    throwIfError(result.error, "Supabase could not restore your session.");
    currentUser = result.data?.session?.user ?? null;
    return currentUser;
  }

  // Shared by getSession(), getProfile() and the auth-state listener: a
  // signed-in user with no profiles row is a first-time OAuth sign-in (see
  // the migration note on private.create_signup_records - an email/password
  // signup always gets a row atomically, so this state is otherwise
  // unreachable) or a player who abandoned the username prompt last time.
  // Either way the caller needs to know to ask for a name, which a bare
  // `profile: null` can't distinguish from "signed out".
  async function sessionResult(user) {
    if (!user) return null;
    let result;
    try {
      result = await supabase.from("profiles").select("id, username").eq("id", user.id).maybeSingle();
      if (result.error && result.error.code !== "PGRST116") throw result.error;
    } catch (error) {
      throw errorFrom(error, "Supabase could not load your profile.");
    }
    if (!result.data) {
      currentProfile = null;
      return {
        profile: null,
        needsUsername: true,
        user: { id: user.id, email: user.email ?? "", suggestedUsername: suggestedUsername(user) },
      };
    }
    currentProfile = profileFromUser(user, result.data);
    return { profile: currentProfile };
  }

  async function signedInProfile() {
    const user = await sessionUser();
    if (!user) return null;
    const result = await sessionResult(user);
    return result?.profile ?? null;
  }

  async function signedInOrGuest(remote, local) {
    const user = await sessionUser();
    if (!user) return local();
    // Crucially, remote failures propagate. A signed-in player must never
    // silently read or overwrite a local guest's data.
    try {
      return await remote(user);
    } catch (error) {
      throw errorFrom(error);
    }
  }

  async function statsFor(user) {
    const result = await supabase
      .from("round_scores")
      .select("score, passes, best_one_touch, triangles, oles, splits, zones")
      .eq("user_id", user.id);
    throwIfError(result.error, "Supabase could not load your round history.");
    return (result.data ?? []).reduce((stats, round) => ({
      games: stats.games + 1,
      bestScore: Math.max(stats.bestScore, number(round.score)),
      totalPasses: stats.totalPasses + integer(round.passes),
      bestOneTouch: Math.max(stats.bestOneTouch, integer(round.best_one_touch)),
      totalTriangles: stats.totalTriangles + integer(round.triangles),
      totalOles: stats.totalOles + integer(round.oles),
      totalSplits: stats.totalSplits + integer(round.splits),
      totalZones: stats.totalZones + integer(round.zones),
    }), DEFAULT_STATS());
  }

  return {
    kind: "supabase",
    async register({ email, username, password } = {}) {
      const cleanEmail = String(email || "").trim().toLowerCase();
      const cleanUsername = String(username || "").trim();
      if (!isEmail(cleanEmail) || !USERNAME_RE.test(cleanUsername) || String(password || "").length < 8)
        throw new LocalDataError("VALIDATION_ERROR", "Use an email, a username of 2-24 letters, digits, underscores, hyphens, or periods, and a password of at least 8 characters.");
      let result;
      try {
        result = await supabase.auth.signUp({ email: cleanEmail, password, options: { data: { username: cleanUsername } } });
      } catch (error) {
        throw errorFrom(error, "Supabase could not create your account.");
      }
      throwIfError(result.error, "Supabase could not create your account.");
      currentUser = result.data?.user ?? null;
      currentProfile = null;
      if (!currentUser || !result.data?.session)
        throw new LocalDataError("STORAGE_ERROR", "Account created, but no session was returned. Check that email confirmation is disabled.");
      return signedInProfile();
    },
    async login({ identifier, password } = {}) {
      const email = String(identifier || "").trim().toLowerCase();
      if (!isEmail(email))
        throw new LocalDataError("VALIDATION_ERROR", "Sign in with the email address used to create your account.");
      let result;
      try {
        result = await supabase.auth.signInWithPassword({ email, password: String(password || "") });
      } catch (error) {
        throw errorFrom(error, "Supabase could not sign you in.");
      }
      throwIfError(result.error, "Supabase could not sign you in.");
      currentUser = result.data?.user ?? null;
      currentProfile = null;
      return signedInProfile();
    },
    async logout() {
      try {
        const result = await supabase.auth.signOut();
        throwIfError(result.error, "Supabase could not sign you out.");
      } finally {
        currentUser = null;
        currentProfile = null;
      }
    },
    async getSession() {
      const user = await sessionUser();
      return sessionResult(user);
    },
    async getProfile() {
      return signedInProfile();
    },
    // signInWithOAuth navigates the whole page away, so nothing here runs
    // again until the redirect back - the returning session is picked up by
    // this same listener (detectSessionInUrl: true, below) exactly as a
    // cross-tab session change already was, which is what carries it into
    // the ordinary post-sign-in flow in main.js.
    async signInWithDiscord({ redirectTo } = {}) {
      let result;
      try {
        result = await supabase.auth.signInWithOAuth({ provider: "discord", options: { redirectTo } });
      } catch (error) {
        throw errorFrom(error, "Supabase could not start Discord sign-in.");
      }
      throwIfError(result.error, "Supabase could not start Discord sign-in.");
      return result.data;
    },
    // Called once, after a first-time OAuth sign-in, once the player has
    // confirmed or changed the name suggested from their Discord identity.
    // profiles has no update policy and no server-side default, so this is
    // the only way that row is ever created for an OAuth account (see the
    // migration note on private.create_signup_records).
    async completeProfile({ username } = {}) {
      const user = await sessionUser();
      if (!user) throw new LocalDataError("UNAUTHORIZED", "Sign in to choose a username.");
      const cleanUsername = String(username || "").trim();
      if (!USERNAME_RE.test(cleanUsername))
        throw new LocalDataError("VALIDATION_ERROR", "Use a username of 2-24 letters, digits, underscores, hyphens, or periods.");
      let result;
      try {
        result = await supabase.from("profiles").insert({ id: user.id, username: cleanUsername }).select("id, username").single();
      } catch (error) {
        throw errorFrom(error, "Supabase could not save your username.");
      }
      throwIfError(result.error, "Supabase could not save your username.");
      currentProfile = profileFromUser(user, result.data);
      return currentProfile;
    },
    onAuthStateChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) => {
        currentUser = session?.user ?? null;
        currentProfile = null;
        const user = session?.user ?? null;
        // sessionResult reads the profiles table, so a transient failure here
        // must not be swallowed as "signed out" - fall back to the same
        // metadata-only shape this listener used before it looked the row
        // up, and let the caller's own error handling (main.js already
        // wraps this in a toast on rejection) take it from there.
        Promise.resolve(user ? sessionResult(user) : null)
          .catch(() => (user ? { profile: profileFromUser(user, null) } : null))
          .then(listener);
      });
      return () => data.subscription.unsubscribe();
    },
    async loadUserData() {
      return signedInOrGuest(async (user) => {
        const [save, preference, stats] = await Promise.all([
          maybeSingle(supabase.from("user_saves").select("progress, settings").eq("user_id", user.id), null),
          maybeSingle(supabase.from("user_preferences").select("score_save_choice").eq("user_id", user.id), null),
          statsFor(user),
        ]);
        // A row from a newer build must never be presented as an empty fresh
        // profile - that is indistinguishable from having lost everything,
        // and it is exactly the state a caller would otherwise autosave right
        // back over the real row (see progressTooNewError above).
        if (save?.progress != null && !isReadableProgress(save.progress)) throw progressTooNewError();
        return normalizeData({ save, preferences: preference, stats });
      }, () => guest.loadUserData());
    },
    async saveUserData(update = {}) {
      return signedInOrGuest(async (user) => {
        const existing = await maybeSingle(supabase.from("user_saves").select("progress, settings").eq("user_id", user.id), null);
        // An existing row this build cannot read must never be upserted:
        // normalizeProgress below would silently fold it down to
        // freshProgress(), and the upsert would write that empty progress
        // straight over the real save. Refuse the whole write instead - this
        // is what actually happened to a live player's save when 0.4.1 moved
        // progress to version 2 and an old client wrote over it.
        if (existing?.progress != null && !isReadableProgress(existing.progress)) throw progressTooNewError();
        // Normalize on the way in too: a new account has no existing row, and
        // writing `{}` for it is what put a broken save in the database in the
        // first place.
        const save = {
          user_id: user.id,
          progress: normalizeProgress(update.progress ?? existing?.progress),
          settings: normalizeSettings(update.settings ?? existing?.settings ?? defaultSettings()),
        };
        const written = await supabase.from("user_saves").upsert(save, { onConflict: "user_id" }).select("progress, settings").single();
        throwIfError(written.error, "Supabase could not save your game.");
        let preference = null;
        if (update.preferences) {
          const choice = normalizePreferences(update.preferences).scoreSaveChoice;
          const prefWrite = await supabase.from("user_preferences").upsert({ user_id: user.id, score_save_choice: choice }, { onConflict: "user_id" }).select("score_save_choice").single();
          throwIfError(prefWrite.error, "Supabase could not save your score preference.");
          preference = prefWrite.data;
        } else preference = await maybeSingle(supabase.from("user_preferences").select("score_save_choice").eq("user_id", user.id), null);
        return normalizeData({ save: written.data, preferences: preference, stats: await statsFor(user) });
      }, () => guest.saveUserData(update));
    },
    async recordRound(round = {}) {
      return signedInOrGuest(async (user) => {
        const result = await supabase.from("round_scores").upsert({
          id: round.id ?? newRoundId(crypto), user_id: user.id, mode: round.mode ?? "career", court: round.court ?? null,
          score: integer(round.score), passes: integer(round.passes), best_one_touch: integer(round.bestOneTouch),
          triangles: integer(round.triangles), oles: integer(round.oles), splits: integer(round.splits), zones: integer(round.zones),
          difficulty: difficulty(round.difficulty),
        }, { onConflict: "id", ignoreDuplicates: true });
        throwIfError(result.error, "Supabase could not record that round.");
        return statsFor(user);
      }, () => guest.recordRound(round));
    },
    async getLeaderboard({ mode = "career", court, difficulty: tier, limit = 10 } = {}) {
      try {
        let query = supabase.from("leaderboard_entries").select("username, mode, court, score, passes, best_one_touch, triangles, oles, splits, zones, difficulty, created_at").eq("mode", mode);
        if (court !== undefined && court !== null) query = query.eq("court", court);
        if (tier !== undefined && tier !== null) query = query.eq("difficulty", difficulty(tier));
        const result = await query.order("score", { ascending: false }).order("created_at", { ascending: true }).limit(Math.min(Math.max(integer(limit), 1), 100));
        throwIfError(result.error, "Supabase could not load the leaderboard.");
        return { mode, court: court ?? null, difficulty: tier ?? null, entries: (result.data ?? []).map((row) => ({ username: row.username ?? "Player", score: number(row.score), passes: integer(row.passes), bestOneTouch: integer(row.best_one_touch), triangles: integer(row.triangles), oles: integer(row.oles), splits: integer(row.splits), zones: integer(row.zones), difficulty: difficulty(row.difficulty), createdAt: row.created_at })) };
      } catch (error) {
        throw errorFrom(error, "Supabase could not load the leaderboard.");
      }
    },
  };
}

// Kept separate from the synchronous, injectable adapter factory so raw
// source-mode browser tests (which do not resolve npm bare specifiers) remain
// entirely local. Vite sees and bundles this dynamic import for real builds.
export async function createConfiguredSupabaseDataAdapter({ url, publishableKey, client, ...options } = {}) {
  if (!client && (!url || !publishableKey))
    throw new LocalDataError("STORAGE_REQUIRED", "Supabase URL and publishable key must be configured.");
  if (!client) {
    let createClient;
    try {
      ({ createClient } = await import("@supabase/supabase-js"));
    } catch (error) {
      throw errorFrom(error, "Supabase could not load in this browser.");
    }
    client = createClient(url, publishableKey, {
      // true is required for the Discord OAuth redirect to be picked up: the
      // session comes back in the return URL, and the client library only
      // parses and clears it from there when this is on. Email/password
      // sign-in never puts anything in the URL, so this is a no-op for it.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
  }
  return createSupabaseDataAdapter({ ...options, url, publishableKey, client });
}
