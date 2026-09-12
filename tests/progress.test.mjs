import test from 'node:test';
import assert from 'node:assert/strict';
import { freshProgress, readProgress, saveProgress, awardMatch, rank } from '../src/progress.js';

function finishedGame({ score = 200, target = 180, time = 0, turnovers = 0, key, difficulty, possessions } = {}) {
  return { score, turnovers, time, config: { target, key, difficulty, possessions } };
}

test('fresh progress has a stable, independent shape', () => {
  const first = freshProgress(), second = freshProgress();
  assert.deepEqual(first, { version: 1, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: 'balanced', difficulty: 'standard', lastCourt: 0 });
  first.courts[0] = { standard: { stars: 1 } };
  assert.deepEqual(second.courts, {});
});

test('a timer-and-score clear awards stars, XP, a best, and the next court', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 400 }), 'career', 0);
  assert.deepEqual(result, { cleared: true, stars: 3, xp: 110, newBest: true });
  assert.equal(progress.unlocked, 1);
  assert.deepEqual(progress.courts[0], { standard: { stars: 3, best: 400 } });
  assert.equal(progress.records['court-0-standard'], 400);
});

test('failed and prematurely abandoned results do not unlock a court', () => {
  for (const game of [finishedGame({ score: 179 }), finishedGame({ score: 999, time: 1 })]) {
    const progress = freshProgress();
    const result = awardMatch(progress, game, 'career', 0);
    assert.equal(result.cleared, false);
    assert.equal(result.stars, 0);
    assert.equal(progress.unlocked, 0);
  }
});

test('replays preserve higher stars and personal bests', () => {
  const progress = freshProgress();
  awardMatch(progress, finishedGame({ score: 450 }), 'career', 0);
  awardMatch(progress, finishedGame({ score: 200, turnovers: 2 }), 'career', 0);
  assert.equal(progress.courts[0].standard.stars, 3);
  assert.equal(progress.courts[0].standard.best, 450);
  assert.equal(progress.records['court-0-standard'], 450);
});

test('save and read round-trip while corrupt or unavailable storage fails safely', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const progress = { ...freshProgress(), xp: 725, unlocked: 2, lastCourt: 2, tactic: 'runner' };
  assert.equal(saveProgress(storage, progress), true);
  assert.deepEqual(readProgress(storage), progress);
  values.set('tiki-taka.progress.v1', '{broken');
  assert.deepEqual(readProgress(storage), freshProgress());
  const unavailable = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readProgress(unavailable), freshProgress());
  assert.equal(saveProgress(unavailable, progress), false);
});

test('loaded scalar values are clamped and invalid tactics fall back', () => {
  const storage = { getItem: () => JSON.stringify({
    version: 1, xp: -5, unlocked: 99, lastCourt: 99, tactic: 'cheat', sound: 'yes', difficulty: 'nightmare',
    courts: { 0: { standard: { stars: -9, best: -3 } }, 1: { standard: { stars: 999, best: 42 }, ruthless: { stars: 2, best: 10 } }, 99: { standard: { stars: 3, best: 1 } } },
    records: { valid: 12, negative: -1, infinite: null, text: '100' },
  }) };
  const progress = readProgress(storage);
  assert.equal(progress.xp, 0);
  assert.equal(progress.unlocked, 5);
  assert.equal(progress.lastCourt, 5);
  assert.equal(progress.tactic, 'balanced');
  assert.equal(progress.difficulty, 'standard');
  assert.equal(progress.sound, true);
  assert.deepEqual(progress.courts, {
    0: { standard: { stars: 0, best: 0 } },
    1: { standard: { stars: 3, best: 42 }, ruthless: { stars: 2, best: 10 } },
  });
  assert.deepEqual(progress.records, { valid: 12 });
});

test('normalizeProgress survives garbage per-tier court data without throwing', () => {
  const storage = { getItem: () => JSON.stringify({
    version: 1,
    courts: {
      0: 42,
      1: 'not an object',
      2: null,
      3: { standard: 'not an object', relaxed: null, ruthless: [] },
      4: {},
      5: { standard: { stars: 2, best: 100 } },
    },
  }) };
  const progress = readProgress(storage);
  assert.deepEqual(progress.courts, { 5: { standard: { stars: 2, best: 100 } } });
});

test('a stored difficulty selection round-trips and an unknown value falls back to standard', () => {
  const storage = { getItem: () => JSON.stringify({ version: 1, difficulty: 'ruthless' }) };
  assert.equal(readProgress(storage).difficulty, 'ruthless');
  const bogus = { getItem: () => JSON.stringify({ version: 1, difficulty: 'nightmare' }) };
  assert.equal(readProgress(bogus).difficulty, 'standard');
});

test('three turnovers cannot clear a court even after reaching the timer and score target', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 999, turnovers: 3 }), 'career', 0);
  assert.equal(result.cleared, false);
  assert.equal(progress.unlocked, 0);
});

test('the possessions limit from config governs the clear check, not a hardcoded three', () => {
  // Relaxed allows 5 turnovers: the 5th ends the run, but 4 turnovers still clears.
  const relaxedProgress = freshProgress();
  const relaxedResult = awardMatch(relaxedProgress, finishedGame({ score: 999, turnovers: 4, difficulty: 'relaxed', possessions: 5 }), 'career', 0);
  assert.equal(relaxedResult.cleared, true);

  // Ruthless allows only 1 turnover: the 1st ends the run and blocks the clear.
  const ruthlessProgress = freshProgress();
  const ruthlessResult = awardMatch(ruthlessProgress, finishedGame({ score: 999, turnovers: 1, difficulty: 'ruthless', possessions: 1 }), 'career', 0);
  assert.equal(ruthlessResult.cleared, false);
});

test('practice remains clearable after unlimited recoveries', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 180, target: 120, turnovers: 8 }), 'practice', 0);
  assert.equal(result.cleared, true);
  assert.equal(progress.unlocked, 0);
});

test('daily records retain only the newest thirty keys without deleting permanent records', () => {
  const progress = freshProgress();
  progress.records.endless = 123;
  for (let day = 1; day <= 35; day++) progress.records[`daily-2026-08-${String(day).padStart(2, '0')}`] = day;
  awardMatch(progress, finishedGame({ key: '2026-09-01' }), 'daily', 0);
  const daily = Object.keys(progress.records).filter(key => key.startsWith('daily-'));
  assert.equal(daily.length, 30);
  assert.equal(progress.records.endless, 123);
  assert.equal(progress.records['daily-2026-09-01'], 200);
  assert.equal('daily-2026-08-01' in progress.records, false);
});

test('stars and personal bests are tracked separately per tier on the same court', () => {
  const progress = freshProgress();
  awardMatch(progress, finishedGame({ score: 400, difficulty: 'relaxed' }), 'career', 0);
  awardMatch(progress, finishedGame({ score: 250, difficulty: 'ruthless' }), 'career', 0);
  assert.deepEqual(progress.courts[0].relaxed, { stars: 3, best: 400 });
  assert.deepEqual(progress.courts[0].ruthless, { stars: 1, best: 250 });
  assert.equal(progress.courts[0].standard, undefined);
  assert.equal(progress.records['court-0-relaxed'], 400);
  assert.equal(progress.records['court-0-ruthless'], 250);
});

test('a clear on Relaxed unlocks the next court, same as any other tier', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 999, difficulty: 'relaxed' }), 'career', 0);
  assert.equal(result.cleared, true);
  assert.equal(progress.unlocked, 1);
});

test('the clear bonus scales with tier while the score-based XP formula is untouched', () => {
  for (const [difficulty, bonus] of [['relaxed', 30], ['standard', 60], ['ruthless', 90]]) {
    const progress = freshProgress();
    const result = awardMatch(progress, finishedGame({ score: 400, difficulty }), 'career', 0);
    assert.equal(result.xp, Math.max(10, Math.floor(400 / 8)) + bonus, difficulty);
  }
  // An unknown/missing difficulty falls back to standard's bonus.
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 400, difficulty: 'nightmare' }), 'career', 0);
  assert.equal(result.xp, Math.max(10, Math.floor(400 / 8)) + 60);
});

test('rank boundaries advance levels, names, and fractions predictably', () => {
  assert.deepEqual(rank(0), { level: 1, name: 'Touchline beginner', fraction: 0, next: 300 });
  assert.deepEqual(rank(299), { level: 1, name: 'Touchline beginner', fraction: 299 / 300, next: 1 });
  assert.deepEqual(rank(300), { level: 2, name: 'Touchline beginner', fraction: 0, next: 300 });
  assert.equal(rank(600).name, 'Space finder');
  assert.equal(rank(99999).name, 'Master of possession');
});
