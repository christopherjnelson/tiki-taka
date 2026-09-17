// Home screen announcement strip — EDIT THIS EACH RELEASE.
//
// This is the one place to change what the small strip above the home
// leaderboard says. It is deliberately static: nobody reads CHANGELOG.md or
// package.json to fill it in, and nothing here should start doing that.
// What changed and what a player needs to notice right now are different
// things, and picking the latter is a judgment call for whoever ships the
// release, not something a build script can infer.
//
// Keep it short — a sentence or two, not the full changelog. Point players
// at "How to Play" or "Changelog" by name when there's more to say; they are
// plain text mentions for now (not links) until dialog navigation elsewhere
// settles, at which point this can wire up real links to those dialogs.
//
// Leave it as an empty string to hide the strip entirely (e.g. between
// releases when there's nothing worth calling out).
export const ANNOUNCEMENT_TEXT =
  "0.4.7 is live — Endless is playable. Survive on Still Water, a court of " +
  "its own: the clock counts up, bonuses pay Energy instead of points, and " +
  "the press grows to five defenders and never stops quickening. One mistake " +
  "ends the run. See the Changelog for the full picture.";
