import { COURTS, DIFFICULTIES, STAR_RATIOS } from "./game.js";
const DIFFICULTY_IDS = DIFFICULTIES.map((tier) => tier.id);
// XP rewards clearing NEW ground, not grinding a round that's already been
// won. Score alone pays a small, capped amount ("performance"); both clear
// payouts scale with how hard the court is - later courts and higher tiers
// pay more either way - but only the first-clear payout is large. Replaying
// a court/tier that has already been cleared pays the same shape of bonus,
// scaled down to a trickle. This is why a career clear checks whether the
// court/tier has ever had stars before writing this round's stars.
const STAR_XP = 6;
const FIRST_CLEAR_TIER = { relaxed: 0.6, standard: 1, ruthless: 1.5 };
// Stand-in "target" for endless and other modes with no real target, so
// performance XP still has a reference point to scale against.
const ENDLESS_REFERENCE = 600;
// XP is a progression reward, so it is only paid in progression modes: World
// tour (career), Endless, and King of the Court ("kotc" - a disabled
// placeholder today, with no gameplay of its own yet, so it is folded into
// the plain performance-only rule below until it ships its own). Practice is
// excluded on purpose: a no-stakes sandbox for finding your feet, not a way
// to grind levels.
const XP_MODES = new Set(["career", "endless", "kotc"]);
// Per-mode "does this round save?" rule. An attempt is not a result: only a
// round that actually counts as a win in ITS mode should write a personal
// best, a round_scores row, or a leaderboard entry. This is deliberately a
// per-mode switch and not one global `if (cleared)` gate. `cleared` means
// `turnovers < possessions`, and Endless is one possession that ends BY
// losing it - turnovers is always 1, so `cleared` is always false for
// Endless no matter how the run went. A single global check would silently
// stop Endless from ever saving anything the day it ships, which is exactly
// backwards for the one mode whose whole point is a leaderboard result.
// Endless is being redesigned as a survival mode scored on elapsed time, not
// points, so it needs its own condition here (not `cleared`) when it ships -
// same for King of the Court once it has gameplay. Until then both are
// explicit `false` below, on their own seam, rather than falling through to
// a shared rule that might accidentally start counting them.
export function roundCounts(mode, cleared) {
  switch (mode) {
    case "career":
      return cleared;
    case "practice":
      // No-stakes sandbox for finding your feet - never saved, never a
      // personal best, no matter the score.
      return false;
    case "endless":
      // TODO(endless-survival): replace with the elapsed-time survival rule
      // once Endless ships its redesign. `cleared` is always false here (see
      // above) - do not swap this for `cleared`.
      return false;
    case "kotc":
      // TODO(kotc): King of the Court has no gameplay yet; give it its own
      // rule here when it ships.
      return false;
    default:
      return false;
  }
}
export function freshProgress() {
  return {
    version: 2,
    xp: 0,
    unlocked: 0,
    courts: {},
    records: {},
    sound: true,
    tactic: "balanced",
    difficulty: "standard",
    lastCourt: 0,
  };
}
// A stored progress object's `version` says which shape it is. This build
// only understands 1 and 2 (see normalizeProgress below). A version this
// build has never heard of can only mean one thing: a NEWER build wrote it,
// using fields this code does not know how to read. That is a fundamentally
// different situation from junk or partial data - there is nothing to
// "repair" here, because the data this build is missing is real and simply
// not expressible in a build this old. Callers that overwrite storage (see
// saveUserData in packages/data/src/supabase.js) must check this BEFORE
// writing: normalizing an unreadable value to freshProgress() and writing
// that back is exactly how a real player's unlocked courts and stars were
// erased by an old client saving over a newer save it could not parse.
//
// A value with NO version at all (`{}`, or a half-written row) is not a
// future save - it is exactly the junk/partial case normalizeProgress
// already repairs for free, and always has, so it is "readable" here too.
// Only an EXPLICIT version this build does not recognise (anything but 1,
// 2, or absent) counts as unreadable.
export function isReadableProgress(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return true;
  if (value.version === undefined) return true;
  return value.version === 1 || value.version === 2;
}
// Progress arrives from storage, from a save row written by an older build,
// and from a remote account whose row may be empty or half-written. Every one
// of those paths has to end at a complete object: a missing `tactic` alone is
// enough to break the first render, and a bad row persists, so the same round
// trip fails on every reload until the value is repaired.
//
// This stays forgiving for junk/partial data - it is not the guard against
// clobbering a future version. That is isReadableProgress above; callers who
// are about to WRITE storage must consult it first.
export function normalizeProgress(value) {
  try {
    if (!value || (value.version !== 1 && value.version !== 2)) return freshProgress();
    const progress = freshProgress();
    // The old flat 300-XP-per-level curve inflated levels far past what this
    // rebalance intends, and there is no honest way to rescale a version-1 xp
    // total onto the new progressive curve. So a version-1 save resets xp to
    // 0 and comes back stamped version 2 - everything else it recorded
    // (unlocked courts, stars, records, tactic, difficulty) is preserved.
    // Legacy `daily-*` record keys are dropped below regardless of version:
    // the Daily mode they named no longer exists, so keeping them around
    // would just be dead weight.
    progress.xp =
      value.version === 2 && Number.isFinite(value.xp) ? Math.max(0, value.xp) : 0;
    progress.unlocked = Math.min(
      COURTS.length - 1,
      Math.max(0, Math.floor(Number(value.unlocked) || 0)),
    );
    progress.lastCourt = Math.min(
      progress.unlocked,
      Math.max(0, Math.floor(Number(value.lastCourt) || 0)),
    );
    if (
      value.courts &&
      typeof value.courts === "object" &&
      !Array.isArray(value.courts)
    ) {
      for (let index = 0; index < COURTS.length; index++) {
        const court = value.courts[index];
        if (!court || typeof court !== "object" || Array.isArray(court))
          continue;
        const entry = {};
        for (const tier of DIFFICULTY_IDS) {
          const raw = court[tier];
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
          const stars = Number.isFinite(raw.stars)
            ? Math.min(3, Math.max(0, Math.floor(raw.stars)))
            : 0;
          const best = Number.isFinite(raw.best) ? Math.max(0, raw.best) : 0;
          entry[tier] = { stars, best };
        }
        if (Object.keys(entry).length) progress.courts[index] = entry;
      }
    }
    if (
      value.records &&
      typeof value.records === "object" &&
      !Array.isArray(value.records)
    ) {
      for (const [key, score] of Object.entries(value.records))
        if (Number.isFinite(score) && score >= 0 && !key.startsWith("daily-"))
          progress.records[key] = score;
    }
    progress.sound = typeof value.sound === "boolean" ? value.sound : true;
    progress.tactic = ["balanced", "runner", "maestro"].includes(value.tactic)
      ? value.tactic
      : "balanced";
    progress.difficulty = DIFFICULTY_IDS.includes(value.difficulty)
      ? value.difficulty
      : "standard";
    return progress;
  } catch {
    return freshProgress();
  }
}
export function readProgress(storage) {
  try {
    return normalizeProgress(JSON.parse(storage.getItem("tiki-taka.progress.v1")));
  } catch {
    return freshProgress();
  }
}
export function saveProgress(storage, progress) {
  try {
    storage.setItem("tiki-taka.progress.v1", JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}
export function awardMatch(progress, game, mode, courtIndex) {
  const possessions = Number.isFinite(game.config.possessions)
    ? game.config.possessions
    : 3;
  const tier = DIFFICULTY_IDS.includes(game.config.difficulty)
    ? game.config.difficulty
    : "standard";
  const isPractice = mode === "practice" || Boolean(game.config?.practice);
  const cleared =
    (game.time <= 0 || isPractice) &&
    (isPractice || game.turnovers < possessions) &&
    game.score >= game.config.target;
  // Stars are graded against the court's reference - what a clean round
  // scores there - not against its clear line. Deriving them from the target
  // meant one number set both the "you may move on" bar and the "you played
  // this beautifully" bar, so neither could be tuned without breaking the
  // other. See the note above COURT_DEFS in game.js.
  const reference =
    game.config.reference > 0
      ? game.config.reference
      : game.config.target > 0
        ? game.config.target
        : ENDLESS_REFERENCE;
  const stars = cleared
    ? 1 +
      Number(game.score >= reference * STAR_RATIOS.two) +
      Number(game.score >= reference * STAR_RATIOS.three && game.turnovers === 0)
    : 0;
  // Full performance XP lands at a round that matches the reference. The old
  // divisor was the target, roughly a third of it, so this saturated at its
  // cap on any competent round and stopped distinguishing anything.
  const performance = Math.min(20, Math.max(0, Math.floor((20 * game.score) / reference)));
  const key = mode === "career" ? `court-${courtIndex}-${tier}` : mode;
  // Read "is this new ground" BEFORE the writes further down overwrite it.
  const isFirstClearOfCourtTier =
    (progress.courts[courtIndex]?.[tier]?.stars || 0) === 0;
  let xp;
  if (!XP_MODES.has(mode)) {
    xp = 0;
  } else if (mode === "career") {
    let clearBonus = 0;
    if (cleared) {
      clearBonus = isFirstClearOfCourtTier
        ? Math.round(((60 + 15 * courtIndex) * FIRST_CLEAR_TIER[tier]) / 5) * 5
        : Math.max(5, Math.round(((6 + 3 * courtIndex) * FIRST_CLEAR_TIER[tier]) / 5) * 5);
    }
    xp = Math.max(3, performance + stars * STAR_XP + clearBonus);
  } else {
    // Endless (target 0, cleared/stars trivially true) pays performance only
    // - no star or clear pay. King of the Court has no gameplay yet and
    // falls through to this same rule until it ships its own.
    xp = Math.max(3, performance);
  }
  progress.xp += xp;
  const counts = roundCounts(mode, cleared);
  const prev = Number(progress.records[key]) || 0;
  let newBest = false;
  if (counts) {
    // "Personal best" now means "best CLEARED round" - a big score on a
    // round you failed stops counting. Deliberate (see roundCounts above):
    // an attempt is not a result, so this must not be "fixed" back to
    // Math.max(prev, game.score) unconditionally.
    progress.records[key] = Math.max(prev, game.score);
    newBest = game.score > prev;
  }
  if (mode === "career" && counts) {
    const courtEntry =
      progress.courts[courtIndex] &&
      typeof progress.courts[courtIndex] === "object" &&
      !Array.isArray(progress.courts[courtIndex])
        ? progress.courts[courtIndex]
        : {};
    const previous = courtEntry[tier] || {};
    progress.courts[courtIndex] = {
      ...courtEntry,
      [tier]: {
        stars: Math.max(Number(previous.stars) || 0, stars),
        best: Math.max(Number(previous.best) || 0, game.score),
      },
    };
    // Unlocks stay global: clearing on ANY tier, including Relaxed, unlocks
    // the next court. This is deliberate - unlocking is not tier-gated.
    // (`counts` already implies `cleared` for career, but spell it out since
    // this line is the one that grants progression.)
    progress.unlocked = Math.max(
      progress.unlocked,
      Math.min(COURTS.length - 1, courtIndex + 1),
    );
  }
  return { cleared, stars, xp, newBest };
}
const MAX_LEVEL = 50;
// Cumulative XP needed to REACH level L (1-indexed; level 1 is 0). Built once
// at module load rather than re-derived per call so rank() is a lookup, not
// a floating-point inverse.
const LEVEL_XP = Object.freeze(
  Array.from({ length: MAX_LEVEL }, (_, i) => {
    const L = i + 1;
    return 10 * Math.round((66 * (L - 1) + 4 * (L - 1) ** 2) / 10);
  }),
);
const RANK_NAMES = [
  "Touchline beginner",
  "First touch",
  "Space finder",
  "Tempo setter",
  "Triangle builder",
  "Press breaker",
  "Lane threader",
  "Playmaker",
  "Metronome",
  "Pitch conductor",
  "Master of possession",
  "Tiki taka",
];
export function rank(xp) {
  const total = Number.isFinite(xp) && xp > 0 ? xp : 0;
  let level = 1;
  for (let i = LEVEL_XP.length - 1; i >= 0; i--) {
    if (total >= LEVEL_XP[i]) {
      level = i + 1;
      break;
    }
  }
  const name = RANK_NAMES[Math.min(11, Math.floor((level - 1) / 4))];
  if (level >= MAX_LEVEL) {
    const into = total - LEVEL_XP[MAX_LEVEL - 1];
    return { level: MAX_LEVEL, name, into, span: 0, fraction: 1, next: 0 };
  }
  const into = total - LEVEL_XP[level - 1];
  const span = LEVEL_XP[level] - LEVEL_XP[level - 1];
  return { level, name, into, span, fraction: into / span, next: span - into };
}
