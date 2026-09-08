import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, COURTS, TACTICS, FOCUS_REWARDS, SPLIT_PRESS, ONE_TOUCH, LIMITS, seeded, dailyConfig, bankPoint, distance, segmentDistance } from '../src/game.js';

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
    assert.equal({ balanced: 5, runner: 3, maestro: 4 }[key], TACTICS[key].focus);
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

test('three-player triangles earn 1.5 seconds of focus without exceeding capacity', () => {
  const game = openGame();
  game.focus = 0;
  completePass(game, 1);
  completePass(game, 2);
  const before = game.score, focusBefore = game.focus;
  completePass(game, 0);
  assert.equal(game.triangles, 1);
  assert.ok(game.score - before > 12);
  assert.equal(game.focus, focusBefore + FOCUS_REWARDS.triangle);
  assert.ok(game.events.some(event => event.type === 'focus' && event.text === 'FOCUS +1.5s' && event.x === game.players[0].x));
  game.focus = game.tactic.focus;
  completePass(game, 1);
  assert.equal(game.focus, game.tactic.focus);
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
  assert.equal(game.focus, FOCUS_REWARDS.wall);
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

test('plain passes earn no focus and combined skill rewards stack at tactic capacity', () => {
  const game = openGame({}, 'runner');
  completePass(game, 1);
  assert.equal(game.focus, 0);
  game.zone = { ...game.players[2], r: 92 };
  completePass(game, 2, true);
  assert.equal(game.focus, FOCUS_REWARDS.wall + FOCUS_REWARDS.zone);
  game.zone = { ...game.players[0], r: 92 };
  completePass(game, 0, true);
  assert.equal(game.focus, game.tactic.focus);
  assert.ok(game.events.some(event => event.type === 'focus' && event.text === 'FOCUS +1.5s'));
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
  assert.equal(game.focus, 1);
  assert.equal(game.focusNeedsRelease, true);
  const beforeHeld = game.elapsed;
  advance(game, 0.25, { focus: true });
  assert.ok(Math.abs(game.elapsed - beforeHeld - 0.25) < 1e-8);
  assert.equal(game.focus, 1);
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

test('a lane with fewer than two close defenders is not a split', () => {
  const empty = threadingGame([]);
  completePass(empty, 1);
  assert.equal(empty.splits, 0);
  assert.equal(empty.score, 12);
  const single = threadingGame([{ x: 450, y: 330 }, { x: 450, y: 520 }]);
  completePass(single, 1);
  assert.equal(single.turnovers, 0);
  assert.equal(single.splits, 0);
  assert.equal(single.score, 12);
  assert.equal(single.focus, 0);
});

test('splitting two defenders earns the bonus, focus and its own label', () => {
  const game = threadingGame([{ x: 450, y: 330 }, { x: 450, y: 270 }]);
  assert.equal(game.pass(1), true);
  assert.ok(Math.abs(game.ball.split - 1 / 3) < 1e-9, 'the split is measured when the pass is struck');
  game.defenders[0].y = 40; game.defenders[1].y = 560;
  for (let frame = 0; game.ball && frame < 600 && game.status === 'playing'; frame++) game.update(STEP);
  assert.equal(game.ball, null);
  assert.equal(game.carrier, 1);
  assert.equal(game.turnovers, 0);
  assert.equal(game.splits, 1, 'defenders scattering during flight cannot erase the split that was aimed through');
  assert.equal(game.score, 12 + 67);
  assert.equal(game.focus, FOCUS_REWARDS.split);
  assert.ok(game.events.some(event => event.type === 'score' && event.text === 'SPLIT THE PRESS +79'));
  assert.ok(FOCUS_REWARDS.split > FOCUS_REWARDS.triangle, 'splitting the press pays the most focus in the game');
});

test('tighter splits outscore looser ones and top the bonus ladder', () => {
  const bonus = gap => {
    const game = threadingGame([{ x: 450, y: 300 + gap }, { x: 450, y: 300 - gap }]);
    completePass(game, 1);
    assert.equal(game.splits, 1);
    return game.score - 12;
  };
  const tight = bonus(22), loose = bonus(42);
  assert.ok(tight > loose, `tight ${tight} must beat loose ${loose}`);
  assert.equal(tight, 76);
  assert.equal(loose, 53);
  assert.ok(loose > 35, 'even the loosest split outscores a triangle');
  assert.equal(SPLIT_PRESS.base, 50);
  assert.equal(SPLIT_PRESS.base + SPLIT_PRESS.tight, 100);
  assert.ok(bonus(21) === 77 && 77 <= SPLIT_PRESS.base + SPLIT_PRESS.tight, 'the tightest survivable split stays under the ceiling');
});

test('the same split pays more on a court with more defenders', () => {
  const pair = [{ x: 450, y: 330 }, { x: 450, y: 270 }];
  const bonus = extra => {
    // The spare defenders sit far off the lane: identical geometry, busier court.
    const game = threadingGame([...pair, ...extra]);
    completePass(game, 1);
    assert.equal(game.splits, 1);
    assert.equal(game.focus, FOCUS_REWARDS.split, 'focus never scales with the defender count');
    return game.score - 12;
  };
  const two = bonus([]), three = bonus([{ x: 200, y: 60 }]);
  const four = bonus([{ x: 200, y: 60 }, { x: 800, y: 560 }]);
  assert.equal(two, 67);
  assert.equal(three, 87);
  assert.equal(four, 107);
  assert.ok(three > two, `three defenders (${three}) must beat two (${two}) for the same split`);
  assert.ok(four > three, `four defenders (${four}) must beat three (${three})`);
  assert.equal(SPLIT_PRESS.perDefender, 0.3);
});

test('splits scale with the combo multiplier like other bonuses', () => {
  const game = threadingGame([{ x: 450, y: 330 }, { x: 450, y: 270 }]);
  game.combo = 7;
  completePass(game, 1);
  assert.equal(game.splits, 1);
  assert.equal(game.score, (12 + 67) * 3);
});

test('bank passes are split across both of their segments without double counting', () => {
  const bankGame = defenders => {
    const game = openGame({ speed: 0 });
    game.players[0].x = 200; game.players[0].y = 200;
    game.players[1].x = 600; game.players[1].y = 200;
    game.defenders = defenders.map((d, id) => ({ ...d, id }));
    return game;
  };
  const wall = bankPoint({ x: 200, y: 200 }, { x: 600, y: 200 });
  assert.ok(distance(wall, { x: 400, y: 50 }) < 1e-8);
  const second = bankGame([{ x: 482, y: 149 }, { x: 518, y: 101 }]);
  for (const d of second.defenders) {
    assert.ok(segmentDistance(d, { x: 200, y: 200 }, wall) > SPLIT_PRESS.radius);
    assert.ok(segmentDistance(d, wall, { x: 600, y: 200 }) < SPLIT_PRESS.radius);
  }
  completePass(second, 1, true);
  assert.equal(second.turnovers, 0);
  assert.equal(second.banks, 1);
  assert.equal(second.splits, 1);
  assert.equal(second.focus, FOCUS_REWARDS.wall + FOCUS_REWARDS.split);
  assert.ok(second.events.some(event => event.type === 'score' && event.text.startsWith('SPLIT THE PRESS')));
  const corner = bankGame([{ x: 400, y: 80 }, { x: 200, y: 520 }]);
  assert.ok(segmentDistance(corner.defenders[0], { x: 200, y: 200 }, wall) < SPLIT_PRESS.radius);
  assert.ok(segmentDistance(corner.defenders[0], wall, { x: 600, y: 200 }) < SPLIT_PRESS.radius);
  completePass(corner, 1, true);
  assert.equal(corner.splits, 0, 'one defender near both segments counts once');
  assert.equal(corner.banks, 1);
});
