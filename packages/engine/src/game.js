export const WIDTH = 1000,
  HEIGHT = 620;
export const LIMITS = { left: 50, right: 950, top: 50, bottom: 570 };
export const FOCUS_REWARDS = { triangle: 1.5, zone: 1, through: 0.75, wall: 0.5 };
export const THROUGH_BALL = { radius: 45, base: 20, tight: 14 };
export const ONE_TOUCH = {
  window: 0.35,
  moveTolerance: 8,
  passBonus: 5,
  milestoneEvery: 10,
  milestoneBonus: 50,
};
export const TACTICS = {
  balanced: {
    name: "Playmaker",
    label: "A little more time to see the pass.",
    speed: 155,
    ballSpeed: 690,
    focus: 5,
  },
  runner: {
    name: "Mover",
    label: "Quick feet. Less time in focus.",
    speed: 195,
    ballSpeed: 640,
    focus: 3,
  },
  maestro: {
    name: "Conductor",
    label: "Faster passes. A calmer first touch.",
    speed: 135,
    ballSpeed: 840,
    focus: 4,
  },
};
export const COURTS = [
  {
    name: "The Courtyard",
    place: "LISBON, PORTUGAL",
    short: "Find your rhythm",
    target: 600,
    time: 75,
    speed: 76,
    defenders: 2,
    seed: 41,
    description: "Room to breathe. Find the spare player and keep it moving.",
  },
  {
    name: "Concrete Club",
    place: "LONDON, ENGLAND",
    short: "Beat the press",
    target: 900,
    time: 75,
    speed: 91,
    defenders: 3,
    seed: 117,
    description:
      "A third defender joins the press. Create space before you pass.",
  },
  {
    name: "El Patio",
    place: "BARCELONA, SPAIN",
    short: "Think in triangles",
    target: 1200,
    time: 80,
    speed: 100,
    defenders: 3,
    seed: 272,
    description: "Three different teammates in a row unlock a triangle bonus.",
  },
  {
    name: "After Hours",
    place: "TOKYO, JAPAN",
    short: "Work the walls",
    target: 1600,
    time: 80,
    speed: 110,
    defenders: 3,
    seed: 525,
    description:
      "Passing lanes close quickly. Bank the ball around the pressure.",
  },
  {
    name: "The Cage",
    place: "SÃO PAULO, BRAZIL",
    short: "Make your own space",
    target: 2000,
    time: 85,
    speed: 115,
    defenders: 4,
    seed: 808,
    description:
      "Four defenders. Every movement matters. Focus is your friend.",
  },
  {
    name: "Total Football",
    place: "AMSTERDAM, NETHERLANDS",
    short: "Own the rhythm",
    target: 2400,
    time: 90,
    speed: 123,
    defenders: 4,
    seed: 1974,
    description:
      "Your final test. Turn pressure into beautiful, continuous possession.",
  },
];
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function segmentDistance(p, a, b) {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const t = clamp(
    ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1),
    0,
    1,
  );
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}
export function bankPoint(a, b) {
  const { left, right, top, bottom } = LIMITS;
  const candidates = [
    { x: b.x, y: 2 * top - b.y, axis: "y", edge: top },
    { x: b.x, y: 2 * bottom - b.y, axis: "y", edge: bottom },
    { x: 2 * left - b.x, y: b.y, axis: "x", edge: left },
    { x: 2 * right - b.x, y: b.y, axis: "x", edge: right },
  ].map((v) => {
    const t = (v.edge - a[v.axis]) / (v[v.axis] - a[v.axis]);
    return { x: a.x + (v.x - a.x) * t, y: a.y + (v.y - a.y) * t };
  });
  return candidates.sort(
    (p, q) =>
      distance(a, p) + distance(p, b) - (distance(a, q) + distance(q, b)),
  )[0];
}
export function dailyConfig(date = new Date()) {
  const key = date.toISOString().slice(0, 10);
  let seed = 0;
  for (const c of key) seed = (Math.imul(seed, 31) + c.charCodeAt(0)) >>> 0;
  return {
    name: "Daily circuit",
    place: "ONE DAY. ONE SHARED COURT.",
    short: key,
    target: 500,
    time: 80,
    speed: 100 + (seed % 12),
    defenders: 3,
    seed,
    description:
      "The same formation and pressure for everyone today. Beat your personal best.",
    key,
  };
}
export class Game {
  constructor(config = COURTS[0], tactic = "balanced") {
    this.config = { ...config };
    this.tactic = TACTICS[tactic] || TACTICS.balanced;
    this.rng = seeded(config.seed);
    this.players = [];
    this.defenders = [];
    this.ball = null;
    this.carrier = 0;
    this.score = 0;
    this.time = config.time;
    this.elapsed = 0;
    this.passes = 0;
    this.turnovers = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.oneTouchStreak = 0;
    this.bestOneTouch = 0;
    this.oneTouchAge = 0;
    this.oneTouchDistance = 0;
    this.oneTouchEligible = false;
    this.queuedPass = null;
    this.triangles = 0;
    this.banks = 0;
    this.zones = 0;
    this.throughBalls = 0;
    this.focus = 0;
    this.focusActive = false;
    this.focusNeedsRelease = false;
    this.hold = 0;
    this.grace = 1.5;
    this.lock = 0;
    this.passCooldown = 0;
    this.status = "playing";
    this.history = [0];
    this.events = [];
    this.zoneIndex = 0;
    this.zoneTimer = 12;
    this.motionTime = 0;
    this.zone = { x: 735, y: 400, r: 92 };
    this.resetPositions();
  }
  resetPositions() {
    const spots = [
      { x: 285, y: 310 },
      { x: 505, y: 155 },
      { x: 770, y: 290 },
      { x: 510, y: 470 },
    ];
    this.players = spots.map((p, i) => ({
      ...p,
      home: { ...p },
      id: i,
      phase: this.rng() * 6.28,
    }));
    this.defenders = Array.from({ length: this.config.defenders }, (_, i) => ({
      x: 570 + (i % 2) * 85,
      y: 240 + Math.floor(i / 2) * 120,
      id: i,
    }));
    this.carrier = 0;
    this.ball = null;
    this.hold = 0;
    this.history = [0];
    this.grace = 1.5;
    this.passCooldown = 0;
    this.oneTouchStreak = 0;
    this.oneTouchAge = 0;
    this.oneTouchDistance = 0;
    this.oneTouchEligible = false;
    this.queuedPass = null;
  }
  emit(type, text, x, y) {
    this.events.push({ type, text, x, y });
  }
  bestTarget(aim) {
    const from = this.players[this.carrier];
    const options = this.players.filter((p) => p.id !== this.carrier);
    return options.sort(
      (a, b) =>
        this.targetValue(b, from, aim) - this.targetValue(a, from, aim),
    )[0].id;
  }
  bestQueuedTarget(aim) {
    if (!this.ball) return null;
    const from = this.players[this.ball.to];
    const options = this.players.filter((p) => p.id !== this.ball.to);
    return options.sort(
      (a, b) =>
        this.targetValue(b, from, aim, this.ball.from) -
        this.targetValue(a, from, aim, this.ball.from),
    )[0].id;
  }
  targetValue(p, from, aim, previous = this.history.at(-2)) {
    let value = this.defenders.length
      ? Math.min(...this.defenders.map((d) => segmentDistance(d, from, p))) *
        0.01
      : 0;
    if (aim && Math.hypot(aim.x, aim.y) > 0.2)
      value +=
        (5 * ((p.x - from.x) * aim.x + (p.y - from.y) * aim.y)) /
        (distance(p, from) * Math.hypot(aim.x, aim.y));
    if (previous === p.id) value -= 0.6;
    return value;
  }
  pass(id, bank = false) {
    if (
      this.status !== "playing" ||
      this.ball ||
      this.lock > 0 ||
      this.passCooldown > 0 ||
      id === this.carrier ||
      !this.players[id]
    )
      return false;
    const oneTouch =
      this.oneTouchEligible &&
      this.oneTouchAge <= ONE_TOUCH.window &&
      this.oneTouchDistance <= ONE_TOUCH.moveTolerance;
    if (!oneTouch) this.oneTouchStreak = 0;
    this.oneTouchEligible = false;
    const from = this.players[this.carrier],
      to = this.players[id];
    const waypoint = bank ? bankPoint(from, to) : null;
    this.ball = {
      x: from.x,
      y: from.y,
      from: this.carrier,
      to: id,
      bank,
      bounced: false,
      waypoint,
      route: waypoint
        ? [{ x: from.x, y: from.y }, { ...waypoint }]
        : [{ x: from.x, y: from.y }],
      focusUsed: false,
      oneTouch,
      trail: [],
    };
    this.emit("kick", "", from.x, from.y);
    return true;
  }
  queuePass(id, bank = false) {
    if (
      this.status !== "playing" ||
      !this.ball ||
      this.lock > 0 ||
      id === this.ball.to ||
      !this.players[id]
    )
      return false;
    this.queuedPass = { id, bank: !!bank };
    return true;
  }
  clearQueuedPass() {
    this.queuedPass = null;
  }
  receive() {
    const ball = this.ball;
    const queued = this.queuedPass;
    this.queuedPass = null;
    this.carrier = ball.to;
    this.ball = null;
    this.hold = 0;
    this.grace = 0.55;
    this.passCooldown = 0.12;
    this.passes++;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const multiplier = 1 + Math.min(4, Math.floor(this.combo / 4));
    const repeat = this.history.at(-2) === this.carrier;
    let points = (repeat ? 6 : 12) * multiplier;
    let label = `+${points}`;
    const p = this.players[this.carrier];
    let focusReward = 0;
    if (ball.bank) {
      this.banks++;
      points += 18 * multiplier;
      label = "WALL PLAY";
      focusReward += FOCUS_REWARDS.wall;
    }
    const lane = [...ball.route, { x: p.x, y: p.y }];
    const threaded = this.defenders
      .map((d) =>
        Math.min(
          ...lane.slice(1).map((end, i) => segmentDistance(d, lane[i], end)),
        ),
      )
      .filter((gap) => gap < THROUGH_BALL.radius)
      .sort((a, b) => a - b);
    if (threaded.length >= 2) {
      const tightness = clamp(
        1 - (threaded[0] + threaded[1]) / (2 * THROUGH_BALL.radius),
        0,
        1,
      );
      points +=
        Math.round(THROUGH_BALL.base + THROUGH_BALL.tight * tightness) *
        multiplier;
      this.throughBalls++;
      label = "THROUGH BALL";
      focusReward += FOCUS_REWARDS.through;
    }
    this.history.push(this.carrier);
    if (this.history.length > 4) this.history.shift();
    if (
      this.history.length >= 4 &&
      this.history.at(-4) === this.carrier &&
      new Set(this.history.slice(-3)).size === 3
    ) {
      points += 35 * multiplier;
      this.triangles++;
      label = "TRIANGLE";
      focusReward += FOCUS_REWARDS.triangle;
      if (this.config.endless) this.time += 5;
    }
    if (distance(p, this.zone) < this.zone.r) {
      points += 25 * multiplier;
      this.zones++;
      label = "ZONE BONUS";
      focusReward += FOCUS_REWARDS.zone;
      this.rotateZone();
    }
    let oneTouchBonus = 0;
    let milestone = false;
    if (ball.oneTouch) {
      this.oneTouchStreak++;
      this.bestOneTouch = Math.max(this.bestOneTouch, this.oneTouchStreak);
      milestone = this.oneTouchStreak % ONE_TOUCH.milestoneEvery === 0;
      oneTouchBonus =
        ONE_TOUCH.passBonus + (milestone ? ONE_TOUCH.milestoneBonus : 0);
      points += oneTouchBonus;
    }
    this.score += points;
    this.emit(
      "score",
      `${label.startsWith("+") ? "PASS" : label} +${points}`,
      p.x,
      p.y - 25,
    );
    if (!ball.focusUsed && focusReward > 0) {
      const gained = Math.min(focusReward, this.tactic.focus - this.focus);
      if (gained > 0) {
        this.focus += gained;
        this.emit("focus", `FOCUS +${gained.toFixed(1)}s`, p.x, p.y);
      }
    }
    if (ball.oneTouch) {
      this.events.push({
        type: "one-touch",
        text: `ONE TOUCH ×${this.oneTouchStreak} +${oneTouchBonus}`,
        x: p.x,
        y: p.y,
        streak: this.oneTouchStreak,
        bonus: oneTouchBonus,
        milestone,
      });
    }
    this.oneTouchAge = 0;
    this.oneTouchDistance = 0;
    this.oneTouchEligible = true;
    if (queued) {
      this.passCooldown = 0;
      this.pass(queued.id, queued.bank);
    }
  }
  rotateZone() {
    const zones = [
      { x: 260, y: 185 },
      { x: 735, y: 430 },
      { x: 730, y: 170 },
      { x: 265, y: 445 },
    ];
    this.zoneIndex =
      (this.zoneIndex + 1 + Math.floor(this.rng() * 2)) % zones.length;
    this.zone = { ...zones[this.zoneIndex], r: 92 };
    this.zoneTimer = 12;
  }
  turnover(reason) {
    this.turnovers++;
    this.combo = 0;
    this.oneTouchStreak = 0;
    this.oneTouchAge = 0;
    this.oneTouchDistance = 0;
    this.oneTouchEligible = false;
    this.clearQueuedPass();
    this.lock = 1.2;
    this.emit("turnover", reason, 500, 310);
    if (this.turnovers >= 3 && !this.config.practice) {
      this.status = "finished";
      this.emit("end", "");
      return;
    }
    this.resetPositions();
  }
  finish() {
    this.time = 0;
    this.status = "finished";
    this.clearQueuedPass();
    this.emit("end", "");
  }
  update(dt, input = {}) {
    if (this.status !== "playing") return;
    dt = clamp(dt, 0, 0.05);
    if (!input.focus) this.focusNeedsRelease = false;
    if (input.focus && this.focus <= 0) this.focusNeedsRelease = true;
    if (this.lock > 0) {
      this.focusActive = false;
      this.lock = Math.max(0, this.lock - dt);
      return;
    }
    const focusedTime =
      input.focus && !this.focusNeedsRelease ? Math.min(dt, this.focus) : 0;
    this.focusActive = focusedTime > 0;
    this.focus = clamp(this.focus - focusedTime, 0, this.tactic.focus);
    if (input.focus && this.focus <= 0) this.focusNeedsRelease = true;
    if (this.ball && this.focusActive) this.ball.focusUsed = true;
    const delta = dt - focusedTime * 0.68;
    this.time -= delta;
    this.elapsed += delta;
    this.motionTime += delta;
    this.zoneTimer -= delta;
    if (this.time <= 0) {
      this.finish();
      return;
    }
    if (this.zoneTimer <= 0) this.rotateZone();
    this.grace = Math.max(0, this.grace - delta);
    this.passCooldown = Math.max(0, this.passCooldown - delta);
    const p = this.players[this.carrier];
    if (!this.ball) {
      if (this.oneTouchEligible) {
        this.oneTouchAge += dt;
        if (this.oneTouchAge > ONE_TOUCH.window) {
          this.oneTouchEligible = false;
          this.oneTouchStreak = 0;
        }
      }
      let mx = input.x || 0,
        my = input.y || 0;
      const m = Math.hypot(mx, my);
      if (m > 1) {
        mx /= m;
        my /= m;
      }
      const oldX = p.x,
        oldY = p.y;
      p.x = clamp(p.x + mx * this.tactic.speed * delta, 80, 920);
      p.y = clamp(p.y + my * this.tactic.speed * delta, 80, 540);
      if (this.oneTouchEligible) {
        this.oneTouchDistance += Math.hypot(p.x - oldX, p.y - oldY);
        if (this.oneTouchDistance > ONE_TOUCH.moveTolerance) {
          this.oneTouchEligible = false;
          this.oneTouchStreak = 0;
        }
      }
      this.hold += delta;
    }
    for (const teammate of this.players) {
      if (teammate.id === this.carrier || this.ball?.to === teammate.id)
        continue;
      const t = this.motionTime * 0.55 + teammate.phase;
      let tx = teammate.home.x + Math.sin(t) * 65,
        ty = teammate.home.y + Math.cos(t * 0.8) * 42;
      for (const d of this.defenders) {
        const dist = distance(teammate, d);
        if (dist < 125) {
          tx += (teammate.x - d.x) * 0.65;
          ty += (teammate.y - d.y) * 0.65;
        }
      }
      const gap = Math.hypot(tx - teammate.x, ty - teammate.y);
      if (gap > 2) {
        const step = Math.min(gap, 58 * delta);
        teammate.x = clamp(
          teammate.x + ((tx - teammate.x) / gap) * step,
          90,
          910,
        );
        teammate.y = clamp(
          teammate.y + ((ty - teammate.y) / gap) * step,
          90,
          530,
        );
      }
    }
    const press =
      this.config.speed +
      (this.config.endless ? Math.floor(this.elapsed / 20) * 7 : 0) +
      Math.min(65, this.hold * 9);
    const closest = [...this.defenders].sort(
      (a, b) => distance(a, p) - distance(b, p),
    )[0];
    for (const d of this.defenders) {
      let tx, ty;
      if (d === closest) {
        tx = p.x;
        ty = p.y;
      } else {
        const mark = this.players[(this.carrier + d.id + 1) % 4];
        tx = p.x * 0.35 + mark.x * 0.65;
        ty = p.y * 0.35 + mark.y * 0.65;
      }
      if (this.ball && distance(d, this.ball) < 145) {
        tx = this.ball.x;
        ty = this.ball.y;
      }
      for (const other of this.defenders) {
        if (other === d) continue;
        const gap = distance(d, other);
        if (gap < 48) {
          tx += (d.x - other.x) * 1.3;
          ty += (d.y - other.y) * 1.3;
        }
      }
      const dist = Math.hypot(tx - d.x, ty - d.y),
        step = Math.min(dist, press * (d === closest ? 1 : 0.78) * delta);
      if (dist > 0) {
        d.x = clamp(d.x + ((tx - d.x) / dist) * step, 65, 935);
        d.y = clamp(d.y + ((ty - d.y) / dist) * step, 65, 555);
      }
      if (!this.ball && this.grace <= 0 && distance(d, p) < 29) {
        this.turnover("CAUGHT IN POSSESSION");
        return;
      }
    }
    if (this.ball) {
      const b = this.ball;
      const destination = b.waypoint || this.players[b.to];
      const dist = distance(b, destination);
      const step = Math.min(dist, this.tactic.ballSpeed * delta);
      const old = { x: b.x, y: b.y };
      if (dist > 0) {
        b.x += ((destination.x - b.x) / dist) * step;
        b.y += ((destination.y - b.y) / dist) * step;
      }
      b.trail.push(old);
      if (b.trail.length > 9) b.trail.shift();
      for (const d of this.defenders) {
        if (segmentDistance(d, old, b) < 20) {
          this.turnover("PASS INTERCEPTED");
          return;
        }
      }
      if (dist <= step + 0.1) {
        if (b.waypoint) {
          b.waypoint = null;
          b.bounced = true;
          this.emit("wall", "", b.x, b.y);
        } else this.receive();
      }
    }
  }
}
