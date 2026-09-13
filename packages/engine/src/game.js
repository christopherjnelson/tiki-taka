export const WIDTH = 1000,
  HEIGHT = 620;
export const LIMITS = { left: 50, right: 950, top: 50, bottom: 570 };
export const FOCUS_REWARDS = { split: 4, triangle: 3, zone: 2, ole: 4, wall: 0 };
export const TRIANGLE_WINDOW = 3.5;
export const TRIANGLE_MAX_HOLD = 1.2;
export const MAX_HOLD = 6;
// Shared with the Canvas renderer so zone overlap exactly matches the visible
// player disc.
export const PLAYER_RADIUS = 24;
export const TEAMMATE_RUN_SPEED = 58;
export const SHOUT_RUN_SPEED_MULTIPLIER = 1.6;
export const PASS_DISTANCE = {
  near: 180,
  far: 520,
  maxPassMultiplier: 1.5,
  splitInfluence: 0.5,
};
export const SPLIT_PRESS = {
  narrow: 70,
  wide: 200,
  base: 50,
  tight: 50,
  perDefender: 0.3,
};
// Ordered by precedence: the label a pass shows is the first bonus it earned.
export const BONUS_LABELS = {
  split: "SPLIT THE PRESS",
  triangle: "TRIANGLE",
  zone: "ZONE BONUS",
  ole: "OLÉ!",
  wall: "WALL PLAY",
};
export const ONE_TOUCH = {
  window: 0.35,
  moveTolerance: 8,
  passBonus: 5,
  milestoneEvery: 10,
  milestoneBonus: 50,
  milestoneFocus: 4,
};
// Boost spends the same earned Focus reserve as slow motion, but consumes energy
// three times as fast while applying only to the carrier's movement.
export const BOOST_SPEED_MULTIPLIER = 1.75;
export const BOOST_DRAIN_RATE = 3;
export const TACTICS = {
  balanced: {
    name: "Playmaker",
    label: "A little more time to see the pass.",
    speed: 155,
    ballSpeed: 690,
    focus: 10,
  },
  runner: {
    name: "Mover",
    label: "Quick feet. Less time in focus.",
    speed: 195,
    ballSpeed: 640,
    focus: 6,
  },
  maestro: {
    name: "Conductor",
    label: "Faster passes. A calmer first touch.",
    speed: 135,
    ballSpeed: 840,
    focus: 8,
  },
};
export const COURTS = [
  {
    name: "The Courtyard",
    place: "LISBON, PORTUGAL",
    short: "Find your rhythm",
    target: 600,
    time: 90,
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
    time: 90,
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
    time: 90,
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
    time: 90,
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
    time: 90,
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
export function passDistanceMultiplier(length) {
  const progress = clamp(
    (length - PASS_DISTANCE.near) / (PASS_DISTANCE.far - PASS_DISTANCE.near),
    0,
    1,
  );
  return 1 + progress * (PASS_DISTANCE.maxPassMultiplier - 1);
}
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
// Signed area of the triangle o->a->b: positive when b sits left of o->a.
const orient = (o, a, b) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
// A proper crossing: each segment has one endpoint strictly either side of the
// other. Strict inequalities so touching at a point or lying collinear is not a
// crossing.
export function segmentsCross(p1, p2, p3, p4) {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}
// The pass splits a pair when it passes between them: the lane crosses the
// segment joining the two defenders. Difficulty is how narrow that pair is, so
// among every crossed pair we keep the tightest gap threaded.
export function splitTightness(defenders, lane) {
  let separation = null;
  for (let s = 0; s < lane.length - 1; s++) {
    for (let a = 0; a < defenders.length; a++) {
      for (let b = a + 1; b < defenders.length; b++) {
        if (!segmentsCross(lane[s], lane[s + 1], defenders[a], defenders[b]))
          continue;
        const gap = distance(defenders[a], defenders[b]);
        if (separation === null || gap < separation) separation = gap;
      }
    }
  }
  if (separation === null) return null;
  return clamp(
    (SPLIT_PRESS.wide - separation) / (SPLIT_PRESS.wide - SPLIT_PRESS.narrow),
    0,
    1,
  );
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
  // The Daily circuit's premise is "one day, one shared course" for every
  // player, so it is always run at the standard tier regardless of the
  // selection remembered elsewhere. applyDifficulty forces this too (it
  // recognizes a daily config by its `key`), but stamping it here keeps a
  // bare `dailyConfig()` result already correct for callers that never pass
  // it through applyDifficulty.
  return applyDifficulty(
    {
      name: "Daily circuit",
      place: "ONE DAY. ONE SHARED COURT.",
      short: key,
      target: 500,
      time: 90,
      speed: 100 + (seed % 12),
      defenders: 3,
      seed,
      description:
        "The same formation and pressure for everyone today. Beat your personal best.",
      key,
    },
    "standard",
  );
}
// Tier multipliers layered on top of each court's own ramp (COURTS above).
// Standard is exactly today's numbers - it must never change these values.
const DIFFICULTY_TIERS = {
  relaxed: { targetMultiplier: 0.7, possessions: 5, speedMultiplier: 0.9, defenderBonus: 0 },
  standard: { targetMultiplier: 1, possessions: 3, speedMultiplier: 1, defenderBonus: 0 },
  ruthless: { targetMultiplier: 1.3, possessions: 1, speedMultiplier: 1.12, defenderBonus: 1 },
};
export const DIFFICULTIES = [
  {
    id: "relaxed",
    name: "Relaxed",
    label: "Softer targets and extra lives. Find your rhythm first.",
  },
  {
    id: "standard",
    name: "Standard",
    label: "The intended challenge, exactly as built.",
  },
  {
    id: "ruthless",
    name: "Ruthless",
    label: "Tighter targets, a quicker press, only one life.",
  },
];
export const MAX_DEFENDERS = 5;
// Pure: returns a new config with the tier's multipliers applied, never
// mutating `config`. Daily configs (identified by their `key`) are always
// forced to standard, matching the Daily circuit's "one shared course"
// premise regardless of what tier is otherwise selected.
export function applyDifficulty(config, tier) {
  const requested = config?.key ? "standard" : tier;
  const id = Object.hasOwn(DIFFICULTY_TIERS, requested) ? requested : "standard";
  const scale = DIFFICULTY_TIERS[id];
  return {
    ...config,
    target: Math.round(((config.target || 0) * scale.targetMultiplier) / 50) * 50,
    possessions: scale.possessions,
    speed: (config.speed || 0) * scale.speedMultiplier,
    defenders: Math.min(MAX_DEFENDERS, (config.defenders || 0) + scale.defenderBonus),
    difficulty: id,
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
    this.splits = 0;
    this.oles = 0;
    this.focus = 0;
    this.focusActive = false;
    this.focusNeedsRelease = false;
    this.boostActive = false;
    this.boostNeedsRelease = false;
    this.hold = 0;
    this.grace = 1.5;
    this.lock = 0;
    this.passCooldown = 0;
    this.status = "playing";
    this.history = [0];
    this.historyTimes = [0];
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
    this.historyTimes = [this.elapsed || 0];
    this.grace = 1.5;
    this.passCooldown = 0;
    this.oneTouchStreak = 0;
    this.oneTouchAge = 0;
    this.oneTouchDistance = 0;
    this.oneTouchEligible = false;
    this.queuedPass = null;
  }
  emit(type, text, x, y, extra) {
    this.events.push({ type, text, x, y, ...extra });
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
    if (this.historyTimes?.length) {
      this.historyTimes[this.historyTimes.length - 1] = this.elapsed;
    }
    const oneTouch =
      this.oneTouchEligible &&
      this.oneTouchAge <= ONE_TOUCH.window &&
      this.oneTouchDistance <= ONE_TOUCH.moveTolerance;
    if (!oneTouch) this.oneTouchStreak = 0;
    this.oneTouchEligible = false;
    const from = this.players[this.carrier],
      to = this.players[id];
    const waypoint = bank ? bankPoint(from, to) : null;
    const lane = waypoint
      ? [
          { x: from.x, y: from.y },
          { ...waypoint },
          { x: to.x, y: to.y },
        ]
      : [
          { x: from.x, y: from.y },
          { x: to.x, y: to.y },
        ];
    this.ball = {
      x: from.x,
      y: from.y,
      from: this.carrier,
      to: id,
      bank,
      bounced: false,
      waypoint,
      // Distance rewards the actual passer-to-receiver progression, not an
      // optional wall detour. Wall passes retain their separate flat bonus.
      passDistance: distance(from, to),
      split: splitTightness(this.defenders, lane),
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
  // A shout is an intent for an off-ball teammate, not a pass and not a
  // scoring action. The intent stays with the live zone until it rotates so a
  // teammate who arrives early does not immediately drift back out of it.
  shout(id) {
    const teammate = this.players[id];
    if (
      this.status !== "playing" ||
      !teammate ||
      id === this.carrier ||
      id === this.ball?.to ||
      !this.zone
    )
      return false;
    for (const player of this.players) player.shoutTarget = null;
    teammate.shoutTarget = { zoneIndex: this.zoneIndex };
    return true;
  }
  receive() {
    const ball = this.ball;
    const queued = this.queuedPass;
    this.queuedPass = null;
    this.carrier = ball.to;
    this.players[this.carrier].shoutTarget = null;
    this.ball = null;
    this.hold = 0;
    this.grace = 0.55;
    this.passCooldown = 0.12;
    this.passes++;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    const multiplier = 1 + Math.min(4, Math.floor(this.combo / 4));
    const repeat = this.history.at(-2) === this.carrier;
    const distanceMultiplier = passDistanceMultiplier(ball.passDistance);
    let points =
      Math.round((repeat ? 6 : 12) * distanceMultiplier) * multiplier;
    const bonuses = [];
    const p = this.players[this.carrier];
    let focusReward = 0;
    if (ball.bank) {
      this.banks++;
      points += 18 * multiplier;
      bonuses.push("wall");
    }
    this.history.push(this.carrier);
    this.historyTimes.push(this.elapsed);
    if (this.history.length > 4) {
      this.history.shift();
      this.historyTimes.shift();
    }
    const triangleElapsed =
      this.historyTimes.length >= 4
        ? this.elapsed - this.historyTimes.at(-4)
        : Infinity;
    const completesTriangle =
      this.history.length >= 4 &&
      this.history.at(-4) === this.carrier &&
      new Set(this.history.slice(-3)).size === 3 &&
      triangleElapsed <= TRIANGLE_WINDOW;
    let triangleCoords = null;
    if (ball.split !== null && !completesTriangle) {
      // Splitting two of three is far harder than two of two, so the reward
      // scales with how crowded the court is. Long passes add up to half of
      // the ordinary pass-distance multiplier so the geometry matters without
      // overwhelming the split's tightness. Focus stays flat.
      const countScale =
        1 + SPLIT_PRESS.perDefender * (this.defenders.length - 2);
      const splitDistanceMultiplier =
        1 + (distanceMultiplier - 1) * PASS_DISTANCE.splitInfluence;
      points +=
        Math.round(
          (SPLIT_PRESS.base + SPLIT_PRESS.tight * ball.split) *
            countScale *
            splitDistanceMultiplier,
        ) * multiplier;
      this.splits++;
      bonuses.push("split");
      focusReward += FOCUS_REWARDS.split;
    }
    if (completesTriangle) {
      points += 35 * multiplier;
      this.triangles++;
      bonuses.push("triangle");
      focusReward += FOCUS_REWARDS.triangle;
      if (this.config.endless) this.time += 5;
      const ids = Array.from(new Set(this.history.slice(-4)));
      triangleCoords = ids.map((id) => ({
        id,
        x: this.players[id].x,
        y: this.players[id].y,
      }));
      // A completed triangle starts a fresh passing sequence. This prevents
      // A-B-C-A-B from paying another triangle on the very next reception.
      this.history = [this.carrier];
      this.historyTimes = [this.elapsed];
    }
    if (
      this.zone &&
      distance(p, this.zone) <= this.zone.r + PLAYER_RADIUS
    ) {
      points += 25 * multiplier;
      this.zones++;
      bonuses.push("zone");
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
      bonuses.push("one-touch");
      if (milestone) {
        bonuses.push("ole");
        this.oles++;
        focusReward += ONE_TOUCH.milestoneFocus;
      }
    }
    this.score += points;
    // Several bonuses can land on one pass; the label shows the best of them
    // while `bonuses` carries the full list for the popup stack.
    const best = Object.keys(BONUS_LABELS).find((key) => bonuses.includes(key));
    this.emit(
      "score",
      `${best ? BONUS_LABELS[best] : "PASS"} +${points}`,
      p.x,
      p.y - 25,
      { bonuses, points, bestBonus: best || null, triangle: triangleCoords },
    );
    if (!ball.focusUsed && focusReward > 0) {
      const gained = Math.min(focusReward, this.tactic.focus - this.focus);
      if (gained > 0) {
        this.focus += gained;
        this.emit("focus", `+${Math.round(gained)} ENERGY`, p.x, p.y);
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
    this.focusActive = false;
    this.boostActive = false;
    this.lock = 1.2;
    this.emit("turnover", reason, 500, 310);
    const possessions = Number.isFinite(this.config.possessions)
      ? this.config.possessions
      : 3;
    if (this.turnovers >= possessions && !this.config.practice) {
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
    for (const player of this.players) player.shoutTarget = null;
    this.focusActive = false;
    this.boostActive = false;
    this.emit("end", "");
  }
  update(dt, input = {}) {
    if (this.status !== "playing") return;
    dt = clamp(dt, 0, 0.05);
    // Both abilities draw the same charge. Once that charge is empty, a
    // player must release both held ability controls before either one can
    // activate again; switching triggers cannot bypass the release gate.
    if (!input.focus && !input.boost) {
      this.focusNeedsRelease = false;
      this.boostNeedsRelease = false;
    }
    if ((input.focus || input.boost) && this.focus <= 0) {
      this.focusNeedsRelease = true;
      this.boostNeedsRelease = true;
    }
    if (this.lock > 0) {
      this.focusActive = false;
      this.boostActive = false;
      this.lock = Math.max(0, this.lock - dt);
      return;
    }
    // Boost owns the shared meter if both controls arrive in one frame. Slow
    // motion would otherwise reduce the very movement Boost is meant to aid.
    const boostRequested = input.boost && !this.boostNeedsRelease;
    const focusedTime =
      !boostRequested && input.focus && !this.focusNeedsRelease
        ? Math.min(dt, this.focus)
        : 0;
    const boostedTime =
      boostRequested &&
      !this.ball
        ? Math.min(dt, this.focus / BOOST_DRAIN_RATE)
        : 0;
    this.focusActive = focusedTime > 0;
    this.boostActive = boostedTime > 0;
    this.focus = clamp(
      this.focus - focusedTime - boostedTime * BOOST_DRAIN_RATE,
      0,
      this.tactic.focus,
    );
    if ((input.focus || input.boost) && this.focus <= 0) {
      this.focusNeedsRelease = true;
      this.boostNeedsRelease = true;
    }
    if (this.ball && this.focusActive) this.ball.focusUsed = true;
    const delta = dt - focusedTime * 0.68;
    if (!this.config.practice) {
      this.time -= delta;
    }
    this.elapsed += delta;
    this.motionTime += delta;
    this.zoneTimer -= delta;
    if (!this.config.practice && this.time <= 0) {
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
      // When the charge runs out within a frame, only the portion actually
      // boosted gets the additional distance. This keeps outcomes stable for
      // different frame partitions.
      const movementTime =
        delta + boostedTime * (BOOST_SPEED_MULTIPLIER - 1);
      p.x = clamp(p.x + mx * this.tactic.speed * movementTime, 80, 920);
      p.y = clamp(p.y + my * this.tactic.speed * movementTime, 80, 540);
      if (this.oneTouchEligible) {
        this.oneTouchDistance += Math.hypot(p.x - oldX, p.y - oldY);
        if (this.oneTouchDistance > ONE_TOUCH.moveTolerance) {
          this.oneTouchEligible = false;
          this.oneTouchStreak = 0;
        }
      }
      this.hold += delta;
      if (this.hold > TRIANGLE_MAX_HOLD && this.history.length > 1) {
        this.history = [this.carrier];
        this.historyTimes = [this.elapsed];
      }
      if (this.hold >= MAX_HOLD) {
        this.turnover("HELD TOO LONG");
        return;
      }
    }
    for (const teammate of this.players) {
      if (teammate.id === this.carrier || this.ball?.to === teammate.id)
        continue;
      const t = this.motionTime * 0.55 + teammate.phase;
      let tx = teammate.home.x + Math.sin(t) * 65,
        ty = teammate.home.y + Math.cos(t * 0.8) * 42;
      const shouted =
        teammate.shoutTarget?.zoneIndex === this.zoneIndex && this.zone;
      if (shouted) {
        tx = this.zone.x;
        ty = this.zone.y;
      } else {
        teammate.shoutTarget = null;
      }
      // A shouted run still respects the same pressure avoidance as normal
      // teammate movement; the zone is the intention, not a straight-line
      // command through a defender.
      for (const d of this.defenders) {
        const dist = distance(teammate, d);
        if (dist < 125) {
          tx += (teammate.x - d.x) * 0.65;
          ty += (teammate.y - d.y) * 0.65;
        }
      }
      const gap = Math.hypot(tx - teammate.x, ty - teammate.y);
      if (gap > 2) {
        const runSpeed =
          TEAMMATE_RUN_SPEED * (shouted ? SHOUT_RUN_SPEED_MULTIPLIER : 1);
        const step = Math.min(gap, runSpeed * delta);
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
