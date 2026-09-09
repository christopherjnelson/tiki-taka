import {
  Game,
  COURTS,
  TACTICS,
  dailyConfig,
  distance,
  clamp,
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
import { createLocalDataAdapter } from "../../../packages/data/src/index.js";
import { createMusic } from "./music.js";
import { TRACKS } from "./playlist.js";
const $ = (id) => document.getElementById(id);
// Running inside the Electron shell rather than a browser tab. window.close()
// only ends the app for a window the shell opened itself, so Quit is offered
// nowhere else.
const inShell = location.protocol === "tiki:";
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
let dataAdapter = createLocalDataAdapter({ storage: dataStorage });
let initialData;
let storageFallback = false;
try {
  initialData = await dataAdapter.loadUserData();
} catch {
  storageFallback = true;
  dataAdapter = createLocalDataAdapter({
    storage:
      dataStorage === storage
        ? {
            getItem: (key) => memory.get(key) ?? null,
            setItem: (key, value) => memory.set(key, value),
            removeItem: (key) => memory.delete(key),
          }
        : dataStorage,
  });
  initialData = await dataAdapter.loadUserData();
}
let progress = initialData.progress;
let settings = initialData.settings;
let accountStats = initialData.stats;
let profile = (await dataAdapter.getSession())?.profile || null;
// One switch used to cover everything, and it lived on `progress.sound` so
// Android could share it. Effects and music now have a switch and a level
// each, in settings. A player who had turned the old switch off must not be
// blasted on the next launch, so the first run after the split folds the old
// boolean into all four fields; `audioMigrated` makes that a one-time step so a
// later "music off, effects on" is never overwritten by it. `progress.sound`
// stays live for apps/mobile, which still reads it, and the shell keeps it in
// step with "is anything audible".
if (!settings.audioMigrated) {
  settings.effectsOn = progress.sound;
  settings.musicOn = progress.sound;
  settings.audioMigrated = true;
}
const sound = new Sound(settings.effectsOn, settings.effectsVolume);
const music = createMusic({
  tracks: TRACKS,
  // A build copies the tracks next to index.html (scripts/build.mjs); the
  // source tree is served straight from public/. Picking one rather than
  // probing both keeps a 404 out of the console.
  resolve: (track) =>
    import.meta.env?.PROD
      ? new URL(`./audio/${track.file}`, document.baseURI).href
      : new URL(`/public/audio/${track.file}`, location.origin).href,
  trim: settings.musicVolume,
});
music.setEnabled(settings.musicOn);
const renderer = new Renderer($("court"));
const viewForHash = () =>
  location.hash === "#play"
    ? "arena"
    : location.hash === "#courts"
      ? "courts"
      : "title";
let mode = "career",
  courtIndex = progress.lastCourt,
  game,
  phase = "ready",
  // A cold load always opens the title screen. applyView() pushes #play when a
  // round starts, so that hash outlives the session in history, bookmarks and
  // reopened tabs; honouring it on boot drops a returning player straight into
  // the arena, where the ready-state overlay reads as a pause menu they never
  // asked for. Within a session the hash still drives the view (see the
  // hashchange listener), so back and forward behave — only this first paint
  // ignores it, and the boot below rewrites the URL so it cannot then lie.
  view = "title",
  bank = false,
  focusToggle = false;
let keys = new Set(),
  aim = null,
  pointerMove = null,
  stick = { x: 0, y: 0 },
  gamepadMove = { x: 0, y: 0 },
  gamepadFocus = false;
let padPrevious = [],
  padConnected = false,
  menuRepeat = 0,
  sliderRepeat = 0,
  finished = false,
  roundCleared = false,
  lastTime = 0,
  toastTimeout,
  announcementTimeout,
  announcementTime = 0,
  focusEarnedTimeout;
let capture = null;
let padFocusElement = null;
// The pause menu is the shell's one in-round menu. It owns Resume, Restart,
// Courts, Settings and Quit so nothing important hides behind a drawer.
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
const anyDialogOpen = () =>
  $("settings-dialog").open ||
  $("help-dialog").open ||
  $("account-dialog").open;
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
// still the way to reach Courts, Settings and Quit.
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
  if ($("title-view")) syncTitle();
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
  $("title-view").hidden = view !== "title";
  $("courts-view").hidden = view !== "courts";
  $("arena-view").hidden = view !== "arena";
  if (view !== "arena") closePauseMenu({ restoreFocus: false });
  // Exactly one game is live at a time: the demo is built on the way into the
  // title screen and dropped on the way out, before the arena starts drawing.
  if (view === "title") startAttract();
  else stopAttract();
  syncProgress();
  syncSettingChrome();
  syncPauseMenu();
  requestAnimationFrame(() => {
    if (anyDialogOpen() || menuOpen) return;
    if (view === "title") padFocus($("title-play"));
    else if (view === "courts") padFocus($("courts-back"));
    else if ($("game-overlay").hidden)
      $("court").focus({ preventScroll: true });
    else padFocus($("start-button"));
  });
  if (updateHash) {
    const hash =
      view === "arena" ? "#play" : view === "courts" ? "#courts" : "";
    if (location.hash !== hash)
      history.pushState(null, "", hash || location.pathname + location.search);
  }
}
// --- The title screen's attract demo -------------------------------------
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
  attractPassIn = 0;
function startAttract() {
  if (!attractCanvas || attractGame) return;
  attractRenderer ||= new Renderer(attractCanvas);
  attractRenderer.effects.length = 0;
  attractGame = new Game(
    {
      ...COURTS[1],
      name: "Attract",
      // Practice rules: unlimited possessions, so a demo left running on the
      // title screen can never stall on a turnover it has no way to dismiss.
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
    demo.pass(demo.bestTarget(null));
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
  $("game-overlay").hidden = false;
  $("overlay-kicker").textContent = kicker;
  $("overlay-title").textContent = title;
  $("overlay-copy").textContent = copy;
  $("start-button").textContent = primary;
  $("secondary-button").textContent = secondary;
  $("secondary-button").hidden = !secondary;
}
function setControlsEnabled(enabled) {
  [
    "pass-button",
    "bank-button",
    "focus-button",
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
  phase = "ready";
  finished = false;
  roundCleared = false;
  bank = false;
  focusToggle = false;
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
    mode === "practice" ? "Start warm-up" : "Play the court",
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
    setOverlay(
      "LEAVE THIS ROUND?",
      "Start somewhere new?",
      "This round’s score will be lost. Your saved progress stays with you.",
      "Keep playing",
      "Leave round",
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
// sit on the title screen in silence with nothing to tell them why. Blocked
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
  hint.hidden = !(view === "title" && audioBlocked());
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
  clearInput();
  setControlsEnabled(false);
  syncFocusButtons();
  syncResumePrompt();
}
function endHold() {
  if (!awaitingResume) return;
  awaitingResume = false;
  delete document.body.dataset.resumeReady;
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
  pointerId = null;
  joystickId = null;
  game?.clearQueuedPass?.();
  $("joystick-thumb").style.transform = "translate(0px, 0px)";
}
function pause() {
  if (phase !== "playing") return;
  phase = "paused";
  focusToggle = false;
  clearInput();
  setControlsEnabled(false);
  $("focus-button").setAttribute("aria-pressed", "false");
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
  if (awaitingResume) holdElapsed = 0;
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
function quitGame() {
  if (!inShell) {
    toast("Close the browser tab to leave the game.");
    return;
  }
  persist();
  // The renderer has no Node bridge by design. window.close() ends a window
  // the shell opened, and apps/electron/main.mjs quits on window-all-closed.
  window.close();
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
    toast("Earn Focus with wall passes, triangles, or bonus zones.");
    return;
  }
  focusToggle = !focusToggle;
  syncFocusButtons();
}
function syncFocusButtons() {
  $("focus-button").setAttribute("aria-pressed", String(focusToggle));
  $("touch-focus").setAttribute("aria-pressed", String(focusToggle));
}
function syncHud() {
  $("score-value").textContent = String(game.score).padStart(3, "0");
  $("time-value").textContent =
    `${Math.floor(Math.ceil(game.time) / 60)}:${String(Math.max(0, Math.ceil(game.time) % 60)).padStart(2, "0")}`;
  $("combo-value").textContent =
    `×${1 + Math.min(4, Math.floor(game.combo / 4))}`;
  $("lives-value").textContent = game.config.practice
    ? "∞"
    : `${Math.max(0, 3 - game.turnovers)} / 3`;
  if (focusToggle && game.focus <= 0) focusToggle = false;
  syncFocusButtons();
  const focusCap = game.tactic.focus;
  const focusAmount = Math.max(0, game.focus);
  const focusRatio = focusCap ? focusAmount / focusCap : 0;
  const focusText = `${focusAmount.toFixed(1)} / ${focusCap}s`;
  $("focus-value").textContent = focusText;
  $("touch-focus-value").textContent = focusText;
  $("focus-fill").style.width = `${focusRatio * 100}%`;
  $("touch-focus-fill").style.width = `${focusRatio * 100}%`;
  $("focus-meter").setAttribute("aria-valuemax", String(focusCap));
  $("focus-meter").setAttribute("aria-valuenow", focusAmount.toFixed(1));
  $("focus-meter").setAttribute(
    "aria-valuetext",
    `${focusAmount.toFixed(1)} of ${focusCap} seconds`,
  );
  const focusEmpty = focusAmount <= 0;
  $("focus-button").classList.toggle("is-empty", focusEmpty);
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
          : `${bank ? "WALL PASS" : "PASS"} → ${game.bestTarget(aim) + 1} · ${game.combo} IN A ROW`
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
  clearInput();
  endHold();
  $("pause-button").disabled = false;
  setPauseState(false);
  setControlsEnabled(false);
  const result = awardMatch(progress, game, mode, courtIndex);
  roundCleared = result.cleared;
  const roundProfileId = profile?.id || null;
  void dataAdapter
    .recordRound({
      score: game.score,
      passes: game.passes,
      bestOneTouch: game.bestOneTouch,
    })
    .then((nextStats) => {
      if ((profile?.id || null) !== roundProfileId) return;
      accountStats = nextStats;
      syncHome();
    })
    .catch(() => toast("Round stats could not be stored."));
  persist();
  syncProgress();
  let title =
    mode === "endless"
      ? "What a run."
      : result.cleared
        ? "Beautifully played."
        : "One more touch.";
  const details = `${game.score} points · ${game.passes} passes · ${game.triangles} triangles · best one-touch ${game.bestOneTouch || 0} · +${result.xp} XP`;
  const extra =
    mode === "career" && result.cleared
      ? courtIndex === COURTS.length - 1
        ? "Circuit complete. Chase three stars on every court."
        : `${COURTS[courtIndex + 1].name} is now unlocked.`
      : game.turnovers >= 3 && !game.config.practice
        ? "The press caught you. Use focus and wall passes to find space."
        : result.cleared
          ? "Keep exploring. There’s always a better passing lane."
          : `Aim for ${game.config.target} points and survive the full round.`;
  setOverlay(
    result.cleared
      ? `COURT CLEARED ${"★".repeat(result.stars)}${result.newBest ? " · NEW BEST" : ""}`
      : result.newBest
        ? "A NEW PERSONAL BEST"
        : "ROUND COMPLETE",
    title,
    `${details}. ${extra}`,
    mode === "career" && result.cleared && courtIndex < COURTS.length - 1
      ? "Next court"
      : "Play again",
    "Back to court",
  );
  $("start-button").focus({ preventScroll: true });
  announce(
    `Round complete. ${game.score} points. ${result.cleared ? "Court cleared." : ""}`,
  );
}
$("start-button").addEventListener("click", () => {
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
  // apps/mobile still reads progress.sound, and a shared profile would look
  // broken if it disagreed with the desktop switches.
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
// The side-rail player. It is the same switch as the settings dialog's Music
// button plus a skip, so there is one notion of "music on" and the volume and
// on/off settings keep governing it.
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
// A rail button is a real button, so activating it takes DOM focus off the
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
function syncSettingChrome() {
  syncAudioChrome();
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle("play-view", view === "arena");
  document.body.dataset.view = view;
  $("theme-button").setAttribute(
    "aria-pressed",
    String(settings.theme === "light"),
  );
  $("theme-button").innerHTML =
    `<span aria-hidden="true">◐</span> ${settings.theme === "dark" ? "Light" : "Dark"}`;
  if ($("preset-select")) $("preset-select").value = settings.preset;
  document.querySelectorAll("[data-binding]").forEach((element) => {
    const codes = settings.bindings[element.dataset.binding] || [];
    element.textContent = codes.map(readableKey).join(" / ") || "Unbound";
  });
  const bindingText = (action) =>
    settings.bindings[action].map(readableKey).join(" / ") || "unbound";
  $("pass-button").title =
    `Smart pass (${bindingText("smartPass")}); press during flight to queue the next pass`;
  $("bank-button").title =
    `Toggle wall pass (${bindingText("wallToggle")}); hold ${bindingText("wallHold")}`;
  $("focus-button").title = `Hold Focus (${bindingText("focusHold")})`;
  $("court").setAttribute(
    "aria-label",
    `Tiki Taka court. Move with ${bindingText("moveUp")}, ${bindingText("moveLeft")}, ${bindingText("moveDown")}, and ${bindingText("moveRight")}. Smart pass with ${bindingText("smartPass")}; direct passes with ${[1, 2, 3, 4].map((number) => bindingText(`direct${number}`)).join(", ")}.`,
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
function syncAccountDialog() {
  $("account-guest").hidden = Boolean(profile);
  $("account-profile").hidden = !profile;
  $("profile-username").textContent = profile?.username || "";
  $("profile-email").textContent = profile?.email || "";
  $("account-button").textContent = `◎ ${profile?.username || "Local profile"}`;
}
async function switchDataContext(nextProfile) {
  if (phase === "playing") pause();
  clearInput();
  profile = nextProfile;
  const data = await dataAdapter.loadUserData();
  progress = data.progress;
  settings = data.settings;
  accountStats = data.stats;
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
function openAccount() {
  if (phase === "playing") pause();
  clearInput();
  $("account-status").textContent = "";
  syncAccountDialog();
  $("account-dialog").showModal();
}
$("account-button").addEventListener("click", openAccount);
$("close-account").addEventListener("click", () => $("account-dialog").close());
$("register-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = await dataAdapter.register({
      email: $("register-email").value,
      username: $("register-username").value,
    });
    await switchDataContext(next);
    $("account-dialog").close();
    toast(`Local profile ${next.username} created on this device.`);
  } catch (error) {
    $("account-status").textContent = error.message;
  }
});
$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const next = await dataAdapter.login({
      identifier: $("login-identifier").value,
    });
    await switchDataContext(next);
    $("account-dialog").close();
    toast(`Playing locally as ${next.username}.`);
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
// The desktop shell opens its window fullscreen without the page ever calling
// requestFullscreen, and Electron reports no display-mode change for it. In the
// shell a fullscreen window fills the screen exactly; a maximised one does not.
const shellFullscreen = () =>
  location.protocol === "tiki:" &&
  window.innerWidth >= screen.width &&
  window.innerHeight >= screen.height;
function syncFullscreen() {
  const active =
    document.fullscreenElement === document.documentElement ||
    shellFullscreen();
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
$("title-courts").addEventListener("click", () => applyView("courts"));
$("title-quit").addEventListener("click", quitGame);
$("courts-back").addEventListener("click", () => applyView("title"));
$("pause-resume").addEventListener("click", dismissPauseMenu);
$("pause-restart").addEventListener("click", () => {
  closePauseMenu({ restoreFocus: false });
  // Every round begins from the invitation card, so restarting lands there
  // rather than throwing the player straight back into a live press.
  prepare();
  padFocus($("start-button"));
});
$("pause-courts").addEventListener("click", () => {
  closePauseMenu({ restoreFocus: false });
  applyView("courts");
});
$("pause-settings").addEventListener("click", openSettings);
$("pause-quit").addEventListener("click", quitGame);
// Quit only appears in the packaged shell: window.close() does nothing for a
// normal browser tab, and a dead menu item is worse than no menu item.
for (const id of ["title-quit", "pause-quit"]) $(id).hidden = !inShell;
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
      const elements = padFocusables([$("pause-menu"), $("music-rail")]);
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
  if (e.code === "Escape" && view === "courts") {
    e.preventDefault();
    applyView("title");
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
    return;
  }
  if (!padConnected) {
    padConnected = true;
    toast(
      "Controller connected. Right stick picks the pass · A plays it · X arms the wall · LT focuses.",
    );
  }
  const pressed = pad.buttons.map((b) => b.pressed),
    tap = (i) => pressed[i] && !padPrevious[i];
  // A gamepad press is not a user activation gesture, so this will not unblock
  // a browser on its own. It costs nothing, it does unblock the packaged shell
  // and any browser whose policy is relaxed, and on the rest it keeps the
  // context ready so the first key or click starts audio instantly.
  if (pressed.some((down, i) => down && !padPrevious[i])) unlockAudio();
  // Any button at all resumes after a turnover, but only on a fresh press:
  // tap() is edge-triggered, so a button still held from before is ignored.
  if (awaitingResume && !menuOpen && !anyDialogOpen()) {
    const anyTap = pressed.some((down, i) => down && !padPrevious[i]);
    if (anyTap && !tap(9) && releaseHold()) {
      padPrevious = pressed;
      return;
    }
  }
  const dead = (v) => (Math.abs(v || 0) > 0.18 ? v : 0);
  // Sticks only drive the court while the round is actually accepting play.
  // Otherwise a nudge behind the pause overlay would keep repainting aim lanes.
  if (acceptingPlayInput()) {
    gamepadMove = { x: dead(pad.axes[0]), y: dead(pad.axes[1]) };
    gamepadFocus = !!pressed[6];
    if (Math.hypot(dead(pad.axes[2]), dead(pad.axes[3])) > 0.2)
      aim = { x: pad.axes[2], y: pad.axes[3] };
    else if (Math.hypot(gamepadMove.x, gamepadMove.y) > 0.2)
      aim = { ...gamepadMove };
  } else {
    gamepadMove = { x: 0, y: 0 };
    gamepadFocus = false;
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
    // The music rail is walked with the pause menu: it is where a controller
    // player can reach the soundtrack without a mouse, and pausing is the only
    // time the d-pad is free to leave the court.
    else
      nav([$("pause-menu"), $("music-rail")], () => $("pause-resume").click());
  } else if (view === "arena" && phase === "playing" && !awaitingResume) {
    if (tap(0)) doPass();
    if (tap(2)) toggleBank();
    if (tap(9)) openPauseMenu();
  } else if (view === "arena" && awaitingResume) {
    if (tap(9)) openPauseMenu();
  } else if (view === "arena" && !$("game-overlay").hidden) {
    if (tap(9)) openPauseMenu();
    else nav($("game-overlay"), () => $("start-button").click());
  } else if (view === "courts") {
    if (tap(1)) applyView("title");
    else nav($("courts-view"), () => $("courts-back").click());
  } else if (view === "title") {
    nav($("title-menu"), () => $("title-play").click());
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
    document.body.dataset.resumeReady = holdElapsed < 0.3 ? "0" : "1";
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
      sound.play(event.type);
      if (event.type === "focus") {
        clearTimeout(focusEarnedTimeout);
        $("focus-button").classList.remove("focus-earned");
        $("touch-focus").classList.remove("focus-earned");
        requestAnimationFrame(() => {
          $("focus-button").classList.add("focus-earned");
          $("touch-focus").classList.add("focus-earned");
        });
        focusEarnedTimeout = setTimeout(() => {
          $("focus-button").classList.remove("focus-earned");
          $("touch-focus").classList.remove("focus-earned");
        }, 700);
      }
      if (event.type === "one-touch" && event.milestone) {
        announce(event.text || `${event.streak} ONE-TOUCH PASSES`);
        announcementTime = now;
      }
      // The engine is shared with Android and still resumes on its own timer;
      // the desktop shell holds the round on top of that instead of changing
      // packages/engine.
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
  if (view === "title") updateAttract(dt);
  if (view === "arena") {
    syncHud();
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
// Drop a stale #play or #courts so the address bar agrees with the title screen
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
if (
  import.meta.env?.PROD &&
  "serviceWorker" in navigator &&
  location.protocol !== "tiki:"
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(`${import.meta.env.BASE_URL}sw.js`)
      .catch(() => {});
  });
}
