import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_KEY,
  ACTIONS,
  PRESETS,
  defaultSettings,
  normalizeSettings,
  loadSettings,
  saveSettings,
  presetBindings,
  actionForCode,
  actionDown,
  bindKey,
  clearBinding,
  readableKey,
  captureAllowed,
} from "../src/settings.js";

test("defaults retain WASD and arrows and define every playable action", () => {
  const settings = defaultSettings();
  assert.equal(settings.sidebarCollapsed, false);
  assert.equal(settings.mobileWallMode, "armed");
  assert.deepEqual(settings.bindings.moveUp, ["KeyW", "ArrowUp"]);
  assert.deepEqual(Object.keys(settings.bindings), Object.keys(ACTIONS));
  assert.deepEqual(Object.keys(PRESETS), ["wasd", "arrows", "left-hand"]);
});

test("settings save and load round trip independently under their versioned key", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const settings = {
    ...defaultSettings(),
    theme: "light",
    playView: true,
    sidebarCollapsed: true,
    mobileWallMode: "instant",
  };
  assert.equal(saveSettings(storage, settings), true);
  assert.equal(values.has(SETTINGS_KEY), true);
  assert.deepEqual(loadSettings(storage), settings);
});

test("invalid stored values normalize themes, booleans, actions, lengths, and duplicate codes", () => {
  const normalized = normalizeSettings({
    theme: "neon",
    playView: 1,
    preset: "nope",
    bindings: {
      moveUp: ["KeyQ", "KeyQ", 4, "KeyZ"],
      moveDown: ["KeyQ", "KeyX"],
    },
  });
  assert.equal(normalized.theme, "dark");
  assert.equal(normalized.playView, false);
  assert.equal(normalized.sidebarCollapsed, false);
  assert.equal(normalized.mobileWallMode, "armed");
  assert.equal(normalized.preset, "custom");
  assert.deepEqual(normalized.bindings.moveUp, ["KeyQ", "KeyZ"]);
  assert.deepEqual(normalized.bindings.moveDown, ["KeyX"]);
  assert.deepEqual(loadSettings({ getItem: () => "{bad" }), defaultSettings());
});

test("audio settings default to on, clamp levels, and never read old data as silence", () => {
  const defaults = defaultSettings();
  assert.equal(defaults.effectsOn, true);
  assert.equal(defaults.musicOn, true);
  assert.equal(defaults.effectsVolume, 0.3);
  assert.equal(defaults.musicVolume, 1);
  // Absent is what every settings blob written before the split looks like.
  const old = normalizeSettings({ theme: "light", preset: "arrows" });
  assert.equal(old.effectsOn, true);
  assert.equal(old.musicOn, true);
  assert.equal(old.effectsVolume, 0.3);
  assert.equal(old.musicVolume, 1);
  assert.equal(old.audioMigrated, false, "old data must still be waiting for the one-time fold");
  // Explicitly off stays off, and a zero level is a real setting, not absence.
  const quiet = normalizeSettings({ effectsOn: false, musicOn: false, effectsVolume: 0, musicVolume: 0 });
  assert.equal(quiet.effectsOn, false);
  assert.equal(quiet.musicOn, false);
  assert.equal(quiet.effectsVolume, 0);
  assert.equal(quiet.musicVolume, 0);
  const junk = normalizeSettings({ effectsVolume: "loud", musicVolume: 4, audioMigrated: true });
  assert.equal(junk.effectsVolume, 0.3, "an unreadable level falls back to the default");
  assert.equal(junk.musicVolume, 1, "levels above unity clamp to the ceiling");
  assert.equal(normalizeSettings({ musicVolume: -3 }).musicVolume, 0);
  assert.equal(junk.audioMigrated, true);
});

test("presets return independent bindings and resolve held actions", () => {
  const left = presetBindings("left-hand");
  assert.deepEqual(left.moveUp, ["KeyI"]);
  assert.equal(actionForCode(left, "KeyL"), "moveRight");
  assert.equal(actionDown(left, new Set(["KeyE"]), "focusHold"), true);
  assert.equal(actionDown(left, new Set(["KeyR"]), "boostHold"), true);
  assert.equal(actionForCode(left, "KeyF"), "shout");
  left.moveUp.push("KeyQ");
  assert.deepEqual(presetBindings("left-hand").moveUp, ["KeyI"]);
});

test("binding rejects conflicts, supports two slots, and clears the secondary", () => {
  const bindings = presetBindings();
  const conflict = bindKey(bindings, "smartPass", 0, "KeyW");
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /Move up/);
  const changed = bindKey(bindings, "focusHold", 1, "KeyG");
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.bindings.focusHold, ["KeyE", "KeyG"]);
  assert.deepEqual(clearBinding(changed.bindings, "focusHold", 1).focusHold, [
    "KeyE",
  ]);
});

test("capture filters browser keys and formats key codes for people", () => {
  assert.deepEqual(captureAllowed({ code: "Escape" }), {
    ok: false,
    cancel: true,
  });
  assert.equal(captureAllowed({ code: "Tab" }).ok, false);
  assert.equal(captureAllowed({ code: "KeyR", ctrlKey: true }).ok, false);
  assert.equal(captureAllowed({ code: "ShiftLeft", shiftKey: true }).ok, true);
  assert.equal(readableKey("ArrowLeft"), "←");
  assert.equal(readableKey("KeyP"), "P");
});
