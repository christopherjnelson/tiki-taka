import test from 'node:test';
import assert from 'node:assert/strict';
import { BOOST_DRAIN_RATE, BOOST_SPEED_MULTIPLIER, Game, COURTS, TACTICS, FOCUS_REWARDS, TRIANGLE_WINDOW, TRIANGLE_MAX_HOLD, SPLIT_PRESS, ONE_TOUCH, LIMITS, seeded, dailyConfig, bankPoint, distance, segmentDistance, segmentsCross } from '../src/game.js';

const STEP = 1 / 60;
function openGame(extra = {}, tactic = 'balanced') {
  const game = new Game({ ...COURTS[0], defenders: 0, ...extra }, tactic);
  game.zone = { x: -1000, y: -1000, r: 1 };
  return game;
}
function advance(game, seconds, input = {}) {
  for (let remaining = seconds; remaining > 1e-9; remaining -= STEP) game.update(Math.min(STEP, remaining), input);
}
function completePass(game, id, bank = false) {
  if (game.passCooldown > 0) advance(game, game.passCooldown + STEP);
  assert.equal(game.pass(id, bank), true);
  for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP);
  assert.equal(game.ball, null, 'pass must resolve within ten seconds');
  assert.equal(game.carrier, id);
}
function completePassWithInput(game, id, bank, input) {
  if (game.passCooldown > 0) advance(game, game.passCooldown + STEP, input);
  assert.equal(game.pass(id, bank), true);
  for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP, input);
  assert.equal(game.ball, null, 'pass must resolve within ten seconds');
  assert.equal(game.carrier, id);
}
function playAssisted(config, seed = config.seed, reactionTime = 0.5) {
  const game = new Game({ ...config, seed });
  let attempts = 0;
  for (let frame = 0; game.status === 'playing' && frame < 18000; frame++) {
    if (!game.ball && !game.lock && game.hold >= reactionTime) attempts += Number(game.pass(game.bestTarget()));
    game.update(STEP);
  }
  return { game, attempts };
}
function playMoving(config, reactionTime = 0.5) {
  const game = new Game(config);
  let attempts = 0;
  for (let frame = 0; game.status === 'playing' && frame < 18000; frame++) {
    if (!game.ball && !game.lock && game.hold >= reactionTime) attempts += Number(game.pass(game.bestTarget()));
    const carrier = game.players[game.carrier];
    const closest = [...game.defenders].sort((a, b) => distance(a, carrier) - distance(b, carrier))[0];
    game.update(STEP, closest ? { x: carrier.x - closest.x, y: carrier.y - closest.y } : {});
  }
  return { game, attempts };
}

test('seeded randomness repeats exactly and distinguishes seeds', () => {
  const sequence = seed => { const rng = seeded(seed); return Array.from({ length: 100 }, rng); };
  assert.deepEqual(sequence(41), sequence(41));
  assert.notDeepEqual(sequence(41), sequence(42));
  assert.ok(sequence(41).every(value => value >= 0 && value < 1));
});

test('daily circuit uses a reproducible UTC day and changes tomorrow', () => {
  const morning = dailyConfig(new Date('2026-09-06T00:01:00Z'));
  assert.deepEqual(morning, dailyConfig(new Date('2026-09-06T23:59:00Z')));
  assert.notEqual(morning.seed, dailyConfig(new Date('2026-09-07T00:01:00Z')).seed);
  assert.equal(morning.key, '2026-09-06');
});

test('all tactics start with empty focus at their advertised capacities and fallback is safe', () => {
  for (const key of Object.keys(TACTICS)) {
    const game = new Game(COURTS[0], key);
    assert.equal(game.focus, 0);
    assert.equal({ balanced: 10, runner: 6, maestro: 8 }[key], TACTICS[key].focus);
    assert.equal('regen' in TACTICS[key], false);
    assert.equal(game.players.length, 4);
    assert.equal(game.defenders.length, COURTS[0].defenders);
  }
  assert.equal(new Game(COURTS[0], 'missing').tactic, TACTICS.balanced);
});

test('movement has equal axial and diagonal speed and stays inside the court', () => {
  const axial = openGame(), diagonal = openGame();
  const start = { ...axial.players[0] };
  advance(axial, 0.5, { x: 1 });
  advance(diagonal, 0.5, { x: 1, y: 1 });
  assert.ok(Math.abs(distance(start, axial.players[0]) - distance(start, diagonal.players[0])) < 1e-8);
  advance(axial, 10, { x: 1, y: 1 });
  assert.ok(axial.players[0].x < LIMITS.right && axial.players[0].y < LIMITS.bottom);
  advance(axial, 20, { x: -1, y: -1 });
  assert.ok(axial.players[0].x > LIMITS.left && axial.players[0].y > LIMITS.top);
});

test('pass validation rejects self, missing, in-flight, locked, and finished passes', () => {
  const game = openGame();
  assert.equal(game.pass(0), false);
  assert.equal(game.pass(99), false);
  assert.equal(game.pass(1), true);
  assert.equal(game.pass(2), false);
  game.ball = null;
  game.lock = 0.5;
  assert.equal(game.pass(1), false);
  game.lock = 0;
  game.finish();
  assert.equal(game.pass(1), false);
});

test('direct passing transfers possession, adds score and resets hold', () => {
  const game = openGame();
  advance(game, 0.5);
  completePass(game, 1);
  assert.equal(game.passes, 1);
  assert.equal(game.score, 12);
  assert.equal(game.combo, 1);
  assert.equal(game.hold, 0);
  assert.ok(game.grace > 0);
  assert.ok(game.events.some(event => event.type === 'kick'));
  assert.ok(game.events.some(event => event.type === 'score'));
});

test('a brief first-touch cooldown prevents instant pass chains after reception', () => {
  const game = openGame();
  completePass(game, 1);
  assert.equal(game.pass(2), false);
  advance(game, 0.13);
  assert.equal(game.pass(2), true);
});

test('one-touch starts unarmed, then rewards quick stationary deliveries', () => {
  const game = openGame();
  completePass(game, 1);
  assert.equal(game.oneTouchStreak, 0);
  assert.equal(game.oneTouchEligible, true);
  assert.equal(game.events.some(event => event.type === 'one-touch'), false);
  const before = game.score;
  completePass(game, 2);
  assert.equal(game.oneTouchStreak, 1);
  assert.equal(game.bestOneTouch, 1);
  assert.equal(game.score - before, 12 + ONE_TOUCH.passBonus);
  assert.deepEqual(game.events.find(event => event.type === 'one-touch'), {
    type: 'one-touch', text: 'ONE TOUCH ×1 +5', x: game.players[2].x, y: game.players[2].y,
    streak: 1, bonus: 5, milestone: false,
  });
});

test('one-touch uses real time, resets for delay or movement, and ignores invalid passes', () => {
  const delayed = openGame();
  completePass(delayed, 1);
  delayed.focus = 2;
  advance(delayed, ONE_TOUCH.window + STEP, { focus: true });
  assert.equal(delayed.oneTouchStreak, 0);
  assert.equal(delayed.oneTouchEligible, false, 'Focus must not stretch the real-time window');
  completePassWithInput(delayed, 2, false, { focus: true });
  assert.equal(delayed.oneTouchStreak, 0);

  const moved = openGame();
  completePass(moved, 1);
  completePass(moved, 2);
  assert.equal(moved.oneTouchStreak, 1);
  advance(moved, 0.1, { x: 1 });
  assert.ok(moved.oneTouchDistance > ONE_TOUCH.moveTolerance);
  assert.equal(moved.oneTouchEligible, false);
  assert.equal(moved.oneTouchStreak, 0);

  const invalid = openGame();
  completePass(invalid, 1);
  completePass(invalid, 2);
  assert.equal(invalid.oneTouchStreak, 1);
  assert.equal(invalid.pass(2), false);
  assert.equal(invalid.pass(99), false);
  assert.equal(invalid.oneTouchStreak, 1);
  assert.equal(invalid.oneTouchEligible, true);
});

test('one-touch milestone adds its flat bonus exactly once every ten passes', () => {
  const game = openGame();
  completePass(game, 1);
  for (let index = 0; index < 20; index++) completePass(game, index % 2 ? 1 : 2);
  assert.equal(game.oneTouchStreak, 20);
  assert.equal(game.bestOneTouch, 20);
  const events = game.events.filter(event => event.type === 'one-touch');
  assert.equal(events.length, 20);
  assert.equal(events.filter(event => event.milestone).length, 2);
  assert.equal(events.at(-1).bonus, ONE_TOUCH.passBonus + ONE_TOUCH.milestoneBonus);
  assert.equal(events.at(-1).text, 'ONE TOUCH ×20 +55');
  assert.equal(game.focus, ONE_TOUCH.milestoneFocus * 2);
  assert.ok(game.events.some(event => event.type === 'focus' && event.text.includes('+4 ENERGY')));
});

test('turnovers and intercepted one-touch attempts reset the current streak but preserve the best', () => {
  const game = openGame({ speed: 0 });
  completePass(game, 1);
  completePass(game, 2);
  assert.equal(game.oneTouchStreak, 1);
  advance(game, game.passCooldown + STEP);
  const from = game.players[2], to = game.players[3];
  game.defenders = [{ x: (from.x + to.x) / 2, y: (from.y + to.y) / 2, id: 0 }];
  assert.equal(game.pass(3), true);
  advance(game, 1);
  assert.equal(game.turnovers, 1);
  assert.equal(game.oneTouchStreak, 0);
  assert.equal(game.bestOneTouch, 1);
  assert.equal(game.queuedPass, null);
});

test('in-flight pass queue validates, replaces, cancels, and launches once past reception cooldown', () => {
  const game = openGame();
  assert.equal(game.queuePass(2), false);
  assert.equal(game.pass(1), true);
  assert.equal(game.queuePass(1), false);
  assert.equal(game.queuePass(99), false);
  assert.equal(game.queuePass(2), true);
  assert.deepEqual(game.queuedPass, { id: 2, bank: false });
  assert.equal(game.queuePass(1), false);
  assert.equal(game.queuePass(99), false);
  assert.deepEqual(game.queuedPass, { id: 2, bank: false }, 'invalid requests preserve the last valid queue');
  assert.equal(game.queuePass(3, true), true);
  assert.deepEqual(game.queuedPass, { id: 3, bank: true });
  game.clearQueuedPass();
  assert.equal(game.queuedPass, null);
  assert.equal(game.queuePass(2), true);
  for (let frame = 0; game.passes === 0 && frame < 600; frame++) game.update(STEP);
  assert.equal(game.carrier, 1);
  assert.equal(game.passes, 1);
  assert.deepEqual(game.ball && { from: game.ball.from, to: game.ball.to, bank: game.ball.bank }, { from: 1, to: 2, bank: false });
  assert.equal(game.queuedPass, null);
  assert.equal(game.passCooldown, 0, 'only the queued successor bypasses reception cooldown');
  for (let frame = 0; game.ball && frame < 600; frame++) game.update(STEP);
  assert.equal(game.carrier, 2);
  assert.equal(game.passes, 2);
  assert.equal(game.oneTouchStreak, 1);
  assert.equal(game.ball, null, 'queued pass executes exactly once');
});

test('queued smart targeting avoids returning to the incoming passer', () => {
  const game = openGame();
  assert.equal(game.pass(1), true);
  assert.notEqual(game.bestQueuedTarget(), 0);
});

test('queued passes clear on reset and finish and reject locked games', () => {
  const game = openGame();
  game.pass(1);
  game.queuePass(2, true);
  game.resetPositions();
  assert.equal(game.queuedPass, null);
  game.pass(1);
  game.queuePass(2);
  game.finish();
  assert.equal(game.queuedPass, null);
  const locked = openGame();
  locked.pass(1);
  locked.lock = 1;
  assert.equal(locked.queuePass(2), false);
});

test('return passes score less while sustained possession builds a multiplier', () => {
  const game = openGame();
  completePass(game, 1);
  const first = game.score;
  completePass(game, 0);
  const second = game.score - first;
  assert.ok(second < first && second > 0);
  completePass(game, 1);
  const beforeFourth = game.score;
  completePass(game, 0);
  assert.ok(game.score - beforeFourth > second);
  assert.equal(game.bestCombo, 4);
  assert.equal(game.triangles, 0);
});

test('three-player triangles earn 3 energy without exceeding capacity', () => {
  const game = openGame();
  game.focus = 0;
  completePass(game, 1);
  completePass(game, 2);
  const before = game.score, focusBefore = game.focus;
  completePass(game, 0);
  assert.equal(game.triangles, 1);
  assert.ok(game.score - before > 12);
  assert.equal(game.focus, focusBefore + FOCUS_REWARDS.triangle);
  assert.ok(game.events.some(event => event.type === 'focus' && event.text === '+3 ENERGY' && event.x === game.players[0].x));
  game.focus = game.tactic.focus;
  completePass(game, 1);
  assert.equal(game.focus, game.tactic.focus);
});

test('triangles must complete within TRIANGLE_WINDOW and break if hold exceeds TRIANGLE_MAX_HOLD', () => {
  // 1. Holding longer than TRIANGLE_MAX_HOLD (1.2s) breaks the triangle chain
  const game1 = openGame();
  completePass(game1, 1);
  advance(game1, TRIANGLE_MAX_HOLD + 0.15);
  completePass(game1, 2);
  completePass(game1, 0);
  assert.equal(game1.triangles, 0, 'holding the ball longer than TRIANGLE_MAX_HOLD breaks the triangle chain');

  // 2. Crisp passing within TRIANGLE_WINDOW and under TRIANGLE_MAX_HOLD awards the triangle
  const game2 = openGame();
  completePass(game2, 1);
  completePass(game2, 2);
  completePass(game2, 0);
  assert.equal(game2.triangles, 1, 'crisp passing within time window awards the triangle');

  // 3. Exceeding TRIANGLE_WINDOW (3.5s) total time prevents the triangle bonus
  const game3 = openGame();
  completePass(game3, 1);
  advance(game3, 1.15); // under TRIANGLE_MAX_HOLD (1.2s)
  completePass(game3, 2);
  advance(game3, 1.15); // under TRIANGLE_MAX_HOLD (1.2s)
  completePass(game3, 0);
  assert.equal(game3.triangles, 0, 'exceeding TRIANGLE_WINDOW total time prevents the triangle bonus');
});

test('receiving inside a zone earns a bonus and rotates the target', () => {
  const game = openGame();
  game.zone = { ...game.players[1], r: 92 };
  const previous = { ...game.zone };
  completePass(game, 1);
  assert.equal(game.zones, 1);
  assert.ok(game.score > 12);
  assert.notDeepEqual(game.zone, previous);
  assert.equal(game.zoneTimer, 12);
  assert.equal(game.focus, FOCUS_REWARDS.zone);
});

test('zones rotate even when the player has not collected them', () => {
  const game = openGame();
  const previous = { ...game.zone };
  advance(game, 12.1);
  assert.notDeepEqual(game.zone, previous);
  assert.equal(game.zones, 0);
});

test('wall routes remain on valid boundaries for diverse player positions', () => {
  const rng = seeded(901);
  for (let iteration = 0; iteration < 500; iteration++) {
    const point = () => ({ x: 80 + rng() * 840, y: 80 + rng() * 460 });
    const from = point(), to = point(), wall = bankPoint(from, to);
    assert.ok(Number.isFinite(wall.x) && Number.isFinite(wall.y));
    assert.ok(wall.x >= LIMITS.left - 1e-8 && wall.x <= LIMITS.right + 1e-8);
    assert.ok(wall.y >= LIMITS.top - 1e-8 && wall.y <= LIMITS.bottom + 1e-8);
    assert.ok([Math.abs(wall.x - LIMITS.left), Math.abs(wall.x - LIMITS.right), Math.abs(wall.y - LIMITS.top), Math.abs(wall.y - LIMITS.bottom)].some(value => value < 1e-8));
    assert.ok(distance(from, wall) + distance(wall, to) >= distance(from, to) - 1e-8);
  }
});

test('wall passes bounce, remain boxed in, reach their receiver and earn extra points', () => {
  const game = openGame();
  assert.equal(game.pass(2, true), true);
  let frames = 0;
  while (game.ball && frames++ < 600) {
    game.update(STEP);
    if (game.ball) {
      assert.ok(game.ball.x >= LIMITS.left - 1e-8 && game.ball.x <= LIMITS.right + 1e-8);
      assert.ok(game.ball.y >= LIMITS.top - 1e-8 && game.ball.y <= LIMITS.bottom + 1e-8);
    }
  }
  assert.equal(game.carrier, 2);
  assert.equal(game.banks, 1);
  assert.equal(game.events.filter(event => event.type === 'wall').length, 1);
  assert.ok(game.score > 12);
  assert.equal(game.focus, 0);
});

test('segment collision catches defenders between ball frames, preventing tunneling', () => {
  const game = openGame({ speed: 0 }, 'maestro');
  game.players[0].x = 100; game.players[0].y = 100;
  game.players[1].x = 300; game.players[1].y = 100;
  game.defenders = [{ x: 121, y: 119, id: 0 }];
  assert.ok(distance(game.players[0], game.defenders[0]) > 20);
  assert.ok(distance({ x: 142, y: 100 }, game.defenders[0]) > 20);
  assert.equal(game.pass(1), true);
  game.update(0.05);
  assert.equal(game.turnovers, 1);
  assert.ok(game.events.some(event => event.text === 'PASS INTERCEPTED'));
});

test('a bank route can bypass an intercepted direct lane', () => {
  const fixture = () => {
    const game = openGame({ speed: 0 });
    game.players[0].x = 200; game.players[0].y = 200;
    game.players[1].x = 600; game.players[1].y = 200;
    game.defenders = [{ x: 400, y: 200, id: 0 }];
    return game;
  };
  const direct = fixture();
  direct.pass(1);
  advance(direct, 1);
  assert.equal(direct.turnovers, 1);
  const bank = fixture();
  completePass(bank, 1, true);
  assert.equal(bank.turnovers, 0);
});

test('turnovers retain earned score and focus, reset combo and formation, and enforce recovery', () => {
  const game = openGame();
  completePass(game, 1);
  game.focus = 2.25;
  const score = game.score;
  game.turnover('TEST');
  assert.equal(game.score, score);
  assert.equal(game.combo, 0);
  assert.equal(game.bestCombo, 1);
  assert.equal(game.carrier, 0);
  assert.equal(game.ball, null);
  assert.equal(game.turnovers, 1);
  assert.equal(game.focus, 2.25);
  assert.ok(game.lock > 0);
  assert.equal(game.pass(1), false);
  advance(game, 1.3);
  assert.equal(game.pass(1), true);
});

test('three turnovers end a standard run; practice keeps playing', () => {
  const standard = openGame(), practice = openGame({ practice: true });
  for (let i = 0; i < 3; i++) { standard.turnover('TEST'); practice.turnover('TEST'); }
  assert.equal(standard.status, 'finished');
  assert.equal(practice.status, 'playing');
  assert.equal(standard.events.filter(event => event.type === 'end').length, 1);
});

test('holding the ball without playing fails on every court', () => {
  for (const court of COURTS) {
    const game = new Game(court);
    advance(game, court.time + 5);
    assert.equal(game.status, 'finished', court.name);
    assert.equal(game.turnovers, 3, court.name);
    assert.equal(game.score, 0, court.name);
    assert.ok(game.time > 0, 'pressure ends an idle run before the clock expires');
  }
});

test('focus slows clock, player movement, and ball movement and drains real time', () => {
  const normal = openGame(), focused = openGame();
  focused.focus = focused.tactic.focus;
  const initial = { ...normal.players[0] };
  advance(normal, 1, { x: 1 });
  advance(focused, 1, { x: 1, focus: true });
  assert.ok(Math.abs(focused.elapsed / normal.elapsed - 0.32) < 1e-8);
  assert.ok(Math.abs(distance(initial, focused.players[0]) / distance(initial, normal.players[0]) - 0.32) < 1e-8);
  assert.ok(Math.abs(focused.focus - (focused.tactic.focus - 1)) < 1e-8);
  const normalBall = openGame(), focusedBall = openGame();
  focusedBall.focus = focusedBall.tactic.focus;
  normalBall.pass(2); focusedBall.pass(2);
  advance(normalBall, 0.1); advance(focusedBall, 0.1, { focus: true });
  assert.ok(distance(initial, focusedBall.ball) < distance(initial, normalBall.ball));
});

test('focus never regenerates while idle or dribbling', () => {
  const game = openGame();
  advance(game, 1);
  assert.equal(game.focus, 0);
  advance(game, 1, { x: 1 });
  assert.equal(game.focus, 0);
});

test('boost spends Focus to increase only the carrier movement at normal game speed', () => {
  const normal = openGame({ speed: 0 }), boosted = openGame({ speed: 0 });
  const start = { ...normal.players[0] };
  boosted.focus = boosted.tactic.focus;
  advance(normal, 1, { x: 1 });
  advance(boosted, 1, { x: 1, boost: true });
  assert.equal(boosted.boostActive, true);
  assert.equal(boosted.focusActive, false);
  assert.ok(Math.abs(boosted.elapsed - normal.elapsed) < 1e-8, 'Boost must not slow the clock like Focus');
  assert.ok(
    Math.abs(
      distance(start, boosted.players[0]) /
        distance(start, normal.players[0]) -
        BOOST_SPEED_MULTIPLIER,
    ) < 1e-8,
    'Boost applies its multiplier to the controlled player only',
  );
  assert.ok(Math.abs(boosted.focus - (boosted.tactic.focus - BOOST_DRAIN_RATE)) < 1e-8);
  assert.deepEqual(boosted.players.slice(1), normal.players.slice(1), 'Boost does not change teammate AI movement');
});

test('boost has a deterministic partial final frame, release gate, and Boost priority', () => {
  const game = openGame({ speed: 0 });
  game.focus = 0.02;
  const start = { ...game.players[0] };
  game.update(0.05, { x: 1, boost: true });
  assert.ok(Math.abs(distance(start, game.players[0]) - game.tactic.speed * (0.05 + (0.02 / BOOST_DRAIN_RATE) * (BOOST_SPEED_MULTIPLIER - 1))) < 1e-8);
  assert.equal(game.focus, 0);
  assert.equal(game.boostNeedsRelease, true);

  game.focus = 1;
  const gated = { ...game.players[0] };
  game.update(0.05, { x: 1, boost: true });
  assert.ok(Math.abs(distance(gated, game.players[0]) - game.tactic.speed * 0.05) < 1e-8, 'a held empty trigger cannot spend later-earned Focus');
  game.update(0.05, { x: 1, focus: true });
  assert.ok(Math.abs(distance(gated, game.players[0]) - game.tactic.speed * 0.1) < 1e-8, 'switching to Focus while Boost remains held cannot bypass the shared release gate');
  game.update(0.05, { x: 1 });
  const released = { ...game.players[0] };
  game.update(0.05, { x: 1, boost: true });
  assert.ok(distance(released, game.players[0]) > game.tactic.speed * 0.05, 'releasing makes Boost available again');

  const shared = openGame({ speed: 0 });
  shared.focus = 1;
  const focusedStart = { ...shared.players[0] };
  shared.update(0.05, { x: 1, focus: true, boost: true });
  assert.equal(shared.focusActive, false);
  assert.equal(shared.boostActive, true);
  assert.ok(distance(focusedStart, shared.players[0]) > shared.tactic.speed * 0.05, 'Boost wins when both shared-resource controls are held');
});

test('boost does not alter a pass, its clock, or its Focus reward eligibility', () => {
  const normal = openGame({ speed: 0 }), boosted = openGame({ speed: 0 });
  normal.zone = { ...normal.players[1], r: 92 };
  boosted.zone = { ...boosted.players[1], r: 92 };
  boosted.focus = 1;
  assert.equal(normal.pass(1), true);
  assert.equal(boosted.pass(1), true);
  normal.update(0.05);
  boosted.update(0.05, { boost: true });
  assert.deepEqual(boosted.ball, normal.ball, 'Boost must not change pass speed or flight state');
  assert.equal(boosted.elapsed, normal.elapsed);
  assert.equal(boosted.time, normal.time);
  assert.equal(boosted.focus, 1, 'Boost cannot spend Focus while the player is not carrying');
  assert.equal(boosted.focusActive, false);
  assert.equal(boosted.boostActive, false);
  assert.equal(boosted.ball.focusUsed, false, 'Boost cannot suppress normal Focus rewards');
  while (normal.ball) normal.update(STEP);
  while (boosted.ball) boosted.update(STEP, { boost: true });
  assert.equal(normal.focus, FOCUS_REWARDS.zone);
  assert.equal(boosted.focus, 1 + FOCUS_REWARDS.zone, 'the pass reward remains intact after a held Boost trigger');
  assert.equal(normal.score, boosted.score);
});

test('plain passes earn no focus and combined skill rewards stack at tactic capacity', () => {
  const game = openGame({}, 'runner');
  completePass(game, 1);
  assert.equal(game.focus, 0);
  game.zone = { ...game.players[2], r: 92 };
  completePass(game, 2, true);
  assert.equal(game.focus, FOCUS_REWARDS.zone);
  game.zone = { ...game.players[0], r: 92 };
  completePass(game, 0, true);
  assert.equal(game.focus, game.tactic.focus);
  assert.ok(game.events.some(event => event.type === 'focus' && event.text === '+4 ENERGY'));
});

test('skill passes completed with focus active keep bonuses but earn no focus', () => {
  const game = openGame();
  game.focus = 2;
  game.zone = { ...game.players[1], r: 92 };
  completePassWithInput(game, 1, true, { focus: true });
  assert.equal(game.banks, 1);
  assert.equal(game.zones, 1);
  assert.ok(game.score > 12);
  assert.ok(game.focus < 2);
  assert.equal(game.events.filter(event => event.type === 'focus').length, 0);
});

test('empty or exhausted focus must be released before earned charge can activate', () => {
  const game = openGame();
  game.zone = { ...game.players[1], r: 92 };
  completePassWithInput(game, 1, false, { focus: true });
  assert.equal(game.focus, FOCUS_REWARDS.zone);
  assert.equal(game.focusNeedsRelease, true);
  const beforeHeld = game.elapsed;
  advance(game, 0.25, { focus: true });
  assert.ok(Math.abs(game.elapsed - beforeHeld - 0.25) < 1e-8);
  assert.equal(game.focus, FOCUS_REWARDS.zone);
  game.update(STEP);
  assert.equal(game.focusNeedsRelease, false);
  const beforeFocus = game.elapsed;
  advance(game, 0.25, { focus: true });
  assert.ok(game.elapsed - beforeFocus < 0.1);
  game.focus = 0.02;
  game.focusNeedsRelease = false;
  const beforePartial = game.elapsed;
  game.update(0.05, { focus: true });
  assert.ok(Math.abs(game.elapsed - beforePartial - (0.05 - 0.02 * 0.68)) < 1e-8);
  assert.equal(game.focusNeedsRelease, true);
});

test('endless triangles extend the clock while standard triangles do not', () => {
  const standard = openGame(), endless = openGame({ endless: true });
  for (const target of [1, 2, 0]) { completePass(standard, target); completePass(endless, target); }
  assert.ok(Math.abs(endless.time - standard.time - 5) < 1e-7);
});

test('clock expiry ends the run and future updates cannot change the result', () => {
  const game = openGame({ time: 0.1 });
  advance(game, 0.2);
  assert.equal(game.status, 'finished');
  assert.equal(game.time, 0);
  const before = JSON.stringify(game);
  advance(game, 1, { x: 1, focus: true });
  assert.equal(JSON.stringify(game), before);
});

test('negative and long frame times cannot reverse time or teleport actors', () => {
  const game = openGame();
  const before = { ...game.players[0] }, time = game.time;
  game.update(-1, { x: 1 });
  assert.equal(game.time, time);
  assert.equal(game.players[0].x, before.x);
  game.update(60, { x: 1 });
  assert.ok(time - game.time <= 0.05 + 1e-8);
  assert.ok(distance(before, game.players[0]) <= game.tactic.speed * 0.05 + 1e-8);
});

test('aim assists toward the selected direction and never chooses the carrier', () => {
  const game = new Game(COURTS[0]);
  game.players = [{ id: 0, x: 500, y: 300 }, { id: 1, x: 200, y: 300 }, { id: 2, x: 800, y: 300 }, { id: 3, x: 500, y: 100 }];
  game.defenders = [{ id: 0, x: 500, y: 550 }];
  assert.equal(game.bestTarget({ x: -1, y: 0 }), 1);
  assert.equal(game.bestTarget({ x: 1, y: 0 }), 2);
  assert.equal(game.bestTarget({ x: 0, y: -1 }), 3);
  assert.notEqual(game.bestTarget(), 0);
});

test('shout sends an eligible pass target to the active bonus zone without affecting scoring', () => {
  const game = openGame();
  game.zone = { x: 735, y: 430, r: 92 };
  const target = game.players[1];
  const before = distance(target, game.zone);
  assert.equal(game.shout(target.id), true);
  advance(game, 1);
  assert.ok(distance(target, game.zone) < before, 'target should close on the bonus zone');
  assert.equal(game.score, 0);
  assert.equal(game.passes, 0);
  assert.equal(game.shout(game.carrier), false, 'the ball carrier cannot be shouted');
  assert.equal(game.shout(99), false, 'missing targets are ignored');
  game.zone = { x: 260, y: 185, r: 92 };
  assert.equal(game.shout(2), true, 'the most recent shout replaces the earlier intent');
  assert.equal(game.players[1].shoutTarget, null, 'the earlier shout target is cleared');
  assert.deepEqual(game.players[2].shoutTarget, { zoneIndex: game.zoneIndex }, 'the new shout target is set');
  game.rotateZone();
  advance(game, STEP);
  assert.equal(game.players[2].shoutTarget, null, 'a zone rotation clears stale shout intent');
  game.zone = null;
  assert.equal(game.shout(2), false, 'a missing bonus zone is ignored');
});

test('segment distance handles endpoints and zero-length segments', () => {
  assert.equal(segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 3);
  assert.equal(segmentDistance({ x: -3, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(segmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }), 5);
});

test('identical seed and inputs reproduce an entire match exactly', () => {
  const first = playAssisted(COURTS[4]), second = playAssisted(COURTS[4]);
  assert.equal(first.game.status, 'finished');
  assert.deepEqual(JSON.parse(JSON.stringify(second)), JSON.parse(JSON.stringify(first)));
  const different = playAssisted(COURTS[4], COURTS[4].seed + 1);
  assert.notDeepEqual(different.game.players, first.game.players);
});

test('every campaign court has a feasible passing strategy under seeded pressure', () => {
  assert.deepEqual(COURTS.map(court => court.target), [600, 900, 1200, 1600, 2000, 2400]);
  for (const court of COURTS) {
    const quick = playAssisted(court, court.seed, 0.25);
    const { game, attempts } = playMoving(court, 0.5);
    assert.equal(quick.game.time, 0, `${court.name}: quick passing must survive the timer`);
    assert.ok(quick.game.score >= court.target, `${court.name}: quick ${quick.game.score}/${court.target}`);
    assert.equal(game.time, 0, `${court.name}: moving strategy must survive the timer`);
    assert.ok(game.turnovers < 3, `${court.name}: moving strategy retains a life`);
    assert.ok(game.score >= court.target, `${court.name}: ${game.score}/${court.target}`);
    assert.ok(game.passes / attempts > 0.75, `${court.name}: viable pass completion`);
  }
});

function threadingGame(defenders) {
  const game = openGame({ speed: 0 });
  game.players[0].x = 200; game.players[0].y = 300;
  game.players[1].x = 700; game.players[1].y = 300;
  game.defenders = defenders.map((d, id) => ({ ...d, id }));
  return game;
}

test('segmentsCross is a proper crossing: strict, so touching and collinear are not', () => {
  // A horizontal bar and a vertical bar through its middle: a clean X.
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }), true);
  // The vertical bar lifted clear above the horizontal one: no crossing.
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 5 }, { x: 5, y: 10 }), false);
  // The vertical bar merely resting its endpoint on the horizontal one: a touch.
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }), false);
  // Both segments lie on the same line and overlap: collinear, never a split.
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 0 }, { x: 15, y: 0 }), false);
  // Segments that would cross only if extended past their endpoints.
  assert.equal(segmentsCross({ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }), false);
});

// Every threading test passes along the horizontal line y = 300, from x = 200
// to x = 700. So a defender with y < 300 is ABOVE the pass and one with y > 300
// is BELOW it, and a pair straddles the pass exactly when it has one of each.
test('a pass with no pair to thread is not a split', () => {
  const empty = threadingGame([]);
  completePass(empty, 1);
  assert.equal(empty.splits, 0);
  assert.equal(empty.score, 12);
  // A lone defender near the lane has nobody to be split from.
  const single = threadingGame([{ x: 450, y: 257 }]);
  completePass(single, 1);
  assert.equal(single.turnovers, 0);
  assert.equal(single.splits, 0);
  assert.equal(single.score, 12);
  assert.equal(single.focus, 0);
});

test('two defenders hugging the lane on the SAME side are not split', () => {
  // Both defenders sit ABOVE y = 300 and both are tight to the lane. The old
  // proximity rule paid this out; passing outside a pair splits nothing, so the
  // crossing rule must refuse it.
  const game = threadingGame([{ x: 430, y: 245 }, { x: 470, y: 257 }]);
  assert.equal(game.pass(1), true);
  assert.equal(game.ball.split, null, 'nothing is threaded when both defenders are one side of the pass');
  for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP);
  assert.equal(game.carrier, 1);
  assert.equal(game.splits, 0);
  assert.equal(game.focus, 0);
  assert.equal(game.score, 12, 'a pass that skirts a pair pays the plain pass only');
  // The mirrored case: both defenders BELOW the lane, equally close.
  const below = threadingGame([{ x: 430, y: 355 }, { x: 470, y: 343 }]);
  completePass(below, 1);
  assert.equal(below.splits, 0);
  assert.equal(below.score, 12);
});

test('a pass threaded between two defenders earns the bonus, focus and its own label', () => {
  // One defender 40 above the lane, one 40 below it: the pass goes straight
  // between them through a gap of 80.
  const game = threadingGame([{ x: 450, y: 260 }, { x: 450, y: 340 }]);
  assert.equal(game.pass(1), true);
  assert.ok(Math.abs(game.ball.split - (200 - 80) / (200 - 70)) < 1e-9, 'tightness comes from the 80-wide gap that was threaded');
  game.defenders[0].y = 40; game.defenders[1].y = 560;
  for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP);
  assert.equal(game.ball, null);
  assert.equal(game.carrier, 1);
  assert.equal(game.turnovers, 0);
  assert.equal(game.splits, 1, 'defenders scattering during flight cannot erase the split that was aimed through');
  assert.equal(game.score, 12 + 96);
  assert.equal(game.focus, FOCUS_REWARDS.split);
  assert.ok(game.events.some(event => event.type === 'score' && event.text === 'SPLIT THE PRESS +108'));
  assert.ok(FOCUS_REWARDS.split > FOCUS_REWARDS.triangle, 'splitting the press pays the most focus in the game');
});

test('a narrower pair outscores a wider one and tops the bonus ladder', () => {
  // Both pairs straddle the lane; only the gap between them changes.
  const bonus = half => {
    const game = threadingGame([{ x: 450, y: 300 - half }, { x: 450, y: 300 + half }]);
    completePass(game, 1);
    assert.equal(game.splits, 1);
    return game.score - 12;
  };
  const tight = bonus(40), loose = bonus(90);
  assert.ok(tight > loose, `a 80-wide gap (${tight}) must beat a 180-wide gap (${loose})`);
  assert.equal(tight, 96);
  assert.equal(loose, 58);
  assert.ok(loose > 35, 'even the laziest split outscores a triangle');
  assert.equal(SPLIT_PRESS.base, 50);
  assert.equal(SPLIT_PRESS.base + SPLIT_PRESS.tight, 100);
  assert.equal(SPLIT_PRESS.narrow, 70);
  assert.equal(SPLIT_PRESS.wide, 200);
  // A pair at or inside `narrow` pays the ceiling; at or beyond `wide`, the floor.
  assert.equal(bonus(30), SPLIT_PRESS.base + SPLIT_PRESS.tight, 'a 60-wide gap is already maxed out');
  assert.equal(bonus(110), SPLIT_PRESS.base, 'a 220-wide gap is a split in name only');
});

test('the same split pays more on a court with more defenders', () => {
  // The threaded pair straddles the lane 80 apart.
  const pair = [{ x: 450, y: 260 }, { x: 450, y: 340 }];
  const bonus = extra => {
    // The spare defenders sit far away, so no pair they form is narrower than 80
    // and the reward still comes from the 80-wide gap: identical geometry, busier court.
    const game = threadingGame([...pair, ...extra]);
    completePass(game, 1);
    assert.equal(game.splits, 1);
    assert.equal(game.focus, FOCUS_REWARDS.split, 'focus never scales with the defender count');
    return game.score - 12;
  };
  const two = bonus([]), three = bonus([{ x: 200, y: 60 }]);
  const four = bonus([{ x: 200, y: 60 }, { x: 800, y: 560 }]);
  assert.equal(two, 96);
  assert.equal(three, 125);
  assert.equal(four, 154);
  assert.ok(three > two, `three defenders (${three}) must beat two (${two}) for the same split`);
  assert.ok(four > three, `four defenders (${four}) must beat three (${three})`);
  assert.equal(SPLIT_PRESS.perDefender, 0.3);
});

test('with several crossed pairs the narrowest one sets the reward', () => {
  // Three defenders: A above the lane, B and C below it. The pass crosses both
  // A-B (gap 130) and A-C (gap 250), so the tightest thread, A-B, must pay.
  const a = { x: 450, y: 250 }, b = { x: 450, y: 380 }, c = { x: 450, y: 500 };
  const game = threadingGame([a, b, c]);
  assert.equal(game.pass(1), true);
  assert.ok(Math.abs(distance(a, b) - 130) < 1e-9);
  assert.ok(Math.abs(distance(a, c) - 250) < 1e-9);
  assert.ok(Math.abs(game.ball.split - (200 - 130) / (200 - 70)) < 1e-9, 'the 130 gap, not the 250 one, is the split that was made');
  for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP);
  assert.equal(game.splits, 1, 'one pass through a crowd is still one split');
  // (50 + 50 * 70/130) * 1.3 for the three-defender court.
  assert.equal(game.score - 12, 100);
});

test('splits scale with the combo multiplier like other bonuses', () => {
  const game = threadingGame([{ x: 450, y: 260 }, { x: 450, y: 340 }]);
  game.combo = 7;
  completePass(game, 1);
  assert.equal(game.splits, 1);
  assert.equal(game.score, (12 + 96) * 3);
});

test('a bank pass can split on its second segment, after the wall', () => {
  const bankGame = defenders => {
    const game = openGame({ speed: 0 });
    game.players[0].x = 200; game.players[0].y = 200;
    game.players[1].x = 600; game.players[1].y = 200;
    game.defenders = defenders.map((d, id) => ({ ...d, id }));
    return game;
  };
  const wall = bankPoint({ x: 200, y: 200 }, { x: 600, y: 200 });
  assert.ok(distance(wall, { x: 400, y: 50 }) < 1e-8);
  // The lane is (200,200) -> (400,50) -> (600,200). This pair straddles the
  // SECOND leg around its midpoint (500,125), and sits entirely to the right of
  // the first leg, which never gets past x = 400.
  const second = bankGame([{ x: 524, y: 93 }, { x: 476, y: 157 }]);
  for (const d of second.defenders) assert.ok(d.x > 400, 'both defenders are clear of the outgoing leg');
  assert.equal(segmentsCross({ x: 200, y: 200 }, wall, second.defenders[0], second.defenders[1]), false);
  assert.equal(segmentsCross(wall, { x: 600, y: 200 }, second.defenders[0], second.defenders[1]), true);
  completePass(second, 1, true);
  assert.equal(second.turnovers, 0);
  assert.equal(second.banks, 1);
  assert.equal(second.splits, 1);
  assert.equal(second.focus, FOCUS_REWARDS.split);
  assert.ok(second.events.some(event => event.type === 'score' && event.text.startsWith('SPLIT THE PRESS')));
  // A pair that both legs merely pass close to, on the same side of each: no split.
  const beside = bankGame([{ x: 430, y: 300 }, { x: 480, y: 320 }]);
  completePass(beside, 1, true);
  assert.equal(beside.splits, 0, 'running alongside a pair is not threading it');
  assert.equal(beside.banks, 1);
});

test('a plain pass carries an empty bonus list', () => {
  const game = threadingGame([]);
  completePass(game, 1);
  const scored = game.events.find(event => event.type === 'score');
  assert.equal(scored.text, 'PASS +12');
  assert.deepEqual(scored.bonuses, []);
});

test('a pass that splits and completes a triangle shows the split and pays both', () => {
  const game = openGame({ speed: 0 });
  const place = () => {
    game.players[0].x = 200; game.players[0].y = 300;
    game.players[1].x = 500; game.players[1].y = 560;
    game.players[2].x = 800; game.players[2].y = 300;
  };
  const pass = id => {
    // Settle past the one-touch window so only the labelled bonuses are in play.
    advance(game, Math.max(game.passCooldown, ONE_TOUCH.window) + STEP);
    place();
    assert.equal(game.pass(id), true);
    for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP);
    assert.equal(game.ball, null);
    assert.equal(game.carrier, id);
  };
  // Parked out of every lane so only the last pass threads the press.
  game.defenders = [{ x: 500, y: 60, id: 0 }, { x: 700, y: 60, id: 1 }];
  pass(1);
  pass(2);
  assert.equal(game.score, 24);
  game.defenders = [{ x: 500, y: 340, id: 0 }, { x: 500, y: 260, id: 1 }];
  pass(0);
  assert.equal(game.splits, 1);
  assert.equal(game.triangles, 1);
  assert.equal(game.score, 24 + 12 + 96 + 35, 'the triangle and the split both pay in full');
  assert.equal(game.focus, FOCUS_REWARDS.split + FOCUS_REWARDS.triangle);
  const scored = game.events.filter(event => event.type === 'score').at(-1);
  assert.equal(scored.text, 'SPLIT THE PRESS +143', 'the rarest bonus owns the label');
  assert.deepEqual(scored.bonuses, ['split', 'triangle']);
  assert.equal(scored.x, game.players[0].x);
  assert.equal(scored.y, game.players[0].y - 25);
});

test('the zone outranks the wall on a banked pass into the zone', () => {
  const game = openGame({ speed: 0 });
  game.players[0].x = 200; game.players[0].y = 200;
  game.players[1].x = 600; game.players[1].y = 200;
  game.zone = { x: 600, y: 200, r: 92 };
  completePass(game, 1, true);
  assert.equal(game.banks, 1);
  assert.equal(game.zones, 1);
  assert.equal(game.score, 12 + 18 + 25, 'the wall and the zone both pay in full');
  const scored = game.events.filter(event => event.type === 'score').at(-1);
  assert.equal(scored.text, 'ZONE BONUS +55');
  assert.deepEqual(scored.bonuses, ['wall', 'zone']);
});
