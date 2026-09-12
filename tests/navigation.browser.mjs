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
      ["title-play", "settings-button"],
      "the home menu offers Play and Settings and nothing else",
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
    await page.waitForTimeout(180);
    assert.equal(
      await page.evaluate(
        (time) => Math.abs(window.__navGame.time - time) < 0.01,
        frozen,
      ),
      true,
      "leaving the arena must freeze the active round",
    );
    await page.locator('[data-home-mode="daily"]').click();
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
    await page.locator('[data-home-mode="daily"]').click();
    await page.locator("#secondary-button").click();
    assert.match(await page.locator("#mode-label").textContent(), /DAILY/i);
    // The arena still pushes its own history entry, so Back leaves the court.
    await page.goBack();
    await page.waitForFunction(() => location.hash !== "#play");
    assert.equal(await page.locator("#arena-view").isHidden(), true);
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator(".court-item").nth(4).click();
    assert.match(await page.locator("#court-title").textContent(), /The Cage/i);
    assert.equal(page.url().endsWith("#play"), true);
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
      "theme-button",
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
    for (const selector of ["#music-toggle", "#music-skip", "#music-track"])
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
      for (const selector of ["#music-toggle", "#music-skip", ".top-brand-mark"])
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
    // Escape and the gamepad's Start still do exactly what they did.
    await page.locator("#court-list button").first().click();
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

    // Switching to London (court 1) updates tab and loads court 1 scores
    const tab1 = page.locator("#hl-tab-1");
    await tab1.click();
    assert.equal(await tab1.getAttribute("aria-selected"), "true");
    assert.equal(await tab0.getAttribute("aria-selected"), "false");
    await page.waitForTimeout(100);

    // Switching to Barcelona via keyboard arrow navigation
    await tab1.focus();
    await page.keyboard.press("ArrowRight");
    const tab2 = page.locator("#hl-tab-2");
    assert.equal(await tab2.getAttribute("aria-selected"), "true");

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
        shout: ["KeyF"], pause: ["Escape"],
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
    await page.waitForTimeout(100);
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
    // the applied target, not just its own label: Relaxed x0.7, Standard
    // x1.0 and Ruthless x1.3 over the same court, rounded to the nearest 50.
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
    assert.notEqual(standardTarget, ruthlessTarget);
    assert.notEqual(standardTarget, relaxedTarget);
    assert.notEqual(relaxedTarget, ruthlessTarget);
    assert.match(standardTarget, /TARGET 600/);
    assert.match(ruthlessTarget, /TARGET \d+/);
    assert.match(relaxedTarget, /TARGET \d+/);

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
      assert.equal(snapshot.configPossessions, count);
      assert.equal(snapshot.lives, `${count} / ${count}`);
      assert.match(snapshot.note, new RegExp(`${count} POSSESSIONS`));
      assert.match(
        snapshot.note,
        new RegExp(`${ordinal} LOSS ENDS THE ROUND`, "i"),
      );
      assert.match(
        snapshot.copy,
        new RegExp(`You have ${count} possessions; the ${ordinal} loss ends the round\\.`, "i"),
      );
    };
    await setDifficulty("relaxed");
    expectPossessions(await possessionSnapshot(), 4, "fourth");
    await setDifficulty("standard");
    expectPossessions(await possessionSnapshot(), 3, "third");
    await setDifficulty("ruthless");
    expectPossessions(await possessionSnapshot(), 2, "second");

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
      ["daily", /^Play today’s circuit$/],
      ["endless", /^Start the run$/],
      ["practice", /^Start the warm-up$/],
      ["career", /^Play the court$/],
    ]) {
      await page.locator(`[data-home-mode="${mode}"]`).click();
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

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
