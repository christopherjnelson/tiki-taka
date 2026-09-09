import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";
import { gotoArena } from "./open-arena.mjs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
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
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  await page.waitForTimeout(100);
}
async function openPauseMenu(page) {
  if (!(await page.locator("#pause-menu").isVisible())) {
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
  }
}
// Leaving the arena now goes through the pause menu, which is the replacement
// for both the old workspace Home button and the sidebar drawer.
async function leaveToCourts(page) {
  await openPauseMenu(page);
  await page.locator("#pause-courts").click();
  await page.locator("#courts-view").waitFor({ state: "visible" });
}

await check(
  "fresh launch presents a gamepad-ready title screen with the progress one step behind it",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(baseURL, { waitUntil: "networkidle" });
    assert.equal(await page.locator("#title-view").isVisible(), true);
    assert.equal(await page.locator("#courts-view").isHidden(), true);
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    // A game, not a dashboard: one vertical menu and nothing else.
    assert.deepEqual(
      await page.evaluate(() =>
        [...document.querySelectorAll("#title-menu button")]
          .filter((el) => !el.hidden)
          .map((el) => el.id),
      ),
      ["title-play", "title-courts", "settings-button"],
      "the title menu offers Play, Courts and Settings and nothing else",
    );
    // Keyboard and controller both start on the menu with no clicking first.
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "title-play",
    );
    // Every earned statistic the old dashboard showed still exists, on Courts.
    await page.locator("#title-courts").click();
    await page.locator("#courts-view").waitFor({ state: "visible" });
    assert.equal(page.url().endsWith("#courts"), true);
    assert.equal(await page.locator("[data-home-mode]").count(), 4);
    assert.equal(await page.locator(".court-item").count(), 6);
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
    // Escape walks back out of Courts without touching the mouse.
    await page.keyboard.press("Escape");
    await page.locator("#title-view").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "Play, Courts modes, unlocked courts, leave confirmation, and history preserve rounds",
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
    await page.waitForTimeout(180);
    const beforeHome = await page.evaluate(() => ({
      time: window.__navGame.time,
    }));
    await leaveToCourts(page);
    assert.equal(await page.locator("#courts-view").isVisible(), true);
    await page.locator("#courts-back").click();
    await page.locator("#title-view").waitFor({ state: "visible" });
    assert.match(await page.locator("#title-play").textContent(), /Resume/i);
    const frozen = await page.evaluate(() => window.__navGame.time);
    await page.waitForTimeout(180);
    assert.equal(
      await page.evaluate(
        (time) => Math.abs(window.__navGame.time - time) < 0.01,
        frozen,
      ),
      true,
      "leaving the arena must freeze the active round",
    );
    await page.locator("#title-courts").click();
    await page.locator("#courts-view").waitFor({ state: "visible" });
    await page.locator('[data-home-mode="daily"]').click();
    assert.match(
      await page.locator("#overlay-kicker").textContent(),
      /LEAVE THIS ROUND/i,
    );
    assert.match(
      await page.locator("#start-button").textContent(),
      /Keep playing/i,
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
    await leaveToCourts(page);
    await page.locator('[data-home-mode="daily"]').click();
    await page.locator("#secondary-button").click();
    assert.match(await page.locator("#mode-label").textContent(), /DAILY/i);
    // The arena still pushes its own history entry, so Back leaves the court.
    await page.goBack();
    await page.waitForFunction(() => location.hash !== "#play");
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    await page.locator("#courts-view").waitFor({ state: "visible" });
    await page.locator(".court-item").nth(4).click();
    assert.match(await page.locator("#court-title").textContent(), /The Cage/i);
    assert.equal(page.url().endsWith("#play"), true);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the pause menu reaches Courts and Settings two presses from pausing",
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
    // Everything the sidebar used to hold moved into settings.
    for (const id of [
      "sound-button",
      "theme-button",
      "fullscreen-button",
      "help-button",
      "account-button",
    ])
      assert.equal(
        await page.locator(`#${id}`).isVisible(),
        true,
        `${id} must stay reachable after the drawer was removed`,
      );
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
      ["pause-resume", "pause-restart", "pause-courts", "pause-settings"],
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
    // Courts is one press away from the same menu.
    await page.locator("#pause-courts").click();
    await page.locator("#courts-view").waitFor({ state: "visible" });
    assert.equal(await page.locator(".court-item").count(), 6);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "the pause menu traps gameplay intent, closes by Escape, and restores focus",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
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
    await page.locator("#pause-courts").click();
    await page.locator("#courts-view").waitFor({ state: "visible" });
    await page.keyboard.press("KeyP");
    assert.equal(
      await page.locator("#courts-view").isVisible(),
      true,
      "custom pause key cannot activate hidden Arena controls from Courts",
    );
    await page.screenshot({
      path: new URL("mobile-menu.png", outputDir).pathname,
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
      [320, 740],
      [390, 844],
      [844, 390],
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
        court && Math.abs(court.width / court.height - 1000 / 620) < 0.01,
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

await check(
  "the title screen and its menus remain usable at portrait and compact landscape sizes",
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
      assert.equal(await page.locator("#title-view").isVisible(), true);
      for (const id of ["title-play", "title-courts", "settings-button"]) {
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
      await page.locator("#title-courts").tap();
      await page.locator("#courts-view").waitFor({ state: "visible" });
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        true,
        `${suffix} courts screen must not overflow horizontally`,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

await check(
  "a cold load opens the title screen even when the URL still says #play",
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
    await page.locator("#title-view").waitFor({ state: "visible" });
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
    await page.locator("#title-view").waitFor({ state: "visible" });
    await page.goForward();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    // ...but a reload from the arena is a cold load, and cold loads open the
    // title screen.
    await page.reload();
    await page.locator("#title-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "nothing scrolls at 1080x1024, and the court keeps its share of the window",
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
      await page.locator("#title-view").waitFor({ state: "visible" });
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
      await noScroll("the title screen");
      await page.locator("#title-courts").click();
      await page.locator("#courts-view").waitFor({ state: "visible" });
      await noScroll("the courts screen");
      await page.locator("#courts-back").click();
      await page.locator("#title-view").waitFor({ state: "visible" });
      await page.locator("#settings-button").click();
      await page.locator("#settings-dialog").waitFor({ state: "visible" });
      await noScroll("the settings screen");
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
      // The side rails are drawn from the letterbox the canvas did not take,
      // so they must never cost the court width. 90.7% is what a 1000:620
      // court gets from a 16:9 window.
      const court = await page.locator("#court").boundingBox();
      if (width / height > 1000 / 620)
        assert.ok(
          (court.width / width) * 100 > 90,
          `the court must keep its share of a ${width}x${height} window, got ${((court.width / width) * 100).toFixed(1)}%`,
        );
      for (const id of ["brand-rail", "music-rail"]) {
        const rail = await page.locator(`#${id}`).boundingBox();
        assert.ok(
          rail.x + rail.width <= court.x + 0.5 ||
            rail.x + 0.5 >= court.x + court.width,
          `${id} must sit beside the court, not over it, at ${width}x${height}`,
        );
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
