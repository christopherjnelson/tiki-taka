import {
  WIDTH,
  HEIGHT,
  PLAYER_RADIUS,
  ZONE_LIFETIME,
  ZONE_POINTS,
  bankPoint,
  segmentDistance,
} from "../../engine/src/game.js";
import { getVenue } from "../../engine/src/venues.js";
import { BONUS_GOLD } from "./palette.js";

const FONT = '"Tiki Signage","Arial Narrow","Arial Black",sans-serif';
// Badge popups (score, focus, one-touch) can land on the same pass at nearly
// the same spot. Newcomers are lifted a row at a time so every reward stays
// readable instead of hiding the one before it.
const BADGE_STACK_STEP = 34,
  BADGE_STACK_MAX = 4 * BADGE_STACK_STEP,
  BADGE_STACK_SPREAD = 170;
const isStackedBadge = (e) =>
  e &&
  (e.type === "score" ||
    e.type === "focus" ||
    (e.type === "one-touch" && !e.milestone));
const badgeAnchorY = (e) =>
  (Number.isFinite(e.y) ? e.y : 310) +
  (e.type === "one-touch" ? -54 : e.type === "focus" ? 11 : -16) -
  (e.stackOffset || 0);
function stackOffsetFor(effects, e) {
  if (!isStackedBadge(e)) return 0;
  const live = effects.filter((o) => isStackedBadge(o) && o.age < o.life);
  if (!live.length) return 0;
  const x = Number.isFinite(e.x) ? e.x : 500;
  for (let offset = 0; offset <= BADGE_STACK_MAX; offset += BADGE_STACK_STEP) {
    const y = badgeAnchorY({ ...e, stackOffset: offset });
    if (
      !live.some(
        (o) =>
          Math.abs((Number.isFinite(o.x) ? o.x : 500) - x) <
            BADGE_STACK_SPREAD &&
          Math.abs(badgeAnchorY(o) - y) < BADGE_STACK_STEP,
      )
    )
      return offset;
  }
  return 0;
}
function getScoreEventColor(e) {
  if (!e) return "#ffffff";
  const bonuses = e.bonuses || [];
  const best = e.bestBonus || "";
  const text = e.text || "";
  if (
    bonuses.includes("triangle") ||
    bonuses.includes("zone") ||
    bonuses.includes("split") ||
    bonuses.includes("ole") ||
    best === "triangle" ||
    best === "zone" ||
    best === "split" ||
    best === "ole" ||
    /TRIANGLE|ZONE|SPLIT|OL[EÉ]/i.test(text)
  ) {
    return BONUS_GOLD;
  }
  if (bonuses.includes("wall") || best === "wall" || /WALL/i.test(text)) {
    return "#38f5e5";
  }
  if (
    bonuses.includes("one-touch") ||
    best === "one-touch" ||
    /ONE TOUCH|ONE-TOUCH/i.test(text)
  ) {
    return "#ff589f";
  }
  return "#ffffff";
}
const circle = (c, x, y, r) => {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
};
const rounded = (c, x, y, w, h, r) => {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
};
function label(
  c,
  text,
  x,
  y,
  size = 12,
  color = "#fff",
  align = "center",
  weight = 700,
  spacing = 0,
) {
  if (c._tikiPortrait) {
    c.save();
    c.translate(x, y);
    c.rotate(-Math.PI / 2);
    c._tikiPortrait = false;
    label(c, text, 0, 0, size, color, align, weight, spacing);
    c.restore();
    c._tikiPortrait = true;
    return;
  }
  c.font = `${weight} ${size}px ${FONT}`;
  c.textBaseline = "middle";
  c.fillStyle = color;
  if (!spacing) {
    c.textAlign = align;
    c.fillText(text, x, y);
    return;
  }
  // Letter-spaced signage: measured and hand-walked, since canvas text has no
  // native tracking control.
  c.textAlign = "left";
  const chars = [...text];
  const width = chars.reduce(
    (sum, ch) => sum + c.measureText(ch).width + spacing,
    -spacing,
  );
  let cursor = align === "center" ? x - width / 2 : align === "right" ? x - width : x;
  for (const ch of chars) {
    c.fillText(ch, cursor, y);
    cursor += c.measureText(ch).width + spacing;
  }
}
// Fits a watermark to the short axis (portrait's 620 design units against
// landscape's 1000) so it steps down instead of cropping.
function fittedSize(c, text, max, start, weight = 900) {
  let size = start;
  c.font = `${weight} ${size}px ${FONT}`;
  while (c.measureText(text).width > max && size > 10) {
    size -= 2;
    c.font = `${weight} ${size}px ${FONT}`;
  }
  return size;
}
const withAlpha = (hex, alpha) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
};
// Signage sits on a plate over the hoarding, the way a real pitch-side board
// does, so the border motif behind it never fights the lettering.
function signPlate(c, cx, cy, width, height, tint) {
  c.fillStyle = "rgba(7,12,26,.86)";
  rounded(c, cx - width / 2, cy - height / 2, width, height, height * 0.28);
  c.fill();
  c.strokeStyle = withAlpha(tint, 0.5);
  c.lineWidth = 1;
  c.stroke();
}
const THEMES = {
  dark: {
    void: "#090b20",
    pitch: "#102c38",
    pitch2: "#14233d",
    line: "#b8fff5",
    muted: "#88b9bd",
  },
};
// Venue identity without on-pitch pattern: a surround colour, a quiet surface
// colour, and how warm the light pooling at centre circle is. Same court, six
// moods - the border band (BORDERS below) carries the rest of the character.
const VENUE_LOOK = {
  lisbon: { surround: ["#2b1240", "#5c2242"], surface: ["#123049", "#0d2036"], light: "#ff9b62", wash: 0.16 },
  london: { surround: ["#1b2030", "#2b3040"], surface: ["#1d2b33", "#131d26"], light: "#cfe6ff", wash: 0.07 },
  barcelona: { surround: ["#6d3327", "#93513a"], surface: ["#123a3a", "#0c2a2c"], light: "#ffcc82", wash: 0.13 },
  tokyo: { surround: ["#0d0726", "#241148"], surface: ["#141338", "#0c0b24"], light: "#38f5e5", wash: 0.15 },
  "sao-paulo": { surround: ["#0c2a27", "#16453c"], surface: ["#0f3327", "#0a2419"], light: "#9bff8a", wash: 0.12 },
  amsterdam: { surround: ["#0b1f4c", "#123468"], surface: ["#0f2b52", "#0a1d3a"], light: "#8fd9ff", wash: 0.1 },
  // Endless's court. Ink and jade rather than neon, and the quietest wash of
  // the lot: nothing here should feel like a stadium.
  "still-water": { surround: ["#0d1518", "#16262a"], surface: ["#122024", "#0a1418"], light: "#d9f5ec", wash: 0.09 },
};
// The pitch inset the engine's LIMITS agree on (packages/engine/src/game.js:
// LIMITS = { left: 50, right: 950, top: 50, bottom: 570 }) - 50 in, on all
// four sides, in whichever design space (1000x620 landscape, 620x1000
// portrait) paintArena is currently painting.
const PITCH_MARGIN = 50;
// ---------------------------------------------------------------------------
// Border motifs. Venue character lives here: the band between the outer edge
// and the touchline, where it can be as loud as it likes because nobody plays
// on it. Each strip is drawn once per edge through a mitred transform, so the
// same motif wraps all four sides and the court is identical turned 90
// degrees - no venue owns a "top" any more, so a future venue is one function
// here, not a landscape and a portrait variant.
//
// Every strip draws in local coordinates: x runs 0..length ALONG the edge, y
// runs 0..depth INWARD from the outer edge.
// ---------------------------------------------------------------------------
function borderBand(c, w, h, depth, strip, venue) {
  const edges = [
    [0, 0, 0, w],
    [w, 0, Math.PI / 2, h],
    [w, h, Math.PI, w],
    [0, h, -Math.PI / 2, h],
  ];
  for (const [x, y, angle, length] of edges) {
    c.save();
    c.translate(x, y);
    c.rotate(angle);
    // Mitre the corners so neighbouring edges meet on the diagonal instead of
    // double-drawing the motif where they overlap.
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(length, 0);
    c.lineTo(length - depth, depth);
    c.lineTo(depth, depth);
    c.closePath();
    c.clip();
    strip(c, length, depth, venue);
    c.restore();
  }
}
const BORDERS = {
  // Azulejo coast: rooftops against a warm sky, rising inward from the edge.
  lisbon(c, L, D, v) {
    const sky = c.createLinearGradient(0, 0, 0, D);
    sky.addColorStop(0, "#ec4388");
    sky.addColorStop(1, withAlpha("#ff9b62", 0));
    c.fillStyle = sky;
    c.fillRect(0, 0, L, D);
    const step = D * 0.62;
    for (let x = 0; x < L; x += step) {
      const tall = D * (0.42 + ((x / step) % 3) * 0.12);
      c.fillStyle = "#152b5a";
      c.fillRect(x + 2, D - tall, step - 4, tall);
      c.fillStyle = withAlpha(v.accent, 0.45);
      c.fillRect(x + step * 0.28, D - tall + step * 0.16, step * 0.2, step * 0.2);
    }
  },
  // Warehouse five-a-side: a steel truss with its rivets.
  london(c, L, D, v) {
    c.fillStyle = "#121827";
    c.fillRect(0, 0, L, D);
    c.strokeStyle = withAlpha(v.accent, 0.5);
    c.lineWidth = Math.max(1.5, D * 0.055);
    const step = D * 0.9;
    c.beginPath();
    for (let x = 0; x <= L; x += step) {
      c.moveTo(x, D * 0.18);
      c.lineTo(x + step / 2, D * 0.82);
      c.lineTo(x + step, D * 0.18);
    }
    c.stroke();
    c.beginPath();
    c.moveTo(0, D * 0.18);
    c.lineTo(L, D * 0.18);
    c.stroke();
    c.fillStyle = BONUS_GOLD;
    for (let x = step / 2; x < L; x += step * 2) c.fillRect(x - D * 0.06, D * 0.12, D * 0.12, D * 0.12);
  },
  // Mosaic courtyard: the best pattern in the game, moved off the pitch and
  // kept at full strength where it cannot hide a ball.
  barcelona(c, L, D, v) {
    c.fillStyle = "#8a4632";
    c.fillRect(0, 0, L, D);
    const step = D * 0.5;
    for (let x = 0; x < L + step; x += step)
      for (let y = 0; y < D + step; y += step) {
        c.fillStyle = withAlpha((x + y) % (step * 2) ? v.secondary : v.accent, 0.5);
        c.beginPath();
        c.moveTo(x + 1, y + step / 2);
        c.lineTo(x + step / 2, y + 1);
        c.lineTo(x + step - 1, y + step / 2);
        c.lineTo(x + step / 2, y + step - 1);
        c.fill();
      }
  },
  // Electric midnight: lit signage boxes, glow and all.
  tokyo(c, L, D, v) {
    c.fillStyle = "#0b0722";
    c.fillRect(0, 0, L, D);
    const step = D * 1.5;
    for (let x = D * 0.3, i = 0; x < L - D * 0.3; x += step, i++) {
      const hot = i % 2 === 0;
      c.fillStyle = withAlpha(hot ? v.secondary : v.accent, 0.72);
      c.shadowColor = withAlpha(hot ? v.secondary : v.accent, 0.8);
      c.shadowBlur = D * 0.35;
      c.fillRect(x, D * 0.24, step * 0.62, D * 0.5);
      c.shadowBlur = 0;
      c.fillStyle = "rgba(9,7,26,.75)";
      c.fillRect(x + step * 0.1, D * 0.38, step * 0.42, D * 0.2);
    }
  },
  // Jungle cage: chain-link, which is what makes this venue itself.
  "sao-paulo"(c, L, D, v) {
    c.fillStyle = "#0b2320";
    c.fillRect(0, 0, L, D);
    const step = D * 0.38;
    c.strokeStyle = withAlpha("#9bff8a", 0.5);
    c.lineWidth = Math.max(1, D * 0.028);
    c.beginPath();
    for (let x = -D; x < L + D; x += step) {
      c.moveTo(x, 0);
      c.lineTo(x + D, D);
      c.moveTo(x, D);
      c.lineTo(x + D, 0);
    }
    c.stroke();
    c.strokeStyle = withAlpha(v.accent, 0.85);
    c.lineWidth = Math.max(1.5, D * 0.05);
    c.beginPath();
    c.moveTo(0, D * 0.07);
    c.lineTo(L, D * 0.07);
    c.stroke();
    c.fillStyle = withAlpha("#79ff55", 0.32);
    for (let x = step; x < L; x += step * 6) {
      circle(c, x, D * 0.2, D * 0.26);
      c.fill();
    }
  },
  // Canal geometry: the gable line of a canal house, repeated.
  // Still Water: raked sand around a quiet pool. Parallel ripples run the
  // length of every edge and bend around a few sunk stones, the way a raked
  // garden bends around what it is raked around. No crowd, no signage, no
  // skyline - the only venue whose border has nothing in it that could cheer.
  "still-water"(c, L, D, v) {
    c.fillStyle = "#0b1316";
    c.fillRect(0, 0, L, D);
    const stones = [];
    for (let x = D * 1.4; x < L; x += D * 3.1)
      stones.push({ x, y: D * 0.52, r: D * 0.2 });
    const lines = 7;
    c.lineWidth = Math.max(1, D * 0.022);
    for (let i = 0; i < lines; i++) {
      const base = D * (0.12 + (i / (lines - 1)) * 0.76);
      // Ripples closest to the pool are the brightest, so the band reads as
      // sand drawn toward water rather than as flat stripes.
      c.strokeStyle = withAlpha(v.accent, 0.1 + (i / lines) * 0.22);
      c.beginPath();
      for (let x = 0; x <= L; x += 6) {
        // Each stone pushes the ripple outward, falling off with distance.
        let y = base;
        for (const stone of stones) {
          const d = Math.abs(x - stone.x);
          if (d < stone.r * 4.2)
            y += (1 - d / (stone.r * 4.2)) * (base < stone.y ? -1 : 1) * stone.r * 0.85;
        }
        if (x === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();
    }
    for (const stone of stones) {
      c.beginPath();
      c.arc(stone.x, stone.y, stone.r, 0, Math.PI * 2);
      c.fillStyle = withAlpha(v.secondary, 0.34);
      c.fill();
      c.strokeStyle = withAlpha(v.accent, 0.3);
      c.lineWidth = Math.max(1, D * 0.018);
      c.stroke();
    }
  },
  amsterdam(c, L, D, v) {
    c.fillStyle = "#0a1b40";
    c.fillRect(0, 0, L, D);
    const step = D * 1.1;
    c.strokeStyle = withAlpha(v.accent, 0.55);
    c.lineWidth = Math.max(1.5, D * 0.05);
    c.beginPath();
    for (let x = 0; x < L + step; x += step) {
      c.moveTo(x, D);
      c.lineTo(x, D * 0.46);
      c.lineTo(x + step / 2, D * 0.14);
      c.lineTo(x + step, D * 0.46);
      c.lineTo(x + step, D);
    }
    c.stroke();
    c.fillStyle = withAlpha(v.secondary, 0.6);
    for (let x = step / 2; x < L; x += step) c.fillRect(x - D * 0.07, D * 0.58, D * 0.14, D * 0.22);
  },
};
// A native-DPR court bitmap is large (and can be very large on a 4K display).
// Keeping the current theme plus one recently used variant makes theme/venue
// transitions instant without retaining a full-resolution bitmap for every
// court a player has visited.
const MAX_BACKGROUND_CACHE_ENTRIES = 2;

export class Renderer {
  // maxDpr caps the backing-store resolution. The arena wants the default 2
  // for a sharp court; the home attract demo passes 1, which quarters the
  // pixels it paints every frame - it is a small decorative card, and on weak
  // hardware its cost otherwise competes with the game itself.
  constructor(canvas, { maxDpr = 2 } = {}) {
    this.canvas = canvas;
    this.maxDpr = maxDpr;
    this.ctx = canvas.getContext("2d");
    this.effects = [];
    this.lastTime = 0;
    this.clock = 0;
    this.backgrounds = new Map();
    this.orientation = "landscape";
    // Reading layout and resetting the canvas transform on every animation
    // frame needlessly makes the game canvas a layout dependency. The canvas
    // only needs either operation when its CSS box, orientation or DPR has
    // changed. ResizeObserver also catches panel-size changes that do not
    // come from a window resize (for example a desktop shell reflow).
    this.resizeNeeded = true;
    this.dpr = 0;
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => {
        this.resizeNeeded = true;
      });
      this.resizeObserver.observe(canvas);
    }
    this.reducedMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof document !== "undefined" && document.fonts?.ready)
      document.fonts.ready.then(() => this.backgrounds.clear());
  }
  themeName() {
    return "dark";
  }
  courtPreview(venue, width = 500, height = 310) {
    if (typeof document === "undefined") return "";
    if (!this.previewCache) this.previewCache = new Map();
    const v = typeof venue === "string" ? getVenue({ venue }) : getVenue(venue);
    const key = `${v.id}:${width}:${height}`;
    if (this.previewCache.has(key)) return this.previewCache.get(key);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(width / WIDTH, 0, 0, height / HEIGHT, 0, 0);
    this.paintArena(ctx, v, THEMES.dark);
    const dataUrl = canvas.toDataURL("image/png");
    this.previewCache.set(key, dataUrl);
    return dataUrl;
  }
  // The pitch, lines and stadium art used to be painted once into a 1000x620
  // bitmap and stretched onto the live canvas by drawImage every frame. That
  // stretch is a non-integer scale in any real window (1.67x at 1920x1080),
  // so every line and edge in it was soft no matter how crisp the live canvas
  // itself was. Baking it at the canvas's own backing-store resolution
  // instead — same design-space drawing code, just run through a matching
  // scale transform onto a bigger bitmap — makes it native-sharp. The cache
  // holds the current venue/theme plus one recent variant; a resize
  // repaints that entry in place rather than growing the map with every
  // intermediate size. The transform
  // mirrors resize() exactly, rotation included, so a portrait canvas gets a
  // background baked already rotated — it is blitted back with no transform
  // at all, so the rotation has to already be in the pixels.
  backgroundFor(v, t, w, h, portrait) {
    const key = `${v.id}:${t}:${portrait ? "p" : "l"}`;
    const cached = this.backgrounds.get(key);
    if (cached && cached.w === w && cached.h === h) {
      // Refresh insertion order so the cap below behaves as a tiny LRU cache.
      this.backgrounds.delete(key);
      this.backgrounds.set(key, cached);
      return cached.canvas;
    }
    if (!cached && this.backgrounds.size >= MAX_BACKGROUND_CACHE_ENTRIES) {
      const oldestKey = this.backgrounds.keys().next().value;
      this.backgrounds.delete(oldestKey);
    }
    const el = cached ? cached.canvas : document.createElement("canvas");
    el.width = w;
    el.height = h;
    const context = el.getContext("2d");
    // Paint in the orientation's OWN visual dimensions - landscape stays
    // 1000x620, portrait becomes 620x1000 - through a scale-only transform.
    // No rotation: paintArena keys its markings off the long axis, so the
    // halfway line lands correctly either way with no per-orientation
    // special case, and anything drawn in that space (including screen-space
    // signage) is already upright on screen once this transform is applied.
    // The pitch inset (PITCH_MARGIN, 50 units, matching the engine's LIMITS)
    // is the same in both spaces, so it maps onto exactly the physical
    // rectangle the old rotated bake produced - the live player layer still
    // draws in rotated 1000x620 design space against that same rectangle.
    const dw = portrait ? HEIGHT : WIDTH,
      dh = portrait ? WIDTH : HEIGHT;
    context.setTransform(w / dw, 0, 0, h / dh, 0, 0);
    this.paintArena(context, v, THEMES[t] || THEMES.dark, dw, dh);
    this.backgrounds.set(key, { canvas: el, w, h });
    return el;
  }
  // Rounds a design-space stroke width so it lands on a whole number of
  // device pixels once the current transform scales it, instead of the
  // fractional width (e.g. 2px -> 3.34px at 1.67x) that anti-aliases into a
  // soft edge. Uses whatever context is passed in, so it works the same for
  // the cached background pass and the live per-frame draw.
  crisp(c, px) {
    const scale = c.getTransform().a || 1;
    return Math.max(1, Math.round(px * scale)) / scale;
  }
  // Paints in VISUAL space: W x H as the player will actually see it, not a
  // fixed 1000x620 that gets rotated for portrait. Markings key off the long
  // axis, so the halfway line is correct either way with no per-orientation
  // branch beyond "which axis is longer". The surface stays quiet - venue
  // identity is carried by colour, light and the border band (drawArchitecture
  // + drawPitchPattern below), not by pattern under the players' feet.
  paintArena(c, v, p = THEMES.dark, W = WIDTH, H = HEIGHT) {
    const look = VENUE_LOOK[v.id] || VENUE_LOOK.london,
      short = Math.min(W, H),
      horizontal = W >= H,
      margin = PITCH_MARGIN,
      px = margin,
      py = margin,
      pw = W - margin * 2,
      ph = H - margin * 2;
    c.save();
    c.clearRect(0, 0, W, H);
    // The surround (everything outside the touchline) and its border motif -
    // this is where venue colour and character live now.
    this.drawArchitecture(c, v, W, H);
    // Quiet playing surface: flat, dark, slightly cooler than the surround so
    // the touchline reads without needing a hard edge.
    c.save();
    rounded(c, px, py, pw, ph, 16);
    c.clip();
    const turf = c.createLinearGradient(px, py, px + pw, py + ph);
    turf.addColorStop(0, look.surface[0]);
    turf.addColorStop(1, look.surface[1]);
    c.fillStyle = turf;
    c.fillRect(px, py, pw, ph);
    // One soft pool of light from the centre plus corner shading - the only
    // things on the surface itself.
    this.drawPitchPattern(c, v, W, H);
    // Watermark: upright in both orientations, fitted to the short axis so
    // portrait (620 units wide) never crops it, and kept faint enough to sit
    // under play.
    const name = v.name.toUpperCase(),
      wmSize = fittedSize(c, name, pw * 0.8, Math.round(short * 0.115));
    label(c, name, W / 2, H / 2, wmSize, "rgba(255,255,255,.055)", "center", 900);
    // Markings. The halfway line always crosses the short dimension at the
    // midpoint of the long one, so orientation is handled by the geometry
    // rather than a branch per venue.
    c.globalAlpha = 0.74;
    c.strokeStyle = p.line;
    c.lineWidth = this.crisp(c, 2);
    c.beginPath();
    if (horizontal) {
      c.moveTo(W / 2, py);
      c.lineTo(W / 2, py + ph);
    } else {
      c.moveTo(px, H / 2);
      c.lineTo(px + pw, H / 2);
    }
    c.stroke();
    circle(c, W / 2, H / 2, 92);
    c.stroke();
    circle(c, W / 2, H / 2, 3);
    c.fillStyle = p.line;
    c.fill();
    for (const [x, y, a] of [
      [px, py, 0],
      [px + pw, py, Math.PI / 2],
      [px + pw, py + ph, Math.PI],
      [px, py + ph, -Math.PI / 2],
    ]) {
      c.beginPath();
      c.arc(x, y, short * 0.036, a, a + Math.PI / 2);
      c.stroke();
    }
    c.restore();
    c.globalAlpha = 1;
    // Touchline and one accent rail outside it - the same frame on all four
    // sides, so it cannot pick a top.
    c.shadowColor = "rgba(0,0,0,.65)";
    c.shadowBlur = 10;
    rounded(c, px, py, pw, ph, 16);
    c.strokeStyle = p.line;
    c.lineWidth = this.crisp(c, 3);
    c.stroke();
    c.shadowBlur = 0;
    c.globalAlpha = 0.72;
    c.strokeStyle = v.accent;
    c.lineWidth = this.crisp(c, 2);
    rounded(c, px - 7, py - 7, pw + 14, ph + 14, 21);
    c.stroke();
    c.globalAlpha = 1;
    // Signage in SCREEN space: always along the visual top and bottom,
    // upright, whichever way the court is turned - never rotated with the
    // pitch. Each sits on a plate over the hoarding, centred and sized to its
    // own text, so the border motif behind it never fights the lettering.
    const topText = `${name}  /  ${v.vibe.toUpperCase()}`,
      topSize = Math.max(10, Math.round(short * 0.019));
    c.font = `600 ${topSize}px ${FONT}`;
    signPlate(c, W / 2, margin / 2, c.measureText(topText).width + short * 0.09, margin * 0.66, v.accent);
    label(c, topText, W / 2, margin / 2, topSize, v.accent, "center", 600, 1.5);
    // The hoarding names the competition, which is the COURT's, not the
    // mode's: Still Water is not on the tour, so it says so in the home
    // preview and in a live run alike.
    const footText = v.competition || "TIKI TAKA WORLD TOUR",
      footSize = Math.max(9, Math.round(short * 0.017));
    c.font = `500 ${footSize}px ${FONT}`;
    signPlate(c, W / 2, H - margin / 2, c.measureText(footText).width + short * 0.1, margin * 0.6, p.muted);
    label(c, footText, W / 2, H - margin / 2, footSize, p.muted, "center", 500, 2);
    const markSize = Math.max(9, short * 0.017);
    c.font = `800 ${markSize}px ${FONT}`;
    signPlate(c, margin * 0.95, margin / 2, c.measureText("TT 98").width + short * 0.03, margin * 0.6, v.secondary);
    label(c, "TT 98", margin * 0.95, margin / 2, markSize, v.secondary, "center", 800);
    c.restore();
  }
  // Surround: the world outside the touchline, plus the venue's own motif
  // wrapped around all four sides via borderBand - one strip function per
  // venue, mitred at the corners, no landscape/portrait variant needed.
  drawArchitecture(c, v, W, H) {
    const look = VENUE_LOOK[v.id] || VENUE_LOOK.london,
      surround = c.createLinearGradient(0, 0, W, H);
    surround.addColorStop(0, look.surround[0]);
    surround.addColorStop(1, look.surround[1]);
    c.fillStyle = surround;
    c.fillRect(0, 0, W, H);
    borderBand(c, W, H, PITCH_MARGIN, BORDERS[v.id] || BORDERS.london, v);
  }
  // The quiet surface: one radial pool of venue-tinted light at centre circle
  // (identical turned 90 degrees, since it is radial) plus equal corner
  // shading for depth without a horizon. Nothing else sits on the pitch -
  // anything drawn here would compete with the four things that actually
  // matter: three teammates, the carrier, and the ball.
  drawPitchPattern(c, v, W, H) {
    const look = VENUE_LOOK[v.id] || VENUE_LOOK.london,
      short = Math.min(W, H),
      margin = PITCH_MARGIN,
      px = margin,
      py = margin,
      pw = W - margin * 2,
      ph = H - margin * 2;
    const pool = c.createRadialGradient(W / 2, H / 2, short * 0.05, W / 2, H / 2, short * 0.72);
    pool.addColorStop(0, withAlpha(look.light, look.wash));
    pool.addColorStop(1, withAlpha(look.light, 0));
    c.fillStyle = pool;
    c.fillRect(px, py, pw, ph);
    for (const [cx, cy] of [
      [px, py],
      [px + pw, py],
      [px + pw, py + ph],
      [px, py + ph],
    ]) {
      const vignette = c.createRadialGradient(cx, cy, 0, cx, cy, short * 0.55);
      vignette.addColorStop(0, "rgba(4,8,18,.5)");
      vignette.addColorStop(1, "rgba(4,8,18,0)");
      c.fillStyle = vignette;
      c.fillRect(px, py, pw, ph);
    }
  }
  addEvent(e) {
    if (
      !e ||
      e.type === "end" ||
      e.type === "focus" ||
      (e.type === "one-touch" && !e.milestone)
    )
      return;
    this.effects.push({
      ...e,
      stackOffset: stackOffsetFor(this.effects, e),
      age: 0,
      life:
        e.type === "turnover"
          ? 1.35
          : e.type === "score"
            ? 1.25
            : e.type === "focus"
              ? 1.05
              : e.type === "one-touch"
                ? e.milestone
                  ? 1.8
                  : 1.05
                : 0.45,
    });
    if (this.effects.length > 32) this.effects.shift();
  }
  resize(orientation = this.orientation) {
    const nextOrientation = orientation === "portrait" ? "portrait" : "landscape",
      d = Math.min(globalThis.devicePixelRatio || 1, this.maxDpr ?? 2);
    if (
      !this.resizeNeeded &&
      this.orientation === nextOrientation &&
      this.dpr === d
    )
      return;
    this.orientation = nextOrientation;
    const r = this.canvas.getBoundingClientRect(),
      w = Math.max(1, Math.round((r.width || WIDTH) * d)),
      h = Math.max(1, Math.round((r.height || HEIGHT) * d));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.orientation === "portrait")
      this.ctx.setTransform(0, h / WIDTH, -w / HEIGHT, 0, w, 0);
    else this.ctx.setTransform(w / WIDTH, 0, 0, h / HEIGHT, 0, 0);
    this.ctx._tikiPortrait = this.orientation === "portrait";
    this.dpr = d;
    this.resizeNeeded = false;
  }
  screenToWorld(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    const sx = (clientX - r.left) / (r.width || 1);
    const sy = (clientY - r.top) / (r.height || 1);
    return this.orientation === "portrait"
      ? { x: sy * WIDTH, y: HEIGHT - sx * HEIGHT }
      : { x: sx * WIDTH, y: sy * HEIGHT };
  }
  screenVectorToWorld(dx, dy) {
    return this.orientation === "portrait"
      ? { x: dy, y: -dx }
      : { x: dx, y: dy };
  }
  upright(x, y, draw) {
    const c = this.ctx;
    if (!c._tikiPortrait) return draw();
    c.save();
    c.translate(x, y);
    c.rotate(-Math.PI / 2);
    c.translate(-x, -y);
    c._tikiPortrait = false;
    draw();
    c.restore();
    c._tikiPortrait = true;
  }
  render(
    game,
    {
      preview = false,
      aim = null,
      target = null,
      bank = false,
      paused = false,
      theme = null,
      orientation = "landscape",
      shoutVisual = null,
    } = {},
  ) {
    if (!game) return;
    this.resize(orientation);
    const c = this.ctx,
      n = performance.now() / 1000,
      dt = this.lastTime ? Math.min(0.05, n - this.lastTime) : 0;
    this.lastTime = n;
    if (!paused) this.clock += dt;
    this.venue = getVenue(game.config);
    const tn = this.themeName(theme);
    c.globalAlpha = 1;
    // The background bitmap is now baked at this canvas's own backing-store
    // resolution (see backgroundFor), so it must be blitted 1:1 rather than
    // through the design-space transform, or it would be stretched a second
    // time. Save/restore keeps everything drawn after this back on the
    // normal WIDTH/HEIGHT coordinate system.
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.drawImage(
      this.backgroundFor(
        this.venue,
        tn,
        this.canvas.width,
        this.canvas.height,
        this.orientation === "portrait",
      ),
      0,
      0,
    );
    c.restore();
    if (!this.reducedMotion) {
      c.fillStyle = this.venue.accent;
      c.globalAlpha = 0.2;
      c.fillRect(80 + ((this.clock * 22) % 840), 45, 44, 3);
      c.fillRect(876 - ((this.clock * 18) % 800), 572, 44, 3);
      c.globalAlpha = 1;
    }
    if (game.focusActive && !preview) {
      c.fillStyle = "rgba(34,245,224,.09)";
      rounded(c, 51, 51, 898, 518, 14);
      c.fill();
      c.strokeStyle = this.venue.accent;
      c.shadowColor = this.venue.accent;
      c.shadowBlur = 16;
      c.lineWidth = 4;
      c.stroke();
      c.shadowBlur = 0;
      this.upright(500, 79, () => {
        rounded(c, 430, 65, 140, 28, 14);
        c.fillStyle = "rgba(7,15,33,.88)";
        c.fill();
        label(c, "FOCUS ACTIVE", 500, 79, 13, "#fff", "center", 800);
      });
    }
    this.drawZone(game);
    const carrier = game.players[game.carrier],
      selected = Number.isInteger(target)
        ? target
        : aim
          ? game.bestTarget(aim)
          : null;
    if (!game.ball && carrier)
      for (const p of game.players) {
        if (p.id === game.carrier) continue;
        const active = selected === p.id;
        if (preview || active || game.focusActive)
          this.drawLane(
            carrier,
            p,
            game.defenders,
            active,
            bank && active,
            preview,
          );
      }
    const activeShout = shoutVisual || this.shoutVisual;
    if (activeShout && game.zone) {
      const elapsed = (performance.now() - activeShout.start) / 1000;
      const total = (activeShout.duration || 2000) / 1000;
      if (elapsed < total) {
        const p = game.players[activeShout.playerId];
        if (p && p.id !== game.carrier) {
          const alpha = Math.max(0, 1 - elapsed / total);
          this.drawShoutTrail(p, game.zone, alpha);
        }
      } else if (this.shoutVisual === activeShout) {
        this.shoutVisual = null;
      }
    }
    if (
      game.ball &&
      bank &&
      !game.queuedPass &&
      Number.isInteger(selected) &&
      game.players[selected] &&
      selected !== game.ball.to
    ) {
      this.drawLane(
        game.players[game.ball.to],
        game.players[selected],
        game.defenders,
        true,
        true,
        false,
      );
    }
    if (game.ball && game.queuedPass && game.players[game.queuedPass.id]) {
      const incoming = game.players[game.ball.to],
        queued = game.players[game.queuedPass.id];
      if (incoming && queued) {
        c.save();
        c.strokeStyle = "rgba(255,255,255,.52)";
        c.lineWidth = 1.5;
        c.setLineDash([3, 8]);
        c.lineDashOffset = this.reducedMotion ? 0 : -this.clock * 12;
        c.beginPath();
        c.moveTo(incoming.x, incoming.y);
        const waypoint = game.queuedPass.bank
          ? bankPoint(incoming, queued)
          : null;
        if (waypoint) c.lineTo(waypoint.x, waypoint.y);
        c.lineTo(queued.x, queued.y);
        c.stroke();
        c.restore();
      }
    }
    if (game.ball?.trail?.length) {
      const tr = game.ball.trail;
      const isSplit = game.ball.split !== null;
      const splitTightness = isSplit ? game.ball.split : 0;
      c.save();
      if (isSplit) {
        c.shadowColor = BONUS_GOLD;
        c.shadowBlur = 12 + splitTightness * 14;
      }
      for (let i = 1; i < tr.length; i++) {
        const ratio = i / tr.length;
        if (isSplit) {
          c.strokeStyle = `rgba(255, 211, 47, ${0.3 + ratio * 0.7})`;
          c.lineWidth = 3 + ratio * (6 + splitTightness * 4);
        } else {
          c.strokeStyle = `rgba(255, 255, 255, ${0.18 + ratio * 0.72})`;
          c.lineWidth = 2 + ratio * 4;
        }
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(tr[i - 1].x, tr[i - 1].y);
        c.lineTo(tr[i].x, tr[i].y);
        c.stroke();
      }
      if (isSplit) {
        c.shadowBlur = 0;
        for (let i = 1; i < tr.length; i++) {
          const ratio = i / tr.length;
          c.strokeStyle = `rgba(255, 255, 255, ${0.45 + ratio * 0.55})`;
          c.lineWidth = 1.5 + ratio * 2.5;
          c.beginPath();
          c.moveTo(tr[i - 1].x, tr[i - 1].y);
          c.lineTo(tr[i].x, tr[i].y);
          c.stroke();
        }
        if (!this.reducedMotion && tr.length >= 3) {
          const head = tr.at(-1);
          const time = performance.now() * 0.01;
          for (let s = 0; s < 3; s++) {
            const angle = time + s * 2.1;
            const dist = 6 + (s * 5) % 12;
            c.fillStyle = s % 2 === 0 ? BONUS_GOLD : "#fff";
            c.beginPath();
            c.arc(head.x + Math.cos(angle) * dist, head.y + Math.sin(angle) * dist, 1.5 + (s % 2), 0, Math.PI * 2);
            c.fill();
          }
        }
      }
      c.restore();
    }
    // Active passing triangle visualization
    for (const e of this.effects) {
      if (e.triangle && e.triangle.length === 3) {
        const triangleDuration = (e.life || 1.25) * 0.5;
        const t = Math.min(1, e.age / triangleDuration);
        if (t >= 1) continue;
        const fade = Math.sin((1 - t) * Math.PI * 0.5);
        const [p1, p2, p3] = e.triangle;
        c.save();
        c.beginPath();
        c.moveTo(p1.x, p1.y);
        c.lineTo(p2.x, p2.y);
        c.lineTo(p3.x, p3.y);
        c.closePath();
        c.strokeStyle = `rgba(255, 225, 75, ${0.95 * fade})`;
        c.lineWidth = 2.5;
        c.shadowColor = BONUS_GOLD;
        c.shadowBlur = 10 * fade;
        c.stroke();
        c.shadowBlur = 0;
        if (!this.reducedMotion) {
          for (const pt of e.triangle) {
            const ringRadius = 24 + (1 - fade) * 16;
            c.strokeStyle = `rgba(255, 211, 47, ${0.65 * fade})`;
            c.lineWidth = 2 * fade;
            c.beginPath();
            c.arc(pt.x, pt.y, ringRadius, 0, Math.PI * 2);
            c.stroke();
          }
        }
        c.restore();
      }
    }
    for (const e of this.effects) {
      if (!paused) e.age += dt;
      if (e.type === "one-touch" && e.milestone) this.drawEffect(e);
    }
    for (const d of game.defenders) this.drawDefender(d);
    for (const p of game.players)
      this.drawPlayer(
        p,
        p.id === game.carrier && !game.ball,
        selected === p.id,
        game.hold,
        preview,
      );
    if (game.ball) this.drawBall(game.ball.x, game.ball.y, game.elapsed * 7);
    for (const e of this.effects)
      if (e.type !== "one-touch" || !e.milestone) this.drawEffect(e);
    // Most frames have no transient effects. Avoid allocating a replacement
    // empty array at display refresh rate in that common case.
    if (this.effects.length)
      this.effects = this.effects.filter((e) => e.age < e.life);
    c.globalAlpha = 1;
    c.setLineDash([]);
  }
  // The zone can be active, or dark and about to arrive (blind gap between
  // rotations). Both states share the portrait upright() wrap; only the
  // active state draws the countdown ring and label, so a player never reads
  // the gap as the zone breaking rather than one about to appear.
  drawZone(game) {
    const z = game.zone;
    // Endless pays no points, so the zone cannot promise "+18" there. It
    // still pays Energy and still feeds the streak, so it keeps its ring and
    // its name - only the number goes.
    const scored = !game.config?.endless;
    if (z) {
      if (this.ctx._tikiPortrait)
        return this.upright(z.x, z.y, () =>
          this.drawActiveZone(z, game.zoneTimer, scored),
        );
      return this.drawActiveZone(z, game.zoneTimer, scored);
    }
    const next = game.nextZone;
    if (!next || !game.zoneBlindDuration) return;
    const alpha =
      1 -
      Math.max(0, Math.min(1, game.zoneBlindTimer / game.zoneBlindDuration));
    if (this.ctx._tikiPortrait)
      return this.upright(next.x, next.y, () =>
        this.drawPendingZone(next, alpha),
      );
    return this.drawPendingZone(next, alpha);
  }
  drawActiveZone(z, t, scored = true) {
    const c = this.ctx,
      p = this.reducedMotion ? 0 : Math.sin(this.clock * 2) * 2;
    c.strokeStyle = BONUS_GOLD;
    c.lineWidth = 2;
    c.setLineDash([6, 7]);
    circle(c, z.x, z.y, z.r + p);
    c.stroke();
    c.setLineDash([]);
    c.lineWidth = 4;
    c.beginPath();
    c.arc(
      z.x,
      z.y,
      z.r,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, t / ZONE_LIFETIME)),
    );
    c.stroke();
    const text = scored ? `ZONE +${ZONE_POINTS}` : "ZONE";
    const width = scored ? 92 : 62;
    rounded(c, z.x - width / 2, z.y + z.r * 0.55 - 12, width, 24, 12);
    c.fillStyle = "rgba(8,18,31,.9)";
    c.fill();
    label(c, text, z.x, z.y + z.r * 0.55, 11, "#ffe66b");
  }
  // Ghost ring that grows from faint to solid across the blind gap, at the
  // exact spot the next zone will activate — legible as "coming", not as a
  // zone that broke.
  drawPendingZone(next, alpha) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, alpha)) * 0.65;
    c.strokeStyle = BONUS_GOLD;
    c.lineWidth = 2;
    c.setLineDash([3, 10]);
    circle(c, next.x, next.y, 92);
    c.stroke();
    c.setLineDash([]);
    c.restore();
  }
  drawLane(a, b, ds, active, bank, preview) {
    const c = this.ctx,
      w = bank ? bankPoint(a, b) : null,
      safe = ds.every(
        (d) =>
          segmentDistance(d, a, w || b) > 31 &&
          (!w || segmentDistance(d, w, b) > 31),
      );
    c.strokeStyle = active
      ? safe
        ? "#fff"
        : "#ff5b84"
      : safe
        ? "rgba(88,246,231,.3)"
        : "rgba(255,91,132,.22)";
    c.lineWidth = active ? 2.5 : 1.4;
    c.setLineDash(active ? [3, 8] : [2, 11]);
    c.lineDashOffset = this.reducedMotion ? 0 : -this.clock * 10;
    c.beginPath();
    c.moveTo(a.x, a.y);
    if (w) c.lineTo(w.x, w.y);
    c.lineTo(b.x, b.y);
    c.stroke();
    c.setLineDash([]);
    if (w) {
      circle(c, w.x, w.y, 8);
      c.fillStyle = BONUS_GOLD;
      c.fill();
      circle(c, w.x, w.y, 3);
      c.fillStyle = "#091526";
      c.fill();
    }
    if (active && !preview) {
      const s = w || a,
        an = Math.atan2(b.y - s.y, b.x - s.x),
        x = b.x - Math.cos(an) * 42,
        y = b.y - Math.sin(an) * 42;
      c.save();
      c.translate(x, y);
      c.rotate(an);
      c.beginPath();
      c.moveTo(-7, -6);
      c.lineTo(0, 0);
      c.lineTo(-7, 6);
      c.stroke();
      c.restore();
    }
  }
  triggerShout(playerId, duration = 2000) {
    this.shoutVisual = { playerId, start: performance.now(), duration };
  }
  drawShoutTrail(p, zone, alpha = 1) {
    const c = this.ctx;
    c.save();
    c.globalAlpha = Math.max(0, Math.min(1, alpha));
    c.strokeStyle = BONUS_GOLD;
    c.lineWidth = 2.4;
    c.setLineDash([4, 6]);
    c.lineDashOffset = this.reducedMotion ? 0 : -this.clock * 14;
    c.beginPath();
    c.moveTo(p.x, p.y);
    c.lineTo(zone.x, zone.y);
    c.stroke();
    c.setLineDash([]);

    const an = Math.atan2(zone.y - p.y, zone.x - p.x);
    const d = Math.hypot(zone.x - p.x, zone.y - p.y);
    if (d > 45) {
      const offset = Math.min(d * 0.5, (zone.r || 40) + 12);
      const ax = zone.x - Math.cos(an) * offset;
      const ay = zone.y - Math.sin(an) * offset;
      c.translate(ax, ay);
      c.rotate(an);
      c.beginPath();
      c.moveTo(-8, -6);
      c.lineTo(0, 0);
      c.lineTo(-8, 6);
      c.stroke();
    }
    c.restore();
  }
  drawPlayer(p, carrier, selected, hold, preview) {
    if (this.ctx._tikiPortrait)
      return this.upright(p.x, p.y, () =>
        this.drawPlayer(p, carrier, selected, hold, preview),
      );
    const c = this.ctx;
    const pulse = this.reducedMotion ? 1 : 1 + Math.sin(this.clock * 5) * 0.06;

    // Carrier Ground Aura & Shadow
    c.fillStyle = "rgba(0,5,18,.42)";
    c.beginPath();
    c.ellipse(
      p.x,
      p.y + 10,
      carrier ? 30 * pulse : 25,
      carrier ? 22 * pulse : 19,
      0,
      0,
      Math.PI * 2,
    );
    c.fill();

    if (carrier) {
      // Outer breathing hero halo with venue accent
      circle(c, p.x, p.y, 38 * pulse);
      c.strokeStyle = this.venue.accent;
      c.lineWidth = this.crisp(c, 2);
      c.shadowColor = this.venue.accent;
      c.shadowBlur = 12;
      c.stroke();
      c.shadowBlur = 0;

      // Inner crisp white hero ring
      circle(c, p.x, p.y, 31);
      c.strokeStyle = "#fff";
      c.lineWidth = this.crisp(c, 2.5);
      c.stroke();

      if (hold > 2 && !preview) {
        c.beginPath();
        c.arc(
          p.x,
          p.y,
          44,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.min(1, (hold - 2) / 4),
        );
        c.strokeStyle = hold > 4 ? this.venue.secondary : BONUS_GOLD;
        c.lineWidth = 4;
        c.stroke();
      }
    } else if (selected && preview) {
      circle(c, p.x, p.y, 35);
      c.strokeStyle = "rgba(255,255,255,0.5)";
      c.lineWidth = this.crisp(c, 1.5);
      c.stroke();
    }

    circle(c, p.x, p.y, PLAYER_RADIUS);
    const g = c.createLinearGradient(p.x - 20, p.y - 20, p.x + 20, p.y + 20);
    g.addColorStop(0, "#71fff0");
    g.addColorStop(1, "#13aebe");
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = "#d7fffb";
    c.lineWidth = this.crisp(c, 2);
    c.stroke();
    label(c, String(p.id + 1), p.x, p.y + 1, 22, "#062332", "center", 900);

    if (carrier) {
      c.save();
      c.shadowColor = "#fff";
      c.shadowBlur = 6;
      this.drawBall(p.x + 25, p.y + 18, 0.3);
      c.restore();

      // Player Indicator: downward accent chevron (no text)
      const chevronY =
        p.y - 38 - (this.reducedMotion ? 0 : Math.sin(this.clock * 6) * 3);
      c.save();
      c.fillStyle = this.venue.accent;
      c.shadowColor = this.venue.accent;
      c.shadowBlur = 8;
      c.beginPath();
      c.moveTo(p.x - 6, chevronY);
      c.lineTo(p.x + 6, chevronY);
      c.lineTo(p.x, chevronY + 7);
      c.closePath();
      c.fill();
      c.restore();
    }
  }
  drawDefender(p) {
    if (this.ctx._tikiPortrait)
      return this.upright(p.x, p.y, () => this.drawDefender(p));
    const c = this.ctx;
    c.save();
    c.translate(p.x, p.y + 6);
    c.rotate(Math.PI / 4);
    rounded(c, -20, -20, 40, 40, 7);
    c.fillStyle = "rgba(0,3,14,.42)";
    c.fill();
    c.restore();
    c.save();
    c.translate(p.x, p.y);
    c.rotate(Math.PI / 4);
    rounded(c, -20, -20, 40, 40, 7);
    const g = c.createLinearGradient(-20, -20, 20, 20);
    g.addColorStop(0, this.venue.secondary);
    g.addColorStop(1, "#d32c73");
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = "#ffc0cf";
    c.lineWidth = this.crisp(c, 2);
    c.stroke();
    c.restore();
    c.strokeStyle = "#fff0f4";
    c.lineWidth = this.crisp(c, 3.2);
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(p.x - 7, p.y - 7);
    c.lineTo(p.x + 7, p.y + 7);
    c.moveTo(p.x + 7, p.y - 7);
    c.lineTo(p.x - 7, p.y + 7);
    c.stroke();
  }
  drawBall(x, y, r) {
    const c = this.ctx;
    c.save();
    c.translate(x, y);
    c.rotate(r);
    c.shadowColor = "#fff";
    c.shadowBlur = 7;
    circle(c, 0, 0, 8);
    c.fillStyle = "#fff";
    c.fill();
    c.shadowBlur = 0;
    circle(c, 0, 0, 3);
    c.fillStyle = "#17213a";
    c.fill();
    c.strokeStyle = "#17213a";
    for (let i = 0; i < 5; i++) {
      const a = (i * Math.PI * 2) / 5;
      c.beginPath();
      c.moveTo(Math.cos(a) * 3, Math.sin(a) * 3);
      c.lineTo(Math.cos(a) * 7, Math.sin(a) * 7);
      c.stroke();
    }
    c.restore();
  }
  drawEffect(e) {
    if (this.ctx._tikiPortrait && e.type === "turnover")
      return this.upright(500, 310, () => this.drawEffect(e));
    const c = this.ctx,
      t = Math.min(1, e.age / e.life);
    c.save();
    c.globalAlpha = Math.min(1, (1 - t) * 3);
    if (e.type === "turnover") {
      rounded(c, 280, 266, 440, 90, 13);
      c.fillStyle = "rgba(10,10,30,.95)";
      c.fill();
      c.strokeStyle = this.venue.secondary;
      c.lineWidth = 2;
      c.stroke();
      label(c, e.text, 500, 298, 20, this.venue.secondary, "center", 900);
      label(c, "RESET / FIND THE NEXT PASS", 500, 330, 11, "#fff");
    } else if (e.type === "one-touch") {
      const milestone = Boolean(e.milestone),
        rise = this.reducedMotion ? 0 : t * 24,
        worldX = milestone ? 285 : Math.max(120, Math.min(880, e.x || 500)),
        worldY = milestone
          ? 505
          : Math.max(100, (e.y || 310) - 54 - rise - (e.stackOffset || 0));
      if (milestone) {
        c.globalAlpha = Math.min(1, (1 - t) * 4);
        c.strokeStyle = this.venue.accent;
        c.lineWidth = 5;
        rounded(c, 48, 48, 904, 524, 17);
        c.stroke();
        c.strokeStyle = this.venue.secondary;
        c.lineWidth = 3;
        rounded(c, 57, 57, 886, 506, 13);
        c.stroke();
        if (!this.reducedMotion)
          for (let i = 0; i < 10; i++) {
            const px = 70 + ((i * 103 + t * 210) % 860),
              top = i % 2 === 0;
            c.fillStyle = i % 2 ? this.venue.accent : this.venue.secondary;
            c.fillRect(px, top ? 53 : 559, 38, 5);
          }
        const burst = this.reducedMotion ? 14 : 14 + t * 22;
        c.globalAlpha = Math.min(0.75, (1 - t) * 2);
        c.strokeStyle = this.venue.accent;
        c.lineWidth = 2;
        for (let i = 0; i < 12; i++) {
          const angle = (i * Math.PI) / 6,
            inner = burst + 165,
            outer = inner + 12;
          c.beginPath();
          c.moveTo(
            worldX + Math.cos(angle) * inner,
            worldY + Math.sin(angle) * 42,
          );
          c.lineTo(
            worldX + Math.cos(angle) * outer,
            worldY + Math.sin(angle) * 52,
          );
          c.stroke();
        }
      }
      const portraitScreenX = Math.max(74, Math.min(546, HEIGHT - worldY)),
        portraitScreenY = Math.max(23, Math.min(977, worldX)),
        badgeX = c._tikiPortrait ? (milestone ? 135 : portraitScreenY) : worldX,
        badgeY = c._tikiPortrait
          ? milestone
            ? 310
            : HEIGHT - portraitScreenX
          : worldY,
        drawBadge = () => {
          rounded(
            c,
            badgeX - (milestone ? 170 : 66),
            badgeY - (milestone ? 46 : 15),
            milestone ? 340 : 132,
            milestone ? 92 : 30,
            milestone ? 22 : 15,
          );
          c.fillStyle = "rgba(7,8,29,.95)";
          c.fill();
          c.strokeStyle = milestone ? this.venue.secondary : this.venue.accent;
          c.lineWidth = 2;
          c.stroke();
          label(
            c,
            milestone ? "OLÉ!" : "ONE TOUCH +5",
            badgeX,
            milestone ? badgeY - 12 : badgeY,
            milestone ? 50 : 13,
            "#fff",
            "center",
            900,
          );
          if (milestone)
            label(
              c,
              `ONE TOUCH ×${e.streak}  /  +${e.bonus}`,
              badgeX,
              badgeY + 29,
              13,
              "#ff79bc",
              "center",
              900,
            );
        };
      if (c._tikiPortrait) this.upright(badgeX, badgeY, drawBadge);
      else drawBadge();
    } else if (e.type === "score" || e.type === "focus") {
      const focus = e.type === "focus",
        displayText = focus
          ? e.text
          : e.points != null
            ? `+${e.points}`
            : e.text?.match(/\+\d+/)
              ? e.text.match(/\+\d+/)[0]
              : e.text,
        badgeColor = focus ? BONUS_GOLD : getScoreEventColor(e),
        worldY = Math.max(
          40,
          e.y -
            (this.reducedMotion ? 10 : t * 38) -
            16 +
            (focus ? 27 : 0) -
            (e.stackOffset || 0),
        );
      c.font = `900 ${focus ? 12 : 15}px ${FONT}`;
      const textW = c.measureText(displayText).width,
        w = Math.max(textW + 24, focus ? 50 : 44),
        worldX = Math.max(55 + w / 2, Math.min(945 - w / 2, e.x)),
        screenX = Math.max(
          5 + w / 2,
          Math.min(HEIGHT - 5 - w / 2, HEIGHT - worldY),
        ),
        screenY = Math.max(20, Math.min(WIDTH - 20, worldX)),
        badgeX = c._tikiPortrait ? screenY : worldX,
        badgeY = c._tikiPortrait ? HEIGHT - screenX : worldY,
        drawBadge = () => {
          rounded(c, badgeX - w / 2, badgeY - 14, w, 28, 14);
          c.fillStyle = "rgba(8,12,31,.92)";
          c.fill();
          c.strokeStyle = badgeColor;
          c.lineWidth = this.crisp(c, 2);
          c.shadowColor = badgeColor;
          c.shadowBlur = 6;
          c.stroke();
          c.shadowBlur = 0;
          label(
            c,
            displayText,
            badgeX,
            badgeY,
            focus ? 12 : 15,
            badgeColor,
            "center",
            900,
          );
        };
      if (c._tikiPortrait) this.upright(badgeX, badgeY, drawBadge);
      else drawBadge();
      if (!focus && !this.reducedMotion)
        for (let i = 0; i < 6; i++) {
          const a = (i * Math.PI) / 3;
          circle(
            c,
            e.x + Math.cos(a) * t * 52,
            e.y + Math.sin(a) * t * 38,
            2.5 * (1 - t),
          );
          c.fillStyle = badgeColor;
          c.fill();
        }
    } else if (!this.reducedMotion) {
      circle(c, e.x, e.y, 8 + t * 29);
      c.strokeStyle = e.type === "wall" ? "#38f5e5" : "#fff";
      c.lineWidth = 2 * (1 - t);
      c.stroke();
    }
    c.restore();
  }
}
