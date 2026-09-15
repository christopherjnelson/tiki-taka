// A fixture list of the soundtrack files public/audio/ ships locally for
// development — see public/audio/manifest.json, which is the runtime source
// of truth music.js actually reads (apps/desktop/src/manifest.js fetches it).
// This array is no longer baked into the app or the build; only the test
// suites use it now, to avoid repeating these six filenames in every test
// that needs a real, decodable track.
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
