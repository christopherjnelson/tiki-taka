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
