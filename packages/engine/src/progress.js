import { COURTS, DIFFICULTIES } from "./game.js";
const DIFFICULTY_IDS = DIFFICULTIES.map((tier) => tier.id);
// The clear bonus scales with tier so the easiest difficulty is not also the
// fastest XP in the game. The rest of the XP formula and the rank() curve are
// deliberately left alone here - a separate rebalance is out of scope.
const CLEAR_BONUS = { relaxed: 30, standard: 60, ruthless: 90 };
export function freshProgress() {
  return {
    version: 1,
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
// Progress arrives from storage, from a save row written by an older build,
// and from a remote account whose row may be empty or half-written. Every one
// of those paths has to end at a complete object: a missing `tactic` alone is
// enough to break the first render, and a bad row persists, so the same round
// trip fails on every reload until the value is repaired.
export function normalizeProgress(value) {
  try {
    if (!value || value.version !== 1) return freshProgress();
    const progress = freshProgress();
    progress.xp = Number.isFinite(value.xp) ? Math.max(0, value.xp) : 0;
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
        if (Number.isFinite(score) && score >= 0) progress.records[key] = score;
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
  const stars = cleared
    ? 1 +
      Number(game.score >= game.config.target * 1.5) +
      Number(game.score >= game.config.target * 2.2 && game.turnovers === 0)
    : 0;
  const xp =
    Math.max(10, Math.floor(game.score / 8)) + (cleared ? CLEAR_BONUS[tier] : 0);
  progress.xp += xp;
  const key =
    mode === "career"
      ? `court-${courtIndex}-${tier}`
      : mode === "daily"
        ? `daily-${game.config.key}`
        : mode;
  const prev = Number(progress.records[key]) || 0;
  progress.records[key] = Math.max(prev, game.score);
  if (mode === "career") {
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
    if (cleared)
      progress.unlocked = Math.max(
        progress.unlocked,
        Math.min(COURTS.length - 1, courtIndex + 1),
      );
  }
  // Bound retained daily records while keeping all permanent court and mode records.
  const daily = Object.keys(progress.records)
    .filter((k) => k.startsWith("daily-"))
    .sort()
    .reverse();
  for (const key of daily.slice(30)) delete progress.records[key];
  return { cleared, stars, xp, newBest: game.score > prev };
}
export function rank(xp) {
  const level = 1 + Math.floor(xp / 300);
  const names = [
    "Touchline beginner",
    "Space finder",
    "Tempo setter",
    "Press breaker",
    "Playmaker",
    "Master of possession",
  ];
  return {
    level,
    name: names[Math.min(names.length - 1, Math.floor((level - 1) / 2))],
    fraction: (xp % 300) / 300,
    next: 300 - (xp % 300),
  };
}
