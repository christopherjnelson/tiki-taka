// The one list of soundtrack files.
//
// music.js plays it and scripts/build.mjs copies from it. A hardcoded second
// list drifted from this one once and shipped a build with no audio at all, so
// the build reads this array and adding a track stays a one-line change.
//
// `file` is deliberately URL-safe. The delivered names carried spaces and an
// "é", which survive a fetch() only once encoded and are a standing trap for
// the service worker's precache list, where a mismatched encoding fails the
// whole cache.addAll(). `title` is the readable name, derived from the
// original filename, and is what the player shows.
export const TRACKS = [
  { file: "beach-bounce.ogg", title: "Beach Bounce" },
  { file: "brick-dust-london.ogg", title: "Brick Dust London" },
  { file: "mare-dourada.ogg", title: "Maré Dourada" },
  { file: "neon-biscayne.ogg", title: "Neon Biscayne" },
  { file: "suba-na-baixa.ogg", title: "Suba Na Baixa" },
  { file: "sunset-crate.ogg", title: "Sunset Crate" },
];

export const TRACK_FILES = TRACKS.map((track) => track.file);
