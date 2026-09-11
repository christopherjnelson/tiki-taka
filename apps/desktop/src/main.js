import {
  Game,
  COURTS,
  TACTICS,
  dailyConfig,
  distance,
  clamp,
  bankPoint,
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
  loadSettings,
  saveSettings,
  presetBindings,
  actionForCode,
  actionDown,
  bindKey,
  clearBinding,
  readableKey,
  captureAllowed,
} from "../../../packages/engine/src/settings.js";
import { createLocalDataAdapter, selectDataAdapter } from "../../../packages/data/src/index.js";
import { createMusic } from "./music.js";
import { TRACKS } from "./playlist.js";
import { SAMPLES } from "./samples.js";
const $ = (id) => document.getElementById(id);
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
try {
  initialData = await dataAdapter.loadUserData();
} catch {
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
let progress = initialData.progress;
let settings = initialData.settings;
let accountStats = initialData.stats;
let preferences = initialData.preferences || { scoreSaveChoice: "ask" };
let profile = null;
// Only the Supabase adapter has a session to ask about; the guest adapter
// has no accounts at all.
if (dataAdapter.kind === "supabase") {
  try {
    profile = (await dataAdapter.getSession())?.profile || null;
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
// Two views now. #courts was the courts page's own hash; it survives here only
// so an old bookmark lands on home rather than nowhere.
const viewForHash = () => (location.hash === "#play" ? "arena" : "home");
let mode = "career",
  courtIndex = progress.lastCourt,
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
function persist() {
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
function toast(text) {
  $("toast").textContent = text;
  $("toast").classList.add("visible");
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => $("toast").classList.remove("visible"), 4000);
}
if (remoteDataUnavailable)
  setTimeout(() => toast("Account data is temporarily unavailable. Your game is still playable."), 0);
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
  $("score-save-dialog").open ||
  $("leaderboard-dialog").open;
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
  const court = COURTS[resumable ? courtIndex : progress.lastCourt];
  $("title-play").lastChild.textContent = resumable
    ? " Resume"
    : progress.xp > 0
      ? " Continue"
      : " Play";
  $("title-play-copy").textContent = resumable
    ? `${game.config.name} · ${Math.max(0, Math.ceil(game.time))} seconds remain`
    : `${court.name} · ${court.place}`;
}
function syncHome() {
  if ($("home-view")) syncTitle();
  const courtProgress = Object.values(progress.courts || {});
  $("home-stars").textContent = String(
    courtProgress.reduce((total, item) => total + (item.stars || 0), 0),
  );
  $("home-cleared").textContent =
    `${courtProgress.filter((item) => (item.stars || 0) > 0).length} / ${COURTS.length}`;
  const best = Math.max(0, ...Object.values(progress.records || {}));
  $("home-best").textContent = best ? String(best) : "—";
  $("home-games").textContent = String(accountStats.games);
  $("home-total-passes").textContent = String(accountStats.totalPasses);
  $("home-best-one-touch").textContent = String(accountStats.bestOneTouch);
}
function applyView(next, { updateHash = true } = {}) {
  view = next;
  if (next !== "arena" && phase === "playing") pause();
  $("home-view").hidden = view !== "home";
  $("arena-view").hidden = view !== "arena";
  if (view !== "arena") closePauseMenu({ restoreFocus: false });
  // Exactly one game is live at a time: the demo is built on the way into home
  // and dropped on the way out, before the arena starts drawing.
  if (view === "home") startAttract();
  else stopAttract();
  syncProgress();
  syncSettingChrome();
  syncPauseMenu();
  requestAnimationFrame(() => {
    if (anyDialogOpen() || menuOpen) return;
    if (view === "home") padFocus($("title-play"));
    else if ($("game-overlay").hidden)
      $("court").focus({ preventScroll: true });
    else padFocus($("start-button"));
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
  attractBankEvery = 4 + Math.floor(Math.random() * 3);
function startAttract() {
  if (!attractCanvas || attractGame) return;
  attractRenderer ||= new Renderer(attractCanvas);
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
      seed: (Date.now() >>> 0) || 1,
    },
    "balanced",
  );
  attractPassIn = 0.9;
  attractPassCount = 0;
  attractBankEvery = 4 + Math.floor(Math.random() * 3);
  // The band over the demo names the venue the demo is actually painting.
  // Read it back through getVenue() rather than from COURTS[1]: the config
  // above carries practice rules and its own seed, and getVenue() weighs both
  // before it settles on a venue, so the court's own entry is not the answer.
  // Renderer does exactly this on its side, so the two can never disagree.
  const band = document.querySelector(".stage-venue"),
    venue = getVenue(attractGame.config);
  if (band) band.textContent = `${venue.name} / ${venue.vibe}`.toUpperCase();
}
function stopAttract() {
  attractGame = null;
  if (attractRenderer) attractRenderer.effects.length = 0;
}
function updateAttract(dt) {
  if (!attractGame || !attractRenderer) return;
  const demo = attractGame,
    carrier = demo.players[demo.carrier];
  // Drift the carrier off the nearest defender and back towards the middle, so
  // the demo reads as play rather than as four statues. The engine moves the
  // teammates and the press on its own.
  let x = 0,
    y = 0;
  const nearest = demo.defenders
    .map((defender) => ({ defender, gap: distance(defender, carrier) }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (nearest && nearest.gap > 0.001) {
    x = (carrier.x - nearest.defender.x) / nearest.gap;
    y = (carrier.y - nearest.defender.y) / nearest.gap;
  }
  x += (500 - carrier.x) / 900;
  y += (310 - carrier.y) / 560;
  demo.update(dt, { x, y, focus: false });
  attractPassIn -= dt;
  if (!demo.ball && attractPassIn <= 0) {
    // bestTarget(null) is the same smart pass the pass button gives a player,
    // so the demo plays the game the way the game means it to be played.
    const target = demo.bestTarget(null);
    attractPassCount++;
    let bank = false;
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
    demo.pass(target, bank);
    attractPassIn = 0.55 + Math.random() * 0.5;
  }
  for (const event of demo.events) attractRenderer.addEvent(event);
  demo.events = [];
  if (demo.status !== "playing") {
    // The clock ran out. Nothing is scored or saved; another round simply
    // starts, and the next frame renders that one instead.
    attractGame = null;
    startAttract();
    return;
  }
  attractRenderer.render(demo, { preview: false });
}
function config() {
  if (mode === "daily") return dailyConfig();
  if (mode === "endless")
    return {
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
    };
  if (mode === "practice")
    return {
      ...COURTS[0],
      name: "The warm-up",
      place: "YOUR SPACE TO EXPERIMENT",
      target: 120,
      time: 90,
      speed: 58,
      defenders: 2,
      practice: true,
      description:
        "A gentle press and unlimited recoveries. Learn the rhythm, try the walls, find your triangle.",
    };
  return COURTS[courtIndex];
}
function recordKey() {
  return mode === "career"
    ? `court-${courtIndex}`
    : mode === "daily"
      ? `daily-${game.config.key}`
      : mode;
}
function syncProgress() {
  const r = rank(progress.xp);
  $("level-label").textContent = `LEVEL ${r.level} · ${r.name}`;
  $("xp-label").textContent = `${progress.xp % 300} / 300 XP`;
  $("xp-fill").style.width = `${r.fraction * 100}%`;
  $("court-list").innerHTML = "";
  COURTS.forEach((court, i) => {
    const btn = document.createElement("button");
    btn.className = `court-item ${i === courtIndex && mode === "career" ? "active" : ""}`;
    btn.disabled = i > progress.unlocked;
    btn.setAttribute(
      "aria-label",
      `${court.name}, ${btn.disabled ? "locked" : `${progress.courts[i]?.stars || 0} stars`}`,
    );
    btn.setAttribute(
      "aria-current",
      i === courtIndex && mode === "career" ? "true" : "false",
    );
    btn.innerHTML = `<span class="court-number">${String(i + 1).padStart(2, "0")}</span><span><span class="court-name">${court.name}</span><span class="court-meta">${court.short}</span></span><span class="court-stars">${btn.disabled ? "↗" : progress.courts[i]?.stars ? "★".repeat(progress.courts[i].stars) : "○"}</span>`;
    btn.addEventListener("click", () => switchMode("career", i));
    $("court-list").append(btn);
  });
  document.querySelectorAll("[data-home-mode]").forEach((btn) => {
    const active = view === "arena" && btn.dataset.homeMode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  syncHome();
}
function setOverlay(kicker, title, copy, primary, secondary = "") {
  clearTimeout(resultRevealTimeout);
  resultActionsReady = true;
  const overlay = $("game-overlay");
  delete overlay.dataset.result;
  delete overlay.dataset.actions;
  $("result-burst").hidden = true;
  $("result-stats").hidden = true;
  $("result-cheer").hidden = true;
  $("overlay-actions").hidden = false;
  $("start-button").disabled = false;
  $("secondary-button").disabled = false;
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
  stars,
  xp,
}) {
  setOverlay(kicker, title, copy, primary, secondary);
  const overlay = $("game-overlay"),
    actions = $("overlay-actions");
  overlay.dataset.result = cleared ? "victory" : "defeat";
  overlay.dataset.actions = "waiting";
  $("result-score").textContent = String(game.score);
  $("result-passes").textContent = String(game.passes);
  $("result-streak").textContent = String(game.bestOneTouch || 0);
  $("result-xp").textContent = `+${xp}`;
  $("result-burst").hidden = false;
  $("result-stats").hidden = false;
  $("result-cheer").hidden = false;
  $("result-cheer").textContent = cleared
    ? `THE COURT ERUPTS${stars ? ` · ${"★".repeat(stars)}` : ""}`
    : "THE CROWD IS STILL WITH YOU";
  $("invitation-note").textContent = "CHOOSE YOUR NEXT MOVE";
  actions.hidden = true;
  $("start-button").disabled = true;
  $("secondary-button").disabled = true;
  resultActionsReady = false;
  $("overlay-card").focus({ preventScroll: true });
  resultRevealTimeout = setTimeout(() => {
    resultActionsReady = true;
    overlay.dataset.actions = "ready";
    actions.hidden = false;
    $("start-button").disabled = false;
    $("secondary-button").disabled = false;
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
  ].forEach((id) => ($(id).disabled = !enabled));
  $("joystick").setAttribute("aria-disabled", String(!enabled));
}
function setPauseState(paused) {
  $("pause-button").innerHTML =
    `<span aria-hidden="true">${paused ? "▶" : "Ⅱ"}</span>`;
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
  renderer.effects.length = 0;
  game = new Game(config(), progress.tactic);
  const venue = getVenue(game.config);
  document.documentElement.dataset.venue = venue.id;
  document.documentElement.style.setProperty("--venue-accent", venue.accent);
  document.documentElement.style.setProperty(
    "--venue-secondary",
    venue.secondary,
  );
  if ($("venue-vibe")) $("venue-vibe").textContent = venue.vibe;
  if ($("arena-venue-label"))
    $("arena-venue-label").textContent =
      `${venue.name} / ${venue.vibe}`.toUpperCase();
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
  setPauseState(false);
  setControlsEnabled(false);
  $("bank-button").setAttribute("aria-pressed", "false");
  $("focus-button").setAttribute("aria-pressed", "false");
  $("boost-button").setAttribute("aria-pressed", "false");
  $("touch-bank").setAttribute("aria-pressed", "false");
  $("touch-focus").setAttribute("aria-pressed", "false");
  $("invitation-note").textContent =
    mode === "practice"
      ? `${game.config.time} SECONDS · UNLIMITED POSSESSIONS · FIND YOUR RHYTHM`
      : mode === "endless"
        ? "60 SECONDS · 3 POSSESSIONS · TRIANGLES ADD TIME"
        : `${game.config.time} SECONDS · 3 POSSESSIONS · THIRD LOSS ENDS THE ROUND`;
  setOverlay(
    mode === "daily"
      ? `DAILY CIRCUIT · ${game.config.key}`
      : mode === "endless"
        ? "HOW LONG CAN YOU KEEP IT?"
        : mode === "practice"
          ? "A LITTLE SPACE TO LEARN"
          : "FOUR PLAYERS. ONE BALL.",
    mode === "practice" ? "Find your feet." : "Keep it beautiful.",
    mode === "endless"
      ? "Connect triangles to buy time. Survive the rising press."
      : `Keep possession for ${game.config.time} seconds. ${mode === "practice" ? "Experiment freely." : `Earn ${game.config.target} points. You have 3 possessions; the third loss ends the round.`}`,
    mode === "daily"
      ? "Play today’s circuit"
      : mode === "endless"
        ? "Start the run"
        : mode === "practice"
          ? "Start the warm-up"
          : "Play the court",
  );
  syncProgress();
  syncHud();
}
function switchMode(next, index = courtIndex) {
  closePauseMenu({ restoreFocus: false });
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
  if (
    phase === "ready" &&
    mode === "daily" &&
    game.config.key !== dailyConfig().key
  ) {
    prepare();
  }
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
  $("court").focus({ preventScroll: true });
  toast(
    mode === "practice"
      ? `Move with ${settings.bindings.moveUp.map(readableKey).join(" / ")} and its direction keys, or drag the court.`
      : `Keep it moving. Click a teammate or use ${settings.bindings.smartPass.map(readableKey).join(" / ")} for a smart pass.`,
  );
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
  bank = !bank;
  $("bank-button").setAttribute("aria-pressed", String(bank));
  $("touch-bank").setAttribute("aria-pressed", String(bank));
}
function toggleFocus() {
  if (phase !== "playing") return;
  if (game.focus <= 0) {
    focusToggle = false;
    syncFocusButtons();
    toast("Earn Energy with wall passes, triangles, or bonus zones.");
    return;
  }
  focusToggle = !focusToggle;
  if (focusToggle) boostToggle = false;
  syncFocusButtons();
  syncBoostButtons();
}
function toggleBoost() {
  if (phase !== "playing") return;
  if (game.focus <= 0) {
    boostToggle = false;
    syncBoostButtons();
    toast("Earn Energy with wall passes, triangles, or bonus zones.");
    return;
  }
  boostToggle = !boostToggle;
  if (boostToggle) focusToggle = false;
  syncBoostButtons();
  syncFocusButtons();
}
function syncFocusButtons() {
  $("focus-button").setAttribute("aria-pressed", String(focusToggle));
  $("touch-focus").setAttribute("aria-pressed", String(focusToggle));
}
function syncBoostButtons() {
  const active = boostToggle || game?.boostActive;
  $("boost-button").setAttribute("aria-pressed", String(active));
}
function selectedPassTarget() {
  return game.queuedPass?.id ?? queuedSmartTarget();
}
function shoutTarget() {
  if (phase !== "playing" || awaitingResume) return;
  const target = selectedPassTarget();
  if (game.shout(target)) {
    toast(`Player ${target + 1} is moving to the bonus zone.`);
  } else {
    toast("No selected teammate can move to the bonus zone.");
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
function paintAmbience(dt) {
  const canvas = ambienceCanvas;
  if (
    !canvas ||
    !ambienceContext ||
    !ambienceVisible ||
    !document.body.classList.contains("play-view")
  )
    return;
  const box = courtBox();
  if (!box) return;
  const width = Math.round(box.width),
    height = Math.round(box.height),
    dpr = Math.min(2, window.devicePixelRatio || 1);
  const backingWidth = Math.round(width * dpr),
    backingHeight = Math.round(height * dpr),
    resized = canvas.width !== backingWidth || canvas.height !== backingHeight;
  if (resized) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  // The decorative wash used to rebuild four gradients and a clipping path
  // at display refresh rate. It is not gameplay feedback, so 30fps while
  // music is active and 12fps while idling retain the intended motion while
  // leaving the main court renderer the bulk of the frame budget.
  const reduced = renderer.reducedMotion,
    measured = music.energy,
    cadence = reduced ? 0.25 : measured === null ? 1 / 12 : 1 / 30;
  ambienceElapsed += dt;
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
  const strength = 0.05 + ambienceLevel * 0.09,
    swell = 1 + ambienceLevel * 0.35;
  if (box.left >= 2) {
    const radius = Math.max(box.left, 90) * 2.1 * swell;
    glow(box.left * 0.5, height * (0.36 + drift * 0.07), radius, strength);
    glow(width - box.left * 0.5, height * (0.64 - drift * 0.07), radius, strength * 0.9);
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
  readout.hidden = !streak;
  if (!streak) return;
  const step = streak % 10,
    progress = step === 0 ? 1 : step / 10;
  readout.classList.toggle("is-milestone", streak >= 10);
  $("one-touch-label").textContent = `ONE TOUCH ×${streak}`;
  $("one-touch-fill").style.width = `${progress * 100}%`;
}
function syncHud() {
  syncOneTouchReadout();
  $("score-value").textContent = String(game.score).padStart(3, "0");
  $("time-value").textContent =
    `${Math.floor(Math.ceil(game.time) / 60)}:${String(Math.max(0, Math.ceil(game.time) % 60)).padStart(2, "0")}`;
  $("combo-value").textContent =
    `×${1 + Math.min(4, Math.floor(game.combo / 4))}`;
  $("lives-value").textContent = game.config.practice
    ? "∞"
    : `${Math.max(0, 3 - game.turnovers)} / 3`;
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
  const focusRatio = focusCap ? focusAmount / focusCap : 0;
  const focusText = `${focusAmount.toFixed(1)} / ${focusCap}s`;
  const focusEmpty = focusAmount <= 0;
  // Focus and Boost both spend the same hidden engine reserve (game.focus);
  // the toolbar shows it once, as the Energy readout, rather than duplicating
  // the same numbers behind each ability's chip.
  $("energy-value").textContent = focusText;
  $("touch-focus-value").textContent = focusText;
  $("energy-fill").style.width = `${focusRatio * 100}%`;
  $("touch-focus-fill").style.width = `${focusRatio * 100}%`;
  $("energy-meter").setAttribute("aria-valuemax", String(focusCap));
  $("energy-meter").setAttribute("aria-valuenow", focusAmount.toFixed(1));
  $("energy-meter").setAttribute(
    "aria-valuetext",
    `${focusAmount.toFixed(1)} of ${focusCap} seconds`,
  );
  $("energy-info").classList.toggle("is-empty", focusEmpty);
  $("touch-focus").classList.toggle("is-empty", focusEmpty);
  $("goal-fill").style.width =
    `${game.config.target ? Math.min(100, (game.score / game.config.target) * 100) : Math.min(100, (game.time / 60) * 100)}%`;
  $("best-label").textContent =
    `PERSONAL BEST ${progress.records[recordKey()] || "—"}`;
  $("target-label").textContent =
    phase === "playing"
      ? game.queuedPass
        ? `QUEUED → ${game.queuedPass.id + 1} · RELEASE ON ARRIVAL`
        : game.ball
          ? `NEXT PASS → ${game.bestQueuedTarget(aim) + 1} · QUEUE IT NOW`
          : `${bank ? "WALL PASS" : "PASS"} → ${game.bestTarget(aim) + 1}`
      : "FIND THE SPACE. MAKE THE PASS.";
  $("time-value").classList.toggle("urgent", game.time < 15);
  $("court-wrap").classList.toggle("is-playing", phase === "playing");
  $("court-wrap").classList.toggle("is-round", phase !== "ready");
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
  const outOfPossessions = game.turnovers >= 3 && !game.config.practice;
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
        : mode === "daily"
          ? "Play today’s circuit again"
          : mode === "endless"
            ? "Start a new run"
            : mode === "practice"
              ? "Practise this court again"
              : "Play this court again",
    secondary: "Back to the round intro",
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
$("pause-button").addEventListener("click", togglePause);
$("pass-button").addEventListener("click", () => doPass());
$("touch-pass").addEventListener("click", () => doPass());
$("bank-button").addEventListener("click", toggleBank);
$("touch-bank").addEventListener("click", toggleBank);
$("focus-button").addEventListener("click", toggleFocus);
$("touch-focus").addEventListener("click", toggleFocus);
$("boost-button").addEventListener("click", toggleBoost);
$("shout-button").addEventListener("click", shoutTarget);
$("tactic-select").addEventListener("change", (e) => {
  progress.tactic = e.target.value;
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
  const toggle = $("music-toggle"),
    skip = $("music-skip");
  if (!toggle) return;
  toggle.setAttribute("aria-pressed", String(settings.musicOn));
  toggle.firstElementChild.textContent = settings.musicOn ? "▮▮" : "▶";
  toggle.setAttribute(
    "aria-label",
    settings.musicOn ? "Pause the soundtrack" : "Play the soundtrack",
  );
  skip.setAttribute("aria-label", "Skip to the next track");
  skip.disabled = music.trackCount < 2;
  const title = music.trackTitle;
  $("music-track").textContent = title || "—";
  $("music-track").title = title
    ? `${title} · track ${music.trackIndex + 1} of ${music.trackCount}`
    : "";
}
// A bar button is a real button, so activating it takes DOM focus off the
// court — and then Space would press the button again instead of making a
// pass. Handing focus straight back is what keeps the player out of the way
// of play; during a pause or a menu the focus belongs where it is.
function returnFocusToCourt() {
  if (phase === "playing" && !menuBlocking())
    $("court").focus({ preventScroll: true });
}
$("music-toggle").addEventListener("click", () => {
  toggleMusic();
  syncMusicRail();
  returnFocusToCourt();
});
$("music-skip").addEventListener("click", () => {
  unlockAudio();
  music.skip(1);
  syncMusicRail();
  returnFocusToCourt();
});
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
  shout: "LB",
  focusHold: "LT",
  boostHold: "RT",
};
// The label a toolbar chip/title should show for an action right now: the
// gamepad glyph while the player is actively using a pad, otherwise the
// player's configured key(s).
function chipLabel(action) {
  if (inputSource === "gamepad" && GAMEPAD_ACTION_LABELS[action])
    return GAMEPAD_ACTION_LABELS[action];
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
  if (inputSource === source) return;
  inputSource = source;
  refreshToolbarChips();
}
function syncSettingChrome() {
  syncAudioChrome();
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle("play-view", view === "arena");
  document.body.dataset.view = view;
  publishScoreboardHeight();
  $("theme-button").setAttribute(
    "aria-pressed",
    String(settings.theme === "light"),
  );
  $("theme-button").innerHTML =
    `<span aria-hidden="true">◐</span> ${settings.theme === "dark" ? "Light" : "Dark"}`;
  if ($("preset-select")) $("preset-select").value = settings.preset;
  refreshToolbarChips();
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
  clearInput();
  capture = null;
  setBindingStatus("");
  $("preset-select").value = settings.preset;
  renderBindings();
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
    : "Your email stays private. Your username is public on the friendly leaderboard. Scores you submit are not independently verified — see the leaderboard for that note.";
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
  const data = await dataAdapter.loadUserData();
  if (generation !== dataContextGeneration) return false;
  applyDataContext(data, nextProfile);
  return true;
}
function applyDataContext(data, nextProfile) {
  profile = nextProfile;
  remoteDataUnavailable = false;
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
      applyDataContext(data, session?.profile || profile);
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
$("top-pause").addEventListener("click", togglePause);
$("close-account").addEventListener("click", () => $("account-dialog").close());
$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = await dataAdapter.register({
      email: $("register-email").value,
      username: $("register-username").value,
      password: $("register-password").value,
    });
    await switchDataContext(next);
    $("account-dialog").close();
    if (saveScoreAfterAuthentication) {
      saveScoreAfterAuthentication = false;
      showScoreSaveDialog();
      await chooseAlwaysSave();
    } else {
      toast(`Account ${next.username} created.`);
    }
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
    await switchDataContext(next);
    $("account-dialog").close();
    if (saveScoreAfterAuthentication) {
      saveScoreAfterAuthentication = false;
      showScoreSaveDialog();
      await chooseAlwaysSave();
    } else {
      toast(`Signed in as ${next.username}.`);
    }
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
  const nextProfile = session?.profile || null;
  if ((nextProfile?.id || null) === (profile?.id || null)) return;
  void switchDataContext(nextProfile).catch(() =>
    toast("Your account changed, but its saved data could not be loaded."),
  );
});
window.addEventListener("pagehide", () => unsubscribeAuthState?.(), { once: true });
window.addEventListener("online", () => void recoverRemoteDataContext());
// Leaderboard: only the Supabase adapter can answer this (it feature-detects
// getLeaderboard), and with no Supabase configuration — the everyday guest
// case — the dialog says so honestly instead of pretending nothing changed.
async function loadLeaderboard() {
  if (!dataAdapter.getLeaderboard) return;
  $("leaderboard-status").textContent = "Loading…";
  $("leaderboard-list").replaceChildren();
  try {
    const mode = $("leaderboard-mode").value;
    const courtValue = $("leaderboard-court").value;
    const board = await dataAdapter.getLeaderboard({
      mode,
      court: courtValue === "" ? undefined : Number(courtValue),
      limit: 10,
    });
    const entries = board?.entries || [];
    $("leaderboard-status").textContent = entries.length ? "" : "No scores yet on this board.";
    $("leaderboard-list").replaceChildren(
      ...entries.map((entry, index) => {
        const li = document.createElement("li");
        const rank = document.createElement("span");
        rank.className = "leaderboard-rank";
        rank.textContent = `#${index + 1}`;
        const name = document.createElement("span");
        name.className = "leaderboard-name";
        name.textContent = entry.username;
        const score = document.createElement("span");
        score.className = "leaderboard-score";
        score.textContent = entry.score;
        li.append(rank, name, score);
        return li;
      }),
    );
  } catch (error) {
    $("leaderboard-status").textContent = error.message || "Leaderboard could not be loaded.";
  }
}
function openLeaderboard() {
  if (phase === "playing") pause();
  clearInput();
  const available = Boolean(dataAdapter.getLeaderboard);
  $("leaderboard-unavailable").hidden = available;
  $("leaderboard-available").hidden = !available;
  $("leaderboard-dialog").showModal();
  if (available) void loadLeaderboard();
}
$("leaderboard-button").addEventListener("click", openLeaderboard);
$("close-leaderboard").addEventListener("click", () => $("leaderboard-dialog").close());
$("leaderboard-mode").addEventListener("change", loadLeaderboard);
$("leaderboard-court").addEventListener("change", loadLeaderboard);
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
  $("preset-select").value = "wasd";
  persistSettings();
  setBindingStatus("Default bindings restored.");
  renderBindings();
  syncSettingChrome();
});
$("theme-button").addEventListener("click", () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  persistSettings();
  syncSettingChrome();
});
function syncFullscreen() {
  const active = document.fullscreenElement === document.documentElement;
  document.body.classList.toggle("fullscreen-game", active);
  $("fullscreen-button").setAttribute("aria-pressed", String(active));
  $("fullscreen-button").innerHTML =
    `<span aria-hidden="true">⌗</span> ${active ? "Exit fullscreen" : "Fullscreen"}`;
}
$("fullscreen-button").addEventListener("click", async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (shellFullscreen())
      toast("Already fullscreen. Press F11 to play in a window.");
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("Fullscreen is not available in this browser.");
  }
  syncFullscreen();
});
document.addEventListener("fullscreenchange", syncFullscreen);
// F11 is handled by the shell, which only tells the page by resizing it.
window.addEventListener("resize", syncFullscreen);
function playFromMenu() {
  const resumeRound = phase === "paused";
  if (!resumeRound) {
    mode = "career";
    courtIndex = progress.lastCourt;
    prepare();
  }
  applyView("arena");
  if (resumeRound) resume();
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
  button.addEventListener("click", () =>
    switchMode(button.dataset.homeMode, courtIndex),
  );
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
window.addEventListener("keydown", () => setInputSource("keyboard"));
window.addEventListener("pointerdown", () => setInputSource("keyboard"));
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
  if (action?.startsWith("direct")) doPass(Number(action.slice(-1)) - 1);
  if (action === "smartPass") doPass();
  if (action === "wallToggle") toggleBank();
  if (action === "shout") shoutTarget();
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
  if (document.hidden) pause();
});
function courtPoint(e) {
  const r = $("court").getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * 1000,
    y: ((e.clientY - r.top) / r.height) * 620,
  };
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
  stick = { x: (dx * scale) / 36, y: (dy * scale) / 36 };
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
function padFocus(el) {
  if (!el) return;
  if (padFocusElement && padFocusElement !== el)
    padFocusElement.classList.remove("pad-focus");
  padFocusElement = el;
  el.classList.add("pad-focus");
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
    // A pad that is gone cannot be the input in use, so the chips go back to
    // keys rather than advertising buttons the player no longer has.
    setInputSource("keyboard");
    return;
  }
  if (!padConnected) {
    padConnected = true;
    toast(
      "Controller connected. Right stick picks the pass · A plays it · X arms the wall · LT focuses · RT boosts · LB shouts.",
    );
  }
  // Standard gamepad triggers expose an analog value even when their `pressed`
  // bit is unreliable. Treat a quarter pull as held and retain that normalized
  // state for edge-triggered buttons such as LB.
  const pressed = pad.buttons.map((b) => b.pressed || (b.value || 0) >= 0.25),
    tap = (i) => pressed[i] && !padPrevious[i],
    dead = (v) => (Math.abs(v || 0) > 0.18 ? v : 0);
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
  )
    setInputSource("gamepad");
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
  } else if ($("leaderboard-dialog").open) {
    if (tap(1) || tap(9)) $("leaderboard-dialog").close();
    else nav($("leaderboard-dialog"));
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
    if (tap(0)) doPass();
    if (tap(2)) toggleBank();
    if (tap(4)) shoutTarget();
    if (tap(9)) openPauseMenu();
  } else if (view === "arena" && awaitingResume) {
    if (tap(9)) openPauseMenu();
  } else if (view === "arena" && !$("game-overlay").hidden) {
    if (tap(9)) openPauseMenu();
    else if (phase !== "finished" || resultActionsReady)
      nav($("game-overlay"), () => $("start-button").click());
  } else if (view === "home") {
    // Home is one list: the menu, then the demo's neighbours — the courts and
    // the modes — then the bar. The menu comes first so the first d-pad step
    // from a fresh load is still the next menu item, and B has nowhere to go
    // back to now that the courts page is this page.
    nav([$("home-view"), $("top-bar")], () => $("title-play").click());
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
  const pulse = 1 + Math.sin(performance.now() / 150) * 0.06;
  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--venue-accent")
      .trim() || "#27ead8";
  c.save();
  c.globalAlpha = 0.9;
  c.strokeStyle = accent;
  c.lineWidth = 4;
  c.shadowColor = accent;
  c.shadowBlur = 18;
  c.beginPath();
  c.arc(player.x, player.y, 42 * pulse, 0, Math.PI * 2);
  c.stroke();
  c.shadowBlur = 0;
  c.globalAlpha = 1;
  c.lineWidth = 2;
  c.strokeStyle = "#fff";
  c.beginPath();
  c.arc(player.x, player.y, 50 * pulse, 0, Math.PI * 2);
  c.stroke();
  // Four corner brackets read as a reticle even against a busy court.
  c.lineWidth = 3.5;
  c.strokeStyle = accent;
  const r = 56 * pulse,
    span = Math.PI / 9;
  for (let i = 0; i < 4; i++) {
    const mid = Math.PI / 4 + (i * Math.PI) / 2;
    c.beginPath();
    c.arc(player.x, player.y, r, mid - span, mid + span);
    c.stroke();
  }
  c.font = '900 15px "Tiki Signage","Arial Narrow",sans-serif';
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillStyle = "rgba(6,12,26,.85)";
  c.beginPath();
  c.roundRect(player.x - 40, player.y - 78, 80, 22, 11);
  c.fill();
  c.strokeStyle = accent;
  c.lineWidth = 1.5;
  c.stroke();
  c.fillStyle = "#fff";
  c.fillText(bank ? "WALL ↗" : "PASS ↗", player.x, player.y - 66);
  c.restore();
}
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  pollGamepad(dt);
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
      // The engine resumes on its own timer; the interface holds the round on
      // top of that instead of changing packages/engine.
      if (
        event.type === "score" &&
        !turnoverEvent &&
        now - announcementTime > 3500
      ) {
        announce(event.text);
        announcementTime = now;
      }
      if (event.type === "end") finish();
    }
    game.events = [];
    if (turnoverEvent) {
      // A third turnover ends the round outright, and the finish overlay owns
      // the screen from there: never hold on top of it. In that case the
      // announcement strip is the only home for the reason, and finish() has
      // already wiped the renderer's effects, so nothing is re-added.
      if (phase === "playing") beginHold(turnoverEvent.text);
      else announce(turnoverEvent.text);
    }
  }
  if (view === "home") updateAttract(dt);
  if (view === "arena") {
    syncHud();
    paintAmbience(dt);
    const target =
      phase === "playing" && !awaitingResume ? queuedSmartTarget() : null;
    renderer.render(game, {
      preview: phase === "ready",
      target,
      aim,
      bank: bank || actionDown(settings.bindings, keys, "wallHold"),
      paused: phase === "paused" || phase === "finished" || awaitingResume,
    });
    drawTargetHighlight(target);
    $("court-wrap").dataset.target = Number.isInteger(target)
      ? String(target)
      : "";
  }
  requestAnimationFrame(frame);
}
syncSettingChrome();
syncFullscreen();
syncAccountDialog();
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
