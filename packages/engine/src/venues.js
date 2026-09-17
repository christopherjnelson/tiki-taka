export const VENUES = [
  {
    id: "lisbon",
    name: "Lisbon",
    vibe: "Azulejo coast",
    accent: "#21f3df",
    secondary: "#ff587f",
    seeds: [41],
  },
  {
    id: "london",
    name: "London",
    vibe: "Warehouse five-a-side",
    accent: "#34e5ed",
    secondary: "#ff4f73",
    seeds: [117],
  },
  {
    id: "barcelona",
    name: "Barcelona",
    vibe: "Mosaic courtyard",
    accent: "#2debd2",
    secondary: "#ff5d68",
    seeds: [272],
  },
  {
    id: "tokyo",
    name: "Tokyo",
    vibe: "Electric midnight",
    accent: "#38f5e5",
    secondary: "#ff3c9c",
    seeds: [525],
  },
  {
    id: "sao-paulo",
    name: "São Paulo",
    vibe: "Jungle cage",
    accent: "#6dff8a",
    secondary: "#ff4e8b",
    seeds: [808],
  },
  {
    id: "amsterdam",
    name: "Amsterdam",
    vibe: "Canal geometry",
    accent: "#40efff",
    secondary: "#ff4ba8",
    seeds: [1974],
  },
  // Endless's own court, and the only venue that is not a place on the world
  // tour - deliberately so. It has no city and no crowd: a still, quiet court
  // where the only thing that matters is that the ball keeps moving. Its
  // palette steps away from the tour's neon for the same reason, and it owns
  // no seed, because Endless seeds every run from the clock (see
  // ENDLESS_COURT in game.js) rather than replaying one court's rally.
  {
    id: "still-water",
    name: "Still Water",
    vibe: "No clock, no whistle",
    accent: "#8fe6cf",
    secondary: "#b6a8ff",
    seeds: [],
    // What the hoarding at the foot of the court says. Only this venue needs
    // its own: it is the one court that is not on the tour, and the sign is
    // the court's, so the home preview and a live run agree without either
    // having to know which mode is running.
    competition: "TIKI TAKA · ENDLESS",
  },
];

const bySeed = new Map(
  VENUES.flatMap((venue) => venue.seeds.map((seed) => [seed, venue])),
);

export function getVenue(config = {}) {
  const requested = String(config.venue || "").toLowerCase();
  const explicit = VENUES.find(
    (venue) => venue.id === requested || venue.name.toLowerCase() === requested,
  );
  if (explicit) return explicit;
  if (bySeed.has(config.seed)) return bySeed.get(config.seed);
  if (config.practice) return VENUES[0];
  if (config.endless) return VENUES.find((venue) => venue.id === "still-water");
  if (config.key)
    return VENUES[Math.abs(Number(config.seed) || 0) % VENUES.length];
  return VENUES[0];
}
