// The one list of soundtrack files.
//
// music.js plays it and both asset pipelines copy from it — scripts/build.mjs
// for the web build and scripts/electron-web.mjs for the packaged shell. Those
// two kept separate hardcoded lists once, and the packaged app shipped with no
// audio at all because only the first was updated; they now read this array so
// adding a track is a one-line change that cannot be half-done.
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
