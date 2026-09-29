import test from 'node:test';
import assert from 'node:assert/strict';
import { freshProgress, readProgress, saveProgress, awardMatch, roundCounts, rank, isReadableProgress } from '../src/progress.js';

// `reference` is what a clean round scores on the court; `target` is the
// clear line taken from it, and the star rungs are their own ratios of the
// reference (STAR_RATIOS: 0.6 and 0.95). The default pair keeps the same
// ~0.3 relationship the real courts use, so 600/180 means: clear at 180,
// two stars at 360, three at 570 and no turnovers.
function finishedGame({ score = 200, reference = 600, target = 180, time = 0, turnovers = 0, key, difficulty, possessions, endless, kotc } = {}) {
  return { score, turnovers, time, config: { reference, target, key, difficulty, possessions, endless, kotc } };
}

test('fresh progress has a stable, independent shape', () => {
  const first = freshProgress(), second = freshProgress();
  assert.deepEqual(first, { version: 2, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: 'balanced', difficulty: 'standard', lastCourt: 0 });
  first.courts[0] = { standard: { stars: 1 } };
  assert.deepEqual(second.courts, {});
});

test('a timer-and-score clear awards stars, XP, a best, and the next court', () => {
  const progress = freshProgress();
  // 600 is the fixture's reference: a clean round that scores what the court
  // is tuned to produce, which is precisely what three stars now means.
  const result = awardMatch(progress, finishedGame({ score: 600 }), 'career', 0);
  assert.deepEqual(result, { cleared: true, stars: 3, xp: 98, newBest: true });
  assert.equal(progress.unlocked, 1);
  assert.deepEqual(progress.courts[0], { standard: { stars: 3, best: 600 } });
  assert.equal(progress.records['court-0-standard'], 600);
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
  awardMatch(progress, finishedGame({ score: 600 }), 'career', 0);
  awardMatch(progress, finishedGame({ score: 200, turnovers: 2 }), 'career', 0);
  assert.equal(progress.courts[0].standard.stars, 3);
  assert.equal(progress.courts[0].standard.best, 600);
  assert.equal(progress.records['court-0-standard'], 600);
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
    version: 2, xp: -5, unlocked: 99, lastCourt: 99, tactic: 'cheat', sound: 'yes', difficulty: 'nightmare',
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
    version: 2,
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
  const storage = { getItem: () => JSON.stringify({ version: 2, difficulty: 'ruthless' }) };
  assert.equal(readProgress(storage).difficulty, 'ruthless');
  const bogus = { getItem: () => JSON.stringify({ version: 2, difficulty: 'nightmare' }) };
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

test('practice remains clearable after unlimited recoveries, but earns no XP', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 180, target: 120, turnovers: 8 }), 'practice', 0);
  assert.equal(result.cleared, true);
  assert.equal(progress.unlocked, 0);
  assert.equal(result.xp, 0);
  assert.equal(progress.xp, 0);
});

test('stars and personal bests are tracked separately per tier on the same court', () => {
  const progress = freshProgress();
  awardMatch(progress, finishedGame({ score: 500, difficulty: 'relaxed' }), 'career', 0);
  awardMatch(progress, finishedGame({ score: 250, difficulty: 'ruthless' }), 'career', 0);
  // Against the fixture's reference of 600: two stars at 450, three at 600.
  assert.deepEqual(progress.courts[0].relaxed, { stars: 2, best: 500 });
  assert.deepEqual(progress.courts[0].ruthless, { stars: 1, best: 250 });
  assert.equal(progress.courts[0].standard, undefined);
  assert.equal(progress.records['court-0-relaxed'], 500);
  assert.equal(progress.records['court-0-ruthless'], 250);
});

test('a clear on Relaxed unlocks the next court, same as any other tier', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 999, difficulty: 'relaxed' }), 'career', 0);
  assert.equal(result.cleared, true);
  assert.equal(progress.unlocked, 1);
});

test('the first clear of a court/tier pays far more than a repeat clear of the same one', () => {
  const progress = freshProgress();
  const round = () => finishedGame({ score: 200, target: 180, reference: 400 });
  const first = awardMatch(progress, round(), 'career', 0);
  const repeat = awardMatch(progress, round(), 'career', 0);
  // performance 10 + one star 6 + clear bonus (60 first, 5 repeat).
  assert.equal(first.xp, 76);
  assert.equal(repeat.xp, 21);
  assert.ok(first.xp > repeat.xp);
});

test('the repeat-clear bonus scales with court index too, not just the first clear', () => {
  const cases = [
    ['relaxed', 0, 180, 21],
    ['standard', 0, 180, 21],
    ['ruthless', 0, 180, 26],
    ['standard', 3, 1600, 31],
    ['standard', 5, 2400, 36],
    ['ruthless', 5, 2400, 46],
  ];
  for (const [difficulty, courtIndex, target, expected] of cases) {
    const progress = freshProgress();
    const round = () => finishedGame({ score: target, target, reference: target * 2, difficulty });
    awardMatch(progress, round(), 'career', courtIndex);
    const repeat = awardMatch(progress, round(), 'career', courtIndex);
    assert.equal(repeat.xp, expected, `${difficulty} court ${courtIndex}`);
  }
  // Same tier, harder court must pay a strictly bigger repeat bonus - this
  // is the bug this test guards against: a flat per-tier repeat bonus with
  // no court term made grinding the easiest court as efficient as the
  // hardest.
  const easy = freshProgress();
  awardMatch(easy, finishedGame({ score: 180, target: 180, reference: 360, difficulty: 'standard' }), 'career', 0);
  const easyRepeat = awardMatch(easy, finishedGame({ score: 180, target: 180, reference: 360, difficulty: 'standard' }), 'career', 0);
  const hard = freshProgress();
  awardMatch(hard, finishedGame({ score: 2400, target: 2400, reference: 4800, difficulty: 'standard' }), 'career', 5);
  const hardRepeat = awardMatch(hard, finishedGame({ score: 2400, target: 2400, reference: 4800, difficulty: 'standard' }), 'career', 5);
  assert.ok(hardRepeat.xp > easyRepeat.xp, 'court 5 Standard repeat must pay more than court 0 Standard repeat');
});

test('first-clear XP scales with tier and with court index', () => {
  const cases = [
    ['relaxed', 0, 180, 51],
    ['standard', 0, 180, 76],
    ['ruthless', 0, 180, 106],
    ['relaxed', 3, 1600, 81],
    ['standard', 3, 1600, 121],
    ['ruthless', 3, 1600, 176],
  ];
  for (const [difficulty, courtIndex, target, expected] of cases) {
    const progress = freshProgress();
    const result = awardMatch(progress, finishedGame({ score: target, target, reference: target * 2, difficulty }), 'career', courtIndex);
    assert.equal(result.xp, expected, `${difficulty} court ${courtIndex}`);
  }
});

test('endless pays performance XP only - no star bonus, no clear bonus', () => {
  const progress = freshProgress();
  // An Extra Time run's "score" is the seconds it lasted. Its bank running
  // out (time <= 0) is the run ending, not a clear, so it is never "cleared".
  const result = awardMatch(progress, finishedGame({ score: 200, reference: 0, target: 0, time: 200, endless: true }), 'endless', 0);
  assert.equal(result.cleared, false);
  assert.equal(result.stars, 0, 'there is nothing to be graded on');
  // Performance only, against ENDLESS_REFERENCE (180 seconds) and capped at 20.
  assert.equal(result.xp, 20);
  const timedOut = awardMatch(freshProgress(), finishedGame({ score: 200, reference: 0, target: 0, time: 0, endless: true }), 'endless', 0);
  assert.equal(timedOut.cleared, false, 'an empty bank is not a clear either');
  assert.equal(timedOut.stars, 0);
  const short = awardMatch(freshProgress(), finishedGame({ score: 45, reference: 0, target: 0, time: 45, endless: true }), 'endless', 0);
  assert.equal(short.xp, 5, 'a 45-second run pays a quarter of the cap');
});

test('every finished endless run records a personal best in seconds', () => {
  const progress = freshProgress();
  const run = (seconds) => awardMatch(progress, finishedGame({ score: seconds, reference: 0, target: 0, time: seconds, endless: true }), 'endless', 0);
  const first = run(96);
  assert.equal(first.newBest, true);
  assert.equal(progress.records.endless, 96, 'the best is the longest run, in seconds');
  assert.equal(run(40).newBest, false, 'a shorter run does not overwrite it');
  assert.equal(progress.records.endless, 96);
  assert.equal(run(150).newBest, true);
  assert.equal(progress.records.endless, 150);
});

test('a non-practice mode that fails to clear still gets the 3 XP floor', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 1, target: 180 }), 'career', 0);
  assert.equal(result.cleared, false);
  assert.equal(result.xp, 3);
});

test('a cleared career round records a personal best; an uncleared one does not', () => {
  const cleared = freshProgress();
  const clearedResult = awardMatch(cleared, finishedGame({ score: 400 }), 'career', 0);
  assert.equal(clearedResult.cleared, true);
  assert.equal(cleared.records['court-0-standard'], 400);

  const failed = freshProgress();
  const failedResult = awardMatch(failed, finishedGame({ score: 400, turnovers: 3 }), 'career', 0);
  assert.equal(failedResult.cleared, false);
  assert.equal(failedResult.newBest, false);
  assert.equal(failed.records['court-0-standard'], undefined);
  assert.deepEqual(failed.courts, {});
});

test('practice records nothing at all, cleared or not', () => {
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 999, target: 120, turnovers: 8 }), 'practice', 0);
  assert.equal(result.cleared, true);
  assert.equal(result.newBest, false);
  assert.deepEqual(progress.records, {});
});

test('a version-1 stored progress resets xp to 0 but keeps everything else', () => {
  const storage = { getItem: () => JSON.stringify({
    version: 1,
    xp: 91234,
    unlocked: 3,
    lastCourt: 2,
    tactic: 'runner',
    difficulty: 'ruthless',
    sound: false,
    courts: { 0: { standard: { stars: 3, best: 500 } } },
    records: { 'court-0-standard': 500, 'daily-2026-09-01': 200 },
  }) };
  const progress = readProgress(storage);
  assert.equal(progress.version, 2);
  assert.equal(progress.xp, 0);
  assert.equal(progress.unlocked, 3);
  assert.equal(progress.lastCourt, 2);
  assert.equal(progress.tactic, 'runner');
  assert.equal(progress.difficulty, 'ruthless');
  assert.equal(progress.sound, false);
  assert.deepEqual(progress.courts, { 0: { standard: { stars: 3, best: 500 } } });
  // The Daily mode no longer exists, so legacy daily-* keys are dropped
  // rather than carried forward as dead weight.
  assert.deepEqual(progress.records, { 'court-0-standard': 500 });
});

test('isReadableProgress accepts known versions and junk, but not a future version', () => {
  // Known versions this build understands.
  assert.equal(isReadableProgress({ version: 1 }), true);
  assert.equal(isReadableProgress({ version: 2 }), true);
  // No version at all is a half-written or synthetic row, not a future save
  // - normalizeProgress already repairs this for free, so it stays readable.
  assert.equal(isReadableProgress({}), true);
  assert.equal(isReadableProgress(null), true);
  assert.equal(isReadableProgress(undefined), true);
  // An explicit version this build has never heard of is the one case that
  // actually means "a newer build wrote this and I would destroy data by
  // treating it as fresh."
  assert.equal(isReadableProgress({ version: 3 }), false);
  assert.equal(isReadableProgress({ version: 99, xp: 1, courts: { 0: { standard: { stars: 3 } } } }), false);
  // Malformed shapes are not a version claim either.
  assert.equal(isReadableProgress([1, 2, 3]), true);
  assert.equal(isReadableProgress('not an object'), true);
});

test('rank boundaries advance levels, names, and fractions predictably', () => {
  assert.deepEqual(rank(0), { level: 1, name: 'Touchline beginner', into: 0, span: 70, fraction: 0, next: 70 });
  assert.deepEqual(rank(69), { level: 1, name: 'Touchline beginner', into: 69, span: 70, fraction: 69 / 70, next: 1 });
  assert.deepEqual(rank(70), { level: 2, name: 'Touchline beginner', into: 0, span: 80, fraction: 0, next: 80 });
});

test('rank titles change every 4 levels', () => {
  assert.equal(rank(0).name, 'Touchline beginner'); // level 1
  assert.equal(rank(70).name, 'Touchline beginner'); // level 2
  assert.equal(rank(150).name, 'Touchline beginner'); // level 3
  assert.equal(rank(230).name, 'Touchline beginner'); // level 4
  assert.equal(rank(330).name, 'First touch'); // level 5, first title change
  assert.equal(rank(3890).name, 'Lane threader'); // level 25
  assert.equal(rank(10650).name, 'Tiki taka'); // level 45, final title
});

test('rank at a mid-curve level reports the right level and span', () => {
  const r = rank(4000); // between level 25 (3890) and level 26 (4150)
  assert.equal(r.level, 25);
  assert.equal(r.into, 110);
  assert.equal(r.span, 260);
});

test('rank caps at level 50 with a zero span and full bar', () => {
  const atCap = rank(12840); // exactly the level-50 threshold
  assert.deepEqual(atCap, { level: 50, name: 'Tiki taka', into: 0, span: 0, fraction: 1, next: 0 });
  const beyondCap = rank(99999);
  assert.equal(beyondCap.level, 50);
  assert.equal(beyondCap.name, 'Tiki taka');
  assert.equal(beyondCap.span, 0);
  assert.equal(beyondCap.fraction, 1);
  assert.equal(beyondCap.into, 99999 - 12840);
});

test('every finished King of the Court round counts, and is never a clear', () => {
  assert.equal(roundCounts('kotc', false), true);
  assert.equal(roundCounts('kotc', true), true);
  // Turnovers are ground lost, not possessions spent, so a round full of them
  // still saves.
  const progress = freshProgress();
  const result = awardMatch(progress, finishedGame({ score: 30, reference: 0, target: 0, time: 0, turnovers: 6, kotc: true, difficulty: 'ruthless' }), 'kotc', 0);
  assert.equal(result.cleared, false);
  assert.equal(result.stars, 0);
  assert.equal(result.newBest, true);
  assert.equal(progress.records['kotc-ruthless'], 30, 'the best is kept per tier');
  assert.equal(progress.courts[0], undefined, 'it never touches the tour progression');
  assert.equal(progress.unlocked, 0);
});

test('King of the Court pays performance XP against its own 48-square reference', () => {
  const xp = (score) => awardMatch(freshProgress(), finishedGame({ score, reference: 0, target: 0, time: 0, kotc: true }), 'kotc', 0).xp;
  assert.equal(xp(48), 20, 'two crowns pays the full cap');
  assert.equal(xp(96), 20, 'the cap holds');
  assert.equal(xp(24), 10, 'one crown pays half');
  assert.equal(xp(1), 3, 'the 3 XP floor applies');
  const progress = freshProgress();
  const run = (score) => awardMatch(progress, finishedGame({ score, reference: 0, target: 0, time: 0, kotc: true }), 'kotc', 0);
  assert.equal(run(20).newBest, true);
  assert.equal(run(12).newBest, false);
  assert.equal(progress.records['kotc-standard'], 20);
  assert.equal(run(31).newBest, true);
  assert.equal(progress.records['kotc-standard'], 31);
  const relaxed = awardMatch(progress, finishedGame({ score: 5, reference: 0, target: 0, time: 0, kotc: true, difficulty: 'relaxed' }), 'kotc', 0);
  assert.equal(relaxed.newBest, true, 'another tier has its own record');
});
