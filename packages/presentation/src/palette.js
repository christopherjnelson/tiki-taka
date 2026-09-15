// Shared colour tokens for the canvas renderer.
//
// The canvas can't read CSS custom properties, so any colour that needs to
// agree with the DOM UI (leaderboard, results screen, HUD) lives here as a
// real value, and is mirrored by hand as a CSS custom property in
// apps/desktop/src/style.css (--bonus-gold). If you change a value here,
// update the mirrored CSS token too, and vice versa.
//
// BONUS_GOLD is the "possession bonus" colour: triangles, splitting the
// press, and zone passes, both on court (badges, telegraphs) and off it
// (leaderboard header, results screen). Olé keeps its own colour (pink,
// --pink in CSS) rather than sharing this one.
export const BONUS_GOLD = "#ffd32f";
