// Runtime soundtrack manifest.
//
// Tracks are no longer copied into the build (see scripts/build.mjs and
// CHANGELOG). Instead a JSON manifest and the .ogg files it lists live
// alongside the served app — same directory the old baked-in copies used,
// public/audio/ in development, a persistent directory outside the release
// on the server in production — and are fetched at runtime. Same origin, so
// no CORS.
//
// Everything here is pure and side-effect-free except fetchManifest's own
// network call, so the interesting logic (parsing, court selection) is
// unit-testable without a DOM or a server.

const MANIFEST_URL = "./audio/manifest.json";
const HOME_COURT = "home";

// A track needs a playable file and a title to show. `court` is optional and
// defaults to the fallback tag, so an older or hand-edited manifest entry
// that omits it still plays everywhere rather than nowhere.
function normalizeTrack(entry) {
  if (!entry || typeof entry !== "object") return null;
  const file = typeof entry.file === "string" ? entry.file.trim() : "";
  const title = typeof entry.title === "string" ? entry.title.trim() : "";
  if (!file || !title) return null;
  const court =
    typeof entry.court === "string" && entry.court.trim()
      ? entry.court.trim()
      : HOME_COURT;
  return { file, title, court };
}

// Turns whatever came back from the manifest fetch into a clean array of
// playable tracks. Any shape other than `{ tracks: [...] }` — missing,
// malformed, not an array, entries missing a file or title — degrades to an
// empty playlist rather than throwing, per the "no music, never a crash"
// contract the caller relies on.
export function parseManifest(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.tracks))
    return [];
  const tracks = [];
  for (const entry of data.tracks) {
    const track = normalizeTrack(entry);
    if (track) tracks.push(track);
  }
  return tracks;
}

// The tracks for a given court, falling back to the `"home"`-tagged tracks
// when that court has none of its own. Every track is tagged `"home"` today,
// so every court plays the same full list; the split into real per-court
// music later is a manifest edit, not a code change, because this lookup is
// already here.
export function selectCourtTracks(tracks, court) {
  const list = Array.isArray(tracks) ? tracks : [];
  const wanted = typeof court === "string" && court ? court : HOME_COURT;
  const forCourt = list.filter((track) => track.court === wanted);
  if (forCourt.length) return forCourt;
  return list.filter((track) => track.court === HOME_COURT);
}

// Fetches and parses the manifest. Any failure — network error, non-OK
// response, invalid JSON, malformed shape — resolves to an empty array
// instead of rejecting, so a caller never needs a catch: a missing manifest
// just means no music.
export async function fetchManifest(url = MANIFEST_URL) {
  try {
    const response = await fetch(url);
    if (!response.ok) return [];
    const data = await response.json();
    return parseManifest(data);
  } catch {
    return [];
  }
}
