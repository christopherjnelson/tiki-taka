import {
  WIDTH,
  HEIGHT,
  bankPoint,
  segmentDistance,
} from "../../engine/src/game.js";
import { getVenue } from "../../engine/src/venues.js";

const FONT = '"Tiki Signage","Arial Narrow","Arial Black",sans-serif';
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
) {
  if (c._tikiPortrait) {
    c.save();
    c.translate(x, y);
    c.rotate(-Math.PI / 2);
    c._tikiPortrait = false;
    label(c, text, 0, 0, size, color, align, weight);
    c.restore();
    c._tikiPortrait = true;
    return;
  }
  c.font = `${weight} ${size}px ${FONT}`;
  c.textAlign = align;
  c.textBaseline = "middle";
  c.fillStyle = color;
  c.fillText(text, x, y);
}
const THEMES = {
  dark: {
    void: "#090b20",
    pitch: "#102c38",
    pitch2: "#14233d",
    line: "#b8fff5",
    muted: "#88b9bd",
  },
  light: {
    void: "#e7d8d0",
    pitch: "#185a68",
    pitch2: "#244c68",
    line: "#ecffff",
    muted: "#416571",
  },
};
const SURFACES = {
  lisbon: { dark: ["#155c82", "#196978"], light: ["#247fa0", "#287e83"] },
  london: { dark: ["#282c38", "#363846"], light: ["#4c5260", "#60636c"] },
  barcelona: { dark: ["#87443f", "#9d503f"], light: ["#ae5c49", "#c36e51"] },
  tokyo: { dark: ["#21124e", "#32135b"], light: ["#3d2670", "#502b79"] },
  "sao-paulo": { dark: ["#173e38", "#205448"], light: ["#296355", "#367462"] },
  amsterdam: { dark: ["#163d79", "#20518d"], light: ["#2863a0", "#3975ad"] },
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.effects = [];
    this.lastTime = 0;
    this.clock = 0;
    this.backgrounds = new Map();
    this.orientation = "landscape";
    this.reducedMotion =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (typeof document !== "undefined" && document.fonts?.ready)
      document.fonts.ready.then(() => this.backgrounds.clear());
  }
  themeName(v) {
    return (
      v ||
      (typeof document !== "undefined" &&
        document.documentElement.dataset.theme) ||
      "dark"
    );
  }
  backgroundFor(v, t) {
    const key = `${v.id}:${t}`;
    if (!this.backgrounds.has(key)) {
      const el = document.createElement("canvas");
      el.width = WIDTH;
      el.height = HEIGHT;
      const context = el.getContext("2d");
      this.paintArena(context, v, THEMES[t] || THEMES.dark);
      this.backgrounds.set(key, el);
    }
    return this.backgrounds.get(key);
  }
  paintArena(c, v, p) {
    const theme = p === THEMES.light ? "light" : "dark",
      surface = SURFACES[v.id]?.[theme] || [p.pitch, p.pitch2],
      g = c.createLinearGradient(0, 0, WIDTH, HEIGHT);
    g.addColorStop(0, p.void);
    g.addColorStop(1, v.id === "tokyo" ? "#27104c" : "#10152c");
    c.fillStyle = g;
    c.fillRect(0, 0, WIDTH, HEIGHT);
    this.drawArchitecture(c, v);
    c.save();
    rounded(c, 50, 50, 900, 520, 16);
    c.clip();
    const turf = c.createLinearGradient(50, 50, 950, 570);
    turf.addColorStop(0, surface[0]);
    turf.addColorStop(1, surface[1]);
    c.fillStyle = turf;
    c.fillRect(50, 50, 900, 520);
    this.drawPitchPattern(c, v);
    const light = c.createLinearGradient(50, 50, 950, 570);
    light.addColorStop(0, "rgba(255,255,255,.13)");
    light.addColorStop(0.38, "rgba(255,255,255,0)");
    light.addColorStop(0.72, "rgba(0,0,20,.12)");
    light.addColorStop(1, "rgba(0,0,20,0)");
    c.fillStyle = light;
    c.fillRect(50, 50, 900, 520);
    c.save();
    c.translate(500, 310);
    c.rotate(-0.08);
    label(
      c,
      v.name.toUpperCase(),
      0,
      0,
      v.id === "sao-paulo" ? 53 : 62,
      "rgba(255,255,255,.055)",
      "center",
      900,
    );
    c.restore();
    c.globalAlpha = 0.74;
    c.strokeStyle = p.line;
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(500, 50);
    c.lineTo(500, 570);
    c.stroke();
    circle(c, 500, 310, 92);
    c.stroke();
    circle(c, 500, 310, 3);
    c.fillStyle = p.line;
    c.fill();
    c.restore();
    c.globalAlpha = 1;
    c.shadowColor = "rgba(0,0,0,.65)";
    c.shadowBlur = 18;
    rounded(c, 50, 50, 900, 520, 16);
    c.strokeStyle = p.line;
    c.lineWidth = 3;
    c.stroke();
    c.shadowBlur = 0;
    c.globalAlpha = 0.72;
    c.strokeStyle = v.accent;
    c.lineWidth = 2;
    rounded(c, 43, 43, 914, 534, 21);
    c.stroke();
    c.globalAlpha = 1;
    label(
      c,
      `${v.name.toUpperCase()}  /  ${v.vibe.toUpperCase()}`,
      500,
      24,
      11,
      v.accent,
    );
    label(c, "TIKI TAKA WORLD TOUR", 500, 597, 10, p.muted);
    label(c, "TT 98", 58, 24, 10, v.secondary, "left", 800);
  }
  drawArchitecture(c, v) {
    const a = v.accent,
      s = v.secondary;
    if (v.id === "lisbon") {
      const sky = c.createLinearGradient(0, 0, 0, 70);
      sky.addColorStop(0, "#ec4388");
      sky.addColorStop(1, "#ff9b62");
      c.fillStyle = sky;
      c.fillRect(0, 0, 1000, 68);
      c.fillStyle = "#152b5a";
      for (let x = 0; x < 1000; x += 28) {
        c.fillRect(x, 574, 26, 46);
        c.strokeStyle = "rgba(90,238,236,.35)";
        c.strokeRect(x + 4, 582, 18, 18);
      }
      c.strokeStyle = a;
      c.lineWidth = 4;
      for (const x of [88, 920]) {
        c.beginPath();
        c.moveTo(x, 50);
        c.quadraticCurveTo(x - 18, 22, x - 27, 6);
        c.moveTo(x, 35);
        c.quadraticCurveTo(x + 25, 25, x + 31, 8);
        c.stroke();
      }
    } else if (v.id === "london") {
      c.fillStyle = "#2b3040";
      c.fillRect(0, 0, 1000, 620);
      c.strokeStyle = "rgba(255,92,112,.25)";
      for (let y = 8; y < 620; y += 14)
        for (let x = ((y / 14) % 2) * 18; x < 1000; x += 36)
          c.strokeRect(x, y, 34, 12);
      c.fillStyle = "#121827";
      c.fillRect(0, 0, 1000, 42);
      c.fillRect(0, 578, 1000, 42);
      c.fillStyle = "#ffd32f";
      for (let x = -20; x < 1020; x += 44) {
        c.save();
        c.translate(x, 42);
        c.rotate(-0.6);
        c.fillRect(0, -5, 25, 10);
        c.restore();
      }
    } else if (v.id === "barcelona") {
      c.fillStyle = "#d56d52";
      c.fillRect(0, 0, 1000, 620);
      for (let x = 0; x < 1000; x += 35)
        for (let y = 0; y < 620; y += 35) {
          c.fillStyle = (x + y) % 70 ? s : a;
          c.globalAlpha = 0.35;
          c.beginPath();
          c.moveTo(x + 2, y + 17);
          c.lineTo(x + 17, y + 2);
          c.lineTo(x + 32, y + 17);
          c.lineTo(x + 17, y + 32);
          c.fill();
        }
      c.globalAlpha = 1;
      c.fillStyle = "#ffcc82";
      for (let x = 82; x < 950; x += 125) {
        c.fillRect(x, 8, 68, 27);
        rounded(c, x + 18, 13, 32, 22, 15);
        c.fillStyle = "#3a3158";
        c.fill();
        c.fillStyle = "#ffcc82";
      }
    } else if (v.id === "tokyo") {
      c.fillStyle = "#100a2c";
      c.fillRect(0, 0, 1000, 620);
      c.strokeStyle = "rgba(45,245,223,.22)";
      for (let x = 12; x < 1000; x += 42) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, 620);
        c.stroke();
      }
      for (let x = 65; x < 950; x += 120) {
        c.fillStyle = x % 240 ? s : a;
        c.globalAlpha = 0.65;
        c.fillRect(x, 8, 76, 27);
        label(c, x % 240 ? "PASS" : "東京", x + 38, 22, 10, "#fff");
      }
      c.globalAlpha = 1;
    } else if (v.id === "sao-paulo") {
      c.fillStyle = "#123c39";
      c.fillRect(0, 0, 1000, 620);
      c.strokeStyle = "rgba(121,255,111,.35)";
      for (let x = -620; x < 1000; x += 18) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x + 620, 620);
        c.stroke();
        c.beginPath();
        c.moveTo(x, 620);
        c.lineTo(x + 620, 0);
        c.stroke();
      }
      c.fillStyle = "#79ff55";
      c.globalAlpha = 0.22;
      for (let x = 0; x < 1000; x += 80) {
        circle(c, x, 20, 32);
        c.fill();
        circle(c, x + 34, 602, 28);
        c.fill();
      }
      c.globalAlpha = 1;
    } else {
      c.fillStyle = "#102a74";
      c.fillRect(0, 0, 1000, 620);
      c.strokeStyle = "rgba(62,237,255,.36)";
      c.lineWidth = 3;
      for (let x = -100; x < 1100; x += 70) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x + 65, 45);
        c.lineTo(x, 90);
        c.stroke();
        c.beginPath();
        c.moveTo(x, 530);
        c.lineTo(x + 65, 575);
        c.lineTo(x, 620);
        c.stroke();
      }
      c.fillStyle = s;
      for (let x = 45; x < 1000; x += 115) c.fillRect(x, 12, 62, 8);
    }
  }
  drawPitchPattern(c, v) {
    c.strokeStyle = v.accent;
    c.fillStyle = v.accent;
    c.lineWidth = 1;
    if (v.id === "lisbon") {
      c.globalAlpha = 0.15;
      for (let x = 54; x < 950; x += 48)
        for (let y = 54; y < 570; y += 48) {
          c.strokeRect(x + 5, y + 5, 38, 38);
          c.beginPath();
          c.moveTo(x + 5, y + 24);
          c.lineTo(x + 24, y + 5);
          c.lineTo(x + 43, y + 24);
          c.lineTo(x + 24, y + 43);
          c.closePath();
          c.stroke();
        }
      c.fillStyle = "rgba(255,125,108,.12)";
      c.beginPath();
      c.moveTo(50, 50);
      c.lineTo(340, 50);
      c.lineTo(170, 570);
      c.lineTo(50, 570);
      c.fill();
    } else if (v.id === "london") {
      c.globalAlpha = 0.16;
      c.strokeStyle = "#c8c8cc";
      for (let x = 50; x < 950; x += 150)
        for (let y = 50; y < 570; y += 130) c.strokeRect(x, y, 150, 130);
      c.globalAlpha = 0.2;
      c.strokeStyle = "#ffd32f";
      c.lineWidth = 8;
      for (let y = 80; y < 570; y += 160) {
        c.beginPath();
        c.moveTo(50, y);
        c.lineTo(95, y);
        c.stroke();
      }
      c.globalAlpha = 0.1;
      for (let i = 0; i < 45; i++) {
        const x = 70 + ((i * 137) % 850),
          y = 65 + ((i * 83) % 490);
        c.fillStyle = i % 2 ? "#fff" : "#101018";
        c.fillRect(x, y, 10 + (i % 4) * 6, 2);
      }
    } else if (v.id === "barcelona") {
      c.globalAlpha = 0.18;
      c.strokeStyle = "#ffd49b";
      for (let x = 65; x < 950; x += 58)
        for (let y = 65; y < 570; y += 58) {
          c.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (i * Math.PI) / 3;
            c.lineTo(x + Math.cos(a) * 22, y + Math.sin(a) * 22);
          }
          c.closePath();
          c.stroke();
        }
      c.fillStyle = "rgba(255,207,127,.14)";
      c.beginPath();
      c.moveTo(50, 50);
      c.lineTo(410, 50);
      c.lineTo(250, 570);
      c.lineTo(50, 570);
      c.fill();
    } else if (v.id === "tokyo") {
      c.globalAlpha = 0.22;
      for (let x = 70; x < 950; x += 70) {
        c.beginPath();
        c.moveTo(x, 50);
        c.lineTo(x, 570);
        c.moveTo(x, 145);
        c.lineTo(x + 35, 145);
        c.lineTo(x + 35, 235);
        c.lineTo(x + 55, 235);
        c.stroke();
        for (const y of [145, 235, 430]) {
          circle(c, x, y, 3);
          c.fill();
        }
      }
      c.strokeStyle = "#ff3c9c";
      c.globalAlpha = 0.17;
      for (let y = 92; y < 570; y += 96) {
        c.beginPath();
        c.moveTo(50, y);
        c.lineTo(950, y);
        c.stroke();
      }
    } else if (v.id === "sao-paulo") {
      c.globalAlpha = 0.12;
      c.strokeStyle = "#b4ff6a";
      for (let x = -400; x < 950; x += 65) {
        c.beginPath();
        c.moveTo(x, 50);
        c.lineTo(x + 520, 570);
        c.stroke();
      }
      c.globalAlpha = 0.1;
      c.fillStyle = "#d2ff72";
      for (let i = 0; i < 34; i++) {
        const x = 55 + ((i * 181) % 890),
          y = 55 + ((i * 107) % 510);
        circle(c, x, y, 7 + (i % 8));
        c.fill();
      }
    } else {
      c.globalAlpha = 0.14;
      c.strokeStyle = "#87efff";
      for (let y = 50; y < 570; y += 22) {
        c.beginPath();
        for (let x = 50; x <= 950; x += 44)
          c.lineTo(x, y + ((x / 44 + y / 22) % 2) * 11);
        c.stroke();
      }
      c.globalAlpha = 0.16;
      c.fillStyle = "#ff4ba8";
      for (let x = 50; x < 950; x += 180) c.fillRect(x, 50, 22, 520);
      c.strokeStyle = "rgba(255,255,255,.25)";
      for (let x = 65; x < 950; x += 24) {
        c.beginPath();
        c.moveTo(x, 50);
        c.lineTo(x, 570);
        c.stroke();
      }
    }
    c.globalAlpha = 1;
  }
  addEvent(e) {
    if (!e || e.type === "end") return;
    this.effects.push({
      ...e,
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
    this.orientation = orientation === "portrait" ? "portrait" : "landscape";
    const r = this.canvas.getBoundingClientRect(),
      d = Math.min(globalThis.devicePixelRatio || 1, 2),
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
    c.drawImage(this.backgroundFor(this.venue, tn), 0, 0);
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
    if (!preview) this.drawOneTouchHud(game.oneTouchStreak || 0);
    this.drawZone(game.zone, game.zoneTimer);
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
        label(c, "NEXT", queued.x, queued.y - 40, 9, "#fff", "center", 900);
        c.restore();
      }
    }
    if (game.ball?.trail?.length) {
      const tr = game.ball.trail;
      for (let i = 1; i < tr.length; i++) {
        c.strokeStyle = `rgba(255,255,255,${0.18 + (i / tr.length) * 0.72})`;
        c.lineWidth = 2 + (i / tr.length) * 4;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(tr[i - 1].x, tr[i - 1].y);
        c.lineTo(tr[i].x, tr[i].y);
        c.stroke();
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
    this.effects = this.effects.filter((e) => e.age < e.life);
    c.globalAlpha = 1;
    c.setLineDash([]);
  }
  drawOneTouchHud(streak, x = 828, y = 27) {
    if (!streak) return;
    if (this.ctx._tikiPortrait)
      // World (40, 310) projects to screen (310, 40), centered across portrait.
      return this.upright(40, 310, () => this.drawOneTouchHud(streak, 40, 310));
    const c = this.ctx,
      step = streak % 10,
      progress = step === 0 ? 1 : step / 10,
      milestone = streak >= 10;
    c.save();
    rounded(c, x - 114, y - 14, 228, 28, 14);
    c.fillStyle = "rgba(7,10,30,.9)";
    c.fill();
    c.strokeStyle = milestone ? "#ff4ba8" : this.venue.accent;
    c.lineWidth = 1.5;
    c.stroke();
    label(c, `ONE TOUCH  ×${streak}`, x - 100, y, 11, "#fff", "left", 900);
    c.fillStyle = "rgba(255,255,255,.16)";
    rounded(c, x + 22, y - 4, 76, 8, 4);
    c.fill();
    c.fillStyle = milestone ? "#ff4ba8" : this.venue.accent;
    rounded(c, x + 22, y - 4, 76 * progress, 8, 4);
    c.fill();
    c.restore();
  }
  drawZone(z, t) {
    if (!z) return;
    if (this.ctx._tikiPortrait)
      return this.upright(z.x, z.y, () => this.drawZone(z, t));
    const c = this.ctx,
      p = this.reducedMotion ? 0 : Math.sin(this.clock * 2) * 2;
    c.strokeStyle = "#ffd32f";
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
      -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, t / 12)),
    );
    c.stroke();
    rounded(c, z.x - 46, z.y + z.r * 0.55 - 12, 92, 24, 12);
    c.fillStyle = "rgba(8,18,31,.9)";
    c.fill();
    label(c, "ZONE +25", z.x, z.y + z.r * 0.55, 11, "#ffe66b");
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
      c.fillStyle = "#ffd32f";
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
  drawPlayer(p, carrier, selected, hold, preview) {
    if (this.ctx._tikiPortrait)
      return this.upright(p.x, p.y, () =>
        this.drawPlayer(p, carrier, selected, hold, preview),
      );
    const c = this.ctx;
    c.fillStyle = "rgba(0,5,18,.42)";
    c.beginPath();
    c.ellipse(p.x, p.y + 10, 25, 19, 0, 0, Math.PI * 2);
    c.fill();
    if (selected) {
      circle(c, p.x, p.y, 35);
      c.strokeStyle = "#fff";
      c.lineWidth = 2;
      c.stroke();
    }
    if (carrier) {
      circle(c, p.x, p.y, 33);
      c.strokeStyle = "#fff";
      c.lineWidth = 3;
      c.shadowColor = this.venue.accent;
      c.shadowBlur = 13;
      c.stroke();
      c.shadowBlur = 0;
      if (hold > 2 && !preview) {
        c.beginPath();
        c.arc(
          p.x,
          p.y,
          38,
          -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * Math.min(1, (hold - 2) / 4),
        );
        c.strokeStyle = hold > 4 ? this.venue.secondary : "#ffd32f";
        c.lineWidth = 4;
        c.stroke();
      }
    }
    circle(c, p.x, p.y, 24);
    const g = c.createLinearGradient(p.x - 20, p.y - 20, p.x + 20, p.y + 20);
    g.addColorStop(0, "#71fff0");
    g.addColorStop(1, "#13aebe");
    c.fillStyle = g;
    c.fill();
    c.strokeStyle = "#d7fffb";
    c.lineWidth = 2;
    c.stroke();
    label(c, String(p.id + 1), p.x, p.y + 1, 22, "#062332", "center", 900);
    if (carrier) {
      this.drawBall(p.x + 25, p.y + 18, 0.3);
      label(c, "YOU", p.x, p.y - 48, 11, "#fff", "center", 900);
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
    c.lineWidth = 2;
    c.stroke();
    c.restore();
    c.strokeStyle = "#fff0f4";
    c.lineWidth = 3.2;
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
    c.shadowBlur = 11;
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
        worldY = milestone ? 505 : Math.max(100, (e.y || 310) - 54 - rise);
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
        badgeX = c._tikiPortrait
          ? milestone
            ? 135
            : portraitScreenY
          : worldX,
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
      if (c._tikiPortrait)
        this.upright(badgeX, badgeY, drawBadge);
      else drawBadge();
    } else if (e.type === "score" || e.type === "focus") {
      const focus = e.type === "focus",
        worldY =
          e.y - (this.reducedMotion ? 10 : t * 38) - 16 + (focus ? 27 : 0);
      c.font = `800 ${focus ? 12 : 15}px ${FONT}`;
      const w = c.measureText(e.text).width + 28,
        worldX = Math.max(55 + w / 2, Math.min(945 - w / 2, e.x)),
        screenX = Math.max(
          5 + w / 2,
          Math.min(HEIGHT - 5 - w / 2, HEIGHT - worldY),
        ),
        screenY = Math.max(20, Math.min(WIDTH - 20, worldX)),
        badgeX = c._tikiPortrait ? screenY : worldX,
        badgeY = c._tikiPortrait ? HEIGHT - screenX : worldY,
        drawBadge = () => {
          rounded(c, badgeX - w / 2, badgeY - 15, w, 30, 15);
          c.fillStyle = "rgba(8,12,31,.94)";
          c.fill();
          c.strokeStyle = focus ? this.venue.accent : "#ffd32f";
          c.stroke();
          label(
            c,
            e.text,
            badgeX,
            badgeY,
            focus ? 12 : 15,
            "#fff",
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
          c.fillStyle = i % 2 ? this.venue.accent : "#ffd32f";
          c.fill();
        }
    } else if (!this.reducedMotion) {
      circle(c, e.x, e.y, 8 + t * 29);
      c.strokeStyle = e.type === "wall" ? "#ffd32f" : "#fff";
      c.lineWidth = 2 * (1 - t);
      c.stroke();
    }
    c.restore();
  }
}
