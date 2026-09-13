// A cold load always opens the title screen, whatever the hash says: #play is
// pushed into history when a round starts, so it outlives the tab and would
// otherwise drop a returning player straight into the arena. See the `view`
// initialiser in apps/desktop/src/main.js.
//
// Deep-linking to `#play` therefore no longer reaches the arena, and a test
// that wants a round on screen has to walk in through the menu the way a
// player does. Hash navigation *within* a session is untouched, so the
// assertions about the URL becoming #play still hold once this has run.
export async function gotoArena(page, baseURL, options) {
  await page.goto(`${baseURL}/`, options);
  await page.locator("#home-view").waitFor({ state: "visible" });
  await page.locator("#title-play").click();
  await page.locator("#arena-view").waitFor({ state: "visible" });
  return page;
}

// The court is not always 1000:620. On a portrait viewport the renderer draws
// the pitch rotated a quarter turn so its long axis runs down the screen —
// `renderer.resize("portrait")` in packages/presentation/src/renderer.js, fed
// from a matchMedia query in the desktop app — and the canvas box is 620:1000
// to match. Tests that assert the court's aspect therefore have to ask which
// orientation they are in; a hardcoded 1000:620 silently passes for years on
// desktop and then fails the moment a phone-shaped viewport is added.
//
// Orientation is decided the same way the CSS decides it: taller than wide is
// portrait. A square viewport counts as landscape, matching
// `(orientation: portrait)`, which is false at exactly 1:1.
export function expectedCourtAspect({ width, height }) {
  return height > width ? 620 / 1000 : 1000 / 620;
}
