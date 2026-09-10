// The one list of sampled effects, the way playlist.js is the one list of
// soundtrack files.
//
// Recorded sounds — a crowd olé, applause, a whistle — go in public/audio/
// effects/ and get a line here. main.js hands the list to Sound.useSamples()
// and scripts/build.mjs copies from it into dist/desktop/audio/effects, where
// the generated service worker precaches whatever it finds. That is the whole
// drop-in: one file, one line, no code.
//
//   name   the effect the sample replaces. The names the game plays are
//          "kick", "wall", "score", "focus", "turnover", "end", "victory",
//          "defeat", "one-touch" and "ole" (the crowd chant at a ten-pass
//          milestone). A name that is
//          not listed keeps its synthesised voice; an unknown name is simply
//          never played.
//   file   the filename inside public/audio/effects. Keep it lowercase,
//          hyphenated and ASCII — no spaces, no accents. Encoded names have
//          broken the service worker's precache before, which fails the whole
//          cache.addAll(). .ogg matches the soundtrack; .mp3 and .wav decode
//          just as well.
//   gain   optional 0..1 trim for that one sample, so a hot recording can be
//          matched to the mix without touching the effects master. Default 1.
//
// For example, once the files exist:
//
//   export const SAMPLES = [
//     { name: "ole", file: "crowd-ole.ogg", gain: 0.8 },
//     { name: "score", file: "crowd-cheer.ogg" },
//   ];
//
// Everything not listed here falls back to the synthesised voice in
// packages/presentation/src/audio.js.
export const SAMPLES = [
  // Recorded applause under the clear fanfare. Registering "victory" also
  // suppresses the synthesised crowd swell audio.js plays as its stand-in —
  // see the note beside that fallback — so the two never stack.
  { name: "victory", file: "crowd-cheer.ogg", gain: 0.8 },
];

export const SAMPLE_FILES = SAMPLES.map((sample) => sample.file);
