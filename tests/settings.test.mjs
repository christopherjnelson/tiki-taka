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

test("presets return independent bindings and resolve held actions", () => {
  const left = presetBindings("left-hand");
  assert.deepEqual(left.moveUp, ["KeyI"]);
  assert.equal(actionForCode(left, "KeyL"), "moveRight");
  assert.equal(actionDown(left, new Set(["KeyE"]), "focusHold"), true);
  left.moveUp.push("KeyQ");
  assert.deepEqual(presetBindings("left-hand").moveUp, ["KeyI"]);
});

test("binding rejects conflicts, supports two slots, and clears the secondary", () => {
  const bindings = presetBindings();
  const conflict = bindKey(bindings, "smartPass", 0, "KeyW");
  assert.equal(conflict.ok, false);
  assert.match(conflict.reason, /Move up/);
  const changed = bindKey(bindings, "focusHold", 1, "KeyF");
  assert.equal(changed.ok, true);
  assert.deepEqual(changed.bindings.focusHold, ["KeyE", "KeyF"]);
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
