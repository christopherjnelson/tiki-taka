import test from 'node:test';
import assert from 'node:assert/strict';
import { freshProgress, readProgress, saveProgress, awardMatch, rank } from '../src/progress.js';

function finishedGame({ score = 200, target = 180, time = 0, turnovers = 0, key } = {}) {
  return { score, turnovers, time, config: { target, key } };
}

test('fresh progress has a stable, independent shape', () => {
  const first = freshProgress(), second = freshProgress();
  assert.deepEqual(first, { version: 1, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: 'balanced', lastCourt: 0 });
  first.courts[0] = { stars: 1 };
  assert.deepEqual(second.courts, {});
});

test('a timer-and-score clear awards stars, XP, a best, and the next court', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 400 }), 'career', 0);
  assert.deepEqual(result, { cleared: true, stars: 3, xp: 110, newBest: true });
  assert.equal(progress.unlocked, 1);
  assert.deepEqual(progress.courts[0], { stars: 3, best: 400 });
  assert.equal(progress.records['court-0'], 400);
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
  assert.equal(progress.courts[0].stars, 3);
  assert.equal(progress.courts[0].best, 450);
  assert.equal(progress.records['court-0'], 450);
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
    version: 1, xp: -5, unlocked: 99, lastCourt: 99, tactic: 'cheat', sound: 'yes',
    courts: { 0: { stars: -9, best: -3 }, 1: { stars: 999, best: 42 }, 99: { stars: 3, best: 1 } },
    records: { valid: 12, negative: -1, infinite: null, text: '100' },
  }) };
  const progress = readProgress(storage);
  assert.equal(progress.xp, 0);
  assert.equal(progress.unlocked, 5);
  assert.equal(progress.lastCourt, 5);
  assert.equal(progress.tactic, 'balanced');
  assert.equal(progress.sound, true);
  assert.deepEqual(progress.courts, { 0: { stars: 0, best: 0 }, 1: { stars: 3, best: 42 } });
  assert.deepEqual(progress.records, { valid: 12 });
});

test('three turnovers cannot clear a court even after reaching the timer and score target', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 999, turnovers: 3 }), 'career', 0);
  assert.equal(result.cleared, false);
  assert.equal(progress.unlocked, 0);
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

test('rank boundaries advance levels, names, and fractions predictably', () => {
  assert.deepEqual(rank(0), { level: 1, name: 'Touchline beginner', fraction: 0, next: 300 });
  assert.deepEqual(rank(299), { level: 1, name: 'Touchline beginner', fraction: 299 / 300, next: 1 });
  assert.deepEqual(rank(300), { level: 2, name: 'Touchline beginner', fraction: 0, next: 300 });
  assert.equal(rank(600).name, 'Space finder');
  assert.equal(rank(99999).name, 'Master of possession');
});
