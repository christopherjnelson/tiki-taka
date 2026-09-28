export const WIDTH = 1000,
  HEIGHT = 620;
export const LIMITS = { left: 50, right: 950, top: 50, bottom: 570 };
// Energy paid for a bonus pass, and only for a pass made WITHOUT Focus (see
// the `!ball.focusUsed` gate in arrive) so the ability can never finance
// itself. These were halved when Energy became a burst resource: at the old
// values roughly three bonus passes refilled the entire meter, so a round
// with any flow in it topped you up faster than you could reasonably spend,
// and the drain rate barely mattered.
//
// These stay whole numbers because the floating readout prints the figure
// ("+2 ENERGY"); a 1.5 would either render a decimal or round itself into a
// lie about what was granted. Halving therefore collapses the triangle and
// the zone onto the same payout. Splitting the press still pays the most,
// which is the relationship worth keeping, and the triangle keeps its real
// reward in points (35x the multiplier) either way.
export const FOCUS_REWARDS = { split: 2, triangle: 1, zone: 1, ole: 2, wall: 0 };
export const TRIANGLE_WINDOW = 3.5;
export const TRIANGLE_MAX_HOLD = 1.2;
export const MAX_HOLD = 6;
// Flow is the multiplier's only input. Every bonus builds it, at different
// rates (FLOW_BUILD): a zone pass fastest, an ole, triangle or split less. Wall
// passes and plain passes build nothing. The multiplier reads the whole-number
// part of flow on the curve the zone-only rule used: the first four flow points
// step it by one each; past that, every two earn a step, up to a ceiling.
// Table: flow 1/2/3/4/6/8/10/12/14 -> multiplier 2/3/4/5/6/7/8/9/10.
// Flow is not banked: FLOW_DECAY_SECONDS without a flow-building bonus drops
// one multiplier step (see Game.decayFlow), and a turnover clears it.
export const MULTIPLIER_CEILING = 10;
export const FLOW_BUILD = { zone: 1, ole: 0.75, triangle: 0.5, split: 0.5 };
export const FLOW_DECAY_SECONDS = 6;
export function flowMultiplier(flow) {
  if (!Number.isFinite(flow) || flow <= 0) return 1;
  const hits = Math.floor(flow);
  if (hits <= 0) return 1;
  if (hits <= 4) return hits + 1;
  return Math.min(MULTIPLIER_CEILING, 5 + Math.floor((hits - 4) / 2));
}
// Pure inverse: the smallest flow that yields multiplier `m`.
export function flowForMultiplier(m) {
  if (!Number.isFinite(m) || m <= 1) return 0;
  if (m <= 5) return m - 1;
  return 4 + 2 * (m - 5);
}
export const ZONE_POINTS = 18;
export const ZONE_LIFETIME = 7;
// After a zone ends or is taken, it goes dark for a random beat before the
// next one appears. The gap is what stops a skilled player chaining zones
// faster than intended; it is not visible as the zone "breaking" because the
// renderer telegraphs the next spot fading in across the same window.
export const ZONE_BLIND_GAP = { min: 1, max: 1.5 };
const ZONE_SPOTS = [
  { x: 260, y: 185 },
  { x: 735, y: 430 },
  { x: 730, y: 170 },
  { x: 265, y: 445 },
];
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
  milestoneFocus: 2,
};
// Boost spends the same earned Focus reserve as slow motion, but consumes energy
// three times as fast while applying only to the carrier's movement.
export const BOOST_SPEED_MULTIPLIER = 1.75;
// Energy per second while an ability is held. Focus and Boost cost the same
// now: one shared meter, one price. Before this, Focus drained at 1/s
// against a Playmaker's capacity of 10 - ten full seconds of slow motion per
// bar, refilled by a handful of bonus passes - which made it something you
// rode rather than something you spent. At 4.5 a full bar is about two
// seconds of either ability, so Energy is banked for the moment that needs
// it instead of held down through the round.
export const FOCUS_DRAIN_RATE = 4.5;
export const BOOST_DRAIN_RATE = 4.5;
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
const COURT_DEFS = [
  {
    name: "The Courtyard",
    place: "LISBON, PORTUGAL",
    short: "Find your rhythm",
    reference: 20000,
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
    reference: 20000,
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
    reference: 20000,
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
    reference: 20000,
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
    reference: 20000,
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
    reference: 20000,
    time: 90,
    speed: 123,
    defenders: 4,
    seed: 1974,
    description:
      "Your final test. Turn pressure into beautiful, continuous possession.",
  },
];

// One measured number per court: `reference` is what a clean round - no
// turnover, so the multiplier rides its ceiling - actually scores there. Every
// other threshold is a ratio of it, which is the point of the rewrite: the
// clear line and the star ladder used to be the same number wearing two hats,
// so making the clear line generous dragged the stars down with it and tuning
// the stars made the court unclearable. They are separate dials now.
//
// 20000 is measured on Total Football: Ruthless rounds there land between
// 10k and 17k, and a round that holds a full multiplier throughout reaches
// about 20k. Three stars sits exactly there on purpose - it is the round the
// court is capable of, not a round beyond it.
//
// NOTE: these numbers (and STAR_RATIOS / CLEAR_RATIO below) were measured
// under the old zone-only multiplier. Every bonus now builds flow and flow
// decays when idle, so they need re-measuring by playtest.
//
// PROVISIONAL for courts 1-5, which carry Amsterdam's number until they are
// measured too. The earlier sweep found clean-round scores flat across all
// six, so a flat reference is the honest placeholder rather than an invented
// curve; the progression comes from the clear ratio instead.
export const STAR_RATIOS = { two: 0.75, three: 1 };
// What fraction of the reference a round must score to clear, walked across
// the roster so the entry bar climbs even though every court's reference is
// its own ceiling. Interpolated by position rather than hardcoded per court,
// so a 10-court roster re-spreads the same curve instead of needing new
// numbers - and courts 7-10 cannot simply be bolted past the end of a table.
//
// The star ratios deliberately do NOT ramp: "three stars" should mean "you
// played this court near-perfectly" identically everywhere. The courts get
// harder to survive, not harder to be graded on.
export const CLEAR_RATIO = { first: 0.35, last: 0.5 };
export function clearRatioFor(index, count = COURT_DEFS.length) {
  if (!(count > 1)) return CLEAR_RATIO.first;
  const t = Math.min(1, Math.max(0, index / (count - 1)));
  return CLEAR_RATIO.first + (CLEAR_RATIO.last - CLEAR_RATIO.first) * t;
}
export const COURTS = COURT_DEFS.map((court, index) => ({
  ...court,
  clearRatio: clearRatioFor(index),
}));
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
// Tier multipliers layered on top of each court's own ramp (COURTS above).
// Standard is exactly today's numbers - it must never change these values.
//
// The tier turns possessions and the target; the COURT turns speed and
// defender count. Ruthless used to turn all four, which double-dipped the
// two dials the courts already ramp (76->123 speed, 2->4 defenders) and made
// Ruthless on a court feel like a court you had not played rather than a
// harder version of the one named on the card - The Cage says "Four
// defenders" and Ruthless quietly made it five. It was also nearly out of
// road: MAX_DEFENDERS is 5 and courts 5-6 already sat at 4, so the bonus
// stopped differing exactly where it should have bitten hardest.
//
// scoreMultiplier is not a difficulty knob - it is how much of the court's
// reference this tier's rounds can actually produce. `flow` resets
// on a turnover (and slips a step per idle 6 seconds), so the number of
// possessions a tier grants IS the
// number of times the multiplier is knocked back to x1, and that dominates
// the final score far more than press speed does. Ruthless grants one
// possession, so every Ruthless round that reaches the whistle had no
// turnover at all and rode the multiplier the whole way: it produces the
// reference, by definition, which is why it sits at 1. Standard's three
// possessions mean two resets, Relaxed's five mean four, and they score
// proportionally less.
//
// Reading them as difficulty would invert the design: Ruthless asks for the
// most points and is still the hardest tier, because the hard part is
// surviving to score them at all. Ruthless's extra pay comes from
// FIRST_CLEAR_TIER, which already values it at 1.5x the XP.
//
// PROVISIONAL: 1 is measured (Ruthless on Total Football). 0.7 and 0.5 are
// estimates - one Standard round and one Relaxed round on the same court
// settle them.
//
// Relaxed keeps its gentler press. Halving the target only helps a player
// who can already hold the ball; the speed ease is what lets them hold it,
// and it is the one accessibility lever the tier has on the late courts.
const DIFFICULTY_TIERS = {
  relaxed: { scoreMultiplier: 0.5, possessions: 5, speedMultiplier: 0.9, defenderBonus: 0 },
  standard: { scoreMultiplier: 0.7, possessions: 3, speedMultiplier: 1, defenderBonus: 0 },
  ruthless: { scoreMultiplier: 1, possessions: 1, speedMultiplier: 1, defenderBonus: 0 },
};
// Each tier's own copy plus the concrete numbers behind it, read straight off
// DIFFICULTY_TIERS above so presentation code never re-states (and risks
// disagreeing with) the values actually applied by applyDifficulty(). `label`
// stays plain prose - it also lands verbatim in title/aria-label attributes,
// which render literal text - so any richer, emphasis-worthy copy is built by
// the caller from `facts`, not baked in here.
export const DIFFICULTIES = [
  {
    id: "relaxed",
    name: "Relaxed",
    label: "Softer targets and extra lives. Find your rhythm first.",
    facts: { ...DIFFICULTY_TIERS.relaxed },
  },
  {
    id: "standard",
    name: "Standard",
    label: "The intended challenge, exactly as built.",
    facts: { ...DIFFICULTY_TIERS.standard },
  },
  {
    id: "ruthless",
    name: "Ruthless",
    label: "The same court and the same target, with only one possession.",
    facts: { ...DIFFICULTY_TIERS.ruthless },
  },
];
export const MAX_DEFENDERS = 5;
// Endless is one fixed difficulty that rises with the clock instead of a tier
// picked before kickoff. Two dials move, and only these two: how many
// defenders are on the court, and how fast they close.
//
// The defender ladder is the landmark - the court visibly gains a body at
// each rung, and the fifth is the one players will talk about. It stops at
// MAX_DEFENDERS because that is as crowded as the court can be without the
// avoidance in update() turning the press into a scrum.
//
// The speed ramp deliberately has NO ceiling. A cap would mean the game
// stops getting harder at 3:15, and a player good enough to survive the
// fifth defender at that speed could then hold the ball indefinitely - the
// run would end when they got bored, not when they were beaten. Rising
// forever keeps "last as long as you can" honest: every run ends eventually,
// and how long it took to end is the whole score. The rate is gentle enough
// (about +17 speed per minute) that the difference between two good runs is
// still skill rather than the ramp.
export const ENDLESS_DEFENDER_STEPS = [
  { at: 0, defenders: 2 },
  { at: 45, defenders: 3 },
  { at: 105, defenders: 4 },
  { at: 195, defenders: MAX_DEFENDERS },
];
export const ENDLESS_PRESS = { base: 75, perSecond: 0.28 };
// Endless's own court. It is NOT a member of COURTS: the circuit is six
// venues with targets, stars and a clear line, and this has none of those -
// putting it in that array would give it a court card, a leaderboard tab and
// a place in the progression it is not part of. The court contributes what a
// court contributes (its look, its name, its seed); everything about the
// difficulty comes from the ladder above, which is why it carries no target,
// no reference and no clock.
export const ENDLESS_COURT = {
  name: "Still Water",
  place: "STAY IN THE FLOW",
  short: "Keep it moving",
  venue: "still-water",
  target: 0,
  reference: 0,
  time: 0,
  speed: ENDLESS_PRESS.base,
  defenders: ENDLESS_DEFENDER_STEPS[0].defenders,
  possessions: 1,
  // Every saved round carries a tier column; nothing in an Endless round
  // reads it, because the clock is the only difficulty here.
  difficulty: "standard",
  endless: true,
  description:
    "One possession, and a press that never stops growing. A third defender at 0:45, a fourth at 1:45, a fifth at 3:15 — and they keep getting quicker after that. Last as long as you can.",
};
// Pure: the press the clock has earned at `elapsed` seconds. Exported so the
// UI can telegraph the next rung without re-deriving the ladder.
export function endlessStage(elapsed) {
  const seconds = Math.max(0, Number(elapsed) || 0);
  let step = ENDLESS_DEFENDER_STEPS[0];
  let next = null;
  for (const candidate of ENDLESS_DEFENDER_STEPS) {
    if (seconds >= candidate.at) step = candidate;
    else {
      next = next || candidate;
    }
  }
  return {
    defenders: step.defenders,
    speed: ENDLESS_PRESS.base + seconds * ENDLESS_PRESS.perSecond,
    next,
  };
}
// Pure: returns a new config with the tier's multipliers applied, never
// mutating `config`.
export function applyDifficulty(config, tier) {
  const id = Object.hasOwn(DIFFICULTY_TIERS, tier) ? tier : "standard";
  const scale = DIFFICULTY_TIERS[id];
  // The tier scales the REFERENCE, and the clear line and star rungs are
  // taken from that - so a tier never changes what a star means relative to
  // what its own rounds can score. Relaxed's five possessions reset the
  // multiplier four times, so its rounds top out near half of Standard's;
  // 0.5 keeps three stars as reachable on Relaxed as it is on Standard.
  const reference = Math.round((config.reference || 0) * scale.scoreMultiplier);
  const clearRatio = Number.isFinite(config.clearRatio)
    ? config.clearRatio
    : CLEAR_RATIO.first;
  // A caller that states its own target keeps it. Free practice sets a gentle
  // pacing number and Endless sets 0 to mean "no target at all"; deriving over
  // the top of either silently handed both a real clear line - practice rounds
  // stopped clearing, and Endless grew a denominator it is not scored on.
  const target = Number.isFinite(config.target)
    ? config.target
    : Math.round((reference * clearRatio) / 50) * 50;
  return {
    ...config,
    reference,
    target,
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
    // Endless counts UP: there is no clock to run out, and the seconds
    // survived are the score. Everything that reads game.time - the HUD
    // readout, the results screen - therefore needs no mode branch.
    this.time = config.endless ? 0 : config.time;
    this.elapsed = 0;
    this.passes = 0;
    this.turnovers = 0;
    this.flow = 0;
    this.bestFlow = 0;
    this.flowIdle = 0;
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
    this.zoneTimer = ZONE_LIFETIME;
    this.zoneBlindTimer = 0;
    this.zoneBlindDuration = 0;
    this.nextZone = null;
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
    this.defenders = Array.from({ length: this.defenderCount() }, (_, i) =>
      this.spawnDefender(i),
    );
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
  // How many defenders this round should have right now. Endless reads the
  // clock; every other mode is fixed at kickoff.
  defenderCount() {
    if (this.config.endless) return endlessStage(this.elapsed).defenders;
    return this.config.defenders;
  }
  // Defenders start on the right-hand side of the court in two columns. A
  // defender added mid-round (Endless) uses the same formation slot it would
  // have had at kickoff, so the press never grows out of thin air next to
  // the carrier.
  spawnDefender(i) {
    return { x: 570 + (i % 2) * 85, y: 240 + Math.floor(i / 2) * 120, id: i };
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
    const p = this.players[this.carrier];
    // Every bonus on this pass is detected first and its flow added before the
    // multiplier is read, so the bonus that lands counts toward its own pass.
    const zoneHit =
      this.zone && distance(p, this.zone) <= this.zone.r + PLAYER_RADIUS;
    const repeat = this.history.at(-2) === this.carrier;
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
    const splitHit = ball.split !== null && !completesTriangle;
    let milestone = false;
    if (ball.oneTouch) {
      this.oneTouchStreak++;
      this.bestOneTouch = Math.max(this.bestOneTouch, this.oneTouchStreak);
      milestone = this.oneTouchStreak % ONE_TOUCH.milestoneEvery === 0;
    }
    let flowBuilt = 0;
    if (zoneHit) flowBuilt += FLOW_BUILD.zone;
    if (completesTriangle) flowBuilt += FLOW_BUILD.triangle;
    if (splitHit) flowBuilt += FLOW_BUILD.split;
    if (milestone) flowBuilt += FLOW_BUILD.ole;
    if (flowBuilt > 0) {
      this.flow += flowBuilt;
      this.bestFlow = Math.max(this.bestFlow, this.flow);
      this.flowIdle = 0;
    }
    const multiplier = flowMultiplier(this.flow);
    const distanceMultiplier = passDistanceMultiplier(ball.passDistance);
    let points =
      Math.round((repeat ? 6 : 12) * distanceMultiplier) * multiplier;
    const bonuses = [];
    let focusReward = 0;
    if (ball.bank) {
      this.banks++;
      points += 18 * multiplier;
      bonuses.push("wall");
    }
    let triangleCoords = null;
    if (splitHit) {
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
    if (zoneHit) {
      points += ZONE_POINTS * multiplier;
      this.zones++;
      bonuses.push("zone");
      focusReward += FOCUS_REWARDS.zone;
      this.beginZoneBlindGap();
    }
    let oneTouchBonus = 0;
    if (ball.oneTouch) {
      oneTouchBonus =
        (ONE_TOUCH.passBonus + (milestone ? ONE_TOUCH.milestoneBonus : 0)) *
        multiplier;
      points += oneTouchBonus;
      bonuses.push("one-touch");
      if (milestone) {
        bonuses.push("ole");
        this.oles++;
        focusReward += ONE_TOUCH.milestoneFocus;
      }
    }
    // Endless is scored on survival time alone (see update()), so bonuses
    // there pay Energy and colour and nothing else. Zeroing the points here
    // rather than skipping the work above keeps one scoring path: the
    // multiplier, the streaks and the popup stack all still run, so a zone
    // hit still reads as a zone hit.
    if (this.config.endless) points = 0;
    this.score += points;
    // Several bonuses can land on one pass; the label shows the best of them
    // while `bonuses` carries the full list for the popup stack.
    const best = Object.keys(BONUS_LABELS).find((key) => bonuses.includes(key));
    // In Endless a popup carries the bonus's name and colour and no number -
    // `points: null` is what tells the renderer to print the text rather than
    // a total, so the mode does not spray "+0" over every pass. A plain pass
    // there has nothing to say at all and stays silent.
    if (!this.config.endless || best)
      this.emit(
        "score",
        this.config.endless
          ? BONUS_LABELS[best]
          : `${best ? BONUS_LABELS[best] : "PASS"} +${points}`,
        p.x,
        p.y - 25,
        {
          bonuses,
          points: this.config.endless ? null : points,
          bestBonus: best || null,
          triangle: triangleCoords,
        },
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
  // Flow is not banked: each FLOW_DECAY_SECONDS without a flow-building bonus
  // slips the multiplier one step (flow falls to the floor of the step below)
  // and restarts the timer. Runs on game time, so Focus slows it, and never
  // during a turnover lock (update() returns before reaching it).
  decayFlow(delta) {
    const multiplier = flowMultiplier(this.flow);
    if (multiplier <= 1) {
      this.flowIdle = 0;
      return;
    }
    this.flowIdle += delta;
    if (this.flowIdle <= FLOW_DECAY_SECONDS) return;
    this.flowIdle = 0;
    this.flow = flowForMultiplier(multiplier - 1);
    this.emit("flow-drop", `×${multiplier - 1}`, 500, 310);
  }
  // Ends the current zone (hit or timed out) and goes dark for a random
  // beat before the next spot activates. `nextZone` is set immediately so
  // the renderer can telegraph where it is coming, not just that it left.
  beginZoneBlindGap() {
    this.zone = null;
    this.zoneIndex =
      (this.zoneIndex + 1 + Math.floor(this.rng() * 2)) % ZONE_SPOTS.length;
    this.nextZone = { ...ZONE_SPOTS[this.zoneIndex] };
    this.zoneBlindDuration =
      ZONE_BLIND_GAP.min + this.rng() * (ZONE_BLIND_GAP.max - ZONE_BLIND_GAP.min);
    this.zoneBlindTimer = this.zoneBlindDuration;
  }
  activatePendingZone() {
    this.zone = { ...ZONE_SPOTS[this.zoneIndex], r: 92 };
    this.zoneTimer = ZONE_LIFETIME;
    this.nextZone = null;
    this.zoneBlindTimer = 0;
    this.zoneBlindDuration = 0;
  }
  turnover(reason) {
    this.turnovers++;
    this.flow = 0;
    this.flowIdle = 0;
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
        ? Math.min(dt, this.focus / FOCUS_DRAIN_RATE)
        : 0;
    const boostedTime =
      boostRequested &&
      !this.ball
        ? Math.min(dt, this.focus / BOOST_DRAIN_RATE)
        : 0;
    this.focusActive = focusedTime > 0;
    this.boostActive = boostedTime > 0;
    this.focus = clamp(
      this.focus - focusedTime * FOCUS_DRAIN_RATE - boostedTime * BOOST_DRAIN_RATE,
      0,
      this.tactic.focus,
    );
    if ((input.focus || input.boost) && this.focus <= 0) {
      this.focusNeedsRelease = true;
      this.boostNeedsRelease = true;
    }
    if (this.ball && this.focusActive) this.ball.focusUsed = true;
    const delta = dt - focusedTime * 0.68;
    if (this.config.endless) {
      this.time += delta;
    } else if (!this.config.practice) {
      this.time -= delta;
    }
    this.elapsed += delta;
    // The score IS the clock in Endless. Whole seconds only: a leaderboard
    // row, a personal best and the Discord record post all carry an integer,
    // and a run is not meaningfully better for a stray hundredth.
    // The epsilon is not cosmetic: `elapsed` is a sum of 1/60 frames, so a
    // whole second arrives as 2.9999999999 and a bare floor() would hold the
    // score a second behind the clock the player is reading.
    if (this.config.endless) this.score = Math.floor(this.elapsed + 1e-9);
    this.motionTime += delta;
    this.decayFlow(delta);
    if (this.zone) {
      this.zoneTimer -= delta;
    } else if (this.zoneBlindTimer > 0) {
      this.zoneBlindTimer -= delta;
    }
    if (!this.config.practice && !this.config.endless && this.time <= 0) {
      this.finish();
      return;
    }
    if (this.zone && this.zoneTimer <= 0) this.beginZoneBlindGap();
    else if (!this.zone && this.zoneBlindTimer <= 0)
      this.activatePendingZone();
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
    // A rung of the Endless ladder can land mid-possession; the new
    // defender walks in from its formation slot rather than appearing on top
    // of anyone, and the event lets the UI call it out.
    //
    // Endless only. Every other mode fixes its defenders at kickoff, and
    // topping the set up from config on every frame would override whatever
    // is actually on the court - including a round whose defenders were
    // removed deliberately.
    const wanted = this.config.endless ? this.defenderCount() : this.defenders.length;
    while (this.defenders.length < wanted) {
      const added = this.spawnDefender(this.defenders.length);
      this.defenders.push(added);
      this.emit("defender", `${this.defenders.length} DEFENDERS`, added.x, added.y, {
        defenders: this.defenders.length,
      });
    }
    const press =
      (this.config.endless ? endlessStage(this.elapsed).speed : this.config.speed) +
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
