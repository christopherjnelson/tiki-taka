export const SETTINGS_KEY = "tiki-taka.settings.v1";

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

export function defaultSettings() {
  return {
    theme: "dark",
    playView: false,
    sidebarCollapsed: false,
    mobileWallMode: "armed",
    preset: "wasd",
    bindings: presetBindings(),
  };
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
    theme: value.theme === "light" ? "light" : "dark",
    playView: value.playView === true,
    sidebarCollapsed: value.sidebarCollapsed === true,
    mobileWallMode: value.mobileWallMode === "instant" ? "instant" : "armed",
    preset: Object.hasOwn(PRESETS, value.preset) ? value.preset : "custom",
    bindings,
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
