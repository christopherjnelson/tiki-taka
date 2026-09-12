# Sampled effects

Drop recorded effects here — a crowd olé, applause, a whistle — then add one
line per file to `apps/desktop/src/samples.js`, which is the only list the app
and the build read.

- Filenames: lowercase, hyphenated, ASCII, no spaces or accents
  (`crowd-ole.ogg`, `crowd-cheer.ogg`). Encoded names have broken the service
  worker's audio request before.
- Formats: `.ogg` matches the soundtrack; `.mp3` and `.wav` decode as well.
- Level: whatever is convenient. Each entry takes an optional `gain` trim, and
  everything plays through the effects master, so the effects switch and the
  effects slider govern samples exactly as they govern the synthesised sounds.

Nothing is committed here on purpose. Every effect keeps its synthesised voice
in `packages/presentation/src/audio.js` until a real file is listed, and a
listed file that is missing is skipped by the build with a warning rather than
failing it.
