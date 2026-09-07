import { COURTS } from "./game.js";
export function freshProgress() {
  return {
    version: 1,
    xp: 0,
    unlocked: 0,
    courts: {},
    records: {},
    sound: true,
    tactic: "balanced",
    lastCourt: 0,
  };
}
export function readProgress(storage) {
  try {
    const value = JSON.parse(storage.getItem("tiki-taka.progress.v1"));
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
        const stars = Number.isFinite(court.stars)
          ? Math.min(3, Math.max(0, Math.floor(court.stars)))
          : 0;
        const best = Number.isFinite(court.best) ? Math.max(0, court.best) : 0;
        progress.courts[index] = { stars, best };
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
    return progress;
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
  const cleared =
    game.time <= 0 &&
    (mode === "practice" || game.config.practice || game.turnovers < 3) &&
    game.score >= game.config.target;
  const stars = cleared
    ? 1 +
      Number(game.score >= game.config.target * 1.5) +
      Number(game.score >= game.config.target * 2.2 && game.turnovers === 0)
    : 0;
  const xp = Math.max(10, Math.floor(game.score / 8)) + (cleared ? 60 : 0);
  progress.xp += xp;
  const key =
    mode === "career"
      ? `court-${courtIndex}`
      : mode === "daily"
        ? `daily-${game.config.key}`
        : mode;
  const prev = Number(progress.records[key]) || 0;
  progress.records[key] = Math.max(prev, game.score);
  if (mode === "career") {
    const previous = progress.courts[courtIndex] || {};
    progress.courts[courtIndex] = {
      stars: Math.max(Number(previous.stars) || 0, stars),
      best: Math.max(Number(previous.best) || 0, game.score),
    };
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
