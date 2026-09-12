export const SETTINGS_KEY = "tiki-taka.settings.v1";

// Kept in step with DEFAULT_EFFECTS_VOLUME in packages/presentation/src/audio.js.
// The engine does not import the presentation package, so the number is
// repeated here rather than crossing that boundary; both comments point at the
// other. Effects default well below unity because the per-effect constants are
// the ceiling and this is the trim (see that file for the measured levels).
// Music defaults to full because its own base gain is already the tuned level.
export const DEFAULT_AUDIO = {
  effectsOn: true,
  effectsVolume: 0.3,
  musicOn: true,
  musicVolume: 1,
};

export const ACTIONS = {
  moveUp: "Move up",
  moveDown: "Move down",
  moveLeft: "Move left",
  moveRight: "Move right",
  smartPass: "Smart pass",
  direct1: "Pass to player 1",
  direct2: "Pass to player 2",
  direct3: "Pass to player 3",
  direct4: "Pass to player 4",
  wallToggle: "Toggle wall pass",
  wallHold: "Hold wall pass",
  focusHold: "Hold Focus",
  boostHold: "Hold Boost",
  shout: "Shout target to bonus zone",
  pause: "Pause",
};

const passKeys = {
  smartPass: ["Space"],
  direct1: ["Digit1"],
  direct2: ["Digit2"],
  direct3: ["Digit3"],
  direct4: ["Digit4"],
  wallToggle: ["KeyB"],
  wallHold: ["ShiftLeft", "ShiftRight"],
  focusHold: ["KeyE"],
  boostHold: ["KeyR"],
  shout: ["KeyF"],
  pause: ["Escape"],
};

export const PRESETS = {
  wasd: {
    moveUp: ["KeyW", "ArrowUp"],
    moveDown: ["KeyS", "ArrowDown"],
    moveLeft: ["KeyA", "ArrowLeft"],
    moveRight: ["KeyD", "ArrowRight"],
    ...passKeys,
  },
  arrows: {
    moveUp: ["ArrowUp"],
    moveDown: ["ArrowDown"],
    moveLeft: ["ArrowLeft"],
    moveRight: ["ArrowRight"],
    ...passKeys,
  },
  "left-hand": {
    moveUp: ["KeyI"],
    moveDown: ["KeyK"],
    moveLeft: ["KeyJ"],
    moveRight: ["KeyL"],
    ...passKeys,
  },
};

const cloneBindings = (bindings) =>
  Object.fromEntries(
    Object.keys(ACTIONS).map((action) => [
      action,
      [...(bindings[action] || [])],
    ]),
  );

export function presetBindings(name = "wasd") {
  return cloneBindings(PRESETS[name] || PRESETS.wasd);
}

export const DEFAULT_GAMEPAD_BINDINGS = {
  smartPass: 0,
  wallToggle: 2,
  shout: 5,
  focusHold: 6,
  boostHold: 7,
};

export const GAMEPAD_BUTTON_LABELS = {
  0: "A / ✕ (Cross)",
  1: "B / ○ (Circle)",
  2: "X / □ (Square)",
  3: "Y / △ (Triangle)",
  4: "LB / L1 (Left Bumper)",
  5: "RB / R1 (Right Bumper)",
  6: "LT / L2 (Left Trigger)",
  7: "RT / R2 (Right Trigger)",
};

export const GAMEPAD_SHORT_LABELS = {
  0: "A",
  1: "B",
  2: "X",
  3: "Y",
  4: "LB",
  5: "RB",
  6: "LT",
  7: "RT",
};

export function defaultSettings() {
  return {
    theme: "dark",
    playView: false,
    sidebarCollapsed: false,
    mobileWallMode: "armed",
    ...DEFAULT_AUDIO,
    // Cleared once the shell has folded a pre-split `progress.sound` into the
    // four fields above; see apps/desktop/src/main.js.
    audioMigrated: false,
    preset: "wasd",
    bindings: presetBindings(),
    gamepadBindings: { ...DEFAULT_GAMEPAD_BINDINGS },
  };
}

// Old stored settings have none of the audio fields. Absent must mean "on" and
// "the default level", never 0 or false, so a returning player is not silenced
// by an upgrade.
function normalizeVolume(value, fallback) {
  const volume = Number(value);
  if (!Number.isFinite(volume)) return fallback;
  return Math.min(1, Math.max(0, volume));
}

function normalizeGamepadButton(value, fallback) {
  const num = Number(value);
  if (Number.isInteger(num) && num >= 0 && num <= 7) return num;
  return fallback;
}

export function normalizeSettings(value) {
  const defaults = defaultSettings();
  if (!value || typeof value !== "object") return defaults;
  const bindings = {};
  const claimed = new Set();
  for (const action of Object.keys(ACTIONS)) {
    const source = Array.isArray(value.bindings?.[action])
      ? value.bindings[action]
      : defaults.bindings[action];
    bindings[action] = [];
    for (const code of source) {
      if (typeof code !== "string" || !code || claimed.has(code)) continue;
      bindings[action].push(code);
      claimed.add(code);
      if (bindings[action].length === 2) break;
    }
  }
  return {
    theme: "dark",
    playView: value.playView === true,
    sidebarCollapsed: value.sidebarCollapsed === true,
    mobileWallMode: value.mobileWallMode === "instant" ? "instant" : "armed",
    effectsOn: value.effectsOn !== false,
    effectsVolume: normalizeVolume(value.effectsVolume, DEFAULT_AUDIO.effectsVolume),
    musicOn: value.musicOn !== false,
    musicVolume: normalizeVolume(value.musicVolume, DEFAULT_AUDIO.musicVolume),
    audioMigrated: value.audioMigrated === true,
    preset: Object.hasOwn(PRESETS, value.preset) ? value.preset : "custom",
    bindings,
    gamepadBindings: {
      smartPass: normalizeGamepadButton(
        value.gamepadBindings?.smartPass,
        DEFAULT_GAMEPAD_BINDINGS.smartPass,
      ),
      wallToggle: normalizeGamepadButton(
        value.gamepadBindings?.wallToggle,
        DEFAULT_GAMEPAD_BINDINGS.wallToggle,
      ),
      shout: normalizeGamepadButton(
        value.gamepadBindings?.shout,
        DEFAULT_GAMEPAD_BINDINGS.shout,
      ),
      focusHold: normalizeGamepadButton(
        value.gamepadBindings?.focusHold,
        DEFAULT_GAMEPAD_BINDINGS.focusHold,
      ),
      boostHold: normalizeGamepadButton(
        value.gamepadBindings?.boostHold,
        DEFAULT_GAMEPAD_BINDINGS.boostHold,
      ),
    },
  };
}

export function loadSettings(storage) {
  try {
    return normalizeSettings(JSON.parse(storage.getItem(SETTINGS_KEY)));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(storage, settings) {
  try {
    storage.setItem(SETTINGS_KEY, JSON.stringify(normalizeSettings(settings)));
    return true;
  } catch {
    return false;
  }
}

export function actionForCode(bindings, code) {
  return (
    Object.keys(ACTIONS).find((action) => bindings[action]?.includes(code)) ||
    null
  );
}

export function actionDown(bindings, pressed, action) {
  return (bindings[action] || []).some((code) => pressed.has(code));
}

export function bindKey(bindings, action, slot, code) {
  if (!Object.hasOwn(ACTIONS, action) || ![0, 1].includes(slot))
    return { ok: false, reason: "Invalid binding." };
  const conflict = actionForCode(bindings, code);
  if (conflict && conflict !== action)
    return {
      ok: false,
      reason: `${readableKey(code)} is already assigned to ${ACTIONS[conflict]}.`,
    };
  const next = cloneBindings(bindings);
  next[action] = next[action].filter((key) => key !== code);
  if (slot < next[action].length) next[action][slot] = code;
  else next[action].push(code);
  next[action] = next[action].filter(Boolean).slice(0, 2);
  return { ok: true, bindings: next };
}

export function clearBinding(bindings, action, slot) {
  const next = cloneBindings(bindings);
  if (slot >= 0 && slot < next[action].length) next[action].splice(slot, 1);
  return next;
}

export function readableKey(code) {
  const names = {
    Space: "Space",
    Escape: "Esc",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    ShiftLeft: "L Shift",
    ShiftRight: "R Shift",
  };
  if (names[code]) return names[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code.replace(/(Left|Right)$/, " $1");
}

export function captureAllowed(event) {
  if (event.code === "Escape") return { ok: false, cancel: true };
  if (
    event.code === "Tab" ||
    event.metaKey ||
    event.ctrlKey ||
    /^F([1-9]|1[0-2])$/.test(event.code)
  )
    return { ok: false, reason: "That key is reserved by the browser." };
  return { ok: true };
}
