import {
  Game,
  COURTS,
  TACTICS,
  DIFFICULTIES,
  applyDifficulty,
  distance,
  clamp,
  bankPoint,
  splitTightness,
  segmentDistance,
  TRIANGLE_WINDOW,
  PLAYER_RADIUS,
  ONE_TOUCH,
} from "../../../packages/engine/src/game.js";
import { Renderer } from "../../../packages/presentation/src/renderer.js";
import {
  freshProgress,
  readProgress,
  saveProgress,
  awardMatch,
  rank,
} from "../../../packages/engine/src/progress.js";
import { Sound } from "../../../packages/presentation/src/audio.js";
import { getVenue } from "../../../packages/engine/src/venues.js";
import {
  ACTIONS,
  PRESETS,
  defaultSettings,
  loadSettings,
  saveSettings,
  presetBindings,
  actionForCode,
  actionDown,
  bindKey,
  clearBinding,
  readableKey,
  captureAllowed,
  DEFAULT_GAMEPAD_BINDINGS,
  GAMEPAD_SHORT_LABELS,
} from "../../../packages/engine/src/settings.js";
import { createLocalDataAdapter, selectDataAdapter, LocalDataError } from "../../../packages/data/src/index.js";
import { createMusic } from "./music.js";
import { TRACKS } from "./playlist.js";
import { SAMPLES } from "./samples.js";
import {
  HOME_ZONE_ORDER,
  withinZone,
  nextZone,
  restoreInZone,
  zoneContaining,
  resolveHomeMove,
} from "./pad-zones.mjs";
const $ = (id) => document.getElementById(id);
// Vite replaces this allowlisted object during a build. The fallback keeps
// source-served development and browser tests identifiable without exposing
// process environment values to the client.
const buildIdentity = typeof __TIKI_TAKA_BUILD__ !== "undefined"
  ? __TIKI_TAKA_BUILD__
  : { stage: "ALPHA", version: "dev", sha: "local", build: "local" };
const buildIdentityText = `${buildIdentity.stage} · v${buildIdentity.version} · ${buildIdentity.sha}${
  buildIdentity.build === "local" ? " · local" : ` · build ${buildIdentity.build}`
}`;
const buildIdentityElement = $("build-identity");
if (buildIdentityElement) {
  buildIdentityElement.textContent = buildIdentityText;
  buildIdentityElement.setAttribute("aria-label", `Build identity: ${buildIdentityText}`);
}
// Discord (or another OAuth provider) redirects back with `error` /
// `error_description` in the query or hash when the player cancels or the
// provider fails - e.g. closing the Discord consent window partway through.
// Read it before anything else touches the URL: supabase-js's
// detectSessionInUrl (see packages/data/src/supabase.js) clears it once the
// client below has parsed it, whether or not this build even shows an
// account dialog.
const oauthReturnError = (() => {
  const params = new URLSearchParams(`${location.search.slice(1)}&${location.hash.slice(1)}`);
  return params.get("error_description") || params.get("error") || null;
})();
let storage;
try {
  storage = window.localStorage;
} catch {
  storage = null;
}
const memory = new Map();
const dataStorage = storage || {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};
// Supabase's publishable browser configuration is supplied at build/serve
// time. With neither value present, there is no account system at all: the
// adapter falls back to guest-only local storage and the game keeps working
// offline, with no sign-in UI offered (see accountsAvailable below).
const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL?.trim();
const supabasePublishableKey = import.meta.env?.VITE_SUPABASE_PUBLISHABLE_KEY?.trim();
// Browser tests can supply an in-memory adapter before this module evaluates.
// It is intentionally not a deployment setting and is ignored unless the
// exact test-only factory global is present.
const testDataAdapterFactory = globalThis.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__;
let dataAdapter = testDataAdapterFactory
  ? await testDataAdapterFactory({ storage: dataStorage })
  : await selectDataAdapter({
      supabaseUrl,
      supabasePublishableKey,
      storage: dataStorage,
    });
let initialData;
let storageFallback = false;
let remoteDataUnavailable = false;
// Set when the stored save (remote row or local guest key) is real but was
// written by a version of Tiki Taka newer than this one, so its `progress`
// carries a version this build does not understand. The old failure mode
// here was normalizeProgress() silently folding that into freshProgress()
// and the next autosave writing that empty progress straight over the real
// save. Instead: play with a synthetic, unsaved snapshot, tell the player
// the truth, and keep dataAdapter exactly as it was so the real save stays
// untouched. persist(), persistSettings() and saveScorePreference() all
// check this flag before calling saveUserData().
let progressTooNew = false;
// A synthetic, deliberately unsaved snapshot used whenever the real save is
// present but unreadable (see progressTooNew above) - never written back
// anywhere, just enough to let the player look around.
function progressTooNewSnapshot() {
  return {
    progress: freshProgress(),
    settings: defaultSettings(),
    stats: {
      games: 0,
      bestScore: 0,
      totalPasses: 0,
      bestOneTouch: 0,
      totalTriangles: 0,
      totalOles: 0,
      totalSplits: 0,
      totalZones: 0,
    },
    preferences: { scoreSaveChoice: "ask" },
  };
}
try {
  initialData = await dataAdapter.loadUserData();
} catch (error) {
  if (error instanceof LocalDataError && error.code === "PROGRESS_TOO_NEW") {
    progressTooNew = true;
    initialData = progressTooNewSnapshot();
  } else {
    // A configured remote adapter must retain its identity and session if a
    // transient profile/save read fails. Use local data only as a temporary
    // playable snapshot; never silently replace the remote adapter with it.
    const fallback = createLocalDataAdapter({
      storage:
        dataStorage === storage
          ? {
              getItem: (key) => memory.get(key) ?? null,
              setItem: (key, value) => memory.set(key, value),
              removeItem: (key) => memory.delete(key),
            }
          : dataStorage,
    });
    if (dataAdapter.kind === "supabase") {
      remoteDataUnavailable = true;
      initialData = await fallback.loadUserData();
    } else {
      storageFallback = true;
      dataAdapter = fallback;
      initialData = await dataAdapter.loadUserData();
    }
  }
}
let progress = initialData.progress;
let settings = initialData.settings;
let accountStats = initialData.stats;
let preferences = initialData.preferences || { scoreSaveChoice: "ask" };
let profile = null;
// Set at boot when a session exists but has no profiles row yet - a
// first-time Discord sign-in, or a player who abandoned the username prompt
// last time (see completeProfile in packages/data/src/supabase.js). Held
// here rather than acted on immediately: the account/username dialogs are
// wired up later, once the shell has finished booting.
let pendingUsernamePrompt = null;
// Only the Supabase adapter has a session to ask about; the guest adapter
// has no accounts at all.
if (dataAdapter.kind === "supabase") {
  try {
    const session = await dataAdapter.getSession();
    if (session?.needsUsername) pendingUsernamePrompt = session.user;
    else profile = session?.profile || null;
  } catch {
    remoteDataUnavailable = true;
  }
}
// The account entry point in the header only makes sense once there is an
// account system to open it onto. With no Supabase configuration, hiding it
// (rather than showing it disabled) is the cleaner read: there is nothing
// for it to lead to, and the game is fully playable as a guest either way.
const accountsAvailable = dataAdapter.kind === "supabase";
if (!accountsAvailable) {
  $("profile-button").hidden = true;
  $("account-button").hidden = true;
  $("discord-signin").hidden = true;
}
// One switch used to cover everything, and it lived on `progress.sound`.
// Effects and music now have a switch and a level each, in settings. A player
// who had turned the old switch off must not be blasted on the next launch, so
// the first run after the split folds the old boolean into all four fields;
// `audioMigrated` makes that a one-time step so a later "music off, effects on"
// is never overwritten by it. `progress.sound` is still written so an older
// saved profile keeps a value that agrees with "is anything audible".
if (!settings.audioMigrated) {
  settings.effectsOn = progress.sound;
  settings.musicOn = progress.sound;
  settings.audioMigrated = true;
}
const sound = new Sound(settings.effectsOn, settings.effectsVolume);
// Sampled effects, if any are listed. The URL is resolved exactly the way the
// soundtrack's is: a build copies these next to index.html, and the dev server
// serves public/ at the same place, so one relative URL is right either way.
// An empty list (the default) leaves every effect on its synthesised voice
// with no fetch at all. See apps/desktop/src/samples.js.
sound.useSamples(
  SAMPLES.map((sample) => ({
    ...sample,
    url: new URL(`./audio/effects/${sample.file}`, document.baseURI).href,
  })),
);
const music = createMusic({
  tracks: TRACKS,
  // A build copies the tracks next to index.html (scripts/build.mjs) and the
  // dev server serves public/ at that same place, so this one relative URL is
  // correct in both. It used to branch on PROD and reach for /public/ in
  // development, which the dev server answers with index.html rather than a
  // 404 — the decode then fails silently and the music simply never plays.
  resolve: (track) => new URL(`./audio/${track.file}`, document.baseURI).href,
  trim: settings.musicVolume,
});
music.setEnabled(settings.musicOn);
const renderer = new Renderer($("court"));
// Court thumbnails are decorative—the full-size selected-court preview is
// still rendered synchronously—so their six PNG conversions do not belong in
// module startup. Keep a generation so a later progress refresh can invalidate
// callbacks queued for the old list.
let courtThumbnailGeneration = 0;
// Two views now. #courts was the courts page's own hash; it survives here only
// so an old bookmark lands on home rather than nowhere.
const viewForHash = () => (location.hash === "#play" ? "arena" : "home");
let mode = "career",
  courtIndex = progress.lastCourt,
  selectedCourtIndex = Math.min(progress.lastCourt || 0, progress.unlocked ?? 0),
  selectedHomeMode = "career",
  game,
  phase = "ready",
  // A cold load always opens home. applyView() pushes #play when a round
  // starts, so that hash outlives the session in history, bookmarks and
  // reopened tabs; honouring it on boot drops a returning player straight into
  // the arena, where the ready-state overlay reads as a pause menu they never
  // asked for. Within a session the hash still drives the view (see the
  // hashchange listener), so back and forward behave — only this first paint
  // ignores it, and the boot below rewrites the URL so it cannot then lie.
  view = "home",
  bank = false,
  focusToggle = false,
  boostToggle = false;
let keys = new Set(),
  aim = null,
  pointerMove = null,
  stick = { x: 0, y: 0 },
  gamepadMove = { x: 0, y: 0 },
  gamepadFocus = false,
  gamepadBoost = false;
const ACTION_BUTTON_MAP = {
  smartPass: "pass-button",
  wallToggle: "bank-button",
  shout: "shout-button",
  focusHold: "focus-button",
  boostHold: "boost-button",
};
const ACTION_NAMES = Object.keys(ACTION_BUTTON_MAP);
const actionHighlightUntil = {
  smartPass: 0,
  wallToggle: 0,
  shout: 0,
  focusHold: 0,
  boostHold: 0,
};
const gamepadPressedActions = {
  smartPass: false,
  wallToggle: false,
  shout: false,
  focusHold: false,
  boostHold: false,
};
const actionPressedCache = {
  smartPass: false,
  wallToggle: false,
  shout: false,
  focusHold: false,
  boostHold: false,
};
let toolbarActionButtons = null;
function getToolbarActionButton(action) {
  if (!toolbarActionButtons) {
    toolbarActionButtons = {
      smartPass: $("pass-button"),
      wallToggle: $("bank-button"),
      shout: $("shout-button"),
      focusHold: $("focus-button"),
      boostHold: $("boost-button"),
    };
  }
  return toolbarActionButtons[action];
}
function triggerActionHighlight(action, duration = 180) {
  if (action in actionHighlightUntil) {
    actionHighlightUntil[action] = performance.now() + duration;
    const btn = getToolbarActionButton(action);
    if (btn && !actionPressedCache[action]) {
      actionPressedCache[action] = true;
      btn.classList.add("action-pressed");
    }
  }
}
function syncActionHighlights(now) {
  if (view !== "arena") return;
  for (const action of ACTION_NAMES) {
    const btn = getToolbarActionButton(action);
    if (!btn) continue;
    let held = gamepadPressedActions[action];
    if (!held) {
      if (action === "smartPass") {
        held =
          actionDown(settings.bindings, keys, "smartPass") ||
          actionDown(settings.bindings, keys, "direct1") ||
          actionDown(settings.bindings, keys, "direct2") ||
          actionDown(settings.bindings, keys, "direct3") ||
          actionDown(settings.bindings, keys, "direct4");
      } else if (action === "wallToggle") {
        held =
          actionDown(settings.bindings, keys, "wallToggle") ||
          actionDown(settings.bindings, keys, "wallHold");
      } else if (action === "shout") {
        held = actionDown(settings.bindings, keys, "shout");
      } else if (action === "focusHold") {
        held = actionDown(settings.bindings, keys, "focusHold");
      } else if (action === "boostHold") {
        held = actionDown(settings.bindings, keys, "boostHold");
      }
    }
    const triggered = (actionHighlightUntil[action] || 0) > now;
    const isPressed = Boolean(held || triggered);
    if (isPressed !== actionPressedCache[action]) {
      actionPressedCache[action] = isPressed;
      btn.classList.toggle("action-pressed", isPressed);
    }
  }
}
let padPrevious = [],
  padConnected = false,
  // The toolbar's key chips track which input the player is actually using,
  // not merely whether a pad is connected — a pad can stay plugged in for a
  // whole session while the player never touches it, so switching on
  // connection alone would show gamepad glyphs to a keyboard player.
  inputSource = "keyboard",
  menuRepeat = 0,
  sliderRepeat = 0,
  finished = false,
  roundCleared = false,
  lastTime = 0,
  toastTimeout,
  announcementTimeout,
  announcementTime = 0,
  focusEarnedTimeout,
  resultRevealTimeout,
  resultActionsReady = true;
const RESULT_ACTION_DELAY = 1200;
let capture = null;
let padFocusElement = null;
let lastInteractionWasPointer = false;
// The completed round is held only until a player explicitly chooses how to
// handle score saving. Its id is deliberately stable across an auth handoff or
// retry so the remote adapter can make submissions idempotent.
let pendingScoreRounds = [];
let saveScoreAfterAuthentication = false;
let dataContextGeneration = 0;
let remoteRecoveryPromise = null;
let pendingDrainPromise = null;
// The pause menu is the one in-round menu. It owns Resume, Restart, Home and
// Settings so nothing important hides behind a drawer. Home, not Courts: the
// court picker and the title screen are the same screen now.
let menuOpen = false;
let menuReturnFocus = null;
// A turnover freezes the round until the player asks for it back, so putting
// the controller down for a moment never costs the next possession.
let awaitingResume = false,
  holdKeys = new Set(),
  holdPointers = new Set(),
  holdElapsed = 0;
let pointerId = null,
  joystickId = null,
  joystickOrigin = null;
// The renderer only rotates the pitch when told to (see renderer.render's
// `orientation` option and its `screenToWorld`/`screenVectorToWorld`
// helpers, which every touch/mouse input below is routed through) — without
// this it draws landscape forever, and touch input would keep mapping to the
// un-rotated court underneath a rotated pitch. `viewportOrientation` tracks
// the same query so a genuine rotation (not just a resize) can clear a
// captured pointer and pause, matching the deleted APK's own resize
// listener: a joystick pointer captured before the rotation is now aimed at
// the wrong axis, and a stuck capture reads as a dead stick.
const portraitQuery = matchMedia("(orientation: portrait)");
let viewportOrientation = portraitQuery.matches ? "portrait" : "landscape";
// Home reads as Back beside the music player, which is where the phone bar
// wants it — but "desktop must not move" is the one hard rule every section
// of this rework answers to, and desktop had Home on the right, between Menu
// and the profile chip, long before this round. Reparenting beats a CSS-only
// reorder here: `.top-bar-left`/`.top-bar-right` are separate flex rows
// either side of the centred wordmark (see `.top-bar`'s grid), and nothing
// in CSS can move one child from one flex container to another. 1025px
// matches the floor named in the brief, not the bar's own 900/1024 tiers.
const desktopBarQuery = matchMedia("(min-width: 1025px)");
function syncHomePlacement() {
  const home = $("top-home");
  if (!home) return;
  if (desktopBarQuery.matches) {
    $("top-bar-right").insertBefore(home, $("profile-button"));
  } else {
    $("top-bar-left").insertBefore(home, $("music-player"));
  }
}
syncHomePlacement();
desktopBarQuery.addEventListener("change", syncHomePlacement);
// Same breakpoint the phone settings sheet uses in style.css (see the
// `.settings-gamepad`/`.settings-bindings` <details> comments there) — kept
// as one query here rather than repeated inline so the two stay in step.
const compactSettingsQuery = matchMedia(
  "(max-width: 900px), (pointer: coarse) and (max-width: 1024px)",
);
// Shown whenever a save is refused because the stored save (remote or local
// guest) is unreadable by this build - see `progressTooNew` above. Kept as
// one string so the boot toast and every blocked autosave agree.
const PROGRESS_TOO_NEW_MESSAGE =
  "Your save is from a newer version of Tiki Taka. Reload the page to update - this session's progress will not be saved until you do.";
function persist() {
  if (progressTooNew) {
    toast(PROGRESS_TOO_NEW_MESSAGE);
    return;
  }
  if (remoteDataUnavailable && onlineAccount()) {
    void recoverRemoteDataContext();
    return;
  }
  void dataAdapter
    .saveUserData({ progress })
    .catch(() =>
      toast("Progress is available for this session but could not be stored."),
    );
  if (!profile && (!storage || !saveProgress(storage, progress))) {
    toast("Progress could not be saved on this browser.");
  }
}
function persistSettings() {
  if (progressTooNew) {
    toast(PROGRESS_TOO_NEW_MESSAGE);
    return;
  }
  if (remoteDataUnavailable && onlineAccount()) {
    void recoverRemoteDataContext();
    return;
  }
  void dataAdapter
    .saveUserData({ settings })
    .catch(() =>
      toast("Settings are available for this session but could not be stored."),
    );
  if (!profile && storage && !saveSettings(storage, settings))
    toast("Settings could not be saved on this browser.");
}
const GAMEPAD_ICON_SVG = `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 11h4M8 9v4M15 12h.01M18 10h.01"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>`;

function toast(text, icon = "") {
  if (icon) {
    $("toast").innerHTML = `${icon}<span>${text}</span>`;
  } else {
    $("toast").textContent = text;
  }
  $("toast").classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $("toast").classList.remove("visible"), 4000);
}
if (progressTooNew) setTimeout(() => toast(PROGRESS_TOO_NEW_MESSAGE), 0);
else if (remoteDataUnavailable)
  setTimeout(() => toast("Account data is temporarily unavailable. Your game is still playable."), 0);
if (oauthReturnError) setTimeout(() => toast(`Discord sign-in didn't complete: ${oauthReturnError}`), 0);
// openUsernamePrompt is a function declaration further down, alongside the
// rest of the account dialog wiring - hoisted, so this boot-time call to it
// is fine even though it appears first in the file.
if (pendingUsernamePrompt) setTimeout(() => openUsernamePrompt(pendingUsernamePrompt), 0);
async function recordRound(round) {
  if (remoteDataUnavailable && onlineAccount()) {
    if (!(await recoverRemoteDataContext())) return false;
  }
  const roundProfileId = profile?.id || null;
  try {
    const nextStats = await dataAdapter.recordRound(round);
    if ((profile?.id || null) !== roundProfileId) return true;
    accountStats = nextStats;
    syncHome();
    return true;
  } catch (error) {
    return false;
  }
}
function queuePendingScore(round, ownerId = null) {
  if (!pendingScoreRounds.some((item) => item.round.id === round.id))
    pendingScoreRounds.push({ round, ownerId });
}
function showScoreSaveDialog(status = "") {
  if (!pendingScoreRounds.length || preferences.scoreSaveChoice !== "ask") return;
  $("score-save-status").textContent = status;
  if (!$("score-save-dialog").open) $("score-save-dialog").showModal();
}
async function saveScorePreference(choice) {
  if (progressTooNew) throw new Error(PROGRESS_TOO_NEW_MESSAGE);
  if (remoteDataUnavailable && onlineAccount())
    throw new Error("Account data is temporarily unavailable. Reconnect before saving this choice.");
  const nextPreferences = { ...preferences, scoreSaveChoice: choice };
  await dataAdapter.saveUserData({ preferences: nextPreferences });
  preferences = nextPreferences;
}
async function savePendingScores() {
  if (pendingDrainPromise) return pendingDrainPromise;
  pendingDrainPromise = (async () => {
    let allSaved = true;
    const remaining = [];
    for (const item of pendingScoreRounds) {
      if (item.ownerId && item.ownerId !== profile?.id) {
        remaining.push(item);
        continue;
      }
      if (!(await recordRound(item.round))) {
        allSaved = false;
        remaining.push(item);
      }
    }
    pendingScoreRounds = remaining;
    return allSaved;
  })();
  try {
    return await pendingDrainPromise;
  } finally {
    pendingDrainPromise = null;
  }
}
const anyDialogOpen = () =>
  $("settings-dialog").open ||
  $("help-dialog").open ||
  $("account-dialog").open ||
  $("score-save-dialog").open;
// Any menu that must swallow gameplay input before it reaches the court.
const menuBlocking = () => menuOpen || anyDialogOpen();
function syncPauseMenu() {
  const open = menuOpen && view === "arena";
  $("pause-menu").hidden = !open;
  document.body.classList.toggle("menu-open", open);
  // The pause menu covers the court, so the start/finish overlay and the
  // resume prompt step aside rather than stacking underneath it.
  $("game-overlay").inert = open;
  syncResumePrompt();
}
function openMenu() {
  if (view !== "arena" || menuOpen) return;
  clearInput();
  closeMusicPopup();
  menuReturnFocus = document.activeElement;
  menuOpen = true;
  syncPauseMenu();
  padFocus($("pause-resume"));
}
// Pausing always lands on the menu; from a ready or finished court the menu is
// still the way to reach Home and Settings.
function openPauseMenu() {
  if (view !== "arena") return;
  if (phase === "playing") pause();
  else openMenu();
}
function closePauseMenu({ restoreFocus = true } = {}) {
  if (!menuOpen) return;
  menuOpen = false;
  syncPauseMenu();
  if (restoreFocus)
    (menuReturnFocus?.isConnected ? menuReturnFocus : $("court"))?.focus({
      preventScroll: true,
    });
  menuReturnFocus = null;
}
// Leaving the menu resumes the round when there was one to resume.
function dismissPauseMenu() {
  const wasPaused = phase === "paused";
  closePauseMenu({ restoreFocus: !wasPaused });
  if (wasPaused) resume();
}
function syncTitle() {
  const resumable = phase === "paused" || phase === "playing";
  const isResumingSelected =
    resumable &&
    selectedCourtIndex === courtIndex &&
    selectedHomeMode === mode;
  const court =
    COURTS[isResumingSelected ? courtIndex : selectedCourtIndex] || COURTS[0];
  $("title-play").lastChild.textContent = isResumingSelected
    ? " Resume"
    : selectedHomeMode === "practice"
      ? " Practice"
      : " Play";
  $("title-play-copy").textContent = isResumingSelected
    ? (selectedHomeMode === "practice"
        ? `${court.name} · Free Practice in progress`
        : `${game.config.name} · ${Math.max(0, Math.ceil(game.time))} seconds remain`)
    : selectedHomeMode === "practice"
      ? `${court.name} · Free Practice`
      : `${court.name} · ${court.place}`;
}
function selectCourt(i) {
  if (i < 0 || i >= COURTS.length || i > progress.unlocked) return;
  selectedCourtIndex = i;
  document.querySelectorAll("#court-list .court-item").forEach((b, idx) => {
    const isSelected = idx === i;
    b.classList.toggle("active", isSelected);
    b.setAttribute("aria-current", isSelected ? "true" : "false");
  });
  document.querySelectorAll("[data-home-mode]").forEach((btn) => {
    const active = btn.dataset.homeMode === selectedHomeMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  syncTitle();
  setAttractVenue(attractVenueForCourt(i));
  selectHomeLeaderboardCourt(i);
  // A gamepad player's cursor was just sitting in the courts zone; follow the
  // flow into modes rather than leaving it stranded on the list. Mouse and
  // keyboard users keep their own focus — nothing here should yank it.
  if (inputSource === "gamepad") {
    const active = document.querySelector("[data-home-mode].active");
    if (active) focusHomeZone("modes", active);
  }
}
function deferCourtThumbnails(list, generation) {
  const thumbnails = [...list.querySelectorAll(".court-thumb")];
  let next = 0;
  const populateNext = () => {
    // syncProgress() replaces the list. Never spend work painting an old,
    // detached set of thumbnails.
    if (generation !== courtThumbnailGeneration || !list.isConnected) return;
    const thumbnail = thumbnails[next++];
    if (thumbnail) {
      const court = COURTS[Number(thumbnail.dataset.courtIndex)];
      if (court) thumbnail.src = renderer.courtPreview(court, 120, 75);
      // One canvas/data-URL conversion per frame avoids replacing startup
      // work with a single delayed long task on slower devices.
      requestAnimationFrame(populateNext);
    }
  };
  // Two frames ensures the browser has an opportunity to paint the complete
  // home UI before the first non-critical preview conversion begins.
  requestAnimationFrame(() => requestAnimationFrame(populateNext));
}
// progress.courts[i] is sparse and per-tier now: {relaxed?, standard?,
// ruthless?}, each {stars, best}. These three helpers are the one place that
// reads that shape so every other call site (home totals, the court list)
// stays agnostic of which tiers happen to be present.
function starsForTier(courtIndexValue, tier) {
  return progress.courts?.[courtIndexValue]?.[tier]?.stars || 0;
}
function bestStarsForCourt(courtIndexValue) {
  return Math.max(0, ...DIFFICULTIES.map((tier) => starsForTier(courtIndexValue, tier.id)));
}
function totalStarsForCourt(courtIndexValue) {
  return DIFFICULTIES.reduce((sum, tier) => sum + starsForTier(courtIndexValue, tier.id), 0);
}
function syncHome() {
  if ($("home-view")) syncTitle();
  $("home-stars").textContent = String(
    COURTS.reduce((total, _court, i) => total + totalStarsForCourt(i), 0),
  );
  $("home-cleared").textContent =
    `${COURTS.filter((_court, i) => bestStarsForCourt(i) > 0).length} / ${COURTS.length}`;
  const best = Math.max(0, ...Object.values(progress.records || {}));
  $("home-best").textContent = best ? String(best) : "—";
  $("home-games").textContent = String(accountStats.games);
  $("home-total-passes").textContent = String(accountStats.totalPasses);
  $("home-best-one-touch").textContent = String(accountStats.bestOneTouch);
  syncHomeLeaderboard();
}



const DIFFICULTY_IDS = DIFFICULTIES.map((tier) => tier.id);
// A three-letter abbreviation for space-constrained UI (the leaderboard
// header's segmented toggle, the court list's tier tag). A plain
// name.slice(0, 3) mangled "Standard" into "STA" — an explicit map so every
// known tier gets an actual short word, with the slice only as a fallback
// for some future tier id this map hasn't been taught yet.
const DIFFICULTY_SHORT_LABELS = { relaxed: "REL", standard: "STD", ruthless: "RUT" };
function shortTierLabel(id) {
  return DIFFICULTY_SHORT_LABELS[id] || String(id).slice(0, 3).toUpperCase();
}
let homeLeaderboardCourt = 0;
// Scores are not comparable across tiers, so the deck always shows exactly
// one tier at a time rather than an "all" blend. Defaults to standard.
let homeLeaderboardDifficulty = "standard";

// Built once from DIFFICULTIES — never hardcoded — so the toggle always
// matches whatever tiers the engine defines. Labels are abbreviated (REL /
// STD / RUT) rather than full names: the header used to also carry a
// separate badge repeating the active tier's full name right next to this
// toggle's own active segment, which read as the same word printed twice in
// a row, and the full names ("RELAXED"/"STANDARD"/"RUTHLESS") were wide
// enough to wrap "CIRCUIT LEADERBOARDS" onto a second line at 1080px. The
// selected segment alone now carries the meaning — the full name is still
// available as the accessible name and the hover title.
function renderHomeLeaderboardDifficultyToggle() {
  const host = $("hl-difficulty-toggle");
  if (!host) return;
  host.replaceChildren(
    ...DIFFICULTIES.map((tier) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hl-diff-btn";
      btn.dataset.tier = tier.id;
      btn.textContent = shortTierLabel(tier.id);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", `${tier.name} — ${tier.label}`);
      btn.title = `${tier.name} — ${tier.label}`;
      btn.addEventListener("click", () => selectHomeLeaderboardDifficulty(tier.id));
      return btn;
    }),
  );
  syncHomeLeaderboardDifficultyButtons();
}

function syncHomeLeaderboardDifficultyButtons() {
  document.querySelectorAll("#hl-difficulty-toggle .hl-diff-btn").forEach((btn) => {
    const isActive = btn.dataset.tier === homeLeaderboardDifficulty;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
  });
}

function selectHomeLeaderboardDifficulty(tier) {
  homeLeaderboardDifficulty = DIFFICULTY_IDS.includes(tier) ? tier : "standard";
  syncHomeLeaderboardDifficultyButtons();
  void syncHomeLeaderboard(homeLeaderboardCourt);
}

function selectHomeLeaderboardCourt(courtIdx) {
  homeLeaderboardCourt = Math.max(0, Math.min(COURTS.length - 1, Number(courtIdx) || 0));
  const tabs = document.querySelectorAll(".hl-tab");
  tabs.forEach((tab) => {
    const isActive = Number(tab.dataset.court) === homeLeaderboardCourt;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
    tab.tabIndex = isActive ? 0 : -1;
  });
  void syncHomeLeaderboard(homeLeaderboardCourt);
}

let leaderboardFetchId = 0;

async function syncHomeLeaderboard(courtIdx = homeLeaderboardCourt, tier = homeLeaderboardDifficulty) {
  const list = $("home-leaderboard-list");
  if (!list) return;
  const statusEl = $("home-leaderboard-status");
  const fetchId = ++leaderboardFetchId;

  // Bonus counts are secondary to score, so a bonus cell dims itself when it
  // is zero — the same "nothing to see here" language the results modal
  // uses for its own breakdown grid (.result-stat.is-zero).
  function bonusCell(value, extraClass) {
    const cell = document.createElement("span");
    cell.className = `hl-cell-bonus ${extraClass || ""}`.trim();
    const n = Number(value) || 0;
    cell.textContent = String(n);
    cell.classList.toggle("is-zero", n === 0);
    return cell;
  }

  function renderEntries(entries) {
    if (statusEl) {
      statusEl.textContent = entries.length ? "" : "No scores recorded yet for this court.";
      statusEl.classList.remove("is-error");
    }
    list.replaceChildren(
      ...entries.slice(0, 10).map((entry, idx) => {
        const li = document.createElement("li");
        const rankNum = entry.rank ?? idx + 1;
        const isTop3 = rankNum <= 3;
        const isCurrentUser =
          profile?.username &&
          entry.name &&
          entry.name.toLowerCase() === profile.username.toLowerCase();
        li.className = `hl-row ${isTop3 ? "hl-row-top" : ""} ${isCurrentUser ? "hl-row-current-user" : ""}`;

        const rank = document.createElement("span");
        rank.className = "hl-cell-rank";
        rank.textContent = entry.medal || (idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : String(idx + 1));

        const player = document.createElement("span");
        player.className = "hl-cell-player";
        player.textContent = entry.name;

        const triangles = bonusCell(entry.triangles, "hl-cell-tri");
        const oles = bonusCell(entry.oles, "hl-cell-ole");
        const splits = bonusCell(entry.splits, "hl-cell-split");
        const zones = bonusCell(entry.zones, "hl-cell-zone");

        const passes = document.createElement("span");
        passes.className = "hl-cell-passes";
        passes.textContent = entry.passes != null ? Number(entry.passes).toLocaleString() : "—";

        const score = document.createElement("span");
        score.className = "hl-cell-score";
        score.textContent = Number(entry.score).toLocaleString();

        li.append(rank, player, oles, triangles, splits, zones, passes, score);
        return li;
      }),
    );
  }

  function syncUserBest(entries) {
    let userBestScore = 0;
    let userBestPasses = null;
    let userBestTriangles = 0;
    let userBestOles = 0;
    let userBestSplits = 0;
    let userBestZones = 0;

    if (progress?.records) {
      const directScore = progress.records[`court-${courtIdx}-${tier}`];
      if (typeof directScore === "number" && directScore > 0) {
        userBestScore = directScore;
      }
    }

    if (profile?.username && entries?.length) {
      const userMatches = entries.filter(
        (e) => e.name && e.name.toLowerCase() === profile.username.toLowerCase(),
      );
      if (userMatches.length) {
        for (const m of userMatches) {
          if (m.score > userBestScore) {
            userBestScore = m.score;
            userBestPasses = m.passes;
            userBestTriangles = m.triangles || 0;
            userBestOles = m.oles || 0;
            userBestSplits = m.splits || 0;
            userBestZones = m.zones || 0;
          }
        }
      }
    }

    const userRankEl = $("hl-user-rank");
    const userPlayerEl = $("hl-user-player") || $("hl-user-pilot");
    const userPassesEl = $("hl-user-passes");
    const userScoreEl = $("hl-user-score");

    if (userPlayerEl) userPlayerEl.textContent = profile?.username || "GUEST PLAYER";
    if (userPassesEl) userPassesEl.textContent = userBestPasses != null ? Number(userBestPasses).toLocaleString() : "—";
    if (userScoreEl) userScoreEl.textContent = userBestScore > 0 ? Number(userBestScore).toLocaleString() : "—";
    for (const [id, value] of [
      ["hl-user-triangles", userBestTriangles],
      ["hl-user-oles", userBestOles],
      ["hl-user-splits", userBestSplits],
      ["hl-user-zones", userBestZones],
    ]) {
      const el = $(id);
      if (!el) continue;
      el.textContent = String(value);
      el.classList.toggle("is-zero", value === 0);
    }
    if (userRankEl) {
      if (userBestScore === 0 || !entries?.length) {
        userRankEl.textContent = "—";
      } else {
        const matchIdx = entries.findIndex(
          (e) => e.score <= userBestScore,
        );
        userRankEl.textContent = matchIdx >= 0 ? `#${matchIdx + 1}` : `#${entries.length}+`;
      }
    }
  }

  if (!dataAdapter?.getLeaderboard) {
    if (statusEl) {
      statusEl.textContent = "Leaderboard unavailable offline.";
      statusEl.classList.add("is-error");
    }
    list.replaceChildren();
    syncUserBest([]);
    return;
  }

  if (statusEl) {
    statusEl.textContent = "Loading scores…";
    statusEl.classList.remove("is-error");
  }
  list.replaceChildren();
  syncUserBest([]);

  try {
    const board = await dataAdapter.getLeaderboard({
      mode: "career",
      court: courtIdx,
      difficulty: tier,
      limit: 10,
    });
    if (fetchId !== leaderboardFetchId) return;

    if (
      board?.entries?.length &&
      courtIdx === homeLeaderboardCourt &&
      tier === homeLeaderboardDifficulty
    ) {
      const loadedEntries = board.entries.map((e, idx) => ({
        rank: idx + 1,
        name: e.username,
        passes: e.passes,
        score: e.score,
        triangles: e.triangles || 0,
        oles: e.oles || 0,
        splits: e.splits || 0,
        zones: e.zones || 0,
        difficulty: e.difficulty || tier,
        medal: idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : String(idx + 1),
      }));
      renderEntries(loadedEntries);
      syncUserBest(loadedEntries);
    } else if (courtIdx === homeLeaderboardCourt && tier === homeLeaderboardDifficulty) {
      renderEntries([]);
      syncUserBest([]);
    }
  } catch {
    if (fetchId !== leaderboardFetchId) return;
    if (statusEl) {
      statusEl.textContent = "Unable to load leaderboard scores.";
      statusEl.classList.add("is-error");
    }
    list.replaceChildren();
    syncUserBest([]);
  }
}
function applyView(next, { updateHash = true } = {}) {
  view = next;
  if (next !== "arena" && phase === "playing") pause();
  $("home-view").hidden = view !== "home";
  $("arena-view").hidden = view !== "arena";
  if (view !== "arena") closePauseMenu({ restoreFocus: false });
  closeMusicPopup();
  // Exactly one game is live at a time: the demo is built on the way into home
  // and dropped on the way out, before the arena starts drawing.
  if (view === "home") {
    if (phase === "paused" || phase === "playing") {
      selectedCourtIndex = courtIndex;
      selectedHomeMode = mode;
    }
    startAttract();
  } else stopAttract();
  syncProgress();
  syncSettingChrome();
  syncPauseMenu();
  syncMusicRail();
  requestAnimationFrame(() => {
    if (anyDialogOpen() || menuOpen) return;
    if (view === "home") {
      if (inputSource === "gamepad") {
        padFocus($("title-play"));
      } else {
        $("title-play")?.classList.remove("pad-focus");
        if (lastInteractionWasPointer) {
          if (document.activeElement === $("title-play")) $("title-play")?.blur();
        } else {
          $("title-play")?.focus({ preventScroll: true });
        }
      }
    } else if ($("game-overlay").hidden) {
      $("court").focus({ preventScroll: true });
    } else {
      if (inputSource === "gamepad") {
        padFocus($("start-button"));
      } else {
        $("start-button")?.classList.remove("pad-focus");
        if (lastInteractionWasPointer) {
          if (document.activeElement === $("start-button")) $("start-button")?.blur();
        } else {
          $("start-button")?.focus({ preventScroll: true });
        }
      }
    }
  });
  if (updateHash) {
    const hash = view === "arena" ? "#play" : "";
    if (location.hash !== hash)
      history.pushState(null, "", hash || location.pathname + location.search);
  }
}
// --- Home's attract demo -------------------------------------------------
//
// A second Game and a second Renderer, with the bots keeping the ball among
// themselves, so the first thing a player sees is the game and not a
// description of it. Three rules hold it in its place:
//
//   * one loop. It is stepped from the shell's existing rAF loop rather than
//     starting a second one, so it cannot outlive the screen it belongs to or
//     run alongside the arena;
//   * it owns nothing. Its events feed its own renderer for the flourish and
//     are then dropped: no progress, no records, no round stats, no sound;
//   * it is invisible to input. The canvas is aria-hidden and not focusable,
//     and nothing here touches `game`, `phase` or the key state.
const attractCanvas = $("attract-court");
let attractGame = null,
  attractRenderer = null,
  attractPassIn = 0,
  // Wall passes are real gameplay the player has tuned by hand
  // (bestTarget() picks the safest lane, which is never a bank), so the demo
  // fakes an occasional one on top of bestTarget's normal choice rather than
  // touching how passing itself works. attractBankEvery randomizes "every
  // fourth to sixth pass" so it doesn't read as a metronome; the count only
  // advances on a real reception (see updateAttract), so a turnover can't
  // skip it early or make it lag behind.
  attractPassCount = 0,
  attractBankEvery = 4 + Math.floor(Math.random() * 3),
  // Set whenever the demo's venue changes (or the demo is (re)started) so a
  // reduced-motion viewer — who never runs the per-frame sim/paint below —
  // still gets exactly one repainted frame reflecting the new court, rather
  // than either a stale one or a redraw on every tick.
  attractNeedsRepaint = false,
  // Tracks demo.turnovers so a turnover (an interception, holding too long)
  // can be noticed from the outside and used to reset the choreography
  // below to its first set piece - the engine already resets its own
  // history and positions when this happens, so this only has to forget
  // which set piece it was mid-way through.
  attractTurnovers = 0;
// Court -> venue is read through the engine's own venue data rather than a
// hardcoded id list: getVenue() resolves a config by its seed, and COURTS[i]
// carries the same seed venues.js keys off, so the two can never disagree.
function attractVenueForCourt(i) {
  return getVenue(COURTS[i] || COURTS[0]).id;
}
// Re-skins the demo in place: background, accent and secondary colors only.
// Never touches seed, defenders, speed or target, so the rally already in
// progress keeps doing whatever it was doing — see Renderer.render(), which
// re-derives `this.venue` from `game.config` every frame.
function setAttractVenue(venueId) {
  if (!attractGame || attractGame.config.venue === venueId) return;
  attractGame.config.venue = venueId;
  attractNeedsRepaint = true;
}
// --- Choreographed rally --------------------------------------------------
//
// bestTarget() alone plays it safe - that's what makes it good for a real
// player - so left to its own devices the demo rarely produces a split, a
// triangle or a one-touch chain against three defenders. This is a
// showcase meant to demonstrate the game to someone who has never played
// it, not a simulation, so the sequence below is deliberately scripted and
// non-random: a small, reorderable table of set pieces cycles through the
// mechanics in a fixed order. Each one is scored with the exact same pure
// engine math the engine itself uses to award the bonus (splitTightness,
// TRIANGLE_WINDOW, PLAYER_RADIUS, ONE_TOUCH) rather than reimplementing the
// geometry here. When a set piece can't be executed on a given decision -
// no lane threads a defender pair, no teammate is standing in the zone -
// the demo keeps possession with an ordinary safe pass and simply tries
// that step again next time; it never stalls, forces a bad pass, or hangs
// on one step forever (see SET_PIECE_PATIENCE). Losing the ball resets the
// whole sequence back to "split" - see attractTurnovers above.
const SET_PIECES = ["split", "triangle", "onetouch", "zone"];
// Decision points (for split/zone) or passes thrown (for onetouch) a set
// piece gets before the demo gives up on it for this lap and moves on.
const SET_PIECE_PATIENCE = { split: 6, zone: 6, onetouch: 20 };
let choreoStep = 0;
let choreoAttempts = 0;
// Persists across the three forced passes of a triangle: { sequence, stage }.
let choreoTriangle = null;
// Count of passes thrown so far in the current one-touch chain.
let choreoOneTouch = 0;
function currentSetPiece() {
  return SET_PIECES[choreoStep % SET_PIECES.length];
}
function resetChoreography() {
  choreoStep = 0;
  choreoAttempts = 0;
  choreoTriangle = null;
  choreoOneTouch = 0;
}
// The same lane a direct (non-bank) pass is scored with in Game#pass.
function directLane(from, to) {
  return [
    { x: from.x, y: from.y },
    { x: to.x, y: to.y },
  ];
}
// Mirrors the triangle check in Game#receive without mutating anything, so
// a candidate pass can be tested before it's committed to.
function wouldCompleteTriangle(demo, target) {
  const history = [...demo.history, target].slice(-4);
  const times = [...demo.historyTimes, demo.elapsed].slice(-4);
  return (
    history.length >= 4 &&
    history.at(-4) === target &&
    new Set(history.slice(-3)).size === 3 &&
    demo.elapsed - times.at(-4) <= TRIANGLE_WINDOW
  );
}
// Split the press: thread the tightest defender pair a direct lane can
// cross. Skips any candidate that would also close a triangle on the same
// pass - only one of the two ever pays out (see Game#receive), so
// choreographing both at once would silently show just the triangle.
function chooseSplit(demo) {
  const from = demo.players[demo.carrier];
  let best = null;
  for (const p of demo.players) {
    if (p.id === demo.carrier || wouldCompleteTriangle(demo, p.id)) continue;
    const tightness = splitTightness(demo.defenders, directLane(from, p));
    if (tightness !== null && (!best || tightness > best.tightness)) {
      best = { id: p.id, tightness };
    }
  }
  return best ? best.id : null;
}
// A pass the engine intercepts (a defender within 20 of the ball's actual
// path - see Game#update) never reaches the target at all, triangle or not,
// so every lane a set piece throws is checked against this margin before
// it's thrown. Wider than the engine's own 20: defenders actively chase the
// ball once it's within 145 of them (see the press loop in Game#update), so
// a lane that's merely clear right now can still be run down mid-flight.
const LANE_CLEARANCE = 45;
function laneIsClear(demo, lane) {
  for (let s = 0; s < lane.length - 1; s++) {
    for (const d of demo.defenders) {
      if (segmentDistance(d, lane[s], lane[s + 1]) < LANE_CLEARANCE) return false;
    }
  }
  return true;
}
// Close a triangle purely from the bot's own pass history - it doesn't
// involve the defenders at all. Anchor on whoever currently has the ball
// and cycle it out to the other two teammates and back: exactly the
// A-B-C-A the engine's history check is looking for. The history math
// doesn't care whether the pass is direct or banked, so a route straight
// through a defender banks off the wall instead rather than getting
// intercepted before it ever completes the triangle.
function chooseTriangleTarget(demo) {
  if (!choreoTriangle) {
    const anchor = demo.carrier;
    const others = demo.players.map((p) => p.id).filter((id) => id !== anchor);
    choreoTriangle = { sequence: [others[0], others[1], anchor], stage: 0 };
  }
  const target = choreoTriangle.sequence[choreoTriangle.stage];
  const from = demo.players[demo.carrier],
    to = demo.players[target];
  // Prefer whichever route is actually clear; if neither is, still throw the
  // direct pass rather than stalling the sequence - an occasional
  // interception here is no worse than the one a real player risks.
  const bank =
    !laneIsClear(demo, directLane(from, to)) &&
    laneIsClear(demo, [from, bankPoint(from, to), to]);
  return { target, bank };
}
// A one-touch pass is just a release with no hold and no movement since the
// last reception - the demo already controls both, it just has to stop
// waiting between passes (see the immediate pacing in updateAttract).
// Cycling the ball around the four players reads as a quick give-and-go.
function chooseOneTouchTarget(demo) {
  return (demo.carrier + 1) % 4;
}
// One-touch is a QUEUED mechanic, not a fast-reaction one: a player presses
// pass while the ball is still travelling and Game#receive releases it the
// instant it lands (see queuePass() in the engine, and the
// "QUEUED -> N - RELEASE ON ARRIVAL" readout in the HUD). The demo used to
// wait for the ball, then throw about 100ms later - inside the engine's
// window, so it scored as a one-touch, but on screen it read as trapping the
// ball and holding it. Queueing mid-flight is both what a player actually
// does and what it should look like: the ball never settles.
function queueNextOneTouch(demo) {
  if (currentSetPiece() !== "onetouch") return;
  // Stop at one ole and hand the cycle on. This check HAS to live here rather
  // than in chooseChoreographedTarget(), which only runs while the ball is on
  // the floor (`!demo.ball`) - with every pass queued the ball is almost
  // never on the floor, so that path stops running and the step would never
  // end. Leaving the chain going is what turned the demo into a non-stop ole
  // reel that never showed a triangle or a split.
  if (demo.oneTouchStreak >= ONE_TOUCH.milestoneEvery) {
    // Deliberately queue nothing from here: the next reception has no pass
    // waiting, so the carrier holds it, the engine breaks the streak on its
    // own, and the demo moves on to the next set piece.
    choreoOneTouch = 0;
    choreoStep++;
    choreoAttempts = 0;
    return;
  }
  if (!demo.ball || demo.queuedPass) return;
  // The ball's destination is the next carrier, so the pass after this one
  // goes to whoever follows THEM in the round robin.
  const next = (demo.ball.to + 1) % 4;
  demo.queuePass(next, false);
}
// Hit the bonus zone: pass to whichever teammate is currently standing in
// it, if any are. The zone drifts on its own schedule so this often isn't
// available the moment the step starts - SET_PIECE_PATIENCE.zone covers it.
function chooseZoneTarget(demo) {
  if (!demo.zone) return null;
  for (const p of demo.players) {
    if (p.id === demo.carrier) continue;
    if (distance(p, demo.zone) <= demo.zone.r + PLAYER_RADIUS) return p.id;
  }
  return null;
}
// Advances the choreography's own state once a chosen pass has actually
// been thrown (demo.pass() returned true) - never on a decision that fell
// back to a normal pass, and never on one blocked by the engine's own pass
// cooldown, so a rapid one-touch retry can't silently burn through its
// patience budget before it ever gets to fire.
function advanceChoreography(demo, piece) {
  if (piece === "triangle") {
    choreoTriangle.stage++;
    if (choreoTriangle.stage >= choreoTriangle.sequence.length) {
      choreoTriangle = null;
      choreoStep++;
      choreoAttempts = 0;
    }
    return;
  }
  if (piece === "onetouch") {
    choreoOneTouch++;
    if (choreoOneTouch >= SET_PIECE_PATIENCE.onetouch) {
      choreoOneTouch = 0;
      choreoStep++;
      choreoAttempts = 0;
    }
    return;
  }
  // A split or a zone hit always closes out the step.
  choreoStep++;
  choreoAttempts = 0;
}
// Returns { target, bank } for the pass this frame's set piece wants, or
// null to fall back to a normal safe pass while it waits for its moment
// (and to keep the whole demo playable-looking rather than stalling on the
// mechanic).
function chooseChoreographedTarget(demo) {
  const piece = currentSetPiece();
  // The milestone bonus already fired inside Game#receive the moment the
  // tenth one-touch reception landed; there's nothing left for this step to
  // do, so move on before throwing a redundant eleventh pass.
  if (piece === "onetouch" && demo.oneTouchStreak >= ONE_TOUCH.milestoneEvery) {
    choreoOneTouch = 0;
    choreoStep++;
    choreoAttempts = 0;
    return null;
  }
  if (piece === "triangle") return chooseTriangleTarget(demo);
  if (piece === "onetouch") return { target: chooseOneTouchTarget(demo), bank: false };
  const target = piece === "split" ? chooseSplit(demo) : chooseZoneTarget(demo);
  if (target === null) {
    choreoAttempts++;
    if (choreoAttempts >= (SET_PIECE_PATIENCE[piece] ?? 6)) {
      choreoStep++;
      choreoAttempts = 0;
    }
    return null;
  }
  return { target, bank: false };
}
function startAttract() {
  if (!attractCanvas || attractGame) return;
  attractRenderer ||= new Renderer(attractCanvas, { maxDpr: 1 });
  attractRenderer.effects.length = 0;
  attractGame = new Game(
    {
      ...COURTS[1],
      name: "Attract",
      // Marks this instance as the demo. Two Games can be alive across a view
      // change, and anything watching from outside — a test probe on
      // Game.prototype.update, a debugging session — needs to be able to tell
      // the player's round from the one running behind the menu.
      attract: true,
      // Practice rules: unlimited possessions, so a demo left running on the
      // home screen can never stall on a turnover it has no way to dismiss.
      practice: true,
      target: 0,
      time: 120,
      speed: 74,
      defenders: 3,
      // Fixed, not Date.now(): the choreography below scripts specific
      // passes against this exact rally, so the seed that produces it -
      // teammate phase offsets, defender starting spots - has to be
      // reproducible rather than different on every visit to the home
      // screen.
      seed: 424242,
    },
    "balanced",
  );
  attractPassIn = 0.9;
  attractPassCount = 0;
  attractBankEvery = 4 + Math.floor(Math.random() * 3);
  attractTurnovers = 0;
  resetChoreography();
  // Skin the demo to whatever court is currently selected (or last selected)
  // rather than whatever COURTS[1]'s own seed would otherwise resolve to.
  attractGame.config.venue = attractVenueForCourt(selectedCourtIndex);
  attractNeedsRepaint = true;
  // Same convention as window.__game for the player's round: a stable,
  // read-only hook for tests/debugging to confirm the demo keeps running the
  // same instance (rather than being torn down and rebuilt) across a venue
  // re-skin, without reaching into module-private state.
  window.__attractGame = attractGame;
  // A reduced-motion viewer never reaches the per-frame branch in
  // updateAttract, so paint the one frame they get right away instead of
  // waiting on whatever schedules the next call.
  if (attractRenderer.reducedMotion) {
    attractRenderer.render(attractGame, { preview: false });
    attractNeedsRepaint = false;
  }
}
function stopAttract() {
  attractGame = null;
  attractNeedsRepaint = false;
  attractAccum = 0;
  // Deliberately NOT resetting attractFrozen: a machine that could not afford
  // the rally once cannot afford it on the next visit to home either, and
  // re-measuring every time would re-spend the budget to reach the same
  // answer.
  attractAge = 0;
  attractCostTotal = 0;
  attractCostSamples = 0;
  window.__attractGame = null;
  if (attractRenderer) attractRenderer.effects.length = 0;
}
// The demo is decoration, not gameplay: stepping and repainting it on every
// animation frame costs the same budget as the live arena for something
// nobody is playing. Capping it at 30fps halves that on weak hardware, where
// the home screen competes with thumbnail painting and audio, and is
// indistinguishable at a glance for a rally of four drifting players.
const ATTRACT_STEP = 1 / 30;
let attractAccum = 0;
// Adaptive degradation. The demo is decoration and must never cost a player
// their frame budget, so it times its own work and gives up if that work is
// consistently expensive - freezing to a single painted frame, which is
// exactly what the static court preview it replaced always was. A machine
// that can afford the rally keeps it; one that cannot gets the picture.
//
// The warmup window matters: first paint, font loading and the first
// native-resolution background bake make the opening frames expensive on
// every machine, and judging on those would freeze the demo everywhere.
const ATTRACT_BUDGET_MS = 6;
const ATTRACT_SAMPLES = 20;
const ATTRACT_WARMUP_SECONDS = 1.5;
let attractFrozen = false,
  attractAge = 0,
  attractCostTotal = 0,
  attractCostSamples = 0;
function updateAttract(dt) {
  if (!attractGame || !attractRenderer) return;
  attractAge += dt;
  // Frozen (or reduced-motion) demos still repaint on demand, so a venue
  // re-skin from selectCourt()/hover is visible even when the rally is not
  // running.
  if (attractFrozen) {
    if (attractNeedsRepaint) {
      attractRenderer.render(attractGame, { preview: false });
      attractNeedsRepaint = false;
    }
    return;
  }
  const startedAt = performance.now();
  stepAttract(dt);
  if (attractAge < ATTRACT_WARMUP_SECONDS || !attractGame) return;
  attractCostTotal += performance.now() - startedAt;
  attractCostSamples++;
  if (attractCostSamples < ATTRACT_SAMPLES) return;
  const average = attractCostTotal / attractCostSamples;
  attractCostTotal = 0;
  attractCostSamples = 0;
  if (average > ATTRACT_BUDGET_MS) {
    attractFrozen = true;
    attractNeedsRepaint = true;
  }
}
function stepAttract(dt) {
  if (!attractGame || !attractRenderer) return;
  // prefers-reduced-motion: freeze the rally. The demo still exists (so a
  // venue re-skin from selectCourt()/hover still applies) but never steps its
  // own simulation and only repaints when something actually changed.
  if (attractRenderer.reducedMotion) {
    if (attractNeedsRepaint) {
      attractRenderer.render(attractGame, { preview: false });
      attractNeedsRepaint = false;
    }
    return;
  }
  attractNeedsRepaint = false;
  // Accumulate real elapsed time and step once per capped frame, so the rally
  // runs at the same speed however often the page paints.
  attractAccum += dt;
  if (attractAccum < ATTRACT_STEP) return;
  dt = attractAccum;
  attractAccum = 0;
  const demo = attractGame,
    carrier = demo.players[demo.carrier];
  // Drift the carrier off the nearest defender and back towards the middle, so
  // the demo reads as play rather than as four statues. The engine moves the
  // teammates and the press on its own.
  let x = 0,
    y = 0;
  // Drift is suppressed only while the engine actually has a one-touch
  // window open on this carrier (~8px of tolerance, see ONE_TOUCH in
  // game.js). With the next pass queued mid-flight that window is now
  // effectively zero - the ball is released on arrival - so the players keep
  // moving through the chain instead of standing still waiting for it.
  if (!demo.oneTouchEligible) {
    const nearest = demo.defenders
      .map((defender) => ({ defender, gap: distance(defender, carrier) }))
      .sort((a, b) => a.gap - b.gap)[0];
    if (nearest && nearest.gap > 0.001) {
      x = (carrier.x - nearest.defender.x) / nearest.gap;
      y = (carrier.y - nearest.defender.y) / nearest.gap;
    }
    x += (500 - carrier.x) / 900;
    y += (310 - carrier.y) / 560;
  }
  demo.update(dt, { x, y, focus: false });
  queueNextOneTouch(demo);
  // The one-touch set piece needs consecutive passes thrown back-to-back
  // (see chooseOneTouchTarget) rather than paced on the usual timer, so it
  // bypasses attractPassIn entirely while it's the active step - Game#pass's
  // own passCooldown is what actually spaces the individual passes out.
  const immediate = currentSetPiece() === "onetouch";
  if (!immediate) attractPassIn -= dt;
  if (!demo.ball && (immediate || attractPassIn <= 0)) {
    const piece = currentSetPiece();
    const choreographed = chooseChoreographedTarget(demo);
    let target, bank;
    if (choreographed !== null) {
      ({ target, bank } = choreographed);
    } else {
      // bestTarget(null) is the same smart pass the pass button gives a
      // player, so a set piece that can't fire this decision still plays
      // the game the way the game means it to be played while it waits.
      target = demo.bestTarget(null);
      bank = false;
      attractPassCount++;
      if (attractPassCount >= attractBankEvery) {
        const passer = demo.players[demo.carrier],
          receiver = demo.players[target];
        const waypoint = bankPoint(passer, receiver);
        const direct = distance(passer, receiver);
        // Perpendicular distance of the bounce point from the direct line: a
        // bank whose waypoint sits almost on that line looks identical to a
        // normal pass, so it isn't worth spending the "every 4-6th" slot on —
        // skip banking this cycle and try again in another 4-6 passes.
        const offset =
          direct > 1
            ? Math.abs(
                (receiver.x - passer.x) * (waypoint.y - passer.y) -
                  (receiver.y - passer.y) * (waypoint.x - passer.x),
              ) / direct
            : 0;
        bank = offset > 40;
        attractPassCount = 0;
        attractBankEvery = 4 + Math.floor(Math.random() * 3);
      }
    }
    const thrown = demo.pass(target, bank);
    if (thrown) {
      // Only a pass the engine actually accepted counts towards the set
      // piece's progress - a one-touch retry blocked by passCooldown must
      // not burn through its patience budget before it ever fires.
      if (choreographed !== null) advanceChoreography(demo, piece);
      attractPassIn = immediate ? 0 : 0.55 + Math.random() * 0.5;
    }
  }
  for (const event of demo.events) attractRenderer.addEvent(event);
  demo.events = [];
  if (demo.turnovers !== attractTurnovers) {
    // An interception or a held-too-long turnover: the engine already reset
    // its own history and positions (see Game#turnover), so the
    // choreography only has to forget which set piece it was mid-way
    // through and start the sequence over from "split".
    attractTurnovers = demo.turnovers;
    resetChoreography();
  }
  if (demo.status !== "playing") {
    // The clock ran out. Nothing is scored or saved; another round simply
    // starts, and the next frame renders that one instead. The venue carries
    // over onto the fresh game rather than resetting to COURTS[1]'s own.
    const venue = attractGame.config.venue;
    attractGame = null;
    startAttract();
    if (venue) attractGame.config.venue = venue;
    return;
  }
  attractRenderer.render(demo, { preview: false });
}
function config() {
  if (mode === "endless")
    return applyDifficulty(
      {
        ...COURTS[1],
        name: "The infinite rondo",
        place: "STAY IN THE FLOW",
        target: 0,
        time: 60,
        speed: 85,
        endless: true,
        seed: Date.now() >>> 0,
        description:
          "Three lives. Endless possibility. Every triangle adds 5 seconds. The press gets faster.",
      },
      progress.difficulty,
    );
  if (mode === "practice") {
    const court = COURTS[courtIndex] || COURTS[0];
    return applyDifficulty(
      {
        ...court,
        target: 120,
        time: Infinity,
        speed: Math.min(court.speed, 65),
        practice: true,
        description:
          "A gentle press and unlimited recoveries. Learn the rhythm, try the walls, find your triangle.",
      },
      progress.difficulty,
    );
  }
  return applyDifficulty(COURTS[courtIndex], progress.difficulty);
}
// The single source of truth for "how many possessions does this round
// allow" — mirrors the exact fallback the engine itself uses (game.js's
// turnover() and progress.js's awardMatch both read config.possessions with
// this same `?? 3` fallback). Every place in the UI that shows or reasons
// about the possession count must call this rather than repeat the literal
// 3, or a difficulty tier's Relaxed/Ruthless possession count (4/2) silently
// disagrees with what the engine is actually enforcing.
function possessionLimit(config = game?.config) {
  return Number.isFinite(config?.possessions) ? config.possessions : 3;
}
const POSSESSION_ORDINALS = {
  1: "first",
  2: "second",
  3: "third",
  4: "fourth",
  5: "fifth",
};
// Falls back to "Nth" for anything outside the tiers' 2-4 range so a future
// tier or config change degrades gracefully instead of reading blank/wrong.
function possessionOrdinal(n) {
  return POSSESSION_ORDINALS[n] || `${n}th`;
}
// Mirrors the exact key format awardMatch() writes in progress.js
// (court-<index>-<tier>) — must be read off game.config.difficulty, the tier
// applyDifficulty actually stamped onto the running round, never off
// progress.difficulty/UI state that could have changed since kickoff.
function recordKey() {
  return mode === "career" ? `court-${courtIndex}-${game.config.difficulty}` : mode;
}
// Builds the difficulty <select> options straight from DIFFICULTIES, the
// same way the engine defines them — never hardcoded here.
function renderDifficultyOptions() {
  const select = $("difficulty-select");
  if (!select) return;
  select.replaceChildren(
    ...DIFFICULTIES.map((tier) => {
      const option = document.createElement("option");
      option.value = tier.id;
      option.textContent = tier.name;
      return option;
    }),
  );
  renderOverlayDifficultyToggle();
}
// The overlay toggle mirrors the <select>'s options exactly (same
// DIFFICULTIES source, same ids), just as a set of buttons rather than a
// dropdown, since it lives in the actually-visible pre-round card.
function renderOverlayDifficultyToggle() {
  const host = $("overlay-difficulty-toggle");
  if (!host) return;
  host.replaceChildren(
    ...DIFFICULTIES.map((tier) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hl-diff-btn";
      btn.dataset.tier = tier.id;
      btn.textContent = tier.name;
      btn.title = tier.label;
      btn.setAttribute("aria-pressed", "false");
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        progress.difficulty = tier.id;
        persist();
        prepare();
      });
      return btn;
    }),
  );
}
// Reflects the tier actually in effect (game.config.difficulty, as
// applyDifficulty stamped it) onto every difficulty-related control: the
// below-court select/description (mirroring the pre-existing, currently
// off-screen tactic-select pattern) and the overlay toggle/description/
// target, which is what a player actually sees before a round.
function syncDifficultyChrome() {
  const activeDifficulty = game.config.difficulty;
  const difficultyMeta =
    DIFFICULTIES.find((tier) => tier.id === activeDifficulty) || DIFFICULTIES[1];
  const practiceDescriptions = {
    relaxed: "Looser targets and a gentle press. Find your rhythm first.",
    standard: "Standard targets and defense. Your space to experiment.",
    ruthless: "Tighter targets and a quicker press.",
  };
  const description =
    mode === "practice"
      ? (practiceDescriptions[activeDifficulty] || difficultyMeta.label)
      : difficultyMeta.label;

  $("difficulty-select").disabled = false;
  $("difficulty-select").value = activeDifficulty;
  $("difficulty-description").textContent = description;
  $("difficulty-target").textContent = game.config.target ? `TARGET ${game.config.target}` : "";

  $("overlay-difficulty").hidden = false;
  $("overlay-difficulty-target").textContent = game.config.target
    ? `TARGET ${game.config.target}`
    : "";
  $("overlay-difficulty-description").textContent = description;
  document.querySelectorAll("#overlay-difficulty-toggle .hl-diff-btn").forEach((btn) => {
    const isActive = btn.dataset.tier === activeDifficulty;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", String(isActive));
    if (mode === "practice") {
      btn.title = practiceDescriptions[btn.dataset.tier] || btn.title;
    }
    btn.disabled = false;
  });
}
function syncProgress() {
  const thumbnailGeneration = ++courtThumbnailGeneration;
  const r = rank(progress.xp);
  $("level-label").textContent = `LEVEL ${r.level} · ${r.name}`;
  $("xp-label").textContent =
    r.span === 0 ? `${progress.xp} XP · MAX` : `${r.into} / ${r.span} XP`;
  $("xp-fill").style.width = `${r.fraction * 100}%`;
  $("court-list").innerHTML = "";
  // Stars are tracked per tier now (progress.courts[i][tier]); the court
  // list shows the tier the player currently has selected rather than
  // guessing or flattening every tier into one number, and says which tier
  // that is with a compact tag rather than a second row of stats.
  const listedTier = DIFFICULTY_IDS.includes(progress.difficulty)
    ? progress.difficulty
    : "standard";
  const listedTierName =
    DIFFICULTIES.find((tier) => tier.id === listedTier)?.name || "Standard";
  // shortTierLabel(), not a plain slice(0, 3) — "Standard".slice(0, 3) is
  // "STA", not a word. See shortTierLabel's own comment.
  const listedTierTag = shortTierLabel(listedTier);
  COURTS.forEach((court, i) => {
    const btn = document.createElement("button");
    const isSelected = i === selectedCourtIndex;
    btn.className = `court-item ${isSelected ? "active" : ""}`;
    btn.disabled = i > progress.unlocked;
    const stars = starsForTier(i, listedTier);
    btn.setAttribute(
      "aria-label",
      `${court.name}, ${btn.disabled ? "locked" : `${stars} stars on ${listedTierName}`}`,
    );
    btn.setAttribute(
      "aria-current",
      isSelected ? "true" : "false",
    );
    // The thumb source is intentionally populated after first paint below.
    // Width/height preserve the existing layout while it is pending.
    btn.innerHTML = `<img class="court-thumb" data-court-index="${i}" alt="" width="48" height="30" loading="lazy" /><span class="court-number">${String(i + 1).padStart(2, "0")}</span><span><span class="court-name">${court.name}</span><span class="court-meta">${court.place}</span></span><span class="court-stars">${btn.disabled ? "↗" : `<span class="court-tier-tag">${listedTierTag}</span>${stars ? "★".repeat(stars) : "○"}`}</span>`;
    const previewHover = () => {
      const copy = $("title-play-copy");
      if (copy && phase !== "paused" && phase !== "playing") {
        copy.textContent = `${court.name} · ${court.place}`;
      }
      document.querySelectorAll("#court-list .court-item").forEach((b, idx) => {
        b.classList.toggle("hover-preview", idx === i);
      });
      setAttractVenue(attractVenueForCourt(i));
    };
    const previewLeave = () => {
      document.querySelectorAll("#court-list .court-item").forEach((b) => {
        b.classList.remove("hover-preview");
      });
      syncTitle();
      // The pointer/focus left the list without selecting anything, so the
      // demo falls back to whatever court is actually selected rather than
      // getting stuck showing the last one hovered.
      setAttractVenue(attractVenueForCourt(selectedCourtIndex));
    };
    btn.addEventListener("mouseenter", previewHover);
    btn.addEventListener("focus", previewHover);
    btn.addEventListener("blur", (e) => {
      if (!e.relatedTarget || !$("court-list")?.contains(e.relatedTarget)) {
        previewLeave();
      }
    });
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      selectCourt(i);
    });
    $("court-list").append(btn);
  });
  deferCourtThumbnails($("court-list"), thumbnailGeneration);
  if (!$("court-list")._hoverPreviewBound) {
    $("court-list")._hoverPreviewBound = true;
    $("court-list").addEventListener("mouseleave", () => {
      document.querySelectorAll("#court-list .court-item").forEach((b) => {
        b.classList.remove("hover-preview");
      });
      syncTitle();
      setAttractVenue(attractVenueForCourt(selectedCourtIndex));
    });
  }
  document.querySelectorAll("[data-home-mode]").forEach((btn) => {
    const active =
      view === "arena"
        ? btn.dataset.homeMode === mode
        : btn.dataset.homeMode === selectedHomeMode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  syncHome();
}
function setOverlay(kicker, title, copy, primary, secondary = "", tertiary = "") {
  clearTimeout(resultRevealTimeout);
  resultActionsReady = true;
  const overlay = $("game-overlay");
  delete overlay.dataset.result;
  delete overlay.dataset.actions;
  $("result-burst").hidden = true;
  $("result-stats").hidden = true;
  $("result-cheer").hidden = true;
  // The difficulty picker only belongs on the pre-round invitation; results
  // screens and the "end this round?" confirmation reuse this same overlay,
  // so the generic reset hides it and prepare() explicitly opts back in.
  $("overlay-difficulty").hidden = true;
  $("overlay-actions").hidden = false;
  $("start-button").disabled = false;
  $("secondary-button").disabled = false;
  if ($("tertiary-button")) {
    $("tertiary-button").disabled = false;
    $("tertiary-button").textContent = tertiary;
    $("tertiary-button").hidden = !tertiary;
  }
  $("game-overlay").hidden = false;
  $("overlay-kicker").textContent = kicker;
  $("overlay-title").textContent = title;
  $("overlay-copy").textContent = copy;
  $("start-button").textContent = primary;
  $("secondary-button").textContent = secondary;
  $("secondary-button").hidden = !secondary;
}
function showRoundResults({
  cleared,
  kicker,
  title,
  copy,
  primary,
  secondary,
  tertiary = "",
  stars,
  xp,
}) {
  setOverlay(kicker, title, copy, primary, secondary, tertiary);
  const overlay = $("game-overlay"),
    actions = $("overlay-actions");
  overlay.dataset.result = cleared ? "victory" : "defeat";
  overlay.dataset.actions = "waiting";
  $("result-score").textContent = String(game.score);
  $("result-xp").textContent = `+${xp}`;
  const breakdown = {
    triangles: game.triangles || 0,
    oles: game.oles || 0,
    splits: game.splits || 0,
    zones: game.zones || 0,
    banks: game.banks || 0,
    passes: game.passes || 0,
    streak: game.bestOneTouch || 0,
    turnovers: game.turnovers || 0,
  };
  for (const [key, value] of Object.entries(breakdown)) {
    $(`result-${key}`).textContent = String(value);
    $(`result-${key}-cell`).classList.toggle("is-zero", value === 0);
  }
  const flowPeak = 1 + Math.min(4, Math.floor((game.bestCombo || 0) / 4));
  $("result-combo").textContent = `x${flowPeak}`;
  $("result-burst").hidden = false;
  $("result-stats").hidden = false;
  $("result-cheer").hidden = false;
  $("result-cheer").textContent = cleared
    ? `THE COURT ERUPTS${stars ? ` · ${"★".repeat(stars)}` : ""}`
    : "THE CROWD IS STILL WITH YOU";
  $("invitation-note").textContent = "CHOOSE YOUR NEXT MOVE";
  actions.hidden = false;
  $("start-button").disabled = true;
  $("secondary-button").disabled = true;
  if ($("tertiary-button")) $("tertiary-button").disabled = true;
  resultActionsReady = false;
  $("overlay-card").focus({ preventScroll: true });
  resultRevealTimeout = setTimeout(() => {
    resultActionsReady = true;
    overlay.dataset.actions = "ready";
    $("start-button").disabled = false;
    $("secondary-button").disabled = false;
    if ($("tertiary-button")) $("tertiary-button").disabled = false;
    if (
      view === "arena" &&
      phase === "finished" &&
      !menuOpen &&
      !anyDialogOpen()
    )
      padFocus($("start-button"));
  }, RESULT_ACTION_DELAY);
}
function setControlsEnabled(enabled) {
  [
    "pass-button",
    "bank-button",
    "focus-button",
    "boost-button",
    "shout-button",
    "touch-pass",
    "touch-bank",
    "touch-focus",
    "touch-shout",
    "touch-boost",
  ].forEach((id) => ($(id).disabled = !enabled));
  $("joystick").setAttribute("aria-disabled", String(!enabled));
}
function setPauseState(paused) {
  $("pause-button").innerHTML = paused
    ? `<svg class="pause-symbol" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><polygon points="4,2.5 13.5,8 4,13.5" fill="currentColor"/></svg><span class="arena-pause-label">RESUME</span>`
    : `<svg class="pause-symbol" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="3" y="2.5" width="3.5" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3.5" height="11" rx="1" fill="currentColor"/></svg><span class="arena-pause-label">PAUSE</span>`;
  $("pause-button").setAttribute(
    "aria-label",
    paused ? "Resume game" : "Pause game",
  );
  const pauseKeys =
    settings.bindings.pause.map(readableKey).join(" / ") || "unbound";
  $("pause-button").title = `${paused ? "Resume" : "Pause"} (${pauseKeys})`;
}
// Every announcement carries a sequence number so the deferred paint and the
// 2.5s wipe belong to one specific call. Without it a later announcement (or a
// clearAnnouncement) could be undone a frame afterwards by an earlier call's
// pending rAF, which is how a stale line ends up sitting under a newer one.
let announcementSeq = 0;
function announce(text) {
  clearTimeout(announcementTimeout);
  const seq = ++announcementSeq;
  $("game-announcement").textContent = "";
  requestAnimationFrame(() => {
    if (seq !== announcementSeq) return;
    $("game-announcement").textContent = text;
  });
  announcementTimeout = setTimeout(() => {
    if (seq !== announcementSeq) return;
    $("game-announcement").textContent = "";
  }, 2500);
}
function clearAnnouncement() {
  announcementSeq++;
  clearTimeout(announcementTimeout);
  $("game-announcement").textContent = "";
}
function prepare() {
  resetHudCache();
  renderer.effects.length = 0;
  game = new Game(config(), progress.tactic);
  window.__game = game;
  const venue = getVenue(game.config);
  document.documentElement.dataset.venue = venue.id;
  document.documentElement.style.setProperty("--venue-accent", venue.accent);
  document.documentElement.style.setProperty(
    "--venue-secondary",
    venue.secondary,
  );
  if ($("venue-vibe")) $("venue-vibe").textContent = venue.vibe;
  if ($("arena-venue-label"))
    $("arena-venue-label").textContent = venue.name.toUpperCase();
  if ($("arena-venue-sub"))
    $("arena-venue-sub").textContent = venue.vibe.toUpperCase();
  phase = "ready";
  finished = false;
  roundCleared = false;
  bank = false;
  focusToggle = false;
  boostToggle = false;
  endHold();
  clearInput();
  $("eyebrow").textContent = game.config.place;
  $("court-title").textContent = game.config.name;
  $("court-description").textContent = game.config.description;
  $("mode-label").textContent =
    mode === "career"
      ? `THE CIRCUIT / ${String(courtIndex + 1).padStart(2, "0")}`
      : mode.toUpperCase();
  $("score-label").textContent = game.config.target
    ? `SCORE / ${game.config.target}`
    : "FLOW SCORE";
  $("goal-label").textContent =
    mode === "endless"
      ? "TRIANGLE = +5 SECONDS"
      : `${game.config.target} POINTS TO CLEAR`;
  $("tactic-select").disabled = false;
  $("tactic-select").value = progress.tactic;
  $("tactic-description").textContent = TACTICS[progress.tactic].label;
  // With the sidebar gone this button is the only pointer-driven way into the
  // menu, so it stays live for the whole time the arena is on screen rather
  // than only while a round is running. Touch players need it before kickoff.
  $("pause-button").disabled = false;
  shoutVisual = null;
  setPauseState(false);
  setControlsEnabled(false);
  $("bank-button").setAttribute("aria-pressed", "false");
  $("focus-button").setAttribute("aria-pressed", "false");
  $("boost-button").setAttribute("aria-pressed", "false");
  $("touch-bank").setAttribute("aria-pressed", "false");
  $("touch-focus").setAttribute("aria-pressed", "false");
  $("touch-boost").setAttribute("aria-pressed", "false");
  // Every branch below reads the possession count off game.config
  // (possessionLimit(), the same fallback the engine itself uses) rather
  // than a literal 3 — Relaxed/Ruthless move it to 4/2, and endless mode is
  // tier-scaled here too (config() runs it through applyDifficulty just
  // like career), so a hardcoded 3 would silently disagree with the engine
  // on any tier but Standard.
  const possessions = possessionLimit(game.config);
  const possessionsOrdinal = possessionOrdinal(possessions).toUpperCase();
  const possessionLabel = possessions === 1 ? "POSSESSION" : "POSSESSIONS";
  $("invitation-note").textContent =
    mode === "practice"
      ? `NO TIMER · UNLIMITED RECOVERIES · FIND YOUR RHYTHM`
      : mode === "endless"
        ? `60 SECONDS · ${possessions} POSSESSIONS · TRIANGLES ADD TIME`
        : `${game.config.time} SECONDS · ${possessions} ${possessionLabel} · ${possessionsOrdinal} LOSS ENDS THE ROUND`;
  setOverlay(
    mode === "endless"
      ? "HOW LONG CAN YOU KEEP IT?"
      : mode === "practice"
        ? "A LITTLE SPACE TO LEARN"
        : "FOUR PLAYERS. ONE BALL.",
    mode === "practice" ? "Find your feet." : "Keep it beautiful.",
    mode === "endless"
      ? "Connect triangles to buy time. Survive the rising press."
      : mode === "practice"
        ? "No timer. Unlimited recoveries. Experiment freely."
        : `Keep possession for ${game.config.time} seconds. Earn ${game.config.target} points. You have ${possessions} ${possessions === 1 ? "possession" : "possessions"}; the ${possessionOrdinal(possessions)} loss ends the round.`,
    mode === "endless"
      ? "Start the run"
      : mode === "practice"
        ? "Start the warm-up"
        : "Play the court",
  );
  // Must run after setOverlay(): that generic reset hides #overlay-difficulty
  // (it is also reused by the results screen and the "end this round?"
  // prompt, neither of which should show a difficulty picker), and this call
  // is what opts the pre-round invitation back in. The tier actually in
  // effect always comes off game.config.difficulty — applyDifficulty()
  // already stamped it there — so every difficulty control reflects reality
  // rather than UI state that could disagree with the round it sits next to.
  syncDifficultyChrome();
  syncProgress();
  syncHud();
}
function switchMode(next, index = courtIndex) {
  if (next === "kotc" || next === "endless") return;
  closePauseMenu({ restoreFocus: false });
  selectedCourtIndex = index;
  selectedHomeMode = next;
  if (phase === "playing" || phase === "paused") {
    pause();
    applyView("arena");
    pendingSwitch = { next, index };
    // Two buttons, two plain outcomes: stay in the round that is still on the
    // clock, or end it and start the one that was just picked.
    setOverlay(
      "THIS ROUND IS STILL GOING",
      "End it and start the new one?",
      "Starting somewhere new ends this round and its score. Everything you have already earned and saved stays with you.",
      "Keep playing this round",
      "End it and start the new one",
    );
    return;
  }
  mode = next;
  courtIndex = index;
  progress.lastCourt = courtIndex;
  prepare();
  persist();
  applyView("arena");
}
let pendingSwitch = null;
function start() {
  if (menuBlocking()) return;
  unlockAudio();
  if (pendingSwitch) {
    pendingSwitch = null;
    resume();
    return;
  }
  if (phase === "paused") {
    resume();
    return;
  }
  if (phase === "finished") prepare();
  phase = "playing";
  $("game-overlay").hidden = true;
  $("pause-button").disabled = false;
  setPauseState(false);
  setControlsEnabled(true);
  $("tactic-select").disabled = true;
  $("difficulty-select").disabled = true;
  $("court").focus({ preventScroll: true });
  // No movement/pass hint toast here any more: it fired on every single
  // round and sat on top of the pitch the whole time a player needed to see
  // it. The pre-round card it replaces already tells the story once, before
  // kickoff, without covering play.
}
// The court only takes movement and aim while a round is actually running and
// is not waiting for the player to pick the ball back up.
const acceptingPlayInput = () =>
  view === "arena" && phase === "playing" && !awaitingResume;
// One gesture unlocks both the effects engine and the soundtrack. Browsers
// block audio until a real user interaction, so every entry point routes here.
function unlockAudio() {
  sound.unlock();
  music.unlock();
  syncMusicState();
}
function syncMusicState() {
  document.body.dataset.music = music.state;
  syncAudioHint();
  // The playlist advances on its own when a track ends, so the rail's title is
  // refreshed on this poll rather than waiting for a player to press something.
  syncMusicRail();
}
// A browser will not resume an AudioContext until a real user activation
// gesture lands, and a gamepad button is not one, so a controller player can
// sit on home in silence with nothing to tell them why. Blocked
// means: the player asked for this sound, nothing failed, and the context is
// still not running. Muted audio and unavailable audio are both "not blocked".
function audioBlocked() {
  const effectsBlocked =
    settings.effectsOn && (!sound.context || sound.context.state !== "running");
  return Boolean((settings.musicOn && music.blocked) || effectsBlocked);
}
function syncAudioHint() {
  const hint = $("audio-hint");
  if (!hint) return;
  hint.hidden = !(view === "home" && audioBlocked());
}
// Mirrors the hold gate onto <body data-resume-ready> so "is a fresh press
// accepted yet" is observable from outside. It is written wherever holdElapsed
// changes, not only once a frame: resume() puts the gate back to zero, and a
// flag that still said "1" until the next frame was a lie anyone reading it in
// that window would act on.
function syncResumeGate() {
  if (!awaitingResume) {
    delete document.body.dataset.resumeReady;
    return;
  }
  document.body.dataset.resumeReady = holdElapsed < 0.3 ? "0" : "1";
}
function syncResumePrompt() {
  const showing = awaitingResume && view === "arena" && !menuOpen;
  $("resume-prompt").hidden = !showing;
  $("court-wrap").classList.toggle("is-held", showing);
}
// A turnover holds the round. The buttons and keys that were already down when
// the hold started are remembered so the press the player was still making
// cannot dismiss the message they need to read.
function beginHold(reason) {
  if (awaitingResume) return;
  awaitingResume = true;
  holdElapsed = 0;
  syncResumeGate();
  // The hold overlay owns the message from here. Anything the announcement
  // strip is still showing would sit underneath #resume-reason and read as a
  // second, smaller copy of the same words.
  clearAnnouncement();
  holdKeys = new Set(keys);
  holdPointers = new Set(
    [pointerId, joystickId].filter((id) => id !== null && id !== undefined),
  );
  $("resume-reason").textContent = reason || "POSSESSION LOST";
  focusToggle = false;
  boostToggle = false;
  clearInput();
  setControlsEnabled(false);
  syncFocusButtons();
  syncResumePrompt();
}
function endHold() {
  if (!awaitingResume) return;
  awaitingResume = false;
  syncResumeGate();
  holdKeys.clear();
  holdPointers.clear();
  syncResumePrompt();
  if (phase === "playing") {
    setControlsEnabled(true);
    $("court").focus({ preventScroll: true });
  }
}
// Any *fresh* press releases the hold: a button still held from before does
// not count, and a short grace period covers a press that straddles the event.
function releaseHold() {
  if (!awaitingResume || menuOpen || anyDialogOpen()) return false;
  if (phase !== "playing") return false;
  if (holdElapsed < 0.3) return false;
  endHold();
  return true;
}
function clearInput() {
  keys.clear();
  stick = { x: 0, y: 0 };
  gamepadMove = { x: 0, y: 0 };
  pointerMove = null;
  aim = null;
  gamepadFocus = false;
  gamepadBoost = false;
  pointerId = null;
  joystickId = null;
  for (const action of ACTION_NAMES) {
    gamepadPressedActions[action] = false;
    actionHighlightUntil[action] = 0;
    if (actionPressedCache[action]) {
      actionPressedCache[action] = false;
      const btn = getToolbarActionButton(action);
      if (btn) btn.classList.remove("action-pressed");
    }
  }
  game?.clearQueuedPass?.();
  $("joystick-thumb").style.transform = "translate(0px, 0px)";
}
function pause() {
  if (phase !== "playing") return;
  phase = "paused";
  focusToggle = false;
  boostToggle = false;
  clearInput();
  setControlsEnabled(false);
  $("focus-button").setAttribute("aria-pressed", "false");
  $("boost-button").setAttribute("aria-pressed", "false");
  $("touch-focus").setAttribute("aria-pressed", "false");
  $("touch-boost").setAttribute("aria-pressed", "false");
  setPauseState(true);
  syncResumePrompt();
  openMenu();
}
function resume() {
  if (phase !== "paused" || view !== "arena" || menuBlocking()) return;
  phase = "playing";
  pendingSwitch = null;
  $("game-overlay").hidden = true;
  setPauseState(false);
  // A round paused mid-hold comes back to the hold, not straight into play.
  setControlsEnabled(!awaitingResume);
  if (awaitingResume) {
    holdElapsed = 0;
    // Straight away, not next frame: coming back from the pause menu closes
    // the gate again, and anything that reads it in between must see that.
    syncResumeGate();
  }
  syncResumePrompt();
  $("court").focus({ preventScroll: true });
}
// Start / Esc / the HUD pause button all land here: it is the one route into
// the pause menu, and the one route back out of it.
function togglePause() {
  if (view !== "arena") return;
  if (menuOpen) dismissPauseMenu();
  else openPauseMenu();
}
function queuedSmartTarget() {
  if (!game.ball) return game.bestTarget(aim);
  return game.bestQueuedTarget(aim);
}
function doPass(id, forceBank = false) {
  if (phase !== "playing" || awaitingResume) return;
  triggerActionHighlight("smartPass");
  unlockAudio();
  const target = id ?? queuedSmartTarget();
  const useBank =
    forceBank || bank || actionDown(settings.bindings, keys, "wallHold");
  const accepted = game.ball
    ? game.queuePass(target, useBank)
    : game.pass(target, useBank);
  if (accepted) {
    bank = false;
    $("bank-button").setAttribute("aria-pressed", "false");
    $("touch-bank").setAttribute("aria-pressed", "false");
  }
}
function toggleBank() {
  if (phase !== "playing") return;
  triggerActionHighlight("wallToggle");
  bank = !bank;
  $("bank-button").setAttribute("aria-pressed", String(bank));
  $("touch-bank").setAttribute("aria-pressed", String(bank));
}
function toggleFocus() {
  if (phase !== "playing") return;
  triggerActionHighlight("focusHold");
  if (game.focus <= 0) {
    focusToggle = false;
    syncFocusButtons();
    toast("Earn Energy with triangles, bonus zones, split passes, or Olé streaks.");
    return;
  }
  focusToggle = !focusToggle;
  if (focusToggle) boostToggle = false;
  syncFocusButtons();
  syncBoostButtons();
}
function toggleBoost() {
  if (phase !== "playing") return;
  triggerActionHighlight("boostHold");
  if (game.focus <= 0) {
    boostToggle = false;
    syncBoostButtons();
    toast("Earn Energy with triangles, bonus zones, split passes, or Olé streaks.");
    return;
  }
  boostToggle = !boostToggle;
  if (boostToggle) focusToggle = false;
  syncBoostButtons();
  syncFocusButtons();
}
let perfOverlay = null,
  perfEnabled = false,
  perfLastSample = 0,
  perfFrames = 0,
  perfJsTotal = 0,
  perfPaintTotal = 0;

try {
  perfEnabled =
    location.search.includes("perf") ||
    location.search.includes("fps") ||
    localStorage.getItem("tiki-taka.perf-overlay") === "1";
} catch {
  perfEnabled = false;
}

function ensurePerfOverlay() {
  if (perfOverlay) return perfOverlay;
  perfOverlay = document.createElement("aside");
  perfOverlay.id = "perf-overlay";
  perfOverlay.className = "perf-overlay";
  perfOverlay.setAttribute("aria-hidden", "true");
  perfOverlay.hidden = !perfEnabled;
  perfOverlay.innerHTML = `
    <div class="perf-title"><span>PERF</span><span id="perf-fps">-- FPS</span></div>
    <div class="perf-row"><span>Frame:</span><span id="perf-frame" class="perf-val">-- ms</span></div>
    <div class="perf-row"><span>JS:</span><span id="perf-js" class="perf-val">-- ms</span></div>
    <div class="perf-row"><span>Paint:</span><span id="perf-paint" class="perf-val">-- ms</span></div>
  `;
  document.body.appendChild(perfOverlay);
  return perfOverlay;
}

function togglePerfOverlay() {
  perfEnabled = !perfEnabled;
  try {
    localStorage.setItem("tiki-taka.perf-overlay", perfEnabled ? "1" : "0");
  } catch {}
  const el = ensurePerfOverlay();
  el.hidden = !perfEnabled;
  if (perfEnabled) {
    perfFrames = 0;
    perfJsTotal = 0;
    perfPaintTotal = 0;
    perfLastSample = performance.now();
  }
}

if (perfEnabled) ensurePerfOverlay();

const hudCache = {
  oneTouchStreak: -1,
  oneTouchMilestone: null,
  oneTouchProgress: -1,
  score: -1,
  timeString: "",
  timeUrgent: null,
  combo: -1,
  lives: "",
  focusToggle: null,
  boostActive: null,
  focusText: "",
  focusRatio: -1,
  focusValuenow: "",
  focusCap: -1,
  focusEmpty: null,
  goalWidth: "",
  bestText: "",
  targetText: "",
  isPlaying: null,
  isRound: null,
  courtTarget: null,
};

function resetHudCache() {
  hudCache.oneTouchStreak = -1;
  hudCache.oneTouchMilestone = null;
  hudCache.oneTouchProgress = -1;
  hudCache.score = -1;
  hudCache.timeString = "";
  hudCache.timeUrgent = null;
  hudCache.combo = -1;
  hudCache.lives = "";
  hudCache.focusToggle = null;
  hudCache.boostActive = null;
  hudCache.focusText = "";
  hudCache.focusRatio = -1;
  hudCache.focusValuenow = "";
  hudCache.focusCap = -1;
  hudCache.focusEmpty = null;
  hudCache.goalWidth = "";
  hudCache.bestText = "";
  hudCache.targetText = "";
  hudCache.isPlaying = null;
  hudCache.isRound = null;
  hudCache.courtTarget = null;
  hudCache.focusTier = "";
  hudCache.energyBoostActive = null;
  hudCache.energyFocusActive = null;
}

function syncFocusButtons() {
  if (focusToggle !== hudCache.focusToggle) {
    const pressed = String(focusToggle);
    $("focus-button").setAttribute("aria-pressed", pressed);
    $("touch-focus").setAttribute("aria-pressed", pressed);
    hudCache.focusToggle = focusToggle;
  }
}
function syncBoostButtons() {
  const active = Boolean(boostToggle || game?.boostActive);
  if (active !== hudCache.boostActive) {
    $("boost-button").setAttribute("aria-pressed", String(active));
    $("touch-boost").setAttribute("aria-pressed", String(active));
    hudCache.boostActive = active;
  }
}
function selectedPassTarget() {
  return game.queuedPass?.id ?? queuedSmartTarget();
}
let shoutVisual = null;
function shoutTarget() {
  if (phase !== "playing" || awaitingResume) return;
  triggerActionHighlight("shout");
  const target = selectedPassTarget();
  if (game.shout(target)) {
    shoutVisual = { playerId: target, start: performance.now(), duration: 2000 };
  }
}
// THE COURT'S OWN BOX
//
// The court is a 1000:620 rectangle centred in the panel. In a wide window
// it is height-limited and a band of extra width is left either side; in a
// tall one it is width-limited and the extra band runs above and below
// instead. That box is also what the HUD bands (see .scoreboard and
// .court-toolbar) and the ambience wash below both measure against, so it
// stays a single source of truth rather than three different guesses.
//
// The court's own size is never touched by any of this: it is still
// min(100cqw, 161.2903cqh) of the panel, about 87% of the width of a
// 1920x1080 viewport.
const COURT_RATIO = 1000 / 620;
const gamePanel = document.querySelector(".game-panel");
let cachedCourtBox = null,
  courtBoxDirty = true;
function invalidateCourtBox() {
  courtBoxDirty = true;
}
if (gamePanel && typeof ResizeObserver === "function") {
  new ResizeObserver(invalidateCourtBox).observe(gamePanel);
} else {
  window.addEventListener("resize", invalidateCourtBox, { passive: true });
}
function courtBox() {
  if (!gamePanel) return null;
  if (!courtBoxDirty) return cachedCourtBox;
  const { width, height } = gamePanel.getBoundingClientRect();
  if (!width || !height) {
    cachedCourtBox = null;
    return null;
  }
  const courtWidth = Math.min(width, height * COURT_RATIO),
    courtHeight = courtWidth / COURT_RATIO;
  cachedCourtBox = {
    width,
    height,
    courtWidth,
    courtHeight,
    left: (width - courtWidth) / 2,
    top: (height - courtHeight) / 2,
  };
  courtBoxDirty = false;
  return cachedCourtBox;
}

// MUSIC-REACTIVE AMBIENCE
//
// One canvas behind the panel, painting only the letterbox the court cannot
// use: the court rectangle is cut out of the clip, so nothing is ever drawn
// over the game. It is driven by an AnalyserNode on the music bus, and it is
// deliberately low-contrast — the ball has to stay the brightest thing moving.
//
// music.energy is null whenever there is nothing to measure: muted, switched
// off, still loading, or blocked by autoplay. That is not an error state, it
// is the idle state, and the wash keeps breathing gently on its own. With
// prefers-reduced-motion the drift and the breathing both stop and the wash
// holds a steady level, which is what renderer.reducedMotion already means
// everywhere else.
let ambienceClock = 0,
  ambienceLevel = 0.15,
  ambienceElapsed = Infinity,
  ambienceAccent = "",
  ambienceColor = [39, 234, 216];
const ambienceCanvas = $("ambience"),
  ambienceContext = ambienceCanvas?.getContext("2d");
let ambienceVisible = Boolean(ambienceCanvas);
if (ambienceCanvas && typeof ResizeObserver === "function") {
  new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    ambienceVisible = width > 0 && height > 0;
    // A newly visible canvas must not wait for the previous cadence before
    // painting its first frame.
    if (ambienceVisible) ambienceElapsed = Infinity;
  }).observe(ambienceCanvas);
}
const ambienceRgb = (accent) => {
  const hex = String(accent || "").trim().replace("#", "");
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
  const value = Number.parseInt(full, 16);
  if (full.length !== 6 || !Number.isFinite(value)) return [39, 234, 216];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};
let lastAmbienceWidth = 0,
  lastAmbienceHeight = 0,
  lastAmbienceDpr = 0;

function paintAmbience(dt) {
  const canvas = ambienceCanvas;
  if (
    !canvas ||
    !ambienceContext ||
    !ambienceVisible ||
    !document.body.classList.contains("play-view")
  )
    return;

  // The decorative wash used to rebuild four gradients and a clipping path
  // at display refresh rate. It is not gameplay feedback, so 30fps while
  // music is active and 12fps while idling retain the intended motion while
  // leaving the main court renderer the bulk of the frame budget.
  const reduced = renderer.reducedMotion,
    measured = music.energy,
    cadence = reduced ? 0.25 : measured === null ? 1 / 12 : 1 / 30;
  ambienceElapsed += dt;

  // Fast path: if courtBox hasn't resized and cadence has not elapsed, exit immediately
  // without touching DOM canvas properties or recomputing backing sizes.
  if (!courtBoxDirty && ambienceElapsed < cadence) return;

  const box = courtBox();
  if (!box) return;
  const width = Math.round(box.width),
    height = Math.round(box.height),
    dpr = Math.min(2, window.devicePixelRatio || 1);
  const backingWidth = Math.round(width * dpr),
    backingHeight = Math.round(height * dpr),
    resized =
      backingWidth !== lastAmbienceWidth ||
      backingHeight !== lastAmbienceHeight ||
      dpr !== lastAmbienceDpr;

  if (resized) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    lastAmbienceWidth = backingWidth;
    lastAmbienceHeight = backingHeight;
    lastAmbienceDpr = dpr;
  }

  if (!resized && ambienceElapsed < cadence) return;
  const elapsed = Math.min(0.25, ambienceElapsed);
  ambienceElapsed = 0;
  const c = ambienceContext;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, width, height);
  // A court that fills the panel leaves nothing to paint in.
  if (box.left < 2 && box.top < 2) return;
  if (!reduced) ambienceClock += elapsed;
  const idle = reduced ? 0.16 : 0.16 + 0.05 * Math.sin(ambienceClock * 0.55);
  const target = measured === null ? idle : 0.12 + Math.min(1, measured) * 0.88;
  // Slow towards the idle level, quicker towards the music: a track starting
  // should feel like the room waking up, not a jump cut.
  ambienceLevel +=
    (target - ambienceLevel) *
    Math.min(1, elapsed * (measured === null ? 1.5 : 6));
  // The venue's accent, straight off the renderer rather than through a
  // getComputedStyle() read on every frame.
  const accent = renderer.venue?.accent || "";
  if (accent !== ambienceAccent) {
    ambienceAccent = accent;
    ambienceColor = ambienceRgb(accent);
  }
  const [r, g, b] = ambienceColor;
  c.save();
  c.beginPath();
  c.rect(0, 0, width, height);
  c.rect(box.left, box.top, box.courtWidth, box.courtHeight);
  c.clip("evenodd");
  const drift = reduced ? 0 : Math.sin(ambienceClock * 0.32);
  const glow = (x, y, radius, strength) => {
    const gradient = c.createRadialGradient(x, y, 0, x, y, radius);
    gradient.addColorStop(0, `rgba(${r},${g},${b},${strength})`);
    gradient.addColorStop(0.55, `rgba(${r},${g},${b},${strength * 0.35})`);
    gradient.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = gradient;
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
    c.fill();
  };
  // Cap the contrast hard: this is atmosphere at the edge of vision, and it
  // must never read as something happening on the court.
  const strength = 0.08 + ambienceLevel * 0.14,
    swell = 1.1 + ambienceLevel * 0.4;
  if (box.left >= 2) {
    const radius = Math.max(box.left, 90) * 2.3 * swell;
    glow(box.left * 0.5, height * (0.36 + drift * 0.07), radius, strength);
    glow(width - box.left * 0.5, height * (0.64 - drift * 0.07), radius, strength * 0.95);
  }
  if (box.top >= 2) {
    const radius = Math.max(box.top, 90) * 2.1 * swell;
    glow(width * (0.32 - drift * 0.05), box.top * 0.5, radius, strength * 0.85);
    glow(width * (0.68 + drift * 0.05), height - box.top * 0.5, radius, strength * 0.85);
  }
  // A thin accent line along the court's edge, brightening with the music:
  // it draws the eye to the frame rather than into it.
  c.strokeStyle = `rgba(${r},${g},${b},${0.06 + ambienceLevel * 0.12})`;
  c.lineWidth = 2;
  c.strokeRect(box.left - 1, box.top - 1, box.courtWidth + 2, box.courtHeight + 2);
  c.restore();
}

// --- Arena rail audio-reactive visualizers --------------------------------
// Active in wide desktop viewports (window.innerWidth >= 1200) during play view.
// Fills the letterbox background flanking the court with symmetrical spectrum analyzers.
const railVizLeft = $("rail-viz-left"),
  railVizRight = $("rail-viz-right"),
  railCtxLeft = railVizLeft?.getContext("2d"),
  railCtxRight = railVizRight?.getContext("2d");

const VIZ_BARS = 10;
const vizBarHeights = new Float32Array(VIZ_BARS);
const vizBarPeaks = new Float32Array(VIZ_BARS);
const vizFreqBuffer = new Uint8Array(64);
let vizClock = 0;
let vizElapsed = 0;

const VIZ_BAND_RANGES = [
  [0, 1],   // Sub-bass (~40-80 Hz)
  [2, 3],   // Bass (~80-160 Hz)
  [4, 6],   // Low-mid (~160-320 Hz)
  [7, 10],  // Mid (~320-600 Hz)
  [11, 15], // Mid-high (~600-1000 Hz)
  [16, 21], // High-mid (~1-2 kHz)
  [22, 28], // Presence (~2-3.5 kHz)
  [29, 37], // Crisp (~3.5-5 kHz)
  [38, 48], // Treble (~5-8 kHz)
  [49, 63], // Air (~8-16 kHz)
];

function drawRoundedSegment(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
    ctx.fill();
  } else {
    ctx.fillRect(x, y, w, h);
  }
}

const VENUE_SPECTRUM_THEMES = {
  lisbon: {
    low: "#21f3df",
    mid: "#ffd64d",
    high: "#ff587f",
    glow: "#21f3df",
    unlit: "rgba(10, 35, 50, 0.4)",
  },
  london: {
    low: "#34e5ed",
    mid: "#ffaa3b",
    high: "#ff4f73",
    glow: "#34e5ed",
    unlit: "rgba(14, 28, 48, 0.4)",
  },
  barcelona: {
    low: "#2debd2",
    mid: "#ffc83b",
    high: "#ff5d68",
    glow: "#2debd2",
    unlit: "rgba(12, 32, 45, 0.4)",
  },
  tokyo: {
    low: "#38f5e5",
    mid: "#bf55ec",
    high: "#ff3c9c",
    glow: "#ff3c9c",
    unlit: "rgba(20, 15, 45, 0.4)",
  },
  "sao-paulo": {
    low: "#6dff8a",
    mid: "#ffe642",
    high: "#ff4e8b",
    glow: "#6dff8a",
    unlit: "rgba(12, 38, 24, 0.4)",
  },
  amsterdam: {
    low: "#40efff",
    mid: "#ff9a3c",
    high: "#ff4ba8",
    glow: "#40efff",
    unlit: "rgba(10, 30, 52, 0.4)",
  },
};

function getVenueSpectrumTheme(venue) {
  if (venue?.id && VENUE_SPECTRUM_THEMES[venue.id]) {
    return VENUE_SPECTRUM_THEMES[venue.id];
  }
  return {
    low: venue?.accent || "#00f0ff",
    mid: "#ffd64d",
    high: venue?.secondary || "#ff2a85",
    glow: venue?.accent || "#00f0ff",
    unlit: "rgba(16, 32, 64, 0.35)",
  };
}

function renderSpectrumCanvas(ctx, w, h, isLeft, dpr, reduced, theme) {
  ctx.clearRect(0, 0, w, h);

  if (h <= 40 || w <= 10) return;

  const pad = Math.max(2, Math.round(3 * dpr));
  const barWidth = Math.max(4, Math.floor((w - (VIZ_BARS + 1) * pad) / VIZ_BARS));
  const totalW = VIZ_BARS * barWidth + (VIZ_BARS - 1) * pad;
  const startX = Math.floor((w - totalW) / 2);

  const numSegs = 50;
  const segGap = Math.max(2, Math.round(2 * dpr));
  const segH = Math.max(2, Math.floor((h - (numSegs - 1) * segGap) / numSegs));
  const totalSegsH = numSegs * segH + (numSegs - 1) * segGap;
  const remY = Math.max(0, Math.floor((h - totalSegsH) / 2));
  const rx = Math.max(1, Math.round(1.5 * dpr));

  for (let c = 0; c < VIZ_BARS; c++) {
    const bx = startX + c * (barWidth + pad);
    const dataIdx = isLeft ? c : VIZ_BARS - 1 - c;
    const val = vizBarHeights[dataIdx] || 0;
    const peak = vizBarPeaks[dataIdx] || 0;

    const litCount = Math.round(val * numSegs);
    const peakSeg = Math.min(numSegs - 1, Math.round(peak * numSegs));

    // Subtle dark chassis channel behind each bar, running full height from top to bottom
    ctx.fillStyle = theme.unlit;
    drawRoundedSegment(ctx, bx - 1, remY, barWidth + 2, totalSegsH, rx);

    for (let s = 0; s < numSegs; s++) {
      const sy = (h - remY) - (s + 1) * segH - s * segGap;
      const frac = s / (numSegs - 1);
      const isLit = s < litCount;
      const isPeak = !reduced && s === peakSeg && peak > 0.05;

      if (isPeak) {
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = theme.glow;
        ctx.shadowBlur = Math.round(6 * dpr);
        drawRoundedSegment(ctx, bx, sy, barWidth, segH, rx);
        ctx.shadowBlur = 0;
      } else if (isLit) {
        let segColor;
        if (frac < 0.55) {
          segColor = theme.low;
        } else if (frac < 0.8) {
          segColor = theme.mid;
        } else {
          segColor = theme.high;
        }
        ctx.fillStyle = segColor;
        ctx.shadowColor = segColor;
        ctx.shadowBlur = (s >= litCount - 2) ? Math.round(5 * dpr) : 0;
        drawRoundedSegment(ctx, bx, sy, barWidth, segH, rx);
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = "rgba(16, 32, 64, 0.35)";
        drawRoundedSegment(ctx, bx, sy, barWidth, segH, rx);
      }
    }
  }
}

function paintRailVisualizers(dt) {
  if (
    !railCtxLeft ||
    !railCtxRight ||
    !document.body.classList.contains("play-view") ||
    window.innerWidth < 1200
  )
    return;

  const reduced = renderer.reducedMotion;
  const cadence = reduced ? 0.25 : 1 / 30;
  vizElapsed += dt;
  if (vizElapsed < cadence) return;
  const elapsed = Math.min(0.2, vizElapsed);
  vizElapsed = 0;
  if (!reduced) vizClock += elapsed;

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const clientWL = railVizLeft.clientWidth,
    clientHL = railVizLeft.clientHeight;
  if (clientWL > 0 && clientHL > 0) {
    const bwL = Math.round(clientWL * dpr),
      bhL = Math.round(clientHL * dpr);
    if (railVizLeft.width !== bwL || railVizLeft.height !== bhL) {
      railVizLeft.width = bwL;
      railVizLeft.height = bhL;
    }
  }
  const clientWR = railVizRight.clientWidth,
    clientHR = railVizRight.clientHeight;
  if (clientWR > 0 && clientHR > 0) {
    const bwR = Math.round(clientWR * dpr),
      bhR = Math.round(clientHR * dpr);
    if (railVizRight.width !== bwR || railVizRight.height !== bhR) {
      railVizRight.width = bwR;
      railVizRight.height = bhR;
    }
  }

  const hasFreq = music.getFrequencyData(vizFreqBuffer);

  for (let b = 0; b < VIZ_BARS; b++) {
    if (reduced) {
      vizBarHeights[b] = 0.35;
      vizBarPeaks[b] = 0.35;
    } else if (hasFreq) {
      const [start, end] = VIZ_BAND_RANGES[b];
      let sum = 0;
      for (let k = start; k <= end; k++) sum += vizFreqBuffer[k];
      const avg = sum / (end - start + 1);
      const freqScale = 1.05 + b * 0.08;
      const targetVal = Math.min(1, (avg / 255) * freqScale);
      if (targetVal > vizBarHeights[b]) {
        vizBarHeights[b] = targetVal;
      } else {
        vizBarHeights[b] = Math.max(0, vizBarHeights[b] - elapsed * 2.5);
      }
    } else {
      vizBarHeights[b] = 0.22 + 0.16 * Math.sin(vizClock * 2.2 + b * 0.65);
    }

    if (!reduced) {
      if (vizBarHeights[b] > vizBarPeaks[b]) {
        vizBarPeaks[b] = vizBarHeights[b];
      } else {
        vizBarPeaks[b] = Math.max(0, vizBarPeaks[b] - elapsed * 0.75);
      }
    }
  }

  const venue = game ? getVenue(game.config) : VENUES[0];
  const theme = getVenueSpectrumTheme(venue);

  renderSpectrumCanvas(railCtxLeft, railVizLeft.width, railVizLeft.height, true, dpr, reduced, theme);
  renderSpectrumCanvas(railCtxRight, railVizRight.width, railVizRight.height, false, dpr, reduced, theme);
}

// The scoreboard floats over the top of the court in play view and reflows
// with the window, so nothing else can be positioned under it from a constant.
// Its measured height is published as --scoreboard-height and the olé readout
// starts below it; see .one-touch-readout in style.css.
let lastScoreboardHeight = -1;
function publishScoreboardHeight() {
  const board = $("scoreboard");
  if (!board) return;
  const height = document.body.classList.contains("play-view")
    ? Math.round(board.getBoundingClientRect().height)
    : 0;
  if (height === lastScoreboardHeight) return;
  lastScoreboardHeight = height;
  document.documentElement.style.setProperty(
    "--scoreboard-height",
    `${height}px`,
  );
}
if (typeof ResizeObserver === "function") {
  const observer = new ResizeObserver(() => publishScoreboardHeight());
  const board = $("scoreboard");
  if (board) observer.observe(board);
}
// A streak of 0 hides the readout; every tenth pass is a milestone, which is
// the pink state the canvas badge used to paint.
function syncOneTouchReadout() {
  const streak = game?.oneTouchStreak || 0,
    readout = $("one-touch-readout");
  if (!readout) return;
  if (streak === 0 && hudCache.oneTouchStreak === 0) return;
  if (streak !== hudCache.oneTouchStreak) {
    readout.hidden = !streak;
    hudCache.oneTouchStreak = streak;
    if (!streak) return;
    $("one-touch-label").textContent = `ONE TOUCH ×${streak}`;
  }
  if (!streak) return;
  const isMilestone = streak >= 10;
  if (isMilestone !== hudCache.oneTouchMilestone) {
    readout.classList.toggle("is-milestone", isMilestone);
    hudCache.oneTouchMilestone = isMilestone;
  }
  const step = streak % 10,
    progress = step === 0 ? 1 : step / 10;
  if (progress !== hudCache.oneTouchProgress) {
    $("one-touch-fill").style.width = `${progress * 100}%`;
    hudCache.oneTouchProgress = progress;
  }
}
function syncHud() {
  syncOneTouchReadout();

  if (game.score !== hudCache.score) {
    $("score-value").textContent = String(game.score).padStart(3, "0");
    hudCache.score = game.score;
  }

  const isPractice = Boolean(game.config.practice);
  const timeCeil = Math.ceil(game.time);
  const timeString = isPractice
    ? "∞"
    : `${Math.floor(timeCeil / 60)}:${String(Math.max(0, timeCeil % 60)).padStart(2, "0")}`;
  if (timeString !== hudCache.timeString) {
    $("time-value").textContent = timeString;
    hudCache.timeString = timeString;
  }
  const isUrgent = !isPractice && game.time < 15;
  if (isUrgent !== hudCache.timeUrgent) {
    $("time-value").classList.toggle("urgent", isUrgent);
    hudCache.timeUrgent = isUrgent;
  }

  const comboTier = 1 + Math.min(4, Math.floor(game.combo / 4));
  if (comboTier !== hudCache.combo) {
    $("combo-value").textContent = `×${comboTier}`;
    hudCache.combo = comboTier;
  }

  const roundPossessions = possessionLimit(game.config);
  const livesText = game.config.practice
    ? "∞"
    : `${Math.max(0, roundPossessions - game.turnovers)} / ${roundPossessions}`;
  if (livesText !== hudCache.lives) {
    $("lives-value").textContent = livesText;
    hudCache.lives = livesText;
  }

  if (focusToggle && game.focus <= 0) focusToggle = false;
  if (boostToggle && game.focus <= 0) boostToggle = false;
  // The engine gives Boost priority for simultaneously held physical inputs.
  // Mirror that exclusivity in click state so the HUD never claims both
  // abilities are active together.
  if (game.boostActive) focusToggle = false;
  syncFocusButtons();
  syncBoostButtons();

  const focusCap = game.tactic.focus;
  const focusAmount = Math.max(0, game.focus);
  const displayVal =
    focusAmount === 0 || focusAmount === focusCap || Number.isInteger(focusAmount)
      ? String(Math.round(focusAmount))
      : focusAmount.toFixed(1);
  const focusText = `${displayVal} / ${focusCap}`;
  if (focusText !== hudCache.focusText) {
    $("energy-value").textContent = focusText;
    $("touch-focus-value").textContent = focusText;
    hudCache.focusText = focusText;
  }

  const focusRatio = focusCap ? focusAmount / focusCap : 0;
  const roundedRatio = Math.round(focusRatio * 1000) / 10;
  if (roundedRatio !== hudCache.focusRatio) {
    const widthStr = `${roundedRatio}%`;
    $("energy-fill").style.width = widthStr;
    $("touch-focus-fill").style.width = widthStr;
    hudCache.focusRatio = roundedRatio;
    const tier = focusAmount >= 7.5 ? "high" : focusAmount >= 3.5 ? "mid" : "low";
    if (tier !== hudCache.focusTier) {
      $("energy-info").dataset.tier = tier;
      hudCache.focusTier = tier;
    }
  }

  const roundedFocus = focusAmount.toFixed(1);
  if (roundedFocus !== hudCache.focusValuenow || focusCap !== hudCache.focusCap) {
    $("energy-meter").setAttribute("aria-valuemax", String(focusCap));
    $("energy-meter").setAttribute("aria-valuenow", roundedFocus);
    $("energy-meter").setAttribute(
      "aria-valuetext",
      `${roundedFocus} of ${focusCap} energy`,
    );
    hudCache.focusValuenow = roundedFocus;
    hudCache.focusCap = focusCap;
  }

  const focusEmpty = focusAmount <= 0;
  if (focusEmpty !== hudCache.focusEmpty) {
    $("energy-info").classList.toggle("is-empty", focusEmpty);
    $("touch-focus").classList.toggle("is-empty", focusEmpty);
    hudCache.focusEmpty = focusEmpty;
  }

  const isBoost = Boolean(game.boostActive);
  if (isBoost !== hudCache.energyBoostActive) {
    $("energy-info").classList.toggle("boost-active", isBoost);
    hudCache.energyBoostActive = isBoost;
  }
  const isFocus = Boolean(game.focusActive);
  if (isFocus !== hudCache.energyFocusActive) {
    $("energy-info").classList.toggle("focus-active", isFocus);
    hudCache.energyFocusActive = isFocus;
  }

  const goalPercent = game.config.target
    ? Math.min(100, (game.score / game.config.target) * 100)
    : Math.min(100, (game.time / 60) * 100);
  const goalWidth = `${Math.round(goalPercent * 10) / 10}%`;
  if (goalWidth !== hudCache.goalWidth) {
    $("goal-fill").style.width = goalWidth;
    hudCache.goalWidth = goalWidth;
  }

  const record = progress.records[recordKey()];
  const bestText = record ? String(record) : "—";
  if (bestText !== hudCache.bestText) {
    $("best-label").textContent = bestText;
    hudCache.bestText = bestText;
  }

  const targetText =
    phase === "playing"
      ? game.queuedPass
        ? `QUEUED → ${game.queuedPass.id + 1} · RELEASE ON ARRIVAL`
        : game.ball
          ? `NEXT PASS → ${game.bestQueuedTarget(aim) + 1} · QUEUE IT NOW`
          : `${bank ? "WALL PASS" : "PASS"} → ${game.bestTarget(aim) + 1}`
      : "FIND THE SPACE. MAKE THE PASS.";
  if (targetText !== hudCache.targetText) {
    $("target-label").textContent = targetText;
    hudCache.targetText = targetText;
  }

  const isPlaying = phase === "playing";
  if (isPlaying !== hudCache.isPlaying) {
    $("court-wrap").classList.toggle("is-playing", isPlaying);
    hudCache.isPlaying = isPlaying;
  }

  const isRound = phase !== "ready";
  if (isRound !== hudCache.isRound) {
    $("court-wrap").classList.toggle("is-round", isRound);
    hudCache.isRound = isRound;
  }
}
function finish() {
  if (finished) return;
  renderer.effects.length = 0;
  finished = true;
  phase = "finished";
  focusToggle = false;
  boostToggle = false;
  clearInput();
  endHold();
  $("pause-button").disabled = false;
  setPauseState(false);
  setControlsEnabled(false);
  const result = awardMatch(progress, game, mode, courtIndex);
  roundCleared = result.cleared;
  const completedRound = {
    id: globalThis.crypto?.randomUUID?.() || `round-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    mode,
    court: courtIndex,
    score: game.score,
    passes: game.passes,
    bestOneTouch: game.bestOneTouch,
    triangles: game.triangles || 0,
    oles: game.oles || 0,
    splits: game.splits || 0,
    zones: game.zones || 0,
    // Read off the config applyDifficulty stamped onto this exact round —
    // never off progress.difficulty, which could have changed since kickoff.
    difficulty: game.config.difficulty,
  };
  if (dataAdapter.kind !== "supabase") {
    void recordRound(completedRound).then((saved) => {
      if (!saved) toast("Round stats could not be stored.");
    });
  } else if (profile && preferences.scoreSaveChoice === "always") {
    queuePendingScore(completedRound, profile.id);
    void savePendingScores().then((saved) => {
      if (!saved) toast("Score could not be saved. It will retry after your next completed game.");
    });
  } else if (preferences.scoreSaveChoice === "ask") {
    queuePendingScore(completedRound);
  }
  persist();
  syncProgress();
  // Must match game.js's own turnover() end-of-round condition exactly
  // (turnovers >= config.possessions, practice exempt) or the UI can decide
  // the round ended for a different reason than the engine actually used —
  // possessionLimit() is the one place both read that fallback from, so this
  // can't drift the way a re-typed literal 3 already had.
  const outOfPossessions =
    game.turnovers >= possessionLimit(game.config) && !game.config.practice;
  const extra =
    mode === "career" && result.cleared
      ? courtIndex === COURTS.length - 1
        ? "Circuit complete. Chase three stars on every court."
        : `${COURTS[courtIndex + 1].name} is now unlocked.`
      : outOfPossessions
        ? "The press caught you. Use focus and wall passes to find space."
        : result.cleared
          ? "Keep exploring. There’s always a better passing lane."
          : `Aim for ${game.config.target} points and survive the full round.`;
  // Both buttons replay this same court; the difference is only whether the
  // ball is moving when you land. Say which is which, and never say "courts",
  // which now means the home screen. Leaving for home is the Menu button in
  // the top bar and the pause menu's Home entry, both of which are reachable
  // from here — this overlay never pretends to offer it.
  showRoundResults({
    cleared: result.cleared,
    kicker: result.cleared
      ? `VICTORY · COURT CLEARED${result.newBest ? " · NEW BEST" : ""}`
      : outOfPossessions
        ? "DEFEAT · POSSESSIONS LOST"
        : "DEFEAT · TARGET MISSED",
    title:
      mode === "endless"
        ? "What a run."
        : result.cleared
          ? "Beautiful football."
          : "Full time.",
    copy: extra,
    primary:
      mode === "career" && result.cleared && courtIndex < COURTS.length - 1
        ? "Play the next court"
        : !result.cleared
          ? "Retry"
          : mode === "endless"
            ? "Start a new run"
            : mode === "practice"
              ? "Practise this court again"
              : "Play this court again",
    secondary: "Change difficulty",
    tertiary: "Home",
    stars: result.stars,
    xp: result.xp,
  });
  sound.play(result.cleared ? "victory" : "defeat");
  announce(
    `Round complete. ${game.score} points. ${result.cleared ? "Court cleared." : ""}`,
  );
  if (pendingScoreRounds.length) showScoreSaveDialog();
}
if (testDataAdapterFactory) {
  // A deliberately narrow test hook: it exercises the post-round consent
  // path without manufacturing pointer/gamepad input or exposing game state
  // in production builds.
  globalThis.__TIKI_TAKA_TEST_HOOKS__ = {
    finishRound: finish,
    prepareRound: prepare,
    switchContext: switchDataContext,
    setScoreSaveChoice: (choice) => {
      preferences = { ...preferences, scoreSaveChoice: choice };
    },
    recoverRemote: recoverRemoteDataContext,
  };
}
$("start-button").addEventListener("click", () => {
  if (phase === "finished" && !resultActionsReady) return;
  if (
    phase === "finished" &&
    mode === "career" &&
    roundCleared &&
    courtIndex < COURTS.length - 1
  ) {
    courtIndex++;
    progress.lastCourt = courtIndex;
    persist();
    prepare();
    start();
    return;
  }
  start();
});
$("secondary-button").addEventListener("click", () => {
  if (phase === "finished" && !resultActionsReady) return;
  if (pendingSwitch) {
    const next = pendingSwitch;
    pendingSwitch = null;
    mode = next.next;
    courtIndex = next.index;
    progress.lastCourt = courtIndex;
    prepare();
    persist();
    return;
  }
  prepare();
});
$("tertiary-button").addEventListener("click", () => {
  if (phase === "finished" && !resultActionsReady) return;
  applyView("home");
});
// The phone sheet's way out. It lands on home rather than merely hiding the
// sheet: the round behind it is over, so dismissing to a dead arena with no
// live controls would strand the player with nothing to press.
$("overlay-close")?.addEventListener("click", () => {
  if (phase === "finished" && !resultActionsReady) return;
  applyView("home");
});
$("pause-button").addEventListener("click", togglePause);
$("pass-button").addEventListener("click", () => doPass());
$("bank-button").addEventListener("click", toggleBank);
$("focus-button").addEventListener("click", toggleFocus);
$("boost-button").addEventListener("click", toggleBoost);
$("shout-button").addEventListener("click", shoutTarget);
// The five touch actions bind the pointer, not the click.
//
// A click on a touchscreen is synthesised only after the browser has decided
// the touch was not the start of a gesture, and while another finger is
// already down — one holding the joystick, say — that decision is deferred.
// The result was that a pass would not register until the movement thumb was
// lifted, which is not how anyone plays: moving and passing at the same time
// is the whole point of a possession game. Acting on pointerdown makes each
// finger independent and removes the synthesis delay for every input, not just
// the second one.
//
// `click` is kept for everything that is not a touch, so a keyboard player
// reaching these with Enter or Space still triggers them; the pointerType
// guard is what stops a touch firing both.
for (const [id, run] of [
  ["touch-pass", () => doPass()],
  ["touch-bank", toggleBank],
  ["touch-focus", toggleFocus],
  ["touch-boost", toggleBoost],
  ["touch-shout", shoutTarget],
]) {
  const button = $(id);
  button.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    if (button.disabled) return;
    // Claiming the pointer keeps a slide off the button from becoming a
    // gesture on whatever is underneath, and stops the court's own
    // pointer handlers seeing this finger at all.
    event.preventDefault();
    event.stopPropagation();
    run();
  });
  button.addEventListener("click", (event) => {
    if (event.pointerType === "touch") return;
    run();
  });
}
$("tactic-select").addEventListener("change", (e) => {
  progress.tactic = e.target.value;
  persist();
  prepare();
});
$("difficulty-select").addEventListener("change", (e) => {
  if (!DIFFICULTY_IDS.includes(e.target.value)) return;
  progress.difficulty = e.target.value;
  persist();
  prepare();
});
// #sound-button survives the split as the master mute: one press silences
// both buses, the next brings back exactly what was on before. The per-bus
// switches below it are what a player reaches for to keep one and drop the
// other.
const percent = (value) => `${Math.round(value * 100)}%`;
let mutedState = null;
function applyAudioSettings() {
  sound.enabled = settings.effectsOn;
  sound.setVolume(settings.effectsVolume);
  music.setEnabled(settings.musicOn);
  music.setVolume(settings.musicVolume);
  // progress.sound is the legacy single switch. Keep it in step so a profile
  // written before the audio split never disagrees with the current settings.
  progress.sound = settings.effectsOn || settings.musicOn;
  unlockAudio();
  syncAudioChrome();
}
function syncAudioChrome() {
  const anyOn = settings.effectsOn || settings.musicOn;
  $("sound-button").setAttribute("aria-pressed", String(anyOn));
  $("sound-button").textContent = anyOn ? "Sound on" : "Sound off";
  $("effects-button").setAttribute("aria-pressed", String(settings.effectsOn));
  $("effects-button").textContent = settings.effectsOn
    ? "Effects on"
    : "Effects off";
  $("music-button").setAttribute("aria-pressed", String(settings.musicOn));
  $("music-button").textContent = settings.musicOn ? "Music on" : "Music off";
  $("effects-volume").value = String(Math.round(settings.effectsVolume * 100));
  $("music-volume").value = String(Math.round(settings.musicVolume * 100));
  $("effects-volume-value").textContent = percent(settings.effectsVolume);
  $("music-volume-value").textContent = percent(settings.musicVolume);
  $("effects-volume").disabled = !settings.effectsOn;
  $("music-volume").disabled = !settings.musicOn;
  syncAudioHint();
  syncMusicRail();
}
$("sound-button").addEventListener("click", () => {
  const anyOn = settings.effectsOn || settings.musicOn;
  if (anyOn) {
    // Remember the shape of the mute so unmuting restores it rather than
    // turning on a bus the player had deliberately switched off.
    mutedState = { effects: settings.effectsOn, music: settings.musicOn };
    settings.effectsOn = false;
    settings.musicOn = false;
  } else {
    settings.effectsOn = mutedState?.effects ?? true;
    settings.musicOn = mutedState?.music ?? true;
    mutedState = null;
  }
  applyAudioSettings();
  persist();
  persistSettings();
});
$("effects-button").addEventListener("click", () => {
  settings.effectsOn = !settings.effectsOn;
  mutedState = null;
  applyAudioSettings();
  persist();
  persistSettings();
});
function toggleMusic() {
  settings.musicOn = !settings.musicOn;
  mutedState = null;
  applyAudioSettings();
  persist();
  persistSettings();
}
$("music-button").addEventListener("click", toggleMusic);
// The top bar's player — the only one now. It is the same switch as the
// settings dialog's Music button plus a skip, so there is one notion of
// "music on" and the volume and on/off settings keep governing it.
function syncMusicRail() {
  // The popup's prev/toggle/skip are the same three controls again, just
  // reachable when the bar-level pair (`#music-prev`/`#music-skip`) is
  // collapsed away — see `.music-transport` in style.css — so every field
  // below is written twice rather than the popup drifting out of sync with
  // whichever pair is actually visible.
  const toggle = $("music-toggle"),
    prev = $("music-prev"),
    skip = $("music-skip"),
    popupToggle = $("music-popup-toggle"),
    popupPrev = $("music-popup-prev"),
    popupSkip = $("music-popup-skip");
  if (!toggle) return;
  for (const t of [toggle, popupToggle]) {
    if (!t) continue;
    t.setAttribute("aria-pressed", String(settings.musicOn));
    t.firstElementChild.textContent = settings.musicOn ? "▮▮" : "▶";
    t.setAttribute(
      "aria-label",
      settings.musicOn ? "Pause the soundtrack" : "Play the soundtrack",
    );
  }
  for (const p of [prev, popupPrev]) {
    if (!p) continue;
    p.setAttribute("aria-label", "Skip to the previous track");
    p.disabled = music.trackCount < 2;
  }
  for (const s of [skip, popupSkip]) {
    if (!s) continue;
    s.setAttribute("aria-label", "Skip to the next track");
    s.disabled = music.trackCount < 2;
  }
  const title = music.trackTitle;
  const titleAttr = title
    ? `${title} · track ${music.trackIndex + 1} of ${music.trackCount}`
    : "";
  $("music-track").textContent = title || "—";
  $("music-track").title = titleAttr;
  const popupTrack = $("music-popup-track");
  if (popupTrack) {
    popupTrack.textContent = title || "—";
    popupTrack.title = titleAttr;
  }
}
// A plain popover, not a <dialog> — see the CSS comment on `.music-popup` for
// why: it must never pause the round or count toward menuBlocking(). Closing
// it lives in one place so every path that should dismiss it (a real close,
// an outside click, Escape, the window widening past the tier that shows the
// opener at all, or another menu opening over it) goes through the same code.
function closeMusicPopup() {
  const popup = $("music-popup");
  if (!popup || popup.hidden) return;
  popup.hidden = true;
  $("music-more")?.setAttribute("aria-expanded", "false");
}
function toggleMusicPopup() {
  const popup = $("music-popup");
  if (!popup) return;
  if (popup.hidden) {
    popup.hidden = false;
    $("music-more").setAttribute("aria-expanded", "true");
  } else {
    closeMusicPopup();
  }
}
$("music-more")?.addEventListener("click", () => {
  toggleMusicPopup();
  unlockAudio();
});
document.addEventListener("pointerdown", (event) => {
  if (!$("music-popup") || $("music-popup").hidden) return;
  if (!$("music-player").contains(event.target)) closeMusicPopup();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("music-popup")?.hidden) closeMusicPopup();
});
// The opener only exists below 901px (see `.music-more` in style.css) — a
// window widened past that tier while the popup was open would otherwise
// leave it floating with no way to reach the button that opened it.
matchMedia("(min-width: 901px)").addEventListener("change", (event) => {
  if (event.matches) closeMusicPopup();
});
// A bar button is a real button, so activating it takes DOM focus off the
// court — and then Space would press the button again instead of making a
// pass. Handing focus straight back is what keeps the player out of the way
// of play; during a pause or a menu the focus belongs where it is.
function returnFocusToCourt() {
  if (phase === "playing" && !menuBlocking())
    $("court").focus({ preventScroll: true });
}
// The popup's transport repeats these three ids' wiring rather than sharing a
// listener, so a tap inside it behaves exactly like the bar-level buttons it
// stands in for once they're collapsed away — including handing focus back to
// the court, which is what lets a skip mid-round not cost you a keypress.
for (const id of ["music-prev", "music-popup-prev"]) {
  $(id)?.addEventListener("click", () => {
    unlockAudio();
    music.skip(-1);
    syncMusicRail();
    returnFocusToCourt();
  });
}
for (const id of ["music-toggle", "music-popup-toggle"]) {
  $(id)?.addEventListener("click", () => {
    toggleMusic();
    syncMusicRail();
    returnFocusToCourt();
  });
}
for (const id of ["music-skip", "music-popup-skip"]) {
  $(id)?.addEventListener("click", () => {
    unlockAudio();
    music.skip(1);
    syncMusicRail();
    returnFocusToCourt();
  });
}
// "input" fires for a mouse drag, an arrow key and the gamepad steps below
// alike, so the level follows the control live and is written once it settles.
for (const [id, key] of [
  ["effects-volume", "effectsVolume"],
  ["music-volume", "musicVolume"],
]) {
  $(id).addEventListener("input", () => {
    settings[key] = Number($(id).value) / 100;
    if (key === "effectsVolume") sound.setVolume(settings[key]);
    else music.setVolume(settings[key]);
    $(`${id}-value`).textContent = percent(settings[key]);
    unlockAudio();
  });
  $(id).addEventListener("change", () => persistSettings());
}
// Xbox-style labels for the five actions pollGamepad() reads off the
// standard gamepad mapping (see the button comments there). Only the
// court toolbar's chips swap to these; everywhere else (the frozen footer
// legend, the help dialog) stays keyboard-phrased regardless of input.
const GAMEPAD_ACTION_LABELS = {
  smartPass: "A",
  wallToggle: "X",
  shout: "RB",
  focusHold: "LT",
  boostHold: "RT",
};
// The label a toolbar chip/title should show for an action right now: the
// gamepad glyph while the player is actively using a pad, otherwise the
// player's configured key(s).
function chipLabel(action) {
  if (inputSource === "gamepad") {
    const gb = settings.gamepadBindings || DEFAULT_GAMEPAD_BINDINGS;
    if (gb[action] !== undefined) {
      return GAMEPAD_SHORT_LABELS[gb[action]] || String(gb[action]);
    }
    if (GAMEPAD_ACTION_LABELS[action]) return GAMEPAD_ACTION_LABELS[action];
  }
  const codes = settings.bindings[action] || [];
  return codes.map(readableKey).join(" / ") || "Unbound";
}
// Refreshes just the toolbar's key chips and their titles. Split out of
// syncSettingChrome() so an input-source flip — which can happen mid-round,
// every time the player's hands move between keyboard and pad — doesn't
// also redo the theme, audio rail and scoreboard-height work that function
// does on a real settings change.
function refreshToolbarChips() {
  document.querySelectorAll("[data-binding]").forEach((element) => {
    element.textContent = element.closest(".court-toolbar")
      ? chipLabel(element.dataset.binding)
      : (settings.bindings[element.dataset.binding] || [])
          .map(readableKey)
          .join(" / ") || "Unbound";
  });
  $("pass-button").title =
    `Smart pass (${chipLabel("smartPass")}); press during flight to queue the next pass`;
  $("bank-button").title =
    `Toggle wall pass (${chipLabel("wallToggle")}); hold ${settings.bindings.wallHold.map(readableKey).join(" / ") || "unbound"}`;
  $("focus-button").title = `Hold Focus (${chipLabel("focusHold")})`;
  $("boost-button").title = `Hold Boost (${chipLabel("boostHold")}). Boost uses Energy.`;
  $("shout-button").title = `Shout selected target to bonus zone (${chipLabel("shout")})`;
}
function setInputSource(source) {
  if (source !== "gamepad") {
    if (padFocusElement) {
      padFocusElement.classList.remove("pad-focus");
      padFocusElement = null;
    }
    document.querySelectorAll(".pad-focus").forEach((el) => el.classList.remove("pad-focus"));
  }
  if (inputSource === source) return;
  inputSource = source;
  refreshToolbarChips();
  const padHint = $("courts-pad-hint");
  if (padHint) padHint.hidden = source !== "gamepad";
}
function syncSettingChrome() {
  syncAudioChrome();
  document.documentElement.dataset.theme = "dark";
  document.body.classList.toggle("play-view", view === "arena");
  document.body.dataset.view = view;
  publishScoreboardHeight();
  if ($("preset-select")) $("preset-select").value = settings.preset;
  syncGamepadDropdowns();
  refreshToolbarChips();
  const padHint = $("courts-pad-hint");
  if (padHint) padHint.hidden = inputSource !== "gamepad";
  // The court's own aria-label stays keyboard-phrased: it is read once by a
  // screen reader, not glanced at mid-play, so it is not worth chasing the
  // live input source the way the visible chips are.
  const bindingText = (action) =>
    settings.bindings[action].map(readableKey).join(" / ") || "unbound";
  $("court").setAttribute(
    "aria-label",
    `Tiki Taka court. Move with ${bindingText("moveUp")}, ${bindingText("moveLeft")}, ${bindingText("moveDown")}, and ${bindingText("moveRight")}. Smart pass with ${bindingText("smartPass")}; direct passes with ${[1, 2, 3, 4].map((number) => bindingText(`direct${number}`)).join(", ")}. Hold Focus with ${bindingText("focusHold")}, Boost with ${bindingText("boostHold")}, and shout the selected target with ${bindingText("shout")}.`,
  );
  $("pause-button").title =
    `${phase === "paused" ? "Resume" : "Pause"} (${settings.bindings.pause.map(readableKey).join(" / ")})`;
}
function setBindingStatus(message = "") {
  $("binding-status").textContent = message;
}
function cancelCapture(message = "Binding cancelled.") {
  capture = null;
  setBindingStatus(message);
  renderBindings();
}
function renderBindings() {
  const list = $("bindings-list");
  list.innerHTML = "";
  for (const [action, label] of Object.entries(ACTIONS)) {
    const row = document.createElement("div");
    row.className = "binding-row";
    const name = document.createElement("label");
    name.className = "binding-label";
    name.textContent = label;
    row.append(name);
    for (let slot = 0; slot < 2; slot++) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "binding-key";
      button.classList.toggle(
        "listening",
        capture?.action === action && capture.slot === slot,
      );
      button.dataset.action = action;
      button.dataset.slot = String(slot);
      button.textContent =
        capture?.action === action && capture.slot === slot
          ? "Press a key…"
          : readableKey(settings.bindings[action][slot] || "") || "Add key";
      button.setAttribute("aria-label", `${label}, binding ${slot + 1}`);
      if (slot === 1) button.title = "Select to rebind; Backspace clears";
      button.addEventListener("click", () => {
        capture = { action, slot };
        clearInput();
        setBindingStatus(
          `Press a key for ${label}. Escape cancels${slot === 1 ? "; Backspace clears" : ""}.`,
        );
        renderBindings();
      });
      row.append(button);
    }
    list.append(row);
  }
}
function openSettings() {
  if (phase === "playing") pause();
  closeMusicPopup();
  clearInput();
  capture = null;
  setBindingStatus("");
  $("preset-select").value = settings.preset;
  renderBindings();
  // Gamepad and keyboard remapping start collapsed on a phone (there is no
  // room to show all three sections open at once — see the <details> markup
  // in index.html) and open on every other size, freshly re-evaluated on
  // each open rather than left to whatever a player last toggled: a settings
  // dialog that stays wide-open on a phone one visit and collapsed on a
  // desktop the next, because of a state that outlived the window it was set
  // in, would be a stranger bug than always resetting to the size-correct
  // default.
  const compact = compactSettingsQuery.matches;
  $("settings-gamepad-group").open = !compact;
  $("settings-bindings-group").open = !compact;
  $("settings-dialog").showModal();
}
// True only for the Supabase adapter: the sole account system left. With no
// Supabase configuration, dataAdapter.kind is "guest" and the account entry
// point in the header is hidden entirely (see accountsAvailable below), so
// this dialog is unreachable in that state and its branching can assume
// "online" whenever it does run.
const onlineAccount = () => dataAdapter.kind === "supabase";
function syncAccountDialog() {
  $("account-guest").hidden = Boolean(profile);
  $("account-profile").hidden = !profile;
  $("profile-username").textContent = profile?.username || "";
  $("profile-email").textContent = profile?.email || "";
  $("account-note").textContent = remoteDataUnavailable
    ? "Account data is temporarily unavailable. You are still playing locally; reconnect before relying on saved scores."
    : "Your email stays private. Your username is public on the friendly leaderboard. Scores you submit are not independently verified.";
  $("account-button").textContent = `◎ ${profile?.username || "Account"}`;
  // The bar says "Guest" until a profile is chosen, and never claims more
  // than the active adapter actually provides.
  $("profile-chip-name").textContent = profile?.username || "Guest";
  $("profile-button").setAttribute(
    "aria-label",
    profile
      ? `Account ${profile.username}. Open profile and settings.`
      : `Playing as Guest. Open account and settings.`,
  );
}
async function switchDataContext(nextProfile) {
  const generation = ++dataContextGeneration;
  if (phase === "playing") pause();
  clearInput();
  let data;
  let unreadable = false;
  try {
    data = await dataAdapter.loadUserData();
  } catch (error) {
    if (!(error instanceof LocalDataError) || error.code !== "PROGRESS_TOO_NEW") throw error;
    unreadable = true;
    data = progressTooNewSnapshot();
  }
  if (generation !== dataContextGeneration) return false;
  applyDataContext(data, nextProfile, unreadable);
  if (unreadable) toast(PROGRESS_TOO_NEW_MESSAGE);
  return true;
}
function applyDataContext(data, nextProfile, unreadable = false) {
  profile = nextProfile;
  remoteDataUnavailable = false;
  progressTooNew = unreadable;
  progress = data.progress;
  settings = data.settings;
  accountStats = data.stats;
  preferences = data.preferences || { scoreSaveChoice: "ask" };
  mode = "career";
  courtIndex = progress.lastCourt;
  // A switched-to profile brings its own audio settings, and may never have
  // seen the split, so it gets the same one-time fold as the first load did.
  if (!settings.audioMigrated) {
    settings.effectsOn = progress.sound;
    settings.musicOn = progress.sound;
    settings.audioMigrated = true;
  }
  mutedState = null;
  applyAudioSettings();
  prepare();
  syncProgress();
  syncSettingChrome();
  syncAccountDialog();
  applyView("home");
}
async function recoverRemoteDataContext() {
  if (!remoteDataUnavailable || !onlineAccount()) return !remoteDataUnavailable;
  if (remoteRecoveryPromise) return remoteRecoveryPromise;
  const generation = ++dataContextGeneration;
  remoteRecoveryPromise = (async () => {
    try {
      // Read the live session and its authoritative save before lifting the
      // write gate; the fallback guest snapshot is never written remotely.
      const session = await dataAdapter.getSession();
      const data = await dataAdapter.loadUserData();
      if (generation !== dataContextGeneration) return false;
      if (session?.needsUsername) {
        applyDataContext(data, null);
        openUsernamePrompt(session.user);
      } else {
        applyDataContext(data, session?.profile || profile);
      }
      if (preferences.scoreSaveChoice === "always" && pendingScoreRounds.length)
        void savePendingScores().then((saved) => {
          if (!saved) toast("Queued scores are still waiting for a connection.");
        });
      toast("Account connection restored.");
      return true;
    } catch {
      return false;
    } finally {
      remoteRecoveryPromise = null;
    }
  })();
  return remoteRecoveryPromise;
}
function openAccount() {
  if (phase === "playing") pause();
  closeMusicPopup();
  clearInput();
  $("account-status").textContent = "";
  syncAccountDialog();
  $("account-dialog").showModal();
}
$("account-button").addEventListener("click", openAccount);
$("profile-button").addEventListener("click", openAccount);
// A mouse-only player's way out of a round: the same togglePause() Esc and the
// gamepad's Start already call, on a labelled control that never sits over the
// court. Both of those keep working untouched.
$("top-home").addEventListener("click", () => applyView("home"));
$("top-pause").addEventListener("click", togglePause);
$("close-account").addEventListener("click", () => $("account-dialog").close());
// The one path every sign-in method finishes through - register(), login()
// and completeProfile() (the username prompt after a first-time Discord
// sign-in) all resolve to a profile the same shape, and from there a
// guest-progress handoff, a pending score save and a data-context switch all
// need to happen identically regardless of which one got the player there.
async function afterAuthenticated(next, successMessage) {
  await switchDataContext(next);
  $("account-dialog").close();
  $("username-dialog").close();
  if (saveScoreAfterAuthentication) {
    saveScoreAfterAuthentication = false;
    showScoreSaveDialog();
    await chooseAlwaysSave();
  } else {
    toast(successMessage);
  }
}
$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = await dataAdapter.register({
      email: $("register-email").value,
      username: $("register-username").value,
      password: $("register-password").value,
    });
    await afterAuthenticated(next, `Account ${next.username} created.`);
  } catch (error) {
    $("account-status").textContent = error.message;
  }
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = await dataAdapter.login({
      identifier: $("login-identifier").value,
      password: $("login-password").value,
    });
    await afterAuthenticated(next, `Signed in as ${next.username}.`);
  } catch (error) {
    $("account-status").textContent = error.message;
  }
});
$("logout-button").addEventListener("click", async () => {
  await dataAdapter.logout();
  await switchDataContext(null);
  $("account-dialog").close();
  toast("Returned to guest progress.");
});
// The redirect to Discord replaces the whole page, so there is nothing to
// await here in the success case - the player is gone before this promise
// would resolve. Only a failure to even start the redirect (network error,
// misconfigured provider) surfaces here.
$("discord-signin").addEventListener("click", async () => {
  $("account-status").textContent = "";
  try {
    await dataAdapter.signInWithDiscord({
      redirectTo: `${location.origin}${location.pathname}`,
    });
  } catch (error) {
    $("account-status").textContent = error.message;
  }
});
function openUsernamePrompt(user) {
  if (phase === "playing") pause();
  closeMusicPopup();
  clearInput();
  $("account-dialog").close();
  pendingUsernamePrompt = user;
  $("username-status").textContent = "";
  $("username-input").value = user?.suggestedUsername || "";
  $("username-dialog").showModal();
}
$("close-username").addEventListener("click", () => $("username-dialog").close());
$("username-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = await dataAdapter.completeProfile({
      username: $("username-input").value,
    });
    pendingUsernamePrompt = null;
    await afterAuthenticated(next, `Welcome, ${next.username}.`);
  } catch (error) {
    $("username-status").textContent = error.message;
  }
});
$("close-score-save").addEventListener("click", () => $("score-save-dialog").close());
$("score-save-later").addEventListener("click", () => $("score-save-dialog").close());
$("score-save-never").addEventListener("click", async () => {
  try {
    await saveScorePreference("never");
    pendingScoreRounds = [];
    $("score-save-dialog").close();
    toast("Scores will stay on this device.");
  } catch (error) {
    $("score-save-status").textContent = error.message || "Your choice could not be saved.";
  }
});
async function chooseAlwaysSave() {
  if (!profile) {
    saveScoreAfterAuthentication = true;
    $("score-save-dialog").close();
    openAccount();
    $("account-status").textContent = "Create an account or sign in to save this score.";
    return;
  }
  try {
    const saved = await savePendingScores();
    if (!saved) {
      // Keep both the round and the ask preference so no score is silently
      // lost, and a transient failure cannot silently turn on future uploads.
      $("score-save-status").textContent = "Score could not be saved. Check your connection and try again.";
      return;
    }
    await saveScorePreference("always");
    $("score-save-dialog").close();
    toast("Score saved. Future completed games will save automatically.");
  } catch (error) {
    $("score-save-status").textContent = error.message || "Your score preference could not be saved.";
  }
}
$("score-save-always").addEventListener("click", chooseAlwaysSave);
// Sessions can change in another tab or when Supabase restores one after the
// shell has booted. Keep the visible account and scoped local state honest.
const unsubscribeAuthState = dataAdapter.onAuthStateChange?.((session) => {
  if (session?.needsUsername) {
    // Covers the Discord redirect returning to an already-booted tab (a
    // second tab, or a slow initial session check) as well as this same
    // boot's own initial-session event - both can fire after the top-level
    // pendingUsernamePrompt handoff already opened this dialog for the same
    // user, so skip re-opening it.
    if ((session.user?.id || null) === (pendingUsernamePrompt?.id || null)) return;
    openUsernamePrompt(session.user);
    return;
  }
  const nextProfile = session?.profile || null;
  if ((nextProfile?.id || null) === (profile?.id || null)) return;
  void switchDataContext(nextProfile).catch(() =>
    toast("Your account changed, but its saved data could not be loaded."),
  );
});
window.addEventListener("pagehide", () => unsubscribeAuthState?.(), { once: true });
window.addEventListener("online", () => void recoverRemoteDataContext());
$("settings-button").addEventListener("click", openSettings);
$("close-settings").addEventListener("click", () =>
  $("settings-dialog").close(),
);
$("settings-dialog").addEventListener("close", () => {
  capture = null;
  clearInput();
});
$("preset-select").addEventListener("change", (event) => {
  capture = null;
  clearInput();
  settings.preset = event.target.value;
  settings.bindings = presetBindings(settings.preset);
  persistSettings();
  setBindingStatus("Control preset applied.");
  renderBindings();
  syncSettingChrome();
});
$("reset-bindings").addEventListener("click", () => {
  capture = null;
  clearInput();
  settings.preset = "wasd";
  settings.bindings = presetBindings();
  settings.gamepadBindings = { ...DEFAULT_GAMEPAD_BINDINGS };
  $("preset-select").value = "wasd";
  persistSettings();
  setBindingStatus("Default bindings restored.");
  renderBindings();
  syncSettingChrome();
});

function syncGamepadDropdowns() {
  const gb = settings.gamepadBindings || DEFAULT_GAMEPAD_BINDINGS;
  document.querySelectorAll("[data-gamepad-action]").forEach((select) => {
    const action = select.dataset.gamepadAction;
    if (gb[action] !== undefined) {
      select.value = String(gb[action]);
    }
  });
}
document.querySelectorAll("[data-gamepad-action]").forEach((select) => {
  select.addEventListener("change", () => {
    const action = select.dataset.gamepadAction;
    const val = Number(select.value);
    if (!settings.gamepadBindings)
      settings.gamepadBindings = { ...DEFAULT_GAMEPAD_BINDINGS };
    settings.gamepadBindings[action] = val;
    persistSettings();
    refreshToolbarChips();
  });
});

// The Fullscreen API is not a given: iPhone Safari has no
// `requestFullscreen` at all (iPad does), and this control now lives in the
// top bar on every screen rather than behind a Settings dialog a player has
// to go find, so there is no dialog wrapper left to quietly no-op inside.
// A button that does nothing when pressed is worse than no button, so the
// single fullscreen control is hidden outright — not just disabled — on any
// browser that lacks the API, decided once at startup rather than re-checked
// on every click.
const fullscreenSupported =
  typeof document.documentElement.requestFullscreen === "function";
if (fullscreenSupported) $("fullscreen-button").hidden = false;

function syncFullscreen() {
  if (!fullscreenSupported) return;
  const active = document.fullscreenElement === document.documentElement;
  document.body.classList.toggle("fullscreen-game", active);
  const button = $("fullscreen-button");
  button.setAttribute("aria-pressed", String(active));
  const label = active ? "Exit fullscreen" : "Enter fullscreen";
  button.title = label;
  button.setAttribute("aria-label", label);
}
if (fullscreenSupported) {
  $("fullscreen-button").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast("Fullscreen is not available in this browser.");
    }
    syncFullscreen();
  });
  document.addEventListener("fullscreenchange", syncFullscreen);
}
function playFromMenu() {
  $("title-play").classList.remove("pad-focus");
  if (document.activeElement === $("title-play")) $("title-play").blur();
  const resumeRound =
    phase === "paused" &&
    selectedCourtIndex === courtIndex &&
    selectedHomeMode === mode;
  if (!resumeRound) {
    switchMode(selectedHomeMode, selectedCourtIndex);
  } else {
    applyView("arena");
    resume();
  }
}
$("title-play").addEventListener("click", playFromMenu);
$("pause-resume").addEventListener("click", dismissPauseMenu);
$("pause-restart").addEventListener("click", () => {
  closePauseMenu({ restoreFocus: false });
  // Every round begins from the invitation card, so restarting lands there
  // rather than throwing the player straight back into a live press.
  prepare();
  padFocus($("start-button"));
});
$("pause-home").addEventListener("click", () => {
  closePauseMenu({ restoreFocus: false });
  applyView("home");
});
$("pause-settings").addEventListener("click", openSettings);
document.querySelectorAll("[data-home-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.disabled || button.dataset.homeMode === "kotc") return;
    selectedHomeMode = button.dataset.homeMode;
    document.querySelectorAll("[data-home-mode]").forEach((btn) => {
      const active = btn === button;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    syncTitle();
    // Mirrors the courts -> modes advance in selectCourt(): a gamepad player
    // who just picked a mode is handed straight to Play. Mouse/keyboard focus
    // is left alone.
    if (inputSource === "gamepad") focusHomeZone("action", $("title-play"));
  });
});
const courtLeaderboardTabs = Array.from(document.querySelectorAll(".hl-tab"));
courtLeaderboardTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectHomeLeaderboardCourt(index));
  tab.addEventListener("keydown", (e) => {
    let nextIndex = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      nextIndex = (index + 1) % courtLeaderboardTabs.length;
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      nextIndex = (index - 1 + courtLeaderboardTabs.length) % courtLeaderboardTabs.length;
    }
    if (nextIndex >= 0) {
      e.preventDefault();
      courtLeaderboardTabs[nextIndex].focus();
      selectHomeLeaderboardCourt(nextIndex);
    }
  });
});
addEventListener("hashchange", () => {
  applyView(viewForHash(), { updateHash: false });
});
$("help-button").addEventListener("click", () => {
  pause();
  $("help-dialog").showModal();
});
$("close-help").addEventListener("click", () => $("help-dialog").close());
$("help-dialog").addEventListener("click", (e) => {
  if (e.target === $("help-dialog")) {
    const r = e.target.getBoundingClientRect();
    if (
      e.clientX < r.left ||
      e.clientX > r.right ||
      e.clientY < r.top ||
      e.clientY > r.bottom
    )
      e.target.close();
  }
});
// Any keyboard or pointer activity switches the toolbar chips back off
// gamepad glyphs, however the player got there — capturing a new binding,
// clicking a menu, or just typing, not only in-round play.
window.addEventListener("keydown", () => {
  lastInteractionWasPointer = false;
  setInputSource("keyboard");
});
window.addEventListener("pointerdown", () => {
  lastInteractionWasPointer = true;
  if (padFocusElement) {
    padFocusElement.classList.remove("pad-focus");
    padFocusElement = null;
  }
  document.querySelectorAll(".pad-focus").forEach((el) => el.classList.remove("pad-focus"));
  setInputSource("keyboard");
});
window.addEventListener("keydown", (e) => {
  if (capture) {
    e.preventDefault();
    e.stopPropagation();
    const allowed = captureAllowed(e);
    if (allowed.cancel) {
      cancelCapture();
      return;
    }
    if (capture.slot === 1 && ["Backspace", "Delete"].includes(e.code)) {
      settings.bindings = clearBinding(
        settings.bindings,
        capture.action,
        capture.slot,
      );
      settings.preset = "custom";
      capture = null;
      persistSettings();
      setBindingStatus("Secondary binding cleared.");
      renderBindings();
      syncSettingChrome();
      return;
    }
    if (!allowed.ok) {
      setBindingStatus(allowed.reason);
      return;
    }
    const result = bindKey(
      settings.bindings,
      capture.action,
      capture.slot,
      e.code,
    );
    if (!result.ok) {
      setBindingStatus(result.reason);
      return;
    }
    settings.bindings = result.bindings;
    settings.preset = "custom";
    capture = null;
    persistSettings();
    setBindingStatus(`${readableKey(e.code)} assigned.`);
    renderBindings();
    syncSettingChrome();
    return;
  }
  if (e.code === "F3" || (e.shiftKey && e.code === "KeyP" && !capture)) {
    e.preventDefault();
    togglePerfOverlay();
    return;
  }
  if (anyDialogOpen()) return;
  if (menuOpen) {
    const action = actionForCode(settings.bindings, e.code);
    if (e.code === "Escape" || action === "pause") {
      e.preventDefault();
      dismissPauseMenu();
      return;
    }
    // Tab cycles the menu only; gameplay keys must not leak to the court.
    if (e.code === "Tab") {
      const elements = padFocusables([$("pause-menu"), $("top-bar")]);
      if (elements.length) {
        e.preventDefault();
        const current = elements.indexOf(document.activeElement);
        const direction = e.shiftKey ? -1 : 1;
        padFocus(
          elements[(current + direction + elements.length) % elements.length],
        );
      }
      return;
    }
    if (action) e.preventDefault();
    return;
  }
  const action = actionForCode(settings.bindings, e.code);
  if (action === "pause") {
    e.preventDefault();
    togglePause();
    return;
  }
  if (phase !== "playing" || e.target instanceof HTMLSelectElement) return;
  // The press that was still down when possession was lost is remembered, so
  // only a genuinely new key wakes the round back up.
  if (awaitingResume) {
    if (!holdKeys.has(e.code) && !e.repeat) {
      if (action) e.preventDefault();
      releaseHold();
    }
    keys.add(e.code);
    return;
  }
  if (action) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (action?.startsWith("direct")) {
    triggerActionHighlight("smartPass");
    doPass(Number(action.slice(-1)) - 1);
  }
  if (action === "smartPass") {
    triggerActionHighlight("smartPass");
    doPass();
  }
  if (action === "wallToggle") {
    triggerActionHighlight("wallToggle");
    toggleBank();
  }
  if (action === "shout") {
    triggerActionHighlight("shout");
    shoutTarget();
  }
  if (action === "focusHold") triggerActionHighlight("focusHold");
  if (action === "boostHold") triggerActionHighlight("boostHold");
});
window.addEventListener("keyup", (e) => {
  keys.delete(e.code);
  holdKeys.delete(e.code);
});
window.addEventListener("blur", () => {
  if (capture) cancelCapture("Binding cancelled when the window lost focus.");
  if (phase === "playing") pause();
  else clearInput();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    pause();
    // Don't leave the demo's rAF work running behind a hidden/backgrounded
    // tab; it restarts fresh (a new rally, not a resumed one) once the tab
    // is visible again and home is still the active view.
    stopAttract();
  } else if (view === "home") {
    startAttract();
  }
});
// A rotation mid-round is exactly the moment a captured joystick/court
// pointer is aimed at an axis that no longer matches what's on screen — the
// deleted APK's own resize listener cleared pointers and paused for the same
// reason. `resize` (not the query's own `change` event) is what actually
// fires across the phones this targets, and `viewportOrientation` filters
// it down to genuine orientation flips rather than every keyboard-open or
// URL-bar-collapse resize a phone browser sends.
window.addEventListener("resize", () => {
  const next = portraitQuery.matches ? "portrait" : "landscape";
  if (next === viewportOrientation) return;
  viewportOrientation = next;
  if (phase === "playing") pause();
  else clearInput();
});
// Raw `(clientX - rect.left) / rect.width * 1000`-style math assumes the
// canvas's own box is laid out the same way its 1000x620 world is drawn.
// That's true in landscape but not in portrait, where the renderer draws the
// pitch rotated 90° inside a 620x1000 box (see renderer.resize()) — the same
// un-rotated arithmetic would then take a tap at 90° to what the player
// sees. renderer.screenToWorld() knows which way the court is currently
// rotated and de-rotates the point before handing back world coordinates.
function courtPoint(e) {
  return renderer.screenToWorld(e.clientX, e.clientY);
}
$("court").addEventListener("pointermove", (e) => {
  const p = courtPoint(e);
  const aimFrom = game.ball?.to ?? game.carrier;
  aim = {
    x: p.x - game.players[aimFrom].x,
    y: p.y - game.players[aimFrom].y,
  };
  if (e.pointerId === pointerId) pointerMove = p;
});
// A pointer press anywhere also picks the ball back up, which keeps touch and
// mouse players on the same footing as the controller.
document.addEventListener(
  "pointerdown",
  (e) => {
    if (!awaitingResume) return;
    if (holdPointers.has(e.pointerId)) return;
    if (releaseHold()) {
      e.stopPropagation();
      e.preventDefault();
    }
  },
  true,
);
$("court").addEventListener("pointerdown", (e) => {
  if (phase !== "playing" || awaitingResume) return;
  unlockAudio();
  const p = courtPoint(e),
    radius = e.pointerType === "touch" ? 70 : 46;
  const target = game.players
    .filter((t) => t.id !== (game.ball?.to ?? game.carrier))
    .map((player) => ({ player, distance: distance(player, p) }))
    .filter((candidate) => candidate.distance < radius)
    .sort((a, b) => a.distance - b.distance)[0]?.player;
  if (target) {
    doPass(target.id);
    return;
  }
  pointerId = e.pointerId;
  pointerMove = p;
  $("court").setPointerCapture(e.pointerId);
});
function releaseCourt(e) {
  if (e.pointerId === pointerId) {
    pointerId = null;
    pointerMove = null;
  }
}
$("court").addEventListener("pointerup", releaseCourt);
$("court").addEventListener("pointercancel", releaseCourt);
$("court").addEventListener("lostpointercapture", releaseCourt);
$("joystick").addEventListener("pointerdown", (e) => {
  if (phase !== "playing") return;
  e.preventDefault();
  joystickId = e.pointerId;
  const r = $("joystick").getBoundingClientRect();
  joystickOrigin = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  $("joystick").setPointerCapture(e.pointerId);
  moveJoystick(e);
});
function moveJoystick(e) {
  if (e.pointerId !== joystickId) return;
  const dx = e.clientX - joystickOrigin.x,
    dy = e.clientY - joystickOrigin.y,
    m = Math.hypot(dx, dy);
  const scale = Math.min(1, 36 / (m || 1));
  // The thumb's own translate stays in raw screen pixels — it has to follow
  // the finger, whichever way the court is drawn. The *world* movement it
  // produces does not: on a rotated pitch, "push up" has to mean "toward the
  // far end of the court", not "toward smaller world Y", so the screen-space
  // vector is de-rotated the same way a tap is (screenToWorld above).
  const screenX = (dx * scale) / 36,
    screenY = (dy * scale) / 36;
  stick = renderer.screenVectorToWorld(screenX, screenY);
  $("joystick-thumb").style.transform =
    `translate(${dx * scale}px, ${dy * scale}px)`;
}
$("joystick").addEventListener("pointermove", moveJoystick);
function releaseJoystick(e) {
  if (e.pointerId === joystickId) {
    joystickId = null;
    stick = { x: 0, y: 0 };
    $("joystick-thumb").style.transform = "translate(0px, 0px)";
  }
}
$("joystick").addEventListener("pointerup", releaseJoystick);
$("joystick").addEventListener("pointercancel", releaseJoystick);
$("joystick").addEventListener("lostpointercapture", releaseJoystick);
document.addEventListener("focusout", (event) => {
  if (event.target === padFocusElement) {
    padFocusElement.classList.remove("pad-focus");
    padFocusElement = null;
  }
});
// `root` may be one element or several. Several is what lets the pause menu
// and the music rail — which are siblings on screen, not nested — be walked as
// one list by the d-pad, without giving either a wrapper it does not want.
const padRoots = (root) => (Array.isArray(root) ? root : [root]).filter(Boolean);
const padWithin = (root, el) =>
  Boolean(el) && padRoots(root).some((node) => node.contains(el));
function padFocusables(root) {
  return padRoots(root)
    .flatMap((node) => [
      ...node.querySelectorAll(
        "button:not(:disabled),select:not(:disabled),input:not(:disabled)",
      ),
    ])
    .filter((el) => !el.closest("[hidden]") && el.getClientRects().length);
}
const isRange = (el) => el instanceof HTMLInputElement && el.type === "range";
// Where each home-screen zone lives in the DOM. HOME_ZONE_ORDER (pad-zones.mjs)
// is the left-to-right cycle order; this just maps each of its ids to the
// container carrying that data-pad-zone attribute in index.html.
const HOME_ZONE_SELECTORS = {
  action: "#title-menu",
  leaderboard: "#home-leaderboard",
  courts: "#court-list",
  modes: ".home-modes",
  topbar: "#top-bar",
};
// The last-focused element in each home zone, so leaving a zone and coming
// back (via left/right) restores where the player was rather than always
// snapping to the zone's first control.
const padHomeZoneMemory = {};
// Reads the live DOM into the { id, axis, elements } shape pad-zones.mjs's
// pure helpers expect. Called fresh every poll — nothing here is cached, so
// a re-render (a new court list, a leaderboard tab switch) is always
// current. `axis` comes straight off the container's data-pad-axis
// attribute ("column" when absent, matching pad-zones.mjs's own default).
function homePadZones() {
  return HOME_ZONE_ORDER.map((id) => {
    const node = document.querySelector(HOME_ZONE_SELECTORS[id]);
    return {
      id,
      axis: node?.dataset.padAxis || "column",
      elements: node ? padFocusables(node) : [],
    };
  });
}
// Focuses an element that belongs to a home zone and remembers it as that
// zone's return point. Every home-screen focus move — within a zone, between
// zones, or an auto-advance after a selection — should go through this so
// the memory used by restoreInZone() never goes stale.
function focusHomeZone(zoneId, el) {
  if (!el) return;
  padFocus(el);
  padHomeZoneMemory[zoneId] = el;
}
function padFocus(el) {
  if (!el) return;
  if (padFocusElement && padFocusElement !== el)
    padFocusElement.classList.remove("pad-focus");
  padFocusElement = el;
  if (inputSource === "gamepad") {
    el.classList.add("pad-focus");
  } else {
    el.classList.remove("pad-focus");
  }
  el.focus({ preventScroll: false });
}
function padActivate(el) {
  if (el instanceof HTMLSelectElement) {
    const options = [...el.options].filter((option) => !option.disabled);
    if (!options.length) return true;
    const current = options.indexOf(el.selectedOptions[0]);
    el.value = options[(current + 1) % options.length].value;
    el.dispatchEvent(new Event("change"));
    return true;
  }
  if (el instanceof HTMLButtonElement) {
    el.click();
    return true;
  }
  // A slider has nothing to activate; A on one must not fall through to the
  // menu's default action and, say, start a round from behind the dialog.
  if (isRange(el)) return true;
  return false;
}
// One place for "collect the controls of whatever is actually on screen, move
// focus with the d-pad or left stick, activate with A". A focused slider takes
// left and right as a level change instead of as navigation, which is the only
// way the volume controls are reachable without a mouse.
function padNavigate(root, { dt, direction, horizontal = 0, activate, fallback }) {
  if (!root) return;
  const focused = document.activeElement;
  const slider = padWithin(root, focused) && isRange(focused) ? focused : null;
  if (slider && horizontal) {
    direction = 0;
    sliderRepeat -= dt;
    if (sliderRepeat <= 0) {
      const step = Number(slider.step) || 1;
      const next = Number(slider.value) + horizontal * step;
      slider.value = String(
        Math.min(Number(slider.max), Math.max(Number(slider.min), next)),
      );
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
      sliderRepeat = 0.11;
    }
  } else sliderRepeat = 0;
  menuRepeat -= dt;
  if (direction && menuRepeat <= 0) {
    const elements = padFocusables(root);
    if (elements.length) {
      const current = elements.indexOf(document.activeElement);
      padFocus(
        elements[(current + direction + elements.length) % elements.length],
      );
    }
    menuRepeat = 0.2;
  } else if (!direction) menuRepeat = 0;
  if (activate) {
    const el = document.activeElement;
    if (!padActivate(padWithin(root, el) ? el : null) && fallback) fallback();
  }
}
function pollGamepad(dt) {
  const pad = Array.from(navigator.getGamepads?.() || []).find(
    (p) => p?.connected,
  );
  if (!pad) {
    if (padConnected) {
      pause();
      toast("Controller disconnected. Round paused.");
    }
    padConnected = false;
    padPrevious = [];
    gamepadMove = { x: 0, y: 0 };
    gamepadFocus = false;
    gamepadBoost = false;
    for (const action of ACTION_NAMES) {
      gamepadPressedActions[action] = false;
    }
    // A pad that is gone cannot be the input in use, so the chips go back to
    // keys rather than advertising buttons the player no longer has.
    setInputSource("keyboard");
    return;
  }
  if (!padConnected) {
    padConnected = true;
    toast("Gamepad Connected", GAMEPAD_ICON_SVG);
  }
  // Standard gamepad triggers expose an analog value even when their `pressed`
  // bit is unreliable. Treat a quarter pull as held and retain that normalized
  // state for edge-triggered buttons such as LB.
  const pressed = pad.buttons.map((b) => b.pressed || (b.value || 0) >= 0.25),
    tap = (i) => pressed[i] && !padPrevious[i],
    dead = (v) => (Math.abs(v || 0) > 0.18 ? v : 0);

  const gb = settings.gamepadBindings || DEFAULT_GAMEPAD_BINDINGS;
  gamepadPressedActions.smartPass = Boolean(pressed[gb.smartPass]);
  gamepadPressedActions.wallToggle = Boolean(pressed[gb.wallToggle]);
  gamepadPressedActions.shout = Boolean(pressed[gb.shout]);
  gamepadPressedActions.focusHold = Boolean(pressed[gb.focusHold]);
  gamepadPressedActions.boostHold = Boolean(pressed[gb.boostHold]);
  if (tap(gb.smartPass)) triggerActionHighlight("smartPass");
  if (tap(gb.wallToggle)) triggerActionHighlight("wallToggle");
  if (tap(gb.shout)) triggerActionHighlight("shout");
  if (tap(gb.focusHold)) triggerActionHighlight("focusHold");
  if (tap(gb.boostHold)) triggerActionHighlight("boostHold");
  // A gamepad press is not a user activation gesture, so this will not unblock
  // a browser on its own. It costs nothing, it does unblock the packaged shell
  // and any browser whose policy is relaxed, and on the rest it keeps the
  // context ready so the first key or click starts audio instantly.
  if (pressed.some((down, i) => down && !padPrevious[i])) unlockAudio();
  // The toolbar's key chips switch to gamepad glyphs on real activity, not
  // on mere connection — a pad can sit plugged in the whole session while
  // the player uses the keyboard, so a fresh button press or a stick pushed
  // past the deadzone is what counts as "actually using the pad".
  if (
    pressed.some((down, i) => down && !padPrevious[i]) ||
    dead(pad.axes[0]) ||
    dead(pad.axes[1]) ||
    dead(pad.axes[2]) ||
    dead(pad.axes[3])
  ) {
    lastInteractionWasPointer = false;
    setInputSource("gamepad");
  }
  // Any button at all resumes after a turnover, but only on a fresh press:
  // tap() is edge-triggered, so a button still held from before is ignored.
  if (awaitingResume && !menuOpen && !anyDialogOpen()) {
    const anyTap = pressed.some((down, i) => down && !padPrevious[i]);
    if (anyTap && !tap(9) && releaseHold()) {
      padPrevious = pressed;
      return;
    }
  }
  // Sticks only drive the court while the round is actually accepting play.
  // Otherwise a nudge behind the pause overlay would keep repainting aim lanes.
  if (acceptingPlayInput()) {
    gamepadMove = { x: dead(pad.axes[0]), y: dead(pad.axes[1]) };
    gamepadFocus = pressed[6];
    gamepadBoost = pressed[7];
    if (Math.hypot(dead(pad.axes[2]), dead(pad.axes[3])) > 0.2)
      aim = { x: pad.axes[2], y: pad.axes[3] };
    else if (Math.hypot(gamepadMove.x, gamepadMove.y) > 0.2)
      aim = { ...gamepadMove };
  } else {
    gamepadMove = { x: 0, y: 0 };
    gamepadFocus = false;
    gamepadBoost = false;
  }
  const direction =
    pressed[13] || pressed[15] || pad.axes[1] > 0.6
      ? 1
      : pressed[12] || pressed[14] || pad.axes[1] < -0.6
        ? -1
        : 0;
  // Left and right are read separately and used only by a focused slider,
  // which takes them as a level change and swallows the navigation. With no
  // slider in focus nothing here applies and menu movement is unchanged: the
  // d-pad's left and right still walk the list and the left stick's horizontal
  // axis is still ignored outside play.
  const horizontal =
    pressed[15] || pad.axes[0] > 0.6
      ? 1
      : pressed[14] || pad.axes[0] < -0.6
        ? -1
        : 0;
  const nav = (root, fallback) =>
    padNavigate(root, { dt, direction, horizontal, activate: tap(0), fallback });
  // Most modal context first: navigation is scoped to whatever is actually on
  // screen so the d-pad never wanders into controls the player cannot see.
  if ($("help-dialog").open) {
    if (tap(1) || tap(9)) $("help-dialog").close();
    else nav($("help-dialog"));
  } else if ($("score-save-dialog").open) {
    if (tap(1) || tap(9)) $("score-save-dialog").close();
    else nav($("score-save-dialog"));
  } else if ($("account-dialog").open) {
    if (tap(1) || tap(9)) $("account-dialog").close();
    else nav($("account-dialog"));
  } else if ($("settings-dialog").open) {
    if (tap(1) || tap(9)) {
      if (capture) cancelCapture();
      else $("settings-dialog").close();
    }
    padNavigate($("settings-dialog"), {
      dt,
      direction,
      horizontal,
      activate: tap(0) && !capture,
    });
  } else if (menuOpen) {
    if (tap(1) || tap(9)) dismissPauseMenu();
    // The top bar is walked with the pause menu: it is where a controller
    // player reaches the soundtrack and the profile without a mouse, and
    // pausing is the only time the d-pad is free to leave the court.
    else nav([$("pause-menu"), $("top-bar")], () => $("pause-resume").click());
  } else if (view === "arena" && phase === "playing" && !awaitingResume) {
    if (tap(gb.smartPass)) doPass();
    if (tap(gb.wallToggle)) toggleBank();
    if (tap(gb.shout)) shoutTarget();
    if (tap(9)) openPauseMenu();
  } else if (view === "arena" && awaitingResume) {
    if (tap(9)) openPauseMenu();
  } else if (view === "arena" && !$("game-overlay").hidden) {
    if (tap(9)) openPauseMenu();
    else if (phase !== "finished" || resultActionsReady)
      nav($("game-overlay"), () => $("start-button").click());
  } else if (view === "home") {
    const focused = document.activeElement;
    const isCourtItem = focused?.classList.contains("court-item");
    if (isCourtItem) {
      const idx = Number(
        focused.querySelector(".court-thumb")?.dataset.courtIndex ??
          selectedCourtIndex,
      );
      if (tap(2)) {
        selectedHomeMode = "practice";
        document.querySelectorAll("[data-home-mode]").forEach((btn) => {
          const active = btn.dataset.homeMode === "practice";
          btn.classList.toggle("active", active);
          btn.setAttribute("aria-pressed", String(active));
        });
        syncTitle();
        padPrevious = pressed;
        return;
      }
      if (tap(0)) {
        selectCourt(idx);
        padPrevious = pressed;
        return;
      }
    }
    // Home is zoned rather than one flat list. Each zone has its own internal
    // axis (data-pad-axis in index.html; resolveHomeMove/zoneAxisIsVertical
    // in pad-zones.mjs) — up/down steps through a "column" zone like the
    // court list, left/right steps through a "row" zone like the mode grid
    // or the leaderboard's tab strip — and whichever direction is NOT that
    // zone's own axis instead hops to a neighbouring zone in HOME_ZONE_ORDER.
    // A zone with fewer than two focusables (the action zone, today) has no
    // internal axis at all, so both directions leave it; without that, the
    // first d-pad press after a fresh load — landing on the lone Play button
    // — would just wrap that one button onto itself and do nothing. Each
    // zone remembers the control it last held focus on. This is the one
    // place in pollGamepad that does not go through the shared
    // padNavigate/nav — that helper only understands one flat focusable
    // list, and home's whole point here is that it is not one.
    const zones = homePadZones();
    const currentZoneId =
      zoneContaining(zones, focused) ||
      zones.find((zone) => zone.elements.length)?.id ||
      null;
    // Pure d-pad-up/down and stick-Y, decoupled from the shared `direction`
    // above (which folds d-pad left/right into the same "next/previous" axis
    // for the old flat list) and from `horizontal`, which stays exactly what
    // it was so a focused slider elsewhere keeps behaving.
    const vertical =
      pressed[13] || pad.axes[1] > 0.6
        ? 1
        : pressed[12] || pad.axes[1] < -0.6
          ? -1
          : 0;
    menuRepeat -= dt;
    if ((vertical || horizontal) && menuRepeat <= 0) {
      const currentZone = zones.find((zone) => zone.id === currentZoneId) || null;
      const move = resolveHomeMove(currentZone, { vertical, horizontal });
      if (move?.within && currentZone) {
        focusHomeZone(currentZoneId, withinZone(currentZone.elements, focused, move.within));
      } else if (move?.between) {
        const targetZone = nextZone(zones, currentZoneId || HOME_ZONE_ORDER[0], move.between);
        if (targetZone) {
          focusHomeZone(
            targetZone.id,
            restoreInZone(targetZone, padHomeZoneMemory[targetZone.id]),
          );
        }
      }
      menuRepeat = 0.2;
    } else if (!vertical && !horizontal) menuRepeat = 0;
    if (tap(0)) {
      const active = document.activeElement;
      const withinAZone = zones.some((zone) => zone.elements.includes(active));
      if (!padActivate(withinAZone ? active : null)) $("title-play").click();
    }
  } else {
    nav(document.body);
  }
  padPrevious = pressed;
}
// The engine's targetValue() scores lanes by distance from defenders, so the
// smart pass drifts away from exactly the tight lane SPLIT THE PRESS rewards.
// The right stick already outweighs that safety term through `aim`; this makes
// the resulting choice unmistakable, so a controller player can aim a split on
// purpose instead of hoping for one. The renderer's own selection ring is a
// 2px circle, which is not enough to steer by.
function drawTargetHighlight(target) {
  const c = renderer.ctx;
  if (!c || !Number.isInteger(target)) return;
  const player = game?.players?.[target];
  if (!player || target === (game.ball?.to ?? game.carrier)) return;
  if (c._tikiPortrait) {
    renderer.upright(player.x, player.y, () => drawTargetHighlight(target));
    return;
  }
  const pulse = 1 + Math.sin(performance.now() / 180) * 0.04;
  const accent = renderer.venue?.accent || "#27ead8";
  c.save();

  // Subtle dashed receiver guide ring
  c.strokeStyle = "rgba(255, 255, 255, 0.4)";
  c.lineWidth = 1.4;
  c.setLineDash([3, 6]);
  c.beginPath();
  c.arc(player.x, player.y, 36 * pulse, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);

  // Four crisp, tactical corner reticle brackets (reduced visual weight)
  c.globalAlpha = 0.8;
  c.lineWidth = 2.2;
  c.strokeStyle = accent;
  const r = 45 * pulse,
    span = Math.PI / 10;
  for (let i = 0; i < 4; i++) {
    const mid = Math.PI / 4 + (i * Math.PI) / 2;
    c.beginPath();
    c.arc(player.x, player.y, r, mid - span, mid + span);
    c.stroke();
  }
  c.restore();
}
function frame(now) {
  const isPerfActive = perfEnabled;
  const frameStart = isPerfActive ? performance.now() : 0;
  const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  pollGamepad(dt);
  syncActionHighlights(now);
  if (awaitingResume) {
    holdElapsed += dt;
    // dt is clamped per frame, so the hold advances at a frame-rate-dependent
    // rate and no wall-clock wait can predict when it opens. Expose the state
    // so tests can wait on the gate itself rather than race a stopwatch.
    syncResumeGate();
  }
  if (view === "arena" && phase === "playing" && !awaitingResume) {
    let x =
      Number(actionDown(settings.bindings, keys, "moveRight")) -
      Number(actionDown(settings.bindings, keys, "moveLeft")) +
      stick.x +
      gamepadMove.x;
    let y =
      Number(actionDown(settings.bindings, keys, "moveDown")) -
      Number(actionDown(settings.bindings, keys, "moveUp")) +
      stick.y +
      gamepadMove.y;
    if (pointerMove) {
      const p = game.players[game.carrier],
        dist = distance(p, pointerMove);
      if (dist > 8) {
        x += (pointerMove.x - p.x) / dist;
        y += (pointerMove.y - p.y) / dist;
      }
    }
    if ((x || y) && !pointerMove && !padConnected) aim = { x, y };
    game.update(dt, {
      x,
      y,
      focus:
        focusToggle ||
        actionDown(settings.bindings, keys, "focusHold") ||
        gamepadFocus,
      boost:
        boostToggle ||
        actionDown(settings.bindings, keys, "boostHold") ||
        gamepadBoost,
    });
    // Found before the loop rather than during it: the engine can emit a score
    // and the turnover that ended it in the same batch, in either order, and
    // the turnover is what decides whether anything else is allowed to speak.
    const turnoverEvent = game.events.find((e) => e.type === "turnover") || null;
    for (const event of game.events) {
      // The turnover's floating canvas text is deferred until after the loop,
      // because whether the hold takes over is only known once "end" has had
      // its chance to finish the round. When it does take over, #resume-reason
      // is the one place the message appears.
      if (event !== turnoverEvent) renderer.addEvent(event);
      // finish() chooses the outcome-specific full-time sound after progress
      // has decided whether this was a clear or a defeat.
      //
      // A completed pass stays silent: the kick already marks it, and a voice
      // on the reception too put a beep behind every single pass. The bonuses
      // that can land on the same reception — wall, Focus, one-touch, the olé
      // — still sound, so a noise now means something happened rather than
      // just that the ball arrived. The score popup is unaffected; only the
      // voice is dropped, and audio.js still defines one if it should return.
      if (event.type !== "end" && event.type !== "score")
        sound.play(event.type);
      if (event.type === "focus") {
        // The flash is about the Energy resource, not either ability chip.
        clearTimeout(focusEarnedTimeout);
        $("energy-info").classList.remove("focus-earned");
        $("touch-focus").classList.remove("focus-earned");
        requestAnimationFrame(() => {
          $("energy-info").classList.add("focus-earned");
          $("touch-focus").classList.add("focus-earned");
        });
        focusEarnedTimeout = setTimeout(() => {
          $("energy-info").classList.remove("focus-earned");
          $("touch-focus").classList.remove("focus-earned");
        }, 700);
      }
      if (event.type === "one-touch" && event.milestone) {
        announce(event.text || `${event.streak} ONE-TOUCH PASSES`);
        announcementTime = now;
      }
      if (event.type === "end") finish();
    }
    game.events = [];
    if (turnoverEvent) {
      // The engine's own turnover() decides when the round-ending turnover
      // has happened (possessionLimit()'s count — 4/3/2 by tier, "third" only
      // on Standard) and sets phase to "finished" itself; the finish overlay
      // owns the screen from there, so this never holds on top of it. In
      // that case the announcement strip is the only home for the reason,
      // and finish() has already wiped the renderer's effects, so nothing is
      // re-added.
      if (phase === "playing") beginHold(turnoverEvent.text);
      else announce(turnoverEvent.text);
    }
  }
  if (view === "home") updateAttract(dt);
  if (view === "arena") {
    syncHud();
    const jsDone = isPerfActive ? performance.now() : 0;
    paintAmbience(dt);
    paintRailVisualizers(dt);
    const target =
      phase === "playing" && !awaitingResume ? queuedSmartTarget() : null;
    renderer.render(game, {
      preview: phase === "ready",
      target,
      aim,
      bank: bank || actionDown(settings.bindings, keys, "wallHold"),
      paused: phase === "paused" || phase === "finished" || awaitingResume,
      shoutVisual,
      orientation: portraitQuery.matches ? "portrait" : "landscape",
    });
    drawTargetHighlight(target);
    const courtTargetStr = Number.isInteger(target) ? String(target) : "";
    if (courtTargetStr !== hudCache.courtTarget) {
      $("court-wrap").dataset.target = courtTargetStr;
      hudCache.courtTarget = courtTargetStr;
    }
    if (isPerfActive) {
      const paintDone = performance.now();
      const jsTime = jsDone - frameStart;
      const paintTime = paintDone - jsDone;
      perfFrames++;
      perfJsTotal += jsTime;
      perfPaintTotal += paintTime;
      const sinceLastSample = now - perfLastSample;
      if (sinceLastSample >= 250) {
        const fps = ((perfFrames * 1000) / sinceLastSample).toFixed(1);
        const avgFrame = (sinceLastSample / perfFrames).toFixed(1);
        const avgJs = (perfJsTotal / perfFrames).toFixed(2);
        const avgPaint = (perfPaintTotal / perfFrames).toFixed(2);
        ensurePerfOverlay();
        const fpsEl = $("perf-fps");
        const frameEl = $("perf-frame");
        const jsEl = $("perf-js");
        const paintEl = $("perf-paint");
        if (fpsEl) fpsEl.textContent = `${fps} FPS`;
        if (frameEl) frameEl.textContent = `${avgFrame} ms`;
        if (jsEl) jsEl.textContent = `${avgJs} ms`;
        if (paintEl) paintEl.textContent = `${avgPaint} ms`;
        perfFrames = 0;
        perfJsTotal = 0;
        perfPaintTotal = 0;
        perfLastSample = now;
      }
    }
  }
  requestAnimationFrame(frame);
}
syncSettingChrome();
syncFullscreen();
syncAccountDialog();
renderDifficultyOptions();
renderHomeLeaderboardDifficultyToggle();
prepare();
syncPauseMenu();
// Drop a stale #play or #courts so the address bar agrees with the home screen
// the player is actually looking at. replaceState, not pushState: the boot must
// not leave a history entry that Back would return to.
if (location.hash)
  history.replaceState(null, "", location.pathname + location.search);
applyView(view, { updateHash: false });
// The packaged shell sets autoplayPolicy to no-user-gesture-required, so this
// first attempt is all it ever needs. A browser tab is likely to refuse it and
// stay armed until a real activation gesture arrives.
applyAudioSettings();
// Write the folded legacy switch down straight away, so the one-time step is
// actually one time rather than repeating on every launch until the player
// happens to touch an audio control.
persistSettings();
// Every plausible source of a user activation gesture retries the unlock, and
// they stay attached rather than firing once: a retry after audio is already
// running is a no-op, and a gamepad press (which grants no activation at all)
// costs nothing but keeps the door open for the moment the player does reach
// for the keyboard or mouse. `click` is here as well as `pointerdown` because
// a keyboard-activated button produces a click with no pointer event.
for (const type of ["pointerdown", "click", "keydown", "touchstart"])
  window.addEventListener(type, unlockAudio, { capture: true, passive: true });
setInterval(syncMusicState, 500);
requestAnimationFrame(frame);
if (storageFallback)
  toast("Browser storage is unavailable. Progress will last for this session.");
if (import.meta.env?.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {});
  });
}
