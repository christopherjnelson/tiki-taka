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
const sound = new Sound(progress.sound);
const renderer = new Renderer($("court"));
let mode = "career",
  courtIndex = progress.lastCourt,
  game,
  phase = "ready",
  view = location.hash === "#play" ? "arena" : "home",
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
  finished = false,
  roundCleared = false,
  lastTime = 0,
  toastTimeout,
  announcementTimeout,
  announcementTime = 0,
  focusEarnedTimeout;
let capture = null;
let sidebarOpen = false;
let sidebarReturnFocus = null;
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
const mobileSidebar = () => matchMedia("(max-width: 900px)").matches;
const drawerSidebar = () =>
  mobileSidebar() || (view === "arena" && settings.playView);
function syncSidebar() {
  const expanded = drawerSidebar() ? sidebarOpen : !settings.sidebarCollapsed;
  document.body.classList.toggle(
    "sidebar-open",
    drawerSidebar() && sidebarOpen,
  );
  document.body.classList.toggle(
    "sidebar-collapsed",
    !drawerSidebar() && settings.sidebarCollapsed,
  );
  $("sidebar-toggle").setAttribute("aria-expanded", String(expanded));
  $("sidebar-toggle").textContent = expanded ? "Hide sidebar" : "Show sidebar";
  $("sidebar-backdrop").hidden = !(drawerSidebar() && sidebarOpen);
  if ($("arena-view")) $("arena-view").inert = drawerSidebar() && sidebarOpen;
  if ($("home-view")) $("home-view").inert = drawerSidebar() && sidebarOpen;
}
function closeSidebar({ restoreFocus = true } = {}) {
  sidebarOpen = false;
  syncSidebar();
  if (restoreFocus) sidebarReturnFocus?.focus({ preventScroll: true });
  sidebarReturnFocus = null;
}
function toggleSidebar() {
  if (drawerSidebar()) {
    if (sidebarOpen) closeSidebar();
    else {
      if (phase === "playing") pause();
      clearInput();
      sidebarReturnFocus = document.activeElement;
      sidebarOpen = true;
      syncSidebar();
      $("home-button")?.focus({ preventScroll: true });
    }
  } else {
    const opening = settings.sidebarCollapsed;
    if (opening) {
      if (phase === "playing") pause();
      clearInput();
    }
    settings.sidebarCollapsed = !settings.sidebarCollapsed;
    persistSettings();
    syncSidebar();
  }
}
function syncHome() {
  const resumable = phase === "paused";
  const court = COURTS[resumable ? courtIndex : progress.lastCourt];
  $("home-continue").textContent = resumable
    ? "Resume round"
    : progress.xp > 0
      ? "Continue World Tour"
      : "Start World Tour";
  $("home-continue-copy").textContent = resumable
    ? `${game.config.name} · ${Math.max(0, Math.ceil(game.time))} seconds remain`
    : `${court.name} · ${court.place}`;
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
function arenaWorkspaceLabel() {
  const modeName =
    mode === "career"
      ? "WORLD TOUR"
      : mode === "daily"
        ? "DAILY CIRCUIT"
        : mode === "endless"
          ? "ENDLESS FLOW"
          : "FREE PRACTICE";
  return `${modeName} / ${game?.config?.name || COURTS[courtIndex].name}`;
}
function applyView(next, { updateHash = true } = {}) {
  if (next === "home" && phase === "playing") pause();
  view = next;
  $("home-view").hidden = view !== "home";
  $("arena-view").hidden = view !== "arena";
  $("arena-home-button").hidden = view !== "arena";
  $("workspace-label").textContent =
    view === "arena" ? arenaWorkspaceLabel() : "HOME";
  $("home-button").setAttribute(
    "aria-current",
    view === "home" ? "page" : "false",
  );
  if (view === "home") {
    closeSidebar({ restoreFocus: false });
    syncHome();
  }
  syncProgress();
  syncSettingChrome();
  syncSidebar();
  requestAnimationFrame(() => {
    if ($("settings-dialog").open || $("help-dialog").open || sidebarOpen)
      return;
    if (view === "home") {
      $("home-title").tabIndex = -1;
      $("home-title").focus({ preventScroll: true });
    } else if ($("game-overlay").hidden)
      $("court").focus({ preventScroll: true });
    else $("start-button").focus({ preventScroll: true });
  });
  if (updateHash) {
    const hash = view === "arena" ? "#play" : "";
    if (location.hash !== hash)
      history.pushState(null, "", hash || location.pathname + location.search);
  }
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
  document.querySelectorAll("[data-mode]").forEach((btn) => {
    const active = view === "arena" && btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  if ($("home-view")) syncHome();
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
function announce(text) {
  clearTimeout(announcementTimeout);
  $("game-announcement").textContent = "";
  requestAnimationFrame(() => {
    $("game-announcement").textContent = text;
  });
  announcementTimeout = setTimeout(
    () => ($("game-announcement").textContent = ""),
    2500,
  );
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
  clearInput();
  $("eyebrow").textContent = game.config.place;
  $("court-title").textContent = game.config.name;
  if (view === "arena")
    $("workspace-label").textContent = arenaWorkspaceLabel();
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
  $("pause-button").disabled = true;
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
  if (sidebarOpen) closeSidebar({ restoreFocus: false });
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
  if ($("settings-dialog").open || $("help-dialog").open || sidebarOpen) return;
  sound.unlock();
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
function clearInput() {
  keys.clear();
  stick = { x: 0, y: 0 };
  gamepadMove = { x: 0, y: 0 };
  pointerMove = null;
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
  setOverlay(
    "TAKE A BREATH",
    "The ball can wait.",
    "Your round is paused. Come back when you’re ready.",
    "Keep playing",
    "Restart round",
  );
}
function resume() {
  if (
    phase !== "paused" ||
    view !== "arena" ||
    $("settings-dialog").open ||
    $("help-dialog").open ||
    sidebarOpen
  )
    return;
  phase = "playing";
  pendingSwitch = null;
  $("game-overlay").hidden = true;
  setPauseState(false);
  setControlsEnabled(true);
  $("court").focus({ preventScroll: true });
}
function togglePause() {
  if (view !== "arena") return;
  if (phase === "playing") pause();
  else if (phase === "paused") resume();
}
function queuedSmartTarget() {
  if (!game.ball) return game.bestTarget(aim);
  return game.bestQueuedTarget(aim);
}
function doPass(id, forceBank = false) {
  if (phase !== "playing") return;
  sound.unlock();
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
  $("pause-button").disabled = true;
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
$("sound-button").setAttribute("aria-pressed", String(progress.sound));
function soundLabel() {
  $("sound-button").textContent = progress.sound ? "Sound on" : "Sound off";
}
soundLabel();
$("sound-button").addEventListener("click", () => {
  progress.sound = !progress.sound;
  sound.enabled = progress.sound;
  sound.unlock();
  $("sound-button").setAttribute("aria-pressed", String(progress.sound));
  soundLabel();
  persist();
});
function syncSettingChrome() {
  document.documentElement.dataset.theme = settings.theme;
  document.body.classList.toggle(
    "play-view",
    view === "arena" && settings.playView,
  );
  $("theme-button").setAttribute(
    "aria-pressed",
    String(settings.theme === "light"),
  );
  $("theme-button").innerHTML =
    `<span aria-hidden="true">◐</span> ${settings.theme === "dark" ? "Light" : "Dark"}`;
  const playViewAvailable = view === "arena";
  $("play-view-button").disabled = !playViewAvailable;
  $("play-view-button").title = playViewAvailable
    ? "Toggle distraction-free Play view"
    : "Open a court to use Play view";
  $("play-view-button").setAttribute(
    "aria-pressed",
    String(playViewAvailable && settings.playView),
  );
  $("play-view-button").innerHTML =
    `<span aria-hidden="true">◇</span> ${playViewAvailable && settings.playView ? "Exit play view" : "Play view"}`;
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
  sound.enabled = progress.sound;
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
$("play-view-button").addEventListener("click", () => {
  settings.playView = !settings.playView;
  sidebarOpen = false;
  persistSettings();
  syncSettingChrome();
  syncSidebar();
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
    else await document.documentElement.requestFullscreen();
  } catch {
    toast("Fullscreen is not available in this browser.");
  }
  syncFullscreen();
});
document.addEventListener("fullscreenchange", syncFullscreen);
$("sidebar-toggle").addEventListener("click", toggleSidebar);
$("sidebar-close")?.addEventListener("click", () => closeSidebar());
$("sidebar-backdrop").addEventListener("click", () => closeSidebar());
$("home-button").addEventListener("click", () => applyView("home"));
$("arena-home-button").addEventListener("click", () => applyView("home"));
$("home-continue").addEventListener("click", () => {
  const resumeRound = phase === "paused";
  if (!resumeRound) {
    mode = "career";
    courtIndex = progress.lastCourt;
    prepare();
  }
  applyView("arena");
  if (resumeRound) resume();
});
$("game-sidebar")
  .querySelector(".brand")
  ?.addEventListener("click", (event) => {
    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      applyView("home");
    }
  });
document.querySelectorAll("[data-home-mode]").forEach((button) => {
  button.addEventListener("click", () =>
    switchMode(button.dataset.homeMode, courtIndex),
  );
});
addEventListener("hashchange", () => {
  applyView(location.hash === "#play" ? "arena" : "home", {
    updateHash: false,
  });
});
addEventListener("resize", () => {
  if (!drawerSidebar()) sidebarOpen = false;
  syncSidebar();
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
document
  .querySelectorAll("[data-mode]")
  .forEach((btn) =>
    btn.addEventListener("click", () => switchMode(btn.dataset.mode)),
  );
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
  if ($("settings-dialog").open) return;
  if ($("help-dialog").open) return;
  if (e.code === "Escape" && sidebarOpen) {
    e.preventDefault();
    closeSidebar();
    return;
  }
  if (e.code === "Tab" && drawerSidebar() && sidebarOpen) {
    const elements = [
      ...$("game-sidebar").querySelectorAll(
        "button:not(:disabled),a[href],select:not(:disabled)",
      ),
    ].filter((element) => element.getClientRects().length);
    if (elements.length) {
      e.preventDefault();
      const current = elements.indexOf(document.activeElement);
      const direction = e.shiftKey ? -1 : 1;
      elements[
        (current + direction + elements.length) % elements.length
      ].focus();
    }
    return;
  }
  if (drawerSidebar() && sidebarOpen) {
    if (actionForCode(settings.bindings, e.code)) e.preventDefault();
    return;
  }
  const action = actionForCode(settings.bindings, e.code);
  if (action === "pause") {
    e.preventDefault();
    togglePause();
    return;
  }
  if (phase !== "playing" || e.target instanceof HTMLSelectElement) return;
  if (action) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (action?.startsWith("direct")) doPass(Number(action.slice(-1)) - 1);
  if (action === "smartPass") doPass();
  if (action === "wallToggle") toggleBank();
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
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
$("court").addEventListener("pointerdown", (e) => {
  if (phase !== "playing") return;
  sound.unlock();
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
      "Controller connected. X to arm the wall pass · A to play it · LT to focus.",
    );
  }
  const pressed = pad.buttons.map((b) => b.pressed),
    tap = (i) => pressed[i] && !padPrevious[i];
  const dead = (v) => (Math.abs(v || 0) > 0.18 ? v : 0);
  gamepadMove = { x: dead(pad.axes[0]), y: dead(pad.axes[1]) };
  gamepadFocus = !!pressed[6];
  if (Math.hypot(dead(pad.axes[2]), dead(pad.axes[3])) > 0.2)
    aim = { x: pad.axes[2], y: pad.axes[3] };
  else if (Math.hypot(gamepadMove.x, gamepadMove.y) > 0.2)
    aim = { ...gamepadMove };
  if (
    drawerSidebar() &&
    sidebarOpen &&
    !$("settings-dialog").open &&
    !$("help-dialog").open
  ) {
    if (tap(1) || tap(9)) closeSidebar();
    menuRepeat -= dt;
    const direction =
      pressed[13] || pressed[15] || pad.axes[1] > 0.6
        ? 1
        : pressed[12] || pressed[14] || pad.axes[1] < -0.6
          ? -1
          : 0;
    if (direction && menuRepeat <= 0) {
      const elements = [
        ...$("game-sidebar").querySelectorAll(
          "button:not(:disabled),select:not(:disabled)",
        ),
      ].filter((el) => el.getClientRects().length);
      const current = elements.indexOf(document.activeElement);
      elements[
        (current + direction + elements.length) % elements.length
      ]?.focus({ preventScroll: false });
      menuRepeat = 0.2;
    } else if (!direction) menuRepeat = 0;
    if (tap(0)) document.activeElement?.click?.();
  } else if ($("settings-dialog").open) {
    if (tap(1) || tap(9)) {
      if (capture) cancelCapture();
      else $("settings-dialog").close();
    }
    menuRepeat -= dt;
    const direction =
      pressed[13] || pressed[15] || pad.axes[1] > 0.6
        ? 1
        : pressed[12] || pressed[14] || pad.axes[1] < -0.6
          ? -1
          : 0;
    if (direction && menuRepeat <= 0) {
      const elements = [
        ...$("settings-dialog").querySelectorAll(
          "button:not(:disabled),select:not(:disabled)",
        ),
      ].filter((el) => el.getClientRects().length);
      const current = elements.indexOf(document.activeElement);
      elements[
        (current + direction + elements.length) % elements.length
      ]?.focus({ preventScroll: false });
      menuRepeat = 0.2;
    } else if (!direction) menuRepeat = 0;
    if (tap(0) && !capture) {
      const el = document.activeElement;
      if (el instanceof HTMLSelectElement) {
        const options = [...el.options].filter((option) => !option.disabled);
        const current = options.indexOf(el.selectedOptions[0]);
        const next = options[(current + 1) % options.length];
        el.value = next.value;
        el.dispatchEvent(new Event("change"));
      } else if (el instanceof HTMLButtonElement) el.click();
    }
  } else if ($("help-dialog").open) {
    if (tap(1) || tap(9)) $("help-dialog").close();
  } else if (view === "arena" && phase === "playing") {
    if (tap(0)) doPass();
    if (tap(2)) toggleBank();
    if (tap(9)) pause();
  } else {
    if (tap(9) && phase === "paused" && view === "arena") resume();
    menuRepeat -= dt;
    const direction =
      pressed[13] || pressed[15] || pad.axes[1] > 0.6
        ? 1
        : pressed[12] || pressed[14] || pad.axes[1] < -0.6
          ? -1
          : 0;
    if (direction && menuRepeat <= 0) {
      const elements = [
        ...document.querySelectorAll(
          "button:not(:disabled),select:not(:disabled)",
        ),
      ].filter((el) => !el.closest("[hidden]") && el.getClientRects().length);
      const current = elements.indexOf(document.activeElement);
      elements[
        (current + direction + elements.length) % elements.length
      ]?.focus({ preventScroll: false });
      menuRepeat = 0.2;
    } else if (!direction) menuRepeat = 0;
    if (tap(0)) {
      const el = document.activeElement;
      if (el instanceof HTMLSelectElement) {
        const options = [...el.options].filter((option) => !option.disabled);
        const current = options.indexOf(el.selectedOptions[0]);
        el.value = options[(current + 1) % options.length].value;
        el.dispatchEvent(new Event("change"));
      } else if (el instanceof HTMLButtonElement) el.click();
      else if (view === "arena") $("start-button").click();
      else $("home-continue").click();
    }
    if (tap(1) && phase === "paused" && view === "arena") resume();
  }
  padPrevious = pressed;
}
function frame(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  pollGamepad(dt);
  if (view === "arena" && phase === "playing") {
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
    for (const event of game.events) {
      renderer.addEvent(event);
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
      if (
        event.type === "turnover" ||
        (event.type === "score" && now - announcementTime > 3500)
      ) {
        announce(event.text);
        announcementTime = now;
      }
      if (event.type === "end") finish();
    }
    game.events = [];
  }
  if (view === "arena") {
    syncHud();
    renderer.render(game, {
      preview: phase === "ready",
      target: phase === "playing" ? queuedSmartTarget() : null,
      aim,
      bank: bank || actionDown(settings.bindings, keys, "wallHold"),
      paused: phase === "paused" || phase === "finished",
    });
  }
  requestAnimationFrame(frame);
}
syncSettingChrome();
syncFullscreen();
syncAccountDialog();
prepare();
syncSidebar();
applyView(view, { updateHash: false });
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
