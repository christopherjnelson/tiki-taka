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
  if (config.endless) return VENUES[1];
  if (config.key)
    return VENUES[Math.abs(Number(config.seed) || 0) % VENUES.length];
  return VENUES[0];
}
