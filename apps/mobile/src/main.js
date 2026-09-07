import {
  Game,
  COURTS,
  TACTICS,
  dailyConfig,
  awardMatch,
} from "../../../packages/engine/src/index.js";
import { Renderer } from "../../../packages/presentation/src/renderer.js";
import { Sound } from "../../../packages/presentation/src/audio.js";
import { createLocalDataAdapter } from "../../../packages/data/src/index.js";

const $ = (id) => document.getElementById(id);
const memory = new Map();
const memoryStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, value),
  removeItem: (key) => memory.delete(key),
};
let storage = memoryStorage;
try {
  localStorage.setItem("tiki-taka.mobile.probe", "1");
  localStorage.removeItem("tiki-taka.mobile.probe");
  storage = localStorage;
} catch {}
let adapter = createLocalDataAdapter({ storage });
let data;
try {
  data = await adapter.loadUserData();
} catch {
  adapter = createLocalDataAdapter({ storage: memoryStorage });
  data = await adapter.loadUserData();
  setTimeout(() =>
    notify("Device storage unavailable. Playing in this session only."),
  );
}
let session = await adapter.getSession();
let mode = "career",
  courtIndex = data.progress.lastCourt || 0,
  game = null;
let phase = "ready",
  screen = "home",
  lastTime = 0,
  frameId = 0;
let viewportOrientation = matchMedia("(orientation: portrait)").matches
  ? "portrait"
  : "landscape";
let move = { x: 0, y: 0 },
  aim = null,
  joystickPointerId = null;
let bankArmed = false;
const actionPointerIds = { pass: new Set(), wall: new Set(), focus: new Set() };
const renderer = new Renderer($("court"));
const sound = new Sound(data.progress.sound);

function config() {
  if (mode === "daily") return dailyConfig();
  if (mode === "endless")
    return {
      ...COURTS[1],
      name: "Infinite rondo",
      place: "ENDLESS FLOW",
      target: 0,
      time: 60,
      speed: 85,
      endless: true,
      seed: Date.now() >>> 0,
    };
  if (mode === "practice")
    return {
      ...COURTS[0],
      name: "The warm-up",
      place: "FREE PRACTICE",
      target: 120,
      time: 90,
      speed: 58,
      defenders: 2,
      practice: true,
    };
  return COURTS[courtIndex];
}
function formatTime(value) {
  const n = Math.max(0, Math.ceil(value));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
function notify(text) {
  const el = $("toast");
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => el.classList.remove("show"), 2200);
}
async function safeSave(update) {
  try {
    data = await adapter.saveUserData(update);
  } catch (error) {
    notify(error.message || "Changes could not be saved.");
  }
}
function clearPointers() {
  joystickPointerId = null;
  move = { x: 0, y: 0 };
  $("joystick-thumb").style.transform = "";
  for (const set of Object.values(actionPointerIds)) set.clear();
  game?.clearQueuedPass?.();
}
function setBankArmed(value) {
  bankArmed = Boolean(value);
  $("wall-action").setAttribute("aria-pressed", String(bankArmed));
  $("wall-action").classList.toggle("active", bankArmed);
}
function setScreen(next) {
  if (screen === "game" && next !== "game" && phase === "playing") pause();
  screen = next;
  document
    .querySelectorAll(".screen")
    .forEach((el) => el.classList.toggle("active", el.id === `${next}-screen`));
  document
    .querySelectorAll("#bottom-nav [data-screen]")
    .forEach((el) => el.classList.toggle("active", el.dataset.screen === next));
  clearPointers();
  if (next === "home") syncHome();
  if (next === "profile") void syncProfile();
}
function makeGame() {
  game = new Game(config(), data.progress.tactic);
  phase = "ready";
  renderer.effects.length = 0;
  $("court-title").textContent = game.config.name;
  $("mode-label").textContent =
    mode === "career" ? "WORLD TOUR" : mode.toUpperCase();
  setBankArmed(false);
  showOverlay(
    "Keep it beautiful.",
    "Move. Pass. Beat the press.",
    "Kick off ↗",
  );
  syncHud();
}
function showOverlay(title, copy, button) {
  $("overlay-title").textContent = title;
  $("overlay-copy").textContent = copy;
  $("start-button").textContent = button;
  $("game-overlay").classList.remove("hidden");
}
function startOrResume() {
  sound.unlock();
  if (!game) makeGame();
  clearPointers();
  phase = "playing";
  $("game-overlay").classList.add("hidden");
  lastTime = performance.now();
}
function pause() {
  if (phase !== "playing") return;
  phase = "paused";
  clearPointers();
  setBankArmed(false);
  showOverlay("Paused.", "Your round is waiting.", "Resume ↗");
}
function syncHud() {
  if (!game) return;
  $("score-value").textContent = String(game.score).padStart(3, "0");
  $("time-value").textContent = formatTime(game.time);
  $("streak-value").textContent = `×${game.oneTouchStreak}`;
  $("focus-value").textContent =
    `${game.focus.toFixed(1)} / ${game.tactic.focus}`;
  $("focus-fill").style.width = `${(game.focus / game.tactic.focus) * 100}%`;
  $("lives-value").textContent = game.config.practice
    ? "∞"
    : `${"● ".repeat(Math.max(0, 3 - game.turnovers))}${"○ ".repeat(Math.min(3, game.turnovers))}`.trim();
}
function chooseTarget() {
  if (!game) return null;
  if (game.ball) return game.bestQueuedTarget(aim);
  if (aim) return game.bestTarget(aim);
  return (
    game.players.find((p) => p.id !== (game.ball?.to ?? game.carrier))?.id ??
    null
  );
}
function pass(bank = bankArmed) {
  if (phase !== "playing") return;
  const id = chooseTarget();
  if (id === null) return;
  const accepted = game.ball ? game.queuePass(id, bank) : game.pass(id, bank);
  if (accepted && bank) setBankArmed(false);
}
function passTo(id, bank = false) {
  if (phase !== "playing" || id === null) return;
  const accepted = game.ball ? game.queuePass(id, bank) : game.pass(id, bank);
  if (accepted && bank) setBankArmed(false);
}
async function finish() {
  if (phase === "finished") return;
  phase = "finished";
  const result = awardMatch(data.progress, game, mode, courtIndex);
  try {
    await adapter.recordRound(game);
    data = await adapter.saveUserData({ progress: data.progress });
  } catch (error) {
    notify(error.message || "Progress could not be saved.");
  }
  showOverlay(
    result.cleared ? "Court cleared." : "Round over.",
    `${game.score} flow · ${game.passes} passes · best one-touch ${game.bestOneTouch}`,
    "Play again ↗",
  );
  syncHome();
}
function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000 || 0);
  lastTime = now;
  if (screen === "game" && phase === "playing") {
    game.update(dt, {
      x: move.x,
      y: move.y,
      focus: actionPointerIds.focus.size > 0,
    });
    for (const event of game.events) {
      renderer.addEvent(event);
      sound.play(event.type, event);
    }
    game.events = [];
    if (game.status === "finished") void finish();
    syncHud();
  }
  if (screen === "game" && game)
    renderer.render(game, {
      preview: phase === "ready",
      aim,
      paused: phase !== "playing",
      theme: data.settings.theme,
      orientation: matchMedia("(orientation: portrait)").matches
        ? "portrait"
        : "landscape",
      bank: bankArmed,
      target: bankArmed ? chooseTarget() : null,
    });
  frameId = requestAnimationFrame(loop);
}

function syncHome() {
  const c = COURTS[courtIndex];
  $("continue-copy").textContent = `${c.place.split(",")[0]} · ${c.name}`;
  $("tour-count").textContent =
    `${Object.values(data.progress.courts).filter((x) => x.stars).length} / 6`;
  const list = $("court-list");
  list.innerHTML = "";
  COURTS.forEach((court, i) => {
    const b = document.createElement("button");
    b.className = "court-button";
    b.disabled = i > data.progress.unlocked;
    b.innerHTML = `<span class="court-number">${String(i + 1).padStart(2, "0")}</span><strong>${court.name}<small>${court.place}</small></strong><span>${b.disabled ? "LOCKED" : data.progress.courts[i]?.stars ? "★".repeat(data.progress.courts[i].stars) : "○"}</span>`;
    b.addEventListener("click", () => {
      mode = "career";
      courtIndex = i;
      data.progress.lastCourt = i;
      void safeSave({ progress: data.progress });
      openGame();
    });
    list.append(b);
  });
}
function openGame() {
  makeGame();
  setScreen("game");
}
function continueGame() {
  if (game && phase === "paused") setScreen("game");
  else openGame();
}
async function resetIdentity() {
  data = await adapter.loadUserData();
  courtIndex = data.progress.lastCourt || 0;
  mode = "career";
  sound.enabled = data.progress.sound;
  document.documentElement.dataset.theme = data.settings.theme;
  $("theme-select").value = data.settings.theme;
  $("sound-toggle").checked = data.progress.sound;
  $("settings-tactic").value = data.progress.tactic;
  $("wall-mode-select").value = data.settings.mobileWallMode;
  makeGame();
  syncHome();
}
async function syncProfile() {
  session = await adapter.getSession();
  data = await adapter.loadUserData();
  const s = data.stats;
  $("profile-name").textContent = session?.profile?.username || "Guest player";
  $("profile-status").textContent = session
    ? `${session.profile.email} · Local demo profile`
    : "Progress stays on this device.";
  $("logout-button").hidden = !session;
  $("stat-games").textContent = s.games;
  $("stat-score").textContent = s.bestScore;
  $("stat-passes").textContent = s.totalPasses;
  $("stat-touch").textContent = s.bestOneTouch;
}
async function auth(action, form) {
  try {
    const values = Object.fromEntries(new FormData(form));
    await adapter[action](values);
    $("auth-message").textContent =
      action === "register"
        ? "Passwordless demo profile created on this device."
        : "Signed in to this device-only profile.";
    await resetIdentity();
    await syncProfile();
  } catch (error) {
    $("auth-message").textContent = error.message;
  }
}

document.querySelectorAll("[data-mode]").forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    openGame();
  }),
);
document
  .querySelectorAll("[data-screen]")
  .forEach((b) =>
    b.addEventListener("click", () =>
      b.dataset.screen === "game"
        ? continueGame()
        : setScreen(b.dataset.screen),
    ),
  );
$("continue-button").addEventListener("click", continueGame);
$("game-back").addEventListener("click", () => setScreen("home"));
$("pause-button").addEventListener("click", pause);
$("start-button").addEventListener("click", () =>
  phase === "finished" ? (makeGame(), startOrResume()) : startOrResume(),
);
$("settings-tactic").value = data.progress.tactic;
$("settings-tactic").addEventListener("change", async (e) => {
  data.progress.tactic = e.target.value;
  await safeSave({ progress: data.progress });
  if (phase === "ready" || phase === "finished") makeGame();
  else notify("Playing style applies to your next round.");
});
$("wall-mode-select").value = data.settings.mobileWallMode;
$("wall-mode-select").addEventListener("change", async (e) => {
  data.settings.mobileWallMode = e.target.value;
  setBankArmed(false);
  await safeSave({ settings: data.settings });
});
$("theme-select").value = data.settings.theme;
document.documentElement.dataset.theme = data.settings.theme;
$("theme-select").addEventListener("change", async (e) => {
  data.settings.theme = e.target.value;
  document.documentElement.dataset.theme = e.target.value;
  await safeSave({ settings: data.settings });
});
$("sound-toggle").checked = data.progress.sound;
$("sound-toggle").addEventListener("change", async (e) => {
  data.progress.sound = e.target.checked;
  sound.enabled = e.target.checked;
  await safeSave({ progress: data.progress });
});
$("register-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void auth("register", e.currentTarget);
});
$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  void auth("login", e.currentTarget);
});
$("logout-button").addEventListener("click", async () => {
  await adapter.logout();
  await resetIdentity();
  await syncProfile();
});

const joystick = $("joystick");
joystick.addEventListener("pointerdown", (e) => {
  if (phase !== "playing") return;
  if (joystickPointerId !== null) return;
  e.preventDefault();
  joystickPointerId = e.pointerId;
  joystick.setPointerCapture(e.pointerId);
  updateStick(e);
});
function updateStick(e) {
  if (e.pointerId !== joystickPointerId) return;
  const r = joystick.getBoundingClientRect(),
    dx = e.clientX - r.left - r.width / 2,
    dy = e.clientY - r.top - r.height / 2,
    len = Math.hypot(dx, dy),
    max = r.width * 0.34,
    scale = len > max ? max / len : 1;
  const screenMove = {
    x: (dx / (max || 1)) * scale,
    y: (dy / (max || 1)) * scale,
  };
  move = renderer.screenVectorToWorld
    ? renderer.screenVectorToWorld(screenMove.x, screenMove.y)
    : matchMedia("(orientation: portrait)").matches
      ? { x: screenMove.y, y: -screenMove.x }
      : screenMove;
  if (len > 0.15) aim = { ...move };
  $("joystick-thumb").style.transform =
    `translate(${dx * scale}px,${dy * scale}px)`;
}
joystick.addEventListener("pointermove", updateStick);
function releaseStick(e) {
  if (e.pointerId !== joystickPointerId) return;
  joystickPointerId = null;
  move = { x: 0, y: 0 };
  $("joystick-thumb").style.transform = "";
}
joystick.addEventListener("pointerup", releaseStick);
joystick.addEventListener("pointercancel", releaseStick);
joystick.addEventListener("lostpointercapture", releaseStick);
function actionButton(id, name, onDown) {
  const button = $(id);
  button.addEventListener("pointerdown", (e) => {
    if (phase !== "playing") return;
    e.preventDefault();
    actionPointerIds[name].add(e.pointerId);
    button.setPointerCapture(e.pointerId);
    onDown();
  });
  const up = (e) => actionPointerIds[name].delete(e.pointerId);
  button.addEventListener("pointerup", up);
  button.addEventListener("pointercancel", up);
  button.addEventListener("lostpointercapture", up);
  button.addEventListener("click", (e) => {
    if (e.detail === 0) onDown();
  });
}
actionButton("pass-action", "pass", () => pass());
actionButton("wall-action", "wall", () => {
  if (data.settings.mobileWallMode === "instant") pass(true);
  else setBankArmed(!bankArmed);
});
actionButton("focus-action", "focus", () => {});
$("court").addEventListener("pointerdown", (event) => {
  if (phase !== "playing") return;
  const point = renderer.screenToWorld(event.clientX, event.clientY);
  const excluded = game.ball?.to ?? game.carrier;
  const target = game.players
    .filter((player) => player.id !== excluded)
    .sort(
      (a, b) =>
        Math.hypot(a.x - point.x, a.y - point.y) -
        Math.hypot(b.x - point.x, b.y - point.y),
    )[0];
  if (target && Math.hypot(target.x - point.x, target.y - point.y) <= 58)
    passTo(target.id, bankArmed);
});
addEventListener("blur", () => {
  clearPointers();
  pause();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearPointers();
    pause();
  }
});
document.addEventListener("keydown", (e) => {
  if (
    e.target instanceof HTMLInputElement ||
    e.target instanceof HTMLSelectElement
  )
    return;
  if (e.code === "Escape") {
    e.preventDefault();
    screen === "game" && phase === "playing" ? pause() : setScreen("home");
  }
  if (e.code === "Space") pass();
  if (e.code === "KeyB") pass(true);
});
document.addEventListener("contextmenu", (event) => {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
});
document.addEventListener("dragstart", (event) => {
  if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
});
addEventListener("resize", () => {
  const next = matchMedia("(orientation: portrait)").matches
    ? "portrait"
    : "landscape";
  if (next !== viewportOrientation) {
    viewportOrientation = next;
    clearPointers();
    if (phase === "playing") pause();
  }
});
if (globalThis.Capacitor?.isNativePlatform?.()) {
  import("@capacitor/app").then(({ App }) => {
    App.addListener("backButton", () => {
      if (screen !== "home") setScreen("home");
      else void App.exitApp();
    });
    App.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) {
        clearPointers();
        pause();
      }
    });
  });
}
syncHome();
await syncProfile();
makeGame();
setScreen("home");
cancelAnimationFrame(frameId);
frameId = requestAnimationFrame(loop);
