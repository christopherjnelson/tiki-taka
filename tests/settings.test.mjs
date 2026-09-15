import test from "node:test";
import assert from "node:assert/strict";
import {
  SETTINGS_KEY,
  ACTIONS,
  PRESETS,
  DEFAULT_GAMEPAD_BINDINGS,
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
  assert.deepEqual(settings.bindings.moveUp, ["KeyW", "ArrowUp"]);
  assert.deepEqual(Object.keys(settings.bindings), Object.keys(ACTIONS));
  assert.deepEqual(Object.keys(PRESETS), ["wasd", "arrows", "left-hand"]);
  assert.equal(settings.gamepadBindings.shout, 5, "default shout button should be RB/R1 (button 5)");
  assert.equal(settings.gamepadBindings.smartPass, 0);
  assert.equal(settings.gamepadBindings.wallToggle, 2);
  assert.equal(settings.gamepadBindings.focusHold, 6);
  assert.equal(settings.gamepadBindings.boostHold, 7);
  assert.equal(settings.gamepadBindings.skipTrack, 8, "default skip-track button should be Select/View (button 8)");
  assert.deepEqual(settings.bindings.skipTrack, ["KeyN"]);
});

test("settings save and load round trip independently under their versioned key", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const settings = {
    ...defaultSettings(),
    playView: true,
    sidebarCollapsed: true,
  };
  assert.equal(saveSettings(storage, settings), true);
  assert.equal(values.has(SETTINGS_KEY), true);
  assert.deepEqual(loadSettings(storage), settings);
});

test("invalid or legacy stored values normalize themes, booleans, actions, lengths, and duplicate codes", () => {
  const normalized = normalizeSettings({
    theme: "light",
    playView: 1,
    preset: "nope",
    bindings: {
      moveUp: ["KeyQ", "KeyQ", 4, "KeyZ"],
      moveDown: ["KeyQ", "KeyX"],
    },
    // A retired setting key (mobileWallMode, removed once nothing read it)
    // left over in a player's saved blob. Unknown keys must be dropped
    // silently, the way junk always has been, never break normalization.
    mobileWallMode: "instant",
  });
  assert.equal(normalized.theme, "dark");
  assert.equal(normalized.playView, false);
  assert.equal(normalized.sidebarCollapsed, false);
  assert.equal("mobileWallMode" in normalized, false);
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

test("Focus slowdown and ability mode default to today's behaviour and survive junk", () => {
  const defaults = defaultSettings();
  assert.equal(defaults.focusSlowdownOn, true);
  assert.equal(defaults.abilityMode, "toggle");
  // Absent is what every settings blob written before this pair existed
  // looks like: it must mean today's behaviour, not the new alternative.
  const old = normalizeSettings({ theme: "light", preset: "arrows" });
  assert.equal(old.focusSlowdownOn, true);
  assert.equal(old.abilityMode, "toggle", "an absent value must mean the tap-to-latch touch players already have");
  // Explicit opt-outs stick.
  const off = normalizeSettings({ focusSlowdownOn: false, abilityMode: "hold" });
  assert.equal(off.focusSlowdownOn, false);
  assert.equal(off.abilityMode, "hold");
  // Junk falls back to today's behaviour, never the new alternative.
  const junk = normalizeSettings({ focusSlowdownOn: "nah", abilityMode: "latched" });
  assert.equal(junk.focusSlowdownOn, true);
  assert.equal(junk.abilityMode, "toggle");
});

test("skip track binds KeyN and gamepad button 8 by default, and junk falls back", () => {
  const defaults = defaultSettings();
  assert.deepEqual(defaults.bindings.skipTrack, ["KeyN"]);
  assert.equal(defaults.gamepadBindings.skipTrack, 8);
  // Absent (every settings blob written before this action existed) must
  // mean the same default, not an unbound action.
  const old = normalizeSettings({ theme: "light", preset: "arrows" });
  assert.deepEqual(old.bindings.skipTrack, ["KeyN"]);
  assert.equal(old.gamepadBindings.skipTrack, 8);
  // An explicit rebind sticks, including to the newly-valid button 8.
  const rebound = normalizeSettings({
    bindings: { skipTrack: ["KeyM"] },
    gamepadBindings: { skipTrack: 3 },
  });
  assert.deepEqual(rebound.bindings.skipTrack, ["KeyM"]);
  assert.equal(rebound.gamepadBindings.skipTrack, 3);
  // Junk normalizes to the defaults, never to an out-of-range button.
  const junk = normalizeSettings({
    bindings: { skipTrack: [4, "", null] },
    gamepadBindings: { smartPass: 8, skipTrack: 99 },
  });
  assert.deepEqual(junk.bindings.skipTrack, []);
  assert.equal(junk.gamepadBindings.smartPass, 0, "button 8 is only valid for skip track");
  assert.equal(junk.gamepadBindings.skipTrack, 8, "an out-of-range button must fall back to the default");
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
