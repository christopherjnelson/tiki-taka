import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";
import { gotoArena, expectedCourtAspect } from "./open-arena.mjs";
import { afterFrames } from "./wait.mjs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
const includeMobileLayouts = process.env.MOBILE_LAYOUTS === "1";
const outputDir = new URL("../test-results/", import.meta.url);
await mkdir(outputDir, { recursive: true });
let server;
try {
  if (!(await fetch(baseURL)).ok) throw new Error("server unavailable");
} catch {
  const url = new URL(baseURL);
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: url.port || "1234" },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      if ((await fetch(baseURL)).ok) break;
    } catch {}
    if (attempt === 59) throw new Error(`Could not start ${baseURL}`);
  }
}
const candidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/opt/google/chrome/chrome",
].filter(Boolean);
const executablePath = candidates.find((path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
const browser = await chromium.launch({
  headless: process.env.HEADED !== "1",
  ...(executablePath && { executablePath }),
});
let failures = 0;

async function check(name, body) {
  try {
    await body();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.error(`✗ ${name}\n${error.stack || error}`);
  }
}
function errorsFor(page) {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}
async function settled(page) {
  // Layout/paint settling after a navigation or resize is a per-frame effect
  // with no single observable condition, so wait for real frames rather
  // than a fixed slice of wall time.
  await afterFrames(page, 6);
}
async function openPauseMenu(page) {
  if (!(await page.locator("#pause-menu").isVisible())) {
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
  }
}
// Leaving the arena goes through the pause menu, which is the replacement for
// both the old workspace Home button and the sidebar drawer. It lands on home,
// which is now also the court picker.
async function leaveToHome(page) {
  await openPauseMenu(page);
  await page.locator("#pause-home").click();
  await page.locator("#home-view").waitFor({ state: "visible" });
}

await check(
  "fresh launch presents one gamepad-ready home screen holding the demo, the courts, the modes and the progress",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#home-view").isVisible(), true);
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    // There is no separate courts page any more, so there is nothing behind
    // home and no entry pointing at it.
    assert.equal(await page.locator("#courts-view").count(), 0);
    assert.equal(await page.locator("#title-courts").count(), 0);
    assert.equal(await page.locator("#courts-back").count(), 0);
    // A game, not a dashboard: one vertical menu, and it no longer has to
    // offer a way to the courts because the courts are already on screen.
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll("#title-menu button")]
          .filter((el) => !el.hidden)
          .map((el) => el.id),
      ),
      ["title-play"],
      "the home menu offers Play and nothing else",
    );
    // Keyboard and controller both start on the menu with no clicking first.
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "title-play",
    );
    // The circuit leaderboard, the courts, the modes and every earned statistic the old
    // dashboard showed are all on this one screen, with nothing clicked.
    assert.equal(await page.locator("#home-leaderboard").isVisible(), true);
    assert.equal(await page.locator(".hl-tab").count(), 6);
    assert.equal(await page.locator("[data-home-mode]").count(), 4);
    assert.equal(await page.locator(".court-item").count(), 6);
    // Thumbnails are intentionally deferred until after the home UI can
    // paint. They must still arrive, and the focus preview remains useful to
    // keyboard players while that work is scheduled.
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll(".court-thumb")].every((image) =>
          image.getAttribute("src")?.startsWith("data:image/png"),
        ),
      undefined,
      { timeout: 10_000 },
    );
    await page.locator(".court-item").first().focus();
    assert.equal(
      await page
        .locator(".court-item")
        .first()
        .evaluate((button) => button.classList.contains("hover-preview")),
      true,
    );
    // The attract demo behind the menu is a live rally, not a still image:
    // it exposes window.__attractGame the same way the player's round exposes
    // window.__game, and it advances on its own without any input.
    await page.locator("#attract-court").waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(() => window.__attractGame?.config?.attract),
      true,
      "the attract demo game must be running behind home",
    );
    const firstPasses = await page.evaluate(() => window.__attractGame.passes);
    await page.waitForFunction(
      (before) => window.__attractGame && window.__attractGame.passes > before,
      firstPasses,
      { timeout: 10_000 },
    );
    await page.locator("#title-play").focus();
    assert.equal(await page.locator(".court-item.hover-preview").count(), 0);
    assert.match(await page.locator("#level-label").textContent(), /LEVEL 1/i);
    assert.equal(await page.locator("#home-stars").textContent(), "0");
    assert.match(await page.locator("#home-cleared").textContent(), /^0/);
    for (const id of [
      "home-best",
      "home-games",
      "home-total-passes",
      "home-best-one-touch",
    ])
      assert.equal(
        await page.locator(`#${id}`).isVisible(),
        true,
        `${id} must survive the redesign`,
      );
    for (const selector of [".home-modes", ".home-progress"]) {
      const box = await page.locator(selector).boundingBox();
      assert.ok(
        box && box.y + box.height <= 720,
        `${selector} should fit above the fold: ${JSON.stringify(box)}`,
      );
    }
    await page.screenshot({
      path: new URL("home-desktop.png", outputDir).pathname,
      fullPage: true,
    });
    // Escape used to walk back out of the courts page. There is nowhere to
    // walk back to now, and pressing it must leave home exactly as it was
    // rather than blanking the view or throwing.
    await page.keyboard.press("Escape");
    await settled(page);
    assert.equal(await page.locator("#home-view").isVisible(), true);
    assert.equal(await page.locator("#court-list button").count(), 6);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the home announcement strip renders static release copy above the leaderboard, and disappears rather than showing empty when there is none",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.locator("#home-view").waitFor({ state: "visible" });
    // ANNOUNCEMENT_TEXT (apps/desktop/src/announcement.js) is non-empty for
    // this build, so the strip must show real text, sit above the
    // leaderboard, and never render as an empty box.
    const strip = page.locator("#home-announcement");
    assert.equal(await strip.isVisible(), true);
    const text = (await strip.textContent())?.trim();
    assert.ok(text && text.length > 0, "the strip must carry non-empty copy");
    const [stripBox, boardBox] = await Promise.all([
      strip.boundingBox(),
      page.locator("#home-leaderboard").boundingBox(),
    ]);
    assert.ok(
      stripBox && boardBox && stripBox.y + stripBox.height <= boardBox.y + 1,
      "the announcement strip must sit above the leaderboard",
    );
    // The empty case, through the real render path: window.__renderHomeAnnouncement
    // is renderHomeAnnouncement() itself (see main.js), called here with
    // blank text the same way it runs with ANNOUNCEMENT_TEXT normally.
    await page.evaluate(() => window.__renderHomeAnnouncement("   "));
    assert.equal(await strip.isVisible(), false);
    const emptyBox = await strip.boundingBox();
    assert.equal(emptyBox, null, "a hidden strip must not occupy layout space");
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "selecting a different court re-skins the attract demo's venue without replacing the running game",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    // Courts past 0 are locked by default; unlock through 4 so the clicks
    // and hovers below actually select rather than being no-ops.
    await context.addInitScript(() =>
      localStorage.setItem(
        "tiki-taka.progress.v1",
        JSON.stringify({ version: 1, xp: 0, unlocked: 5, courts: {}, records: {} }),
      ),
    );
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.locator("#attract-court").waitFor({ state: "visible" });
    await page.waitForFunction(() => !!window.__attractGame);
    // Court 0 is Lisbon, court 2 is Barcelona (see packages/engine/src/venues.js
    // and COURTS in packages/engine/src/game.js — both keyed off the same
    // seeds). Hovering/selecting must change the venue colors without ever
    // tearing down and rebuilding window.__attractGame.
    await page.locator(".court-item").nth(0).click();
    const before = await page.evaluate(() => ({
      instanceTag: (window.__attractGame.__navTestTag ??=
        Math.random().toString(36).slice(2)),
      passes: window.__attractGame.passes,
      venue: window.__attractGame.config.venue,
    }));
    assert.equal(before.venue, "lisbon");
    await page.locator(".court-item").nth(2).click();
    const after = await page.evaluate(() => ({
      instanceTag: window.__attractGame.__navTestTag,
      venue: window.__attractGame.config.venue,
    }));
    assert.equal(
      after.instanceTag,
      before.instanceTag,
      "selecting a different court must not replace the attract demo's Game instance",
    );
    assert.equal(after.venue, "barcelona");
    // Hovering another court item previews its venue, and leaving the list
    // without selecting falls back to the court that is actually selected
    // (Barcelona, from the click above) rather than getting stuck.
    await page.locator(".court-item").nth(4).dispatchEvent("mouseenter");
    await page.waitForFunction(
      () => window.__attractGame.config.venue === "sao-paulo",
    );
    await page.locator("#court-list").dispatchEvent("mouseleave");
    await page.waitForFunction(
      () => window.__attractGame.config.venue === "barcelona",
    );
    assert.equal(
      await page.evaluate(() => window.__attractGame.__navTestTag),
      before.instanceTag,
      "hover preview and its fallback must not replace the Game instance either",
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "tapping a court on a phone actually changes which court Play starts, in both orientations",
  async () => {
    // Regression for a real report: on mobile portrait, tapping a court did
    // not change which court Play started. `.court-list` used to carry a
    // stale `display: flex; overflow: auto` (plus a 188px button min-width)
    // from before the home redesign, still live under `@media (max-width:
    // 700px)`, which forced the grid of court buttons into one clipped,
    // horizontally-scrolling strip only about one row tall. A portrait phone
    // (narrower than 700px) hit it; a landscape phone at the same physical
    // size (usually wider than 700px) did not - which is exactly why the
    // report said it "worked" in landscape.
    //
    // A plain `locator.tap()` does not catch this: Playwright's own
    // actionability check scrolls a target into view before tapping it,
    // including sideways inside a clipped flex strip, which silently does
    // for the test what a real finger never does by accident while
    // scrolling the page. So this taps at the item's OWN on-screen
    // coordinates after only bringing the *list* (not the item) into view -
    // a real vertical page scroll, same as a player scrolling to see the
    // court list, without also sliding the list's own horizontal offset.
    for (const [width, height, name] of [
      [390, 844, "portrait"],
      [844, 390, "landscape"],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      // Unlock through court 2 (El Patio, Barcelona) so tapping it is a real
      // selection rather than the disabled-court no-op selectCourt() also
      // has to guard against.
      await context.addInitScript(() =>
        localStorage.setItem(
          "tiki-taka.progress.v1",
          JSON.stringify({ version: 2, xp: 0, unlocked: 5, courts: {}, records: {} }),
        ),
      );
      const page = await context.newPage(),
        errors = errorsFor(page);
      await page.goto(baseURL, { waitUntil: "networkidle" });
      await page.locator("#home-view").waitFor({ state: "visible" });
      const point = await page.evaluate(() => {
        const list = document.querySelector("#court-list");
        const el = list.querySelectorAll(".court-item")[2];
        list.scrollIntoView({ block: "center", inline: "nearest" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      await page.touchscreen.tap(point.x, point.y);
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#court-list .court-item")[2]
            ?.getAttribute("aria-current") === "true",
        null,
        { timeout: 2000 },
      ).catch(() => {});
      await page.locator("#title-play").click();
      await page.locator("#arena-view").waitFor({ state: "visible" });
      assert.equal(
        await page.locator("#court-title").textContent(),
        "El Patio",
        `${name} (${width}x${height}): tapping court 3 (El Patio) should start El Patio, not whatever was already selected`,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

await check(
  "the attract demo's choreographed rally shows every showcase mechanic on its own within a bounded window",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.locator("#attract-court").waitFor({ state: "visible" });
    await page.waitForFunction(() => !!window.__attractGame);
    // The demo's Game is seeded deterministically (see startAttract in
    // main.js) precisely so this is reproducible rather than a coin flip:
    // a full lap through the set-piece table (split, triangle, one-touch,
    // zone) fires every one of the engine's own counters well inside the
    // first fifteen seconds of simulated play. Assert on the engine's own
    // counters, not on rendering, and leave plenty of headroom (a slow CI
    // runner, an occasional turnover that restarts the sequence) rather
    // than a timeout tuned to a fast machine.
    await page.waitForFunction(
      () =>
        window.__attractGame &&
        window.__attractGame.splits > 0 &&
        window.__attractGame.triangles > 0 &&
        window.__attractGame.oles > 0,
      undefined,
      { timeout: 45_000 },
    );
    const counts = await page.evaluate(() => ({
      splits: window.__attractGame.splits,
      triangles: window.__attractGame.triangles,
      oles: window.__attractGame.oles,
      zones: window.__attractGame.zones,
    }));
    assert.ok(counts.splits > 0, "the demo must split the press on its own");
    assert.ok(counts.triangles > 0, "the demo must close a triangle on its own");
    assert.ok(
      counts.oles > 0,
      "the demo must complete a one-touch chain long enough to pay the olé milestone",
    );
    // The zone bonus depends on the zone's own slower rotation lining up
    // with a teammate's orbit (see chooseZoneTarget in main.js), so it is
    // given the rest of the window above rather than its own separate wait.
    await page.waitForFunction(() => window.__attractGame.zones > 0, undefined, {
      timeout: 45_000,
    });
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "home's zones cover every focusable control, for the gamepad zone nav pad-zones.mjs drives",
  async () => {
    // pollGamepad's home branch (apps/desktop/src/main.js) reads
    // data-pad-zone containers to build the zone list zoneContaining()/
    // nextZone()/restoreInZone() (apps/desktop/src/pad-zones.mjs) then act
    // on. Playwright cannot synthesize a real Gamepad object, so it cannot
    // drive that logic end to end — what it CAN verify is the DOM contract
    // the logic depends on: every zone id it expects exists, and no enabled,
    // visible focusable inside #home-view has been left outside all of them,
    // which is exactly the kind of thing a future home redesign could break
    // silently.
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.locator("#home-view").waitFor({ state: "visible" });
    const expectedZones = ["action", "leaderboard", "courts", "modes"];
    for (const zone of expectedZones) {
      assert.equal(
        await page.locator(`#home-view [data-pad-zone="${zone}"]`).count(),
        1,
        `#home-view is missing its "${zone}" pad zone`,
      );
    }
    // The top bar sits outside #home-view (it is a shared page header), so it
    // is checked separately rather than folded into the #home-view sweep
    // below.
    assert.equal(
      await page.locator('[data-pad-zone="topbar"]').count(),
      1,
      "the top bar is missing its pad zone",
    );
    assert.equal(
      await page.locator("#top-bar").getAttribute("data-pad-zone"),
      "topbar",
    );
    const orphans = await page.evaluate(() => {
      const home = document.getElementById("home-view");
      const focusables = [
        ...home.querySelectorAll(
          "button:not(:disabled),select:not(:disabled),input:not(:disabled)",
        ),
      ].filter((el) => !el.closest("[hidden]") && el.getClientRects().length);
      return focusables
        .filter((el) => !el.closest("[data-pad-zone]"))
        .map((el) => el.id || el.className || el.tagName);
    });
    assert.deepEqual(
      orphans,
      [],
      "every enabled, visible focusable in #home-view must sit inside a data-pad-zone container",
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "Play, modes, unlocked courts, the leave confirmation and history all preserve rounds",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    await context.addInitScript(() =>
      localStorage.setItem(
        "tiki-taka.progress.v1",
        JSON.stringify({
          version: 1,
          xp: 650,
          unlocked: 5,
          lastCourt: 2,
          sound: false,
          tactic: "balanced",
          courts: { 0: { stars: 3, best: 700 }, 1: { stars: 2, best: 800 } },
          records: { "court-0": 700, "court-1": 800 },
        }),
      ),
    );
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL);
    assert.match(
      await page.locator("#title-play-copy").textContent(),
      /El Patio|Barcelona/i,
    );
    await page.locator("#title-play").click();
    assert.equal(page.url().endsWith("#play"), true);
    assert.equal(await page.locator("#court-title").textContent(), "El Patio");
    await page.evaluate(async () => {
      const { Game } = await import("/src/game.js");
      const update = Game.prototype.update;
      window.__navGame = null;
      Game.prototype.update = function (...args) {
        // The title screen runs its own Game behind the menu, and it updates
        // too. Skip it, or this probe would follow the demo instead of the
        // round the player actually started.
        if (!this.config.attract) window.__navGame = this;
        return update.apply(this, args);
      };
    });
    await page.locator("#start-button").click();
    await page.waitForFunction(() => window.__navGame);
    // wall-clock: this just gives the round some genuine elapsed game time
    // before capturing a baseline, so that "leaving freezes it" below has a
    // moving clock to prove stopped; the comparison that matters is the
    // did-not-change one further down.
    await page.waitForTimeout(180);
    const beforeHome = await page.evaluate(() => ({
      time: window.__navGame.time,
    }));
    await leaveToHome(page);
    assert.equal(await page.locator("#home-view").isVisible(), true);
    // Home is the courts screen, so a paused round is still offered as Resume
    // from the very menu that shows the six courts.
    assert.match(await page.locator("#title-play").textContent(), /Resume/i);
    assert.equal(await page.locator("#court-list button").count(), 6);
    const frozen = await page.evaluate(() => window.__navGame.time);
    // wall-clock: proving the round clock does NOT run once home is reached
    // holds regardless of how many frames actually ran in this window.
    await page.waitForTimeout(180);
    assert.equal(
      await page.evaluate(
        (time) => Math.abs(window.__navGame.time - time) < 0.01,
        frozen,
      ),
      true,
      "leaving the arena must freeze the active round",
    );
    assert.equal(
      await page.locator('[data-home-mode="endless"]').isDisabled(),
      false,
      "endless mode is playable",
    );
    await page.locator('[data-home-mode="practice"]').click();
    assert.match(await page.locator("#title-play").textContent(), /Practice/i);
    await page.locator("#title-play").click();
    // The confirmation names both outcomes plainly, and neither button says
    // anything a player would have to guess at.
    assert.match(
      await page.locator("#overlay-kicker").textContent(),
      /THIS ROUND IS STILL GOING/i,
    );
    assert.match(
      await page.locator("#overlay-title").textContent(),
      /End it and start the new one\?/i,
    );
    assert.match(
      await page.locator("#start-button").textContent(),
      /^Keep playing this round$/,
    );
    assert.match(
      await page.locator("#secondary-button").textContent(),
      /^End it and start the new one$/,
    );
    await page.locator("#start-button").click();
    assert.equal(await page.locator("#game-overlay").isHidden(), true);
    assert.equal(
      await page.evaluate(
        (time) =>
          window.__navGame.time <= time && window.__navGame.time > time - 1,
        beforeHome.time,
      ),
      true,
      "resume keeps the same round time",
    );
    await leaveToHome(page);
    await page.locator('[data-home-mode="practice"]').click();
    assert.match(await page.locator("#title-play").textContent(), /Practice/i);
    await page.locator("#title-play").click();
    await page.locator("#secondary-button").click();
    assert.match(await page.locator("#mode-label").textContent(), /PRACTICE|WARM-UP/i);
    // The arena still pushes its own history entry, so Back leaves the court.
    await page.goBack();
    await page.waitForFunction(() => location.hash !== "#play");
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator(".court-item").nth(4).click();
    assert.match(
      await page.locator("#title-play-copy").textContent(),
      /The Cage|Tokyo/i,
    );
    await page.locator("#title-play").click();
    assert.match(await page.locator("#court-title").textContent(), /The Cage/i);
    assert.equal(page.url().endsWith("#play"), true);

    // Verify selecting a different court and launching Free practice on it
    await leaveToHome(page);
    await page.locator(".court-item").nth(2).click();
    assert.match(
      await page.locator("#title-play-copy").textContent(),
      /El Patio|Barcelona/i,
    );
    await page.locator('[data-home-mode="practice"]').click();
    assert.match(await page.locator("#title-play").textContent(), /Practice/i);
    await page.locator("#title-play").click();
    if (await page.locator("#secondary-button").isVisible()) {
      await page.locator("#secondary-button").click();
    }
    assert.match(
      await page.locator("#mode-label").textContent(),
      /PRACTICE|WARM-UP/i,
    );
    assert.match(
      await page.locator("#court-title").textContent(),
      /El Patio/i,
    );
    assert.equal(page.url().endsWith("#play"), true);

    // Verify selecting a different court preserves staged practice mode
    await leaveToHome(page);
    await page.locator('[data-home-mode="practice"]').click();
    assert.match(await page.locator("#title-play").textContent(), /Practice/i);
    await page.locator(".court-item").nth(3).click();
    assert.match(await page.locator("#title-play").textContent(), /Practice/i);
    assert.match(await page.locator("#title-play-copy").textContent(), /Free Practice/i);
    assert.equal(await page.locator('[data-home-mode="practice"]').getAttribute("aria-pressed"), "true");

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the pause menu reaches Home and Settings two presses from pausing",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    // Settings is on the title menu on the way in.
    await page.locator("#settings-button").click();
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
    );
    // Everything the sidebar used to hold moved into settings. With no
    // Supabase configuration (the default here), account-button is hidden —
    // there is no account system to open it onto.
    for (const id of [
      "sound-button",
      "fullscreen-button",
      "help-button",
    ])
      assert.equal(
        await page.locator(`#${id}`).isVisible(),
        true,
        `${id} must stay reachable after the drawer was removed`,
      );
    assert.equal(await page.locator("#account-button").isVisible(), false);
    await page.locator("#close-settings").click();
    // ...and on the pause menu once a round is on screen.
    await gotoArena(page, baseURL);
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      true,
    );
    assert.equal(await page.locator("#play-view-button").count(), 0);
    assert.equal(await page.locator(".sidebar").count(), 0);
    assert.equal(await page.locator("#sidebar-toggle").count(), 0);
    await page.locator("#start-button").click();
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll("#pause-menu button")]
          .filter((el) => !el.hidden)
          .map((el) => el.id),
      ),
      ["pause-resume", "pause-restart", "pause-home", "pause-settings"],
    );
    await page.screenshot({
      path: new URL("play-view-menu-desktop.png", outputDir).pathname,
      fullPage: true,
    });
    await page.locator("#pause-settings").click();
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
    );
    await page.locator("#close-settings").click();
    // Home is one press away from the same menu, and the entry says Home
    // rather than Courts now that they are the same screen.
    assert.match(
      await page.locator("#pause-home").textContent(),
      /\bHome\b/,
    );
    assert.equal(
      await page.evaluate(() =>
        [...document.querySelectorAll("#pause-menu button")].some((el) =>
          /courts/i.test(el.textContent),
        ),
      ),
      false,
      "the pause menu must not still say Courts",
    );
    await page.locator("#pause-home").click();
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(await page.locator(".court-item").count(), 6);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the pause menu traps gameplay intent, closes by Escape, and restores focus",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    });
    await context.addInitScript(() =>
      localStorage.setItem(
        "tiki-taka.settings.v1",
        JSON.stringify({ bindings: { pause: ["KeyP"] } }),
      ),
    );
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await page.locator("#start-button").click();
    // A remapped pause key still opens the menu in the arena.
    await page.keyboard.press("KeyP");
    assert.equal(
      await page.locator("#pause-menu").isVisible(),
      true,
      "custom pause key works in Arena",
    );
    await page.locator("#pause-resume").click();
    await page.locator("#pause-menu").waitFor({ state: "hidden" });
    // The custom pause key opens the menu, and the menu takes focus.
    await page.keyboard.press("KeyP");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "pause-resume",
    );
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("menu-open")),
      true,
    );
    assert.equal(await page.locator("#pause-settings").isVisible(), true);
    // A gameplay key must not reach the court from behind the menu.
    await page.keyboard.press("KeyD");
    assert.equal(await page.locator("#pause-menu").isVisible(), true);
    assert.equal(await page.locator("#game-overlay").getAttribute("inert"), "");
    // Tab stays inside the menu instead of wandering into the court.
    await page.keyboard.press("Tab");
    assert.equal(
      await page.evaluate(() =>
        Boolean(
          document
            .querySelector("#pause-menu")
            ?.contains(document.activeElement),
        ),
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "court",
      "leaving the menu hands focus back to the court",
    );
    // Escape a second time re-opens it; Resume closes it the same way.
    await page.keyboard.press("KeyP");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
    await page.locator("#pause-resume").click();
    await page.locator("#pause-menu").waitFor({ state: "hidden" });
    assert.equal(
      await page.evaluate(() => {
        const el = document.activeElement;
        return !el || !el.closest("[hidden],[inert]");
      }),
      true,
    );
    await page.keyboard.press("KeyP");
    await page.locator("#pause-home").click();
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.keyboard.press("KeyP");
    assert.equal(
      await page.locator("#home-view").isVisible(),
      true,
      "custom pause key cannot activate hidden Arena controls from Courts",
    );
    await page.screenshot({
      path: new URL("pause-menu.png", outputDir).pathname,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "Arena geometry stays centered, bounded, and at the native court ratio",
  async () => {
    const viewports = [
      [1280, 720],
      [1366, 768],
      [1440, 900],
      [1920, 1080],
      ...(includeMobileLayouts
        ? [
            [320, 740],
            [390, 844],
            [844, 390],
          ]
        : []),
    ];
    for (const [width, height] of viewports) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: width <= 900,
        hasTouch: width <= 900,
        serviceWorkers: "block",
      });
      const page = await context.newPage(),
        errors = errorsFor(page);
      await gotoArena(page, baseURL);
      await settled(page);
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        true,
        `${width}x${height} overflow`,
      );
      const court = await page.locator("#court").boundingBox();
      const wrap = await page.locator("#court-wrap").boundingBox();
      assert.ok(
        court &&
          Math.abs(
            court.width / court.height - expectedCourtAspect({ width, height }),
          ) < 0.01,
        `${width}x${height} ratio ${JSON.stringify(court)}`,
      );
      assert.ok(
        wrap &&
          Math.abs(court.x + court.width / 2 - (wrap.x + wrap.width / 2)) <= 1,
        `${width}x${height} court centered in wrap`,
      );
      // The arena is always Play view: the below-court panel is put away and
      // the court owns the space.
      assert.equal(
        await page
          .locator("body")
          .evaluate((el) => el.classList.contains("play-view")),
        true,
        `${width}x${height} play view`,
      );
      assert.equal(
        await page.locator(".below-court").isHidden(),
        true,
        `${width}x${height} below-court is hidden in Play view`,
      );
      for (const selector of ["#court", ".court-toolbar"]) {
        // Compact landscape Play view hands the toolbar's job to the touch
        // controls, so only measure what the presentation actually shows.
        if (selector !== "#court" && (await page.locator(selector).isHidden()))
          continue;
        const box = await page.locator(selector).boundingBox();
        assert.ok(
          box && box.x >= -1 && box.x + box.width <= width + 1,
          `${width}x${height} ${selector} ${JSON.stringify(box)}`,
        );
      }
      if (width >= 1280) {
        for (const selector of ["#court", ".court-toolbar"]) {
          const box = await page.locator(selector).boundingBox();
          assert.ok(
            box.y >= -1 && box.y + box.height <= height + 1,
            `${width}x${height} ${selector} vertical ${JSON.stringify(box)}`,
          );
        }
      }
      if (width === 1366)
        await page.screenshot({
          path: new URL("arena-desktop.png", outputDir).pathname,
          fullPage: true,
        });
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

if (includeMobileLayouts) await check(
  "home and its menus remain usable at portrait and compact landscape sizes",
  async () => {
    for (const [width, height, suffix] of [
      [390, 844, "mobile"],
      [844, 390, "compact"],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      const page = await context.newPage(),
        errors = errorsFor(page);
      await page.goto(baseURL);
      await settled(page);
      assert.equal(await page.locator("#home-view").isVisible(), true);
      for (const id of ["title-play", "settings-button"]) {
        const box = await page.locator(`#${id}`).boundingBox();
        assert.ok(
          box && box.x >= -1 && box.x + box.width <= width + 1,
          `${suffix} ${id} bounded ${JSON.stringify(box)}`,
        );
      }
      await page.screenshot({
        path: new URL(`home-${suffix}.png`, outputDir).pathname,
        fullPage: true,
      });
      await page.locator("#settings-button").tap();
      await page.locator("#settings-dialog").waitFor({ state: "visible" });
      assert.equal(await page.locator("#fullscreen-button").isVisible(), true);
      assert.equal(await page.locator("#sound-button").isVisible(), true);
      await page.screenshot({
        path: new URL(`menu-${suffix}.png`, outputDir).pathname,
        fullPage: true,
      });
      await page.locator("#close-settings").tap();
      // Home is the courts screen on a phone too — there is no second page to
      // tap through to, so the same view has to hold without overflowing.
      await page.locator("#home-view").waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        true,
        `${suffix} home screen must not overflow horizontally`,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

await check(
  "a cold load opens home even when the URL still says #play",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const errors = errorsFor(page);
    // #play is pushed into history the moment a round starts, so it survives a
    // bookmark, a reopened tab and a refresh. A returning player must still
    // land on the menu rather than in the arena on a ready-state overlay.
    await page.goto(`${baseURL}/#play`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#arena-view").isHidden(),
      true,
      "a stale #play must not open the arena on a cold load",
    );
    assert.equal(
      new URL(page.url()).hash,
      "",
      "the URL must not claim a view the player is not looking at",
    );
    // Hash navigation inside the session is untouched.
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    assert.equal(page.url().endsWith("#play"), true);
    await page.goBack();
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.goForward();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    // ...but a reload from the arena is a cold load, and cold loads open the
    // title screen.
    await page.reload();
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "nothing scrolls at 1080x1024, 1280x720 or 1920x1080, and the court keeps its share of the window",
  async () => {
    for (const [width, height] of [
      [1080, 1024],
      [1280, 720],
      [1920, 1080],
    ]) {
      const context = await browser.newContext({
        viewport: { width, height },
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const errors = errorsFor(page);
      await page.goto(`${baseURL}/`);
      await page.locator("#home-view").waitFor({ state: "visible" });
      const noScroll = async (where) => {
        await settled(page);
        const box = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          clientWidth: document.documentElement.clientWidth,
          clientHeight: document.documentElement.clientHeight,
        }));
        assert.ok(
          box.scrollWidth <= box.clientWidth,
          `${where} scrolls sideways at ${width}x${height}: ${box.scrollWidth} > ${box.clientWidth}`,
        );
        assert.ok(
          box.scrollHeight <= box.clientHeight,
          `${where} scrolls down at ${width}x${height}: ${box.scrollHeight} > ${box.clientHeight}`,
        );
      };
      await noScroll("home");
      // Home holds the demo, the courts, the modes and the progress at once,
      // so it is not enough that the document does not scroll: the view's own
      // box must not be an overflowing scroller either.
      const inner = await page
        .locator("#home-view")
        .evaluate((el) => ({
          scrollWidth: el.scrollWidth,
          scrollHeight: el.scrollHeight,
          clientWidth: el.clientWidth,
          clientHeight: el.clientHeight,
        }));
      assert.ok(
        inner.scrollHeight <= inner.clientHeight &&
          inner.scrollWidth <= inner.clientWidth,
        `home needs ${inner.scrollWidth}x${inner.scrollHeight} inside ${inner.clientWidth}x${inner.clientHeight} at ${width}x${height}`,
      );
      for (const selector of [
        "#home-leaderboard",
        "#court-list",
        ".home-modes",
        ".home-progress",
        "#title-play",
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(
          box &&
            box.y >= -1 &&
            box.x >= -1 &&
            box.y + box.height <= height + 1 &&
            box.x + box.width <= width + 1,
          `${selector} must be fully on screen at ${width}x${height}: ${JSON.stringify(box)}`,
        );
      }
      assert.equal(await page.locator("#court-list button").count(), 6);
      await page.locator("#settings-button").click();
      await page.locator("#settings-dialog").waitFor({ state: "visible" });
      await noScroll("the settings screen");
      const bindings = await page.locator("#bindings-list").evaluate((list) => ({
        scrollWidth: list.scrollWidth,
        clientWidth: list.clientWidth,
        rows: [...list.querySelectorAll(".binding-row")].map((row) => ({
          scrollWidth: row.scrollWidth,
          clientWidth: row.clientWidth,
          buttons: [...row.querySelectorAll(".binding-key")].map((button) => ({
            width: button.getBoundingClientRect().width,
            height: button.getBoundingClientRect().height,
          })),
        })),
      }));
      assert.ok(
        bindings.scrollWidth <= bindings.clientWidth,
        `binding grid scrolls sideways at ${width}x${height}: ${bindings.scrollWidth} > ${bindings.clientWidth}`,
      );
      for (const row of bindings.rows) {
        assert.ok(
          row.scrollWidth <= row.clientWidth,
          `binding row scrolls sideways at ${width}x${height}: ${row.scrollWidth} > ${row.clientWidth}`,
        );
        for (const button of row.buttons)
          assert.ok(
            button.width >= 76 && button.height >= 34,
            `binding control is too small at ${width}x${height}: ${JSON.stringify(button)}`,
          );
      }
      // A dialog that fits the page but scrolls inside itself still hides the
      // controls at the bottom of it, which is the thing being asked for here.
      if (height >= 1024) {
        const dialog = await page
          .locator("#settings-dialog")
          .evaluate((el) => ({
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
          }));
        assert.ok(
          dialog.scrollHeight <= dialog.clientHeight,
          `the settings dialog needs ${dialog.scrollHeight}px inside ${dialog.clientHeight}px at ${width}x${height}`,
        );
      }
      await page.locator("#close-settings").click();
      await page.locator("#title-play").click();
      await page.locator("#arena-view").waitFor({ state: "visible" });
      await noScroll("the arena");
      // The court is height-limited in any window wider than 1000:620, so the
      // permanent top bar's row comes straight off the canvas: 90.7% of a
      // 1920x1080 window before the bar, 87.0% after it. Emptying the two side
      // gutters — the wordmark and the old second music player both moved into
      // the bar — buys none of that back, because the spare width was never
      // the constraint. 86% is the floor the drop must not slide past.
      const court = await page.locator("#court").boundingBox();
      // The bar reserves its own row rather than floating over the game.
      const bar = await page.locator("#top-bar").boundingBox();
      assert.ok(
        bar.y + bar.height <= court.y + 0.5,
        `the top bar must sit above the court, not over it, at ${width}x${height}: bar ends at ${bar.y + bar.height}, court starts at ${court.y}`,
      );
      if (width / height > 1000 / 620) {
        // The bar is the ONLY thing the court gives up. Everything left below
        // it goes to the canvas, so the largest 1000:620 rectangle that fits
        // in the remaining height is what the court must actually measure.
        const available = (height - bar.height) * (1000 / 620);
        assert.ok(
          court.width >= Math.min(width, available) - 2,
          `the court must take every pixel the top bar left at ${width}x${height}: got ${court.width.toFixed(1)}, expected ${available.toFixed(1)}`,
        );
        // And an absolute floor, so a bar that grew fat would still be caught.
        assert.ok(
          (court.width / width) * 100 > 84,
          `the court must keep its share of a ${width}x${height} window, got ${((court.width / width) * 100).toFixed(1)}%`,
        );
      }
      if (width === 1920 && height === 1080)
        assert.ok(
          (court.width / width) * 100 > 86,
          `a 1920x1080 window must still give the court ~87%, got ${((court.width / width) * 100).toFixed(1)}%`,
        );
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

await check(
  "the top bar carries one soundtrack player and a mouse exit on every screen",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    // There is exactly one player in the document. The side rail this replaced
    // was a second implementation of the same three controls, and it only
    // existed while a round was on screen.
    for (const selector of ["#music-prev", "#music-toggle", "#music-skip", "#music-track"])
      assert.equal(
        await page.locator(selector).count(),
        1,
        `${selector} must exist exactly once now that the rail is gone`,
      );
    assert.equal(await page.locator("#brand-rail").count(), 0);
    assert.equal(await page.locator("#music-rail").count(), 0);
    const barIsUp = async (where) => {
      await settled(page);
      assert.equal(
        await page.locator("#top-bar").isVisible(),
        true,
        `the top bar must be on screen on ${where}`,
      );
      for (const selector of ["#music-prev", "#music-toggle", "#music-skip", ".top-brand-mark"])
        assert.equal(
          await page.locator(selector).isVisible(),
          true,
          `${selector} must be on screen on ${where}`,
        );
    };
    await barIsUp("the title screen");
    // With no Supabase configuration (the default here), there is no account
    // system at all, so the profile chip is hidden rather than offered
    // disabled or pointing at a demo.
    assert.equal(await page.locator("#profile-button").isVisible(), false);
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    await barIsUp("the arena");
    // The player still works from the bar during play, and the round keeps the
    // keyboard afterwards rather than leaving focus parked on a bar button.
    const before = await page.locator("#music-toggle").getAttribute("aria-pressed");
    await page.locator("#music-toggle").click();
    assert.notEqual(
      await page.locator("#music-toggle").getAttribute("aria-pressed"),
      before,
      "the bar's play/pause must still switch the soundtrack during play",
    );
    await page.locator("#music-toggle").click();
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "a mouse alone can leave a round through the top bar",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await page.locator("#start-button").click();
    await page.waitForFunction(
      () => document.querySelector("#game-overlay")?.hidden === true,
    );
    // Only the mouse from here: no Escape, no gamepad. The Menu button lives in
    // the bar, off the court, well away from the pass controls at its foot.
    const bar = await page.locator("#top-bar").boundingBox();
    const court = await page.locator("#court").boundingBox();
    assert.ok(
      bar.y + bar.height <= court.y + 0.5,
      "the Menu button must not sit over the court",
    );
    assert.equal(await page.locator("#top-pause").isVisible(), true);
    assert.equal(await page.locator("#top-home").isVisible(), true);
    await page.locator("#top-pause").click();
    await page.locator("#pause-menu").waitFor({ state: "visible" });
    await page.locator("#pause-home").click();
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      false,
      "the mouse-only exit must actually leave the play view",
    );
    // Nothing on a menu screen has a pause menu to reach, so the button is not
    // offered there.
    assert.equal(await page.locator("#top-pause").isVisible(), false);
    assert.equal(await page.locator("#top-home").isVisible(), false);
    // Escape and the gamepad's Start still do exactly what they did.
    await page.locator("#court-list button").first().click();
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("#top-home").isVisible(), true);
    await page.locator("#top-home").click();
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator("#court-list button").first().click();
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the home circuit leaderboard provides court filtering tabs and displays scores",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      const bindings = {
        moveUp: ["KeyW", "ArrowUp"], moveDown: ["KeyS", "ArrowDown"],
        moveLeft: ["KeyA", "ArrowLeft"], moveRight: ["KeyD", "ArrowRight"],
        smartPass: ["Space"], direct1: ["Digit1"], direct2: ["Digit2"],
        direct3: ["Digit3"], direct4: ["Digit4"], wallToggle: ["KeyB"],
        wallHold: ["ShiftLeft"], focusHold: ["KeyE"], boostHold: ["KeyR"],
        shout: ["KeyF"], pause: ["Escape"], skipTrack: ["KeyN"],
      };
      window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
        kind: "local",
        async getSession() { return null; },
        async loadUserData() {
          return {
            progress: {
              version: 1, xp: 0, unlocked: 5, courts: {}, records: {},
              sound: true, tactic: "balanced", difficulty: "standard", lastCourt: 0,
            },
            settings: {
              theme: "dark", effectsOn: false, effectsVolume: 0, musicOn: false,
              musicVolume: 0, audioMigrated: true, preset: "wasd", bindings,
            },
            stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 },
            preferences: { scoreSaveChoice: "ask" },
          };
        },
        async saveUserData() { return {}; },
        async recordRound() { return { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 }; },
        async getLeaderboard({ court = 0, difficulty = "standard" } = {}) {
          return {
            entries: [{
              username: `court-${court}-player`, score: 5000 - court * 100, passes: 50,
              triangles: 5, oles: 2, splits: 3, zones: 4, difficulty,
            }],
          };
        },
        onAuthStateChange() { return () => {}; },
      });
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator("#home-leaderboard").waitFor({ state: "visible" });

    // Lisbon (court 0) is selected by default
    const tab0 = page.locator("#hl-tab-0");
    assert.equal(await tab0.getAttribute("aria-selected"), "true");
    assert.ok((await tab0.getAttribute("class")).includes("active"));

    // Leaderboard list renders entries
    await page.locator("#home-leaderboard-list .hl-row").first().waitFor({ state: "visible" });
    const rowCount = await page.locator("#home-leaderboard-list .hl-row").count();
    assert.ok(rowCount > 0, "leaderboard should render ranked rows");
    assert.equal(
      await page.locator("#home-leaderboard-list .hl-row .hl-cell-player").first().textContent(),
      "court-0-player",
    );

    // Bonus columns run OLÉ, TRIANGLE, SPLIT THE PRESS, ZONE PASS (OLÉ leads
    // the group since it sits beside the yellow triangle/split/zone cells) —
    // pin the header and the "your best" footer to the same order so they
    // can't silently diverge from each other or from a row.
    const bonusOrder = ["hl-cell-ole", "hl-cell-tri", "hl-cell-split", "hl-cell-zone"];
    const headBonusClasses = await page.locator(".hl-head > .hl-cell-bonus").evaluateAll((els) =>
      els.map((el) => [...el.classList].find((c) => c.startsWith("hl-cell-") && c !== "hl-cell-bonus")),
    );
    assert.deepEqual(headBonusClasses, bonusOrder, "leaderboard header bonus columns");
    const rowBonusClasses = await page
      .locator("#home-leaderboard-list .hl-row")
      .first()
      .locator(".hl-cell-bonus")
      .evaluateAll((els) =>
        els.map((el) => [...el.classList].find((c) => c.startsWith("hl-cell-") && c !== "hl-cell-bonus")),
      );
    assert.deepEqual(rowBonusClasses, bonusOrder, "leaderboard row bonus columns");
    const userBonusClasses = await page.locator(".hl-user-cells > .hl-cell-bonus").evaluateAll((els) =>
      els.map((el) => [...el.classList].find((c) => c.startsWith("hl-cell-") && c !== "hl-cell-bonus")),
    );
    assert.deepEqual(userBonusClasses, bonusOrder, "leaderboard your-best bonus columns");

    // Switching to London (court 1) updates tab and loads court 1 scores
    const tab1 = page.locator("#hl-tab-1");
    await tab1.click();
    assert.equal(await tab1.getAttribute("aria-selected"), "true");
    assert.equal(await tab0.getAttribute("aria-selected"), "false");
    await page.waitForFunction(
      () => document.querySelector("#home-leaderboard-list .hl-row .hl-cell-player")?.textContent === "court-1-player",
    );

    // Switching to Barcelona via keyboard arrow navigation
    await tab1.focus();
    await page.keyboard.press("ArrowRight");
    const tab2 = page.locator("#hl-tab-2");
    assert.equal(await tab2.getAttribute("aria-selected"), "true");
    await page.waitForFunction(
      () => document.querySelector("#home-leaderboard-list .hl-row .hl-cell-player")?.textContent === "court-2-player",
    );

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the home leaderboard switches by mode, hides court/difficulty controls that don't apply, and shows a calm empty state for a mode with no scores",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      const bindings = {
        moveUp: ["KeyW", "ArrowUp"], moveDown: ["KeyS", "ArrowDown"],
        moveLeft: ["KeyA", "ArrowLeft"], moveRight: ["KeyD", "ArrowRight"],
        smartPass: ["Space"], direct1: ["Digit1"], direct2: ["Digit2"],
        direct3: ["Digit3"], direct4: ["Digit4"], wallToggle: ["KeyB"],
        wallHold: ["ShiftLeft"], focusHold: ["KeyE"], boostHold: ["KeyR"],
        shout: ["KeyF"], pause: ["Escape"], skipTrack: ["KeyN"],
      };
      window.__leaderboardCalls = [];
      window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
        kind: "local",
        async getSession() { return null; },
        async loadUserData() {
          return {
            progress: {
              version: 1, xp: 0, unlocked: 5, courts: {}, records: {},
              sound: true, tactic: "balanced", difficulty: "standard", lastCourt: 0,
            },
            settings: {
              theme: "dark", effectsOn: false, effectsVolume: 0, musicOn: false,
              musicVolume: 0, audioMigrated: true, preset: "wasd", bindings,
            },
            stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 },
            preferences: { scoreSaveChoice: "ask" },
          };
        },
        async saveUserData() { return {}; },
        async recordRound() { return { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 }; },
        // Only "career" has any scores recorded here; the other boards are
        // deliberately empty so the empty states can be asserted.
        async getLeaderboard(args) {
          window.__leaderboardCalls.push(args);
          if (args.mode !== "career") return { entries: [] };
          return { entries: [{ username: "tour-player", score: 4200, passes: 40 }] };
        },
        onAuthStateChange() { return () => {}; },
      });
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator("#home-leaderboard").waitFor({ state: "visible" });

    // World tour is the default: court tabs and the difficulty toggle are
    // visible, and the mocked score renders.
    await page.locator("#home-leaderboard-list .hl-row").first().waitFor({ state: "visible" });
    assert.equal(await page.locator("#hl-tabs").isHidden(), false);
    assert.equal(await page.locator("#hl-difficulty-toggle").isHidden(), false);
    assert.equal(
      await page.locator("#home-leaderboard-list .hl-row .hl-cell-player").first().textContent(),
      "tour-player",
    );
    // The heading names the mode on screen. It used to read "CIRCUIT
    // LEADERBOARDS" under a fixed trophy no matter which mode was selected,
    // which is wrong for two of the three and matches none of their buttons.
    const heading = page.locator("#hl-title");
    const headingIcon = page.locator("#hl-mode-icon .hl-icon-art");
    assert.equal(await heading.textContent(), "WORLD TOUR LEADERBOARD");
    assert.equal(await headingIcon.evaluate((el) => el.tagName.toLowerCase()), "svg");
    const careerCall = await page.evaluate(() => window.__leaderboardCalls.at(-1));
    assert.equal(careerCall.mode, "career");
    assert.equal(careerCall.court, 0);
    assert.equal(careerCall.difficulty, "standard");

    // Switching to King of the Court hides the court tabs (it has one court)
    // but keeps the difficulty toggle (the tier is its press), queries by the
    // new mode and tier, and shows a calm empty state rather than an error or
    // a spinner that never resolves.
    const kotcButton = page.locator('#hl-mode-toggle .hl-mode-btn[data-mode="kotc"]');
    await kotcButton.click();
    await page.waitForFunction(() => window.__leaderboardCalls.at(-1)?.mode === "kotc");
    const kotcCall = await page.evaluate(() => window.__leaderboardCalls.at(-1));
    assert.equal(kotcCall.court, undefined);
    assert.equal(kotcCall.difficulty, "standard");
    assert.equal(await page.locator("#hl-tabs").isHidden(), true);
    assert.equal(await page.locator("#hl-difficulty-toggle").isHidden(), false);
    assert.equal(await page.locator("#hl-head-score").textContent(), "SQUARES");
    assert.equal(await heading.textContent(), "KING OF THE COURT LEADERBOARD");
    await page.waitForFunction(
      () => document.querySelectorAll("#home-leaderboard-list .hl-row").length === 0,
    );
    const status = page.locator("#home-leaderboard-status");
    await page.waitForFunction(
      () => !/unable to load|offline|error/i.test(document.querySelector("#home-leaderboard-status")?.textContent || ""),
    );
    assert.match(await status.textContent(), /no rounds recorded yet/i);
    assert.equal(await status.evaluate((el) => el.classList.contains("is-error")), false);

    // Endless hides the same court/tier chrome, but it is playable now, so
    // its empty board says the board is empty rather than that the mode is
    // unbuilt - and it ranks on time survived, not points.
    const endlessButton = page.locator('#hl-mode-toggle .hl-mode-btn[data-mode="endless"]');
    await endlessButton.click();
    await page.waitForFunction(() => window.__leaderboardCalls.at(-1)?.mode === "endless");
    assert.equal(await page.locator("#hl-tabs").isHidden(), true);
    assert.equal(await heading.textContent(), "EXTRA TIME LEADERBOARD");
    assert.match(await status.textContent(), /no runs recorded yet/i);
    assert.equal(await page.locator("#hl-head-score").textContent(), "TIME");

    const careerButton = page.locator('#hl-mode-toggle .hl-mode-btn[data-mode="career"]');
    await careerButton.click();
    await page.waitForFunction(() => window.__leaderboardCalls.at(-1)?.mode === "career");
    assert.equal(await page.locator("#hl-tabs").isHidden(), false);
    assert.equal(await page.locator("#hl-difficulty-toggle").isHidden(), false);
    assert.equal(await heading.textContent(), "WORLD TOUR LEADERBOARD");
    await page.waitForFunction(
      () => document.querySelector("#home-leaderboard-list .hl-row .hl-cell-player")?.textContent === "tour-player",
    );

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "a delayed saved-game restore acknowledges syncing until controls are ready",
  async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    await context.addInitScript(() => {
      window.__releaseBootData = null;
      window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
        kind: "local",
        async getSession() { return null; },
        loadUserData() { return new Promise((resolve) => { window.__releaseBootData = resolve; }); },
        async saveUserData() { return {}; }, async recordRound() { return {}; },
        async getLeaderboard() { return { entries: [] }; }, onAuthStateChange() { return () => {}; },
      });
    });
    const page = await context.newPage(), errors = errorsFor(page);
    const navigation = page.goto(`${baseURL}/`);
    const boot = page.locator("#boot-sync");
    await boot.waitFor({ state: "visible" });
    assert.match(await boot.textContent(), /syncing your game/i);
    await page.waitForFunction(() => typeof window.__releaseBootData === "function");
    await page.evaluate(() => window.__releaseBootData({
      progress: { version: 1, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: "balanced", difficulty: "standard", lastCourt: 0 },
      settings: {
        theme: "dark", effectsOn: false, effectsVolume: 0, musicOn: false,
        musicVolume: 0, audioMigrated: true, preset: "wasd", bindings: {
          moveUp: ["KeyW", "ArrowUp"], moveDown: ["KeyS", "ArrowDown"],
          moveLeft: ["KeyA", "ArrowLeft"], moveRight: ["KeyD", "ArrowRight"],
          smartPass: ["Space"], direct1: ["Digit1"], direct2: ["Digit2"], direct3: ["Digit3"], direct4: ["Digit4"],
          wallToggle: ["KeyB"], wallHold: ["ShiftLeft"], focusHold: ["KeyE"], boostHold: ["KeyR"], shout: ["KeyF"], pause: ["Escape"], skipTrack: ["KeyN"],
        },
      }, stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 }, preferences: { scoreSaveChoice: "ask" },
    }));
    await navigation;
    await afterFrames(page, 2);
    await boot.waitFor({ state: "hidden" });
    assert.equal(await page.locator("#home-view").isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "leaderboard loading stays responsive, refreshes in place, times out safely, and ignores stale results",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      // Keep the hung-request assertion deterministic without making this
      // navigation suite wait for the production eight-second deadline.
      globalThis.__TIKI_TAKA_TEST_LEADERBOARD_TIMEOUT_MS__ = 500;
      window.__leaderboardCalls = [];
      window.__leaderboardResolvers = [];
      const bindings = {
        moveUp: ["KeyW", "ArrowUp"], moveDown: ["KeyS", "ArrowDown"],
        moveLeft: ["KeyA", "ArrowLeft"], moveRight: ["KeyD", "ArrowRight"],
        smartPass: ["Space"], direct1: ["Digit1"], direct2: ["Digit2"], direct3: ["Digit3"], direct4: ["Digit4"],
        wallToggle: ["KeyB"], wallHold: ["ShiftLeft"], focusHold: ["KeyE"], boostHold: ["KeyR"], shout: ["KeyF"], pause: ["Escape"], skipTrack: ["KeyN"],
      };
      window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
        kind: "local",
        async getSession() { return null; },
        async loadUserData() {
          return { progress: { version: 1, xp: 0, unlocked: 5, courts: {}, records: {}, sound: true, tactic: "balanced", difficulty: "standard", lastCourt: 0 }, settings: { theme: "dark", effectsOn: false, effectsVolume: 0, musicOn: false, musicVolume: 0, audioMigrated: true, preset: "wasd", bindings }, stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 }, preferences: { scoreSaveChoice: "ask" } };
        },
        async saveUserData() { return {}; },
        async recordRound() { return {}; },
        getLeaderboard(args) {
          window.__leaderboardCalls.push(args);
          return new Promise((resolve) => window.__leaderboardResolvers.push(resolve));
        },
        onAuthStateChange() { return () => {}; },
      });
    });
    const page = await context.newPage(), errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    const board = page.locator("#home-leaderboard");
    const table = board.locator(".hl-table");
    const status = page.locator("#home-leaderboard-status");
    assert.equal(await table.getAttribute("aria-busy"), "true");
    assert.match(await status.textContent(), /loading/i);
    await page.waitForFunction(() => window.__leaderboardCalls.length > 0);
    const initialCallCount = await page.evaluate(() => window.__leaderboardCalls.length);
    // A slow remote query must not turn Home into a frozen screen: another
    // Home control remains interactive while the first query is unresolved.
    await page.locator("[data-home-mode]").last().click();
    assert.equal(await page.locator("[data-home-mode]").last().getAttribute("aria-pressed"), "true");
    await page.evaluate(() => window.__leaderboardResolvers.at(-1)({ entries: [{ username: "before-refresh", score: 100, passes: 1 }] }));
    await page.locator("#home-leaderboard-list .hl-row").first().waitFor({ state: "visible" });

    const refresh = page.locator("#home-leaderboard-refresh");
    await refresh.click();
    await page.waitForFunction((count) => window.__leaderboardCalls.length > count, initialCallCount);
    assert.deepEqual(await page.evaluate(() => {
      const { mode, court, difficulty, limit } = window.__leaderboardCalls.at(-1);
      return { mode, court, difficulty, limit };
    }), { mode: "career", court: 0, difficulty: "standard", limit: 25 });
    assert.equal(await table.getAttribute("aria-busy"), "true");
    assert.match(await status.textContent(), /refreshing/i);
    assert.equal(await page.locator("#home-leaderboard-list .hl-cell-player").first().textContent(), "before-refresh");
    await page.evaluate(() => window.__leaderboardResolvers.at(-1)({ entries: [{ username: "after-refresh", score: 200, passes: 2 }] }));
    await page.waitForFunction(() => document.querySelector("#home-leaderboard-list .hl-cell-player")?.textContent === "after-refresh");
    assert.equal(await table.getAttribute("aria-busy"), "false");

    // Let the next request hang. The UI must recover with a useful retry path.
    const refreshedCallCount = await page.evaluate(() => window.__leaderboardCalls.length);
    await refresh.click();
    await page.waitForFunction((count) => window.__leaderboardCalls.length > count, refreshedCallCount);
    await page.waitForFunction(() => /taking too long|try again/i.test(document.querySelector("#home-leaderboard-status")?.textContent || ""), null, { timeout: 10_000 });
    assert.equal(await refresh.isEnabled(), true);
    assert.equal(await page.locator("#home-leaderboard-list .hl-cell-player").first().textContent(), "after-refresh");

    // A superseded request can resolve eventually, but must never repaint a newer court.
    const hungCallCount = await page.evaluate(() => window.__leaderboardCalls.length);
    await page.locator("#hl-tab-1").click();
    await page.waitForFunction((count) => window.__leaderboardCalls.length > count, hungCallCount);
    await page.evaluate(() => window.__leaderboardResolvers.at(-2)({ entries: [{ username: "stale", score: 1, passes: 1 }] }));
    await page.evaluate(() => window.__leaderboardResolvers.at(-1)({ entries: [{ username: "court-one", score: 300, passes: 3 }] }));
    await page.waitForFunction(() => document.querySelector("#home-leaderboard-list .hl-cell-player")?.textContent === "court-one");
    assert.equal(await page.locator("#home-leaderboard-list .hl-cell-player").first().textContent(), "court-one");
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the circuit leaderboard shows an offline error when no remote adapter is configured and does not render hardcoded data",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator("#home-leaderboard").waitFor({ state: "visible" });

    // Without a remote adapter, status shows the offline message and no rows render
    const status = page.locator("#home-leaderboard-status");
    await status.waitFor({ state: "visible" });
    assert.match(await status.textContent(), /unavailable offline/i);
    const rowCount = await page.locator("#home-leaderboard-list .hl-row").count();
    assert.equal(rowCount, 0, "no hardcoded rows should render when offline");

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the leaderboard difficulty filter re-queries by tier, and the round setup selector changes the applied target",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      serviceWorkers: "block",
    });
    // A mock adapter whose getLeaderboard records the difficulty it was
    // called with and tags returned entries with it — this is what proves
    // the toggle actually re-queries rather than merely restyling rows that
    // were already on screen.
    await context.addInitScript(() => {
      window.__leaderboardCalls = [];
      const bindings = {
        moveUp: ["KeyW", "ArrowUp"], moveDown: ["KeyS", "ArrowDown"],
        moveLeft: ["KeyA", "ArrowLeft"], moveRight: ["KeyD", "ArrowRight"],
        smartPass: ["Space"], direct1: ["Digit1"], direct2: ["Digit2"],
        direct3: ["Digit3"], direct4: ["Digit4"], wallToggle: ["KeyB"],
        wallHold: ["ShiftLeft"], focusHold: ["KeyE"], boostHold: ["KeyR"],
        shout: ["KeyF"], pause: ["Escape"], skipTrack: ["KeyN"],
      };
      window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
        kind: "local",
        async getSession() { return null; },
        async loadUserData() {
          return {
            progress: {
              version: 1, xp: 0, unlocked: 5, courts: {}, records: {},
              sound: true, tactic: "balanced", difficulty: "standard", lastCourt: 0,
            },
            settings: {
              theme: "dark", effectsOn: false, effectsVolume: 0, musicOn: false,
              musicVolume: 0, audioMigrated: true, preset: "wasd", bindings,
            },
            stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 },
            preferences: { scoreSaveChoice: "ask" },
          };
        },
        async saveUserData() { return {}; },
        async recordRound() { return { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 }; },
        async getLeaderboard({ difficulty } = {}) {
          window.__leaderboardCalls.push(difficulty);
          return {
            entries: [{
              username: `mock-${difficulty}`, score: 4242, passes: 10,
              triangles: 1, oles: 1, splits: 1, zones: 1, difficulty,
            }],
          };
        },
        onAuthStateChange() { return () => {}; },
      });
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator("#home-leaderboard").waitFor({ state: "visible" });
    // Sets progress.difficulty and fires prepare() exactly like a real
    // selection would — works from any view since #difficulty-select is
    // always in the DOM (see the .below-court hidden-in-play-view note
    // below), just not painted while the arena is on screen.
    const setDifficulty = (tier) =>
      page.evaluate((t) => {
        const select = document.getElementById("difficulty-select");
        select.value = t;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, tier);

    // The deck defaults to the player's own currently-selected tier
    // (Standard here), and shows it unambiguously via the active toggle
    // segment alone (no separate badge repeating the same word next to it —
    // that used to render as "RUTHLESS RUTHLESS" side by side), not merely
    // by restyling — the row content itself is the mocked "standard" query
    // result.
    await page.waitForFunction(() => window.__leaderboardCalls.includes("standard"));
    const standardBtn = page.locator('#hl-difficulty-toggle .hl-diff-btn[data-tier="standard"]');
    assert.equal(await standardBtn.getAttribute("aria-pressed"), "true");
    assert.equal(await standardBtn.textContent(), "STD");
    await page.locator("#home-leaderboard-list .hl-row").first().waitFor({ state: "visible" });
    assert.match(
      await page.locator("#home-leaderboard-list .hl-row .hl-cell-player").first().textContent(),
      /mock-standard/,
    );
    // No element anywhere in the header repeats the identical label next to
    // the toggle's own active segment.
    assert.equal(await page.locator("#hl-mode-badge").count(), 0);

    // Switching to Ruthless re-queries the adapter with that tier rather
    // than just restyling the existing Standard rows.
    const ruthlessBtn = page.locator('#hl-difficulty-toggle .hl-diff-btn[data-tier="ruthless"]');
    await ruthlessBtn.click();
    await page.waitForFunction(() => window.__leaderboardCalls.includes("ruthless"));
    assert.equal(await ruthlessBtn.getAttribute("aria-pressed"), "true");
    assert.equal(await ruthlessBtn.textContent(), "RUT");
    assert.equal(await standardBtn.getAttribute("aria-pressed"), "false");
    await page.waitForFunction(
      () => document.querySelector("#home-leaderboard-list .hl-row .hl-cell-player")?.textContent === "mock-ruthless",
    );
    // The header title stays on one line — the toggle used to crowd it onto
    // two at 1080px.
    const titleBox = await page.locator(".hl-title").boundingBox();
    const titleLineHeight = await page.locator(".hl-title").evaluate(
      (el) => parseFloat(getComputedStyle(el).lineHeight) || 0,
    );
    assert.ok(
      titleBox && titleBox.height <= titleLineHeight * 1.4,
      `"CIRCUIT LEADERBOARDS" must stay on one line, got height ${titleBox?.height} vs line-height ${titleLineHeight}`,
    );

    // Re-check the same one-line requirement at the app's narrower cited
    // desktop width (1080px) — the header must not have been fixed for one
    // width by breaking the other.
    await page.setViewportSize({ width: 1080, height: 1024 });
    // A resize's layout settling is a per-frame effect with no single
    // observable condition, so wait for real frames rather than a fixed
    // slice of wall time.
    await afterFrames(page, 6);
    const narrowTitleBox = await page.locator(".hl-title").boundingBox();
    assert.ok(
      narrowTitleBox && narrowTitleBox.height <= titleLineHeight * 1.4,
      `"CIRCUIT LEADERBOARDS" must stay on one line at 1080px too, got height ${narrowTitleBox?.height}`,
    );

    // The court list's tier tag must be a real abbreviation, never a
    // mid-word clip like "STA" (a plain name.slice(0, 3) mangled
    // "Standard") — check all three tiers, since they abbreviate
    // differently, on the first court card.
    for (const [tier, short] of [["relaxed", "REL"], ["standard", "STD"], ["ruthless", "RUT"]]) {
      await setDifficulty(tier);
      const tag = await page.locator(".court-item").first().locator(".court-tier-tag").textContent();
      assert.equal(tag, short, `court tier tag for ${tier}`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });

    // Now prove the round setup's own difficulty selector actually changes
    // the applied target, not just its own label. The target is the court's
    // reference (20000 on The Courtyard) scaled by the tier and then taken
    // at the court's clear ratio (0.35): Relaxed 20000 x 0.5 x 0.35 = 3500,
    // Standard x 0.7 = 4900, Ruthless x 1 = 7000, to the nearest 50.
    // Ruthless deliberately shares Standard's target — its single
    // possession means every round it finishes had no turnover, so it
    // already outscores Standard; raising its target too would push its
    // star rungs past what the tier can score (see DIFFICULTY_TIERS).
    // The arena is always Play view (.below-court, which holds this
    // selector, stays hidden the whole time per the existing "reclaim the
    // window for the court" design) — set the value directly and dispatch
    // change, exactly what a real selection does, rather than a visible
    // click the layout never offers.
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    await setDifficulty("standard");
    const standardTarget = await page.locator("#difficulty-target").textContent();
    await setDifficulty("ruthless");
    const ruthlessTarget = await page.locator("#difficulty-target").textContent();
    await setDifficulty("relaxed");
    const relaxedTarget = await page.locator("#difficulty-target").textContent();
    assert.notEqual(standardTarget, relaxedTarget);
    assert.notEqual(standardTarget, ruthlessTarget);
    assert.match(relaxedTarget, /TARGET 3500/);
    assert.match(standardTarget, /TARGET 4900/);
    assert.match(ruthlessTarget, /TARGET 7000/);

    // The possession count must agree with the tier everywhere it's shown —
    // the HUD counter (#lives-value), the pre-round note, and the overlay
    // copy — not just the target. This is what would have caught the
    // hardcoded-3 possessions/turnovers bug: Relaxed gets 4 lives, Standard
    // 3, Ruthless 2, and the ordinal wording ("second"/"third"/"fourth")
    // must track the count exactly.
    const possessionSnapshot = () =>
      page.evaluate(() => ({
        lives: document.getElementById("lives-value")?.textContent,
        note: document.getElementById("invitation-note")?.textContent,
        copy: document.getElementById("overlay-copy")?.textContent,
        configPossessions: window.__game?.config?.possessions,
      }));
    const expectPossessions = (snapshot, count, ordinal) => {
      const word = count === 1 ? "POSSESSION" : "POSSESSIONS";
      const wordLower = count === 1 ? "possession" : "possessions";
      assert.equal(snapshot.configPossessions, count);
      assert.equal(snapshot.lives, `${count} / ${count}`);
      assert.match(snapshot.note, new RegExp(`${count} ${word}`));
      assert.match(
        snapshot.note,
        new RegExp(`${ordinal} LOSS ENDS THE ROUND`, "i"),
      );
      assert.match(
        snapshot.copy,
        new RegExp(`You have ${count} ${wordLower}; the ${ordinal} loss ends the round\\.`, "i"),
      );
    };
    await setDifficulty("relaxed");
    expectPossessions(await possessionSnapshot(), 5, "fifth");
    await setDifficulty("standard");
    expectPossessions(await possessionSnapshot(), 3, "third");
    await setDifficulty("ruthless");
    expectPossessions(await possessionSnapshot(), 1, "first");

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "every round overlay says plainly what its buttons do, in every mode",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    await page.locator("#home-view").waitFor({ state: "visible" });
    // The card that opens a round names the round it is about to open, so the
    // button is never just a generic "Play" the player has to interpret.
    for (const [mode, primary] of [
      ["practice", /^Start the warm-up$/],
      ["career", /^Play the court$/],
      ["endless", /^Start the run$/],
      ["kotc", /^Take the court$/],
    ]) {
      await page.locator(`[data-home-mode="${mode}"]`).click();
      await page.locator("#title-play").click();
      await page.locator("#arena-view").waitFor({ state: "visible" });
      assert.match(
        await page.locator("#start-button").textContent(),
        primary,
        `the ${mode} invitation should name what it starts`,
      );
      // Nothing that opens a round offers a second button to guess at.
      assert.equal(await page.locator("#secondary-button").isHidden(), true);
      // Back out the way a mouse would: the bar's Menu, then Home.
      await page.locator("#top-pause").click();
      await page.locator("#pause-menu").waitFor({ state: "visible" });
      await page.locator("#pause-home").click();
      await page.locator("#home-view").waitFor({ state: "visible" });
    }
    // King of the Court is a playable mode: enabled, and it opens a round.
    const kingBtn = page.locator('[data-home-mode="kotc"]');
    assert.match(await kingBtn.locator("strong").textContent(), /King of the Court/i);
    assert.equal(await kingBtn.isDisabled(), false);
    await kingBtn.click();
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("#mode-label").textContent(), "KING OF THE COURT");
    assert.equal(await page.locator("#score-target").textContent(), "/ 24");
    assert.equal(await page.locator("#lives-label").textContent(), "CROWNS");
    assert.equal(await page.locator("#combo-value").isHidden(), true, "no multiplier pill without a multiplier");
    await page.locator("#top-pause").click();
    await page.locator("#pause-menu").waitFor({ state: "visible" });
    await page.locator("#pause-home").click();
    await page.locator("#home-view").waitFor({ state: "visible" });
    // Nowhere in the shell still calls home "Courts".
    const strays = await page.evaluate(() =>
      [...document.querySelectorAll("button")]
        .filter((el) => el.getClientRects().length && /\bcourts\b/i.test(el.textContent))
        .map((el) => `${el.id || el.className}: ${el.textContent.trim()}`),
    );
    assert.deepEqual(
      strays,
      [],
      `no visible control should still say "courts": ${JSON.stringify(strays)}`,
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "help and the changelog read as back navigation from Settings, and Escape/backdrop match",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/`);
    // Nothing has opened help yet - its markup default is a plain close,
    // which is what a future direct entry point (help reached with no
    // Settings open beneath it) would keep, since setDialogBackChrome() in
    // main.js only switches this to a back arrow when it is opened *from*
    // Settings (see the help-button handler).
    assert.equal(
      await page.locator("#close-help").evaluate((el) => el.textContent.trim()),
      "×",
    );
    assert.equal(
      await page.locator("#close-help").getAttribute("aria-label"),
      "Close instructions",
    );

    await page.locator("#settings-button").click();
    await page.locator("#settings-dialog").waitFor({ state: "visible" });

    // Help opened from Settings: the dismiss control reads as "back", and
    // Settings was never closed underneath it - dialog.close() is the whole
    // mechanism, so closing help simply reveals Settings again.
    await page.locator("#help-button").click();
    await page.locator("#help-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#close-help").textContent(), "‹");
    assert.match(
      await page.locator("#close-help").getAttribute("aria-label"),
      /back to settings/i,
    );
    assert.equal(
      await page.locator("#settings-dialog").evaluate((d) => d.open),
      true,
      "settings-dialog must stay open underneath help",
    );
    await page.locator("#close-help").click();
    await page.locator("#help-dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#settings-dialog").evaluate((d) => d.open),
      true,
      "closing help returns to settings, already open",
    );

    // The changelog gets its own page, reached from Settings, with the same
    // back affordance and the same build-time-sourced content.
    await page.locator("#changelog-button").click();
    await page.locator("#changelog-dialog").waitFor({ state: "visible" });
    assert.equal(await page.locator("#close-changelog").textContent(), "‹");
    await page.locator("#close-changelog").click();
    await page.locator("#changelog-dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#settings-dialog").evaluate((d) => d.open),
      true,
      "closing the changelog returns to settings, already open",
    );

    // A backdrop click on a sub-page does the same thing as its back button
    // - it never skips past settings to close everything.
    await page.locator("#help-button").click();
    await page.locator("#help-dialog").waitFor({ state: "visible" });
    // Land the press+release well clear of the dialog's own box, in its
    // ::backdrop - the corner of the viewport is always outside it at this
    // viewport size.
    await page.mouse.move(8, 8);
    await page.mouse.down();
    await page.mouse.up();
    await page.locator("#help-dialog").waitFor({ state: "hidden" });
    assert.equal(
      await page.locator("#settings-dialog").evaluate((d) => d.open),
      true,
      "a backdrop click on help must not close settings underneath it",
    );
    await page.locator("#close-settings").click();
    await page.locator("#settings-dialog").waitFor({ state: "hidden" });

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
