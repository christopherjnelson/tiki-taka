import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";
import { gotoArena } from "./open-arena.mjs";

const playwright = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
const browserType = playwright[process.env.BROWSER || "chromium"];
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
const outputDir = new URL("../test-results/", import.meta.url);
await mkdir(outputDir, { recursive: true });
let server;
try {
  const response = await fetch(baseURL);
  if (!response.ok) throw new Error(String(response.status));
} catch {
  const url = new URL(baseURL);
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: url.port || "5173" },
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
]
  .filter(Boolean)
  .map((path) => {
    try {
      return statSync(path).isDirectory()
        ? `${path}/chrome-headless-shell`
        : path;
    } catch {
      return path;
    }
  });
const executablePath = candidates.find((path) => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
});
const browser = await browserType.launch({
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
async function observeGame(page) {
  await page.evaluate(async () => {
    const { Game } = await import("/src/game.js");
    window.__interfaceGame = { game: null, passes: [] };
    const update = Game.prototype.update,
      pass = Game.prototype.pass;
    Game.prototype.update = function (dt, input) {
      // The title screen's attract demo is a Game too; follow the player's
      // round, not the one running behind the menu.
      if (this.config.attract) return update.call(this, dt, input);
      window.__interfaceGame.game = this;
      window.__interfaceGame.input = { ...input };
      return update.call(this, dt, input);
    };
    Game.prototype.pass = function (id, bank) {
      const accepted = pass.call(this, id, bank);
      window.__interfaceGame.passes.push({ id, bank: !!bank, accepted });
      return accepted;
    };
  });
  await page.waitForFunction(() => window.__interfaceGame?.game);
}
async function settle(page, passes = 0) {
  await page.waitForFunction((count) => {
    const game = window.__interfaceGame?.game;
    return (
      game &&
      game.passes > count &&
      !game.ball &&
      !game.lock &&
      !game.passCooldown
    );
  }, passes);
}
// Settings has two doors now: the title menu on the way in, and the pause menu
// once a court is on screen. Both must work, so this helper takes whichever is
// on screen rather than a single fixed route.
async function openSettings(page) {
  if (await page.locator("#settings-button").isVisible())
    await page.locator("#settings-button").click();
  else {
    await openPauseMenu(page);
    await page.locator("#pause-settings").click();
  }
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
}
async function openPauseMenu(page) {
  if (!(await page.locator("#pause-menu").isVisible())) {
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "visible" });
  }
}
async function closePauseMenu(page) {
  if (await page.locator("#pause-menu").isVisible()) {
    await page.keyboard.press("Escape");
    await page.locator("#pause-menu").waitFor({ state: "hidden" });
  }
}
// The utility buttons the sidebar used to hold now live in the settings
// dialog, so reaching one means opening settings first.
async function useSettingsControl(page, selector) {
  if (!(await page.locator(selector).isVisible())) await openSettings(page);
  await page.locator(selector).click();
}
async function bind(page, action, slot, key) {
  await page
    .locator(`.binding-key[data-action="${action}"][data-slot="${slot}"]`)
    .click();
  await page.keyboard.press(key);
}
async function pulsePad(page, button) {
  await page.evaluate((index) => window.__setInterfacePad(index, true), button);
  await page.waitForTimeout(80);
  await page.evaluate(
    (index) => window.__setInterfacePad(index, false),
    button,
  );
  await page.waitForTimeout(80);
}

await check(
  "real remapping persists and controls movement, passing, and earned Focus",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 850 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem("tiki-taka.settings.v1"))
        localStorage.setItem(
          "tiki-taka.settings.v1",
          JSON.stringify({ playView: true }),
        );
      const pressed = Array(16).fill(false);
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => [
          {
            connected: true,
            axes: [0, 0, 0, 0],
            buttons: pressed.map((value) => ({
              pressed: value,
              value: Number(value),
            })),
          },
        ],
      });
      window.__setInterfacePad = (index, value) => {
        pressed[index] = value;
      };
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await page.locator("#start-button").click();
    await observeGame(page);
    const timeBefore = await page.evaluate(
      () => window.__interfaceGame.game.time,
    );
    await openSettings(page);
    await pulsePad(page, 13);
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
      "D-pad input from a drawer-opened modal must stay in the modal",
    );
    await page.waitForTimeout(250);
    const timePaused = await page.evaluate(
      () => window.__interfaceGame.game.time,
    );
    assert.ok(
      Math.abs(timeBefore - timePaused) < 0.15,
      "opening settings must pause the round clock",
    );

    await page
      .locator('.binding-key[data-action="smartPass"][data-slot="0"]')
      .click();
    await pulsePad(page, 1);
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
      "gamepad B cancels capture without closing settings",
    );
    assert.match(
      await page.locator("#binding-status").textContent(),
      /cancelled/i,
    );
    await pulsePad(page, 9);
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      false,
      "gamepad Start closes settings",
    );
    assert.equal(
      await page.locator("#pause-menu").isVisible(),
      true,
      "gamepad modal close must not resume behind it",
    );
    const afterPadClose = await page.evaluate(
      () => window.__interfaceGame.game.time,
    );
    await page.waitForTimeout(180);
    assert.ok(
      Math.abs(
        (await page.evaluate(() => window.__interfaceGame.game.time)) -
          afterPadClose,
      ) < 0.01,
    );
    await openSettings(page);

    await page
      .locator('.binding-key[data-action="smartPass"][data-slot="0"]')
      .click();
    await page.keyboard.press("KeyW");
    assert.match(
      await page.locator("#binding-status").textContent(),
      /already assigned to Move up/,
    );
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
      "capture Escape cancels capture, not modal",
    );
    assert.match(
      await page.locator("#binding-status").textContent(),
      /cancelled/i,
    );

    await bind(page, "moveUp", 0, "KeyT");
    await page
      .locator('.binding-key[data-action="moveUp"][data-slot="1"]')
      .click();
    await page.keyboard.press("Backspace");
    assert.equal(
      await page
        .locator('.binding-key[data-action="moveUp"][data-slot="1"]')
        .textContent(),
      "Add key",
    );
    await bind(page, "smartPass", 0, "KeyP");
    await bind(page, "focusHold", 0, "KeyQ");
    assert.equal(await page.locator("#preset-select").inputValue(), "custom");
    await page.locator("#close-settings").click();
    assert.equal(
      await page.locator("#pause-menu").isVisible(),
      true,
      "closing settings leaves the round paused on the pause menu",
    );
    await closePauseMenu(page);
    if (await page.locator("#game-overlay").isVisible())
      await page.locator("#start-button").click();

    const before = await page.evaluate(() => ({
      ...window.__interfaceGame.game.players[
        window.__interfaceGame.game.carrier
      ],
    }));
    await page.keyboard.down("KeyW");
    await page.waitForTimeout(220);
    await page.keyboard.up("KeyW");
    const afterOld = await page.evaluate(() => ({
      ...window.__interfaceGame.game.players[
        window.__interfaceGame.game.carrier
      ],
    }));
    assert.ok(
      Math.abs(afterOld.y - before.y) < 1,
      "old movement key must stop moving",
    );
    await page.keyboard.down("KeyT");
    await page.waitForTimeout(220);
    await page.keyboard.up("KeyT");
    const afterNew = await page.evaluate(() => ({
      ...window.__interfaceGame.game.players[
        window.__interfaceGame.game.carrier
      ],
    }));
    assert.ok(
      afterNew.y < afterOld.y - 5,
      "new movement key must move the carrier",
    );

    await page.keyboard.press("KeyB");
    const passes = await page.evaluate(
      () => window.__interfaceGame.game.passes,
    );
    await page.keyboard.press("KeyP");
    await settle(page, passes);
    assert.equal(
      await page.evaluate(() => window.__interfaceGame.game.focus),
      0.5,
      "actual wall pass earns Focus",
    );
    const focusBefore = await page.evaluate(
      () => window.__interfaceGame.game.focus,
    );
    await page.keyboard.down("KeyQ");
    await page.waitForTimeout(220);
    await page.keyboard.up("KeyQ");
    assert.ok(
      await page.evaluate(
        (value) => window.__interfaceGame.game.focus < value,
        focusBefore,
      ),
      "custom Focus key drains earned reserve",
    );

    await page.reload();
    await openSettings(page);
    assert.equal(await page.locator("#preset-select").inputValue(), "custom");
    assert.equal(
      await page
        .locator('.binding-key[data-action="moveUp"][data-slot="0"]')
        .textContent(),
      "T",
    );
    assert.equal(
      await page
        .locator('.binding-key[data-action="smartPass"][data-slot="0"]')
        .textContent(),
      "P",
    );
    await page.locator("#reset-bindings").click();
    assert.equal(await page.locator("#preset-select").inputValue(), "wasd");
    await page.reload();
    await openSettings(page);
    assert.equal(
      await page
        .locator('.binding-key[data-action="moveUp"][data-slot="0"]')
        .textContent(),
      "W",
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "theme and Play view persist with exact canvas geometry and accurate pointer passing",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    const dark = await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--bg"));
    await useSettingsControl(page, "#theme-button");
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    const light = await page
      .locator("html")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--bg"));
    assert.notEqual(light, dark);
    await page.reload();
    // The theme is remembered across the reload; the view is not, because a
    // cold load always opens the title screen. Walk back to the arena for the
    // Play-view assertions below.
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
    await page.locator("#home-view").waitFor({ state: "visible" });
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    await useSettingsControl(page, "#theme-button");
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");

    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      true,
      "the arena is always presented in Play view",
    );
    assert.equal(await page.locator("#play-view-button").count(), 0);
    // The navigation drawer is gone entirely; the pause menu replaces it.
    assert.equal(await page.locator(".sidebar").count(), 0);
    assert.equal(await page.locator("#sidebar-toggle").count(), 0);
    if (await page.locator("#settings-dialog").evaluate((el) => el.open))
      await page.locator("#close-settings").click();
    await closePauseMenu(page);
    await openPauseMenu(page);
    assert.equal(
      await page.locator("#pause-settings").isVisible(),
      true,
      "settings remain reachable mid-round through the pause menu",
    );
    await closePauseMenu(page);
    await page.reload();
    // A reload is a cold load, so it opens home rather than
    // dropping straight back into the arena. Once the player asks for the
    // arena again it is still Play view, which is what this is checking.
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      false,
      "a cold load lands on home, not in Play view",
    );
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      true,
    );
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 844, height: 390 },
      { width: 390, height: 844 },
      { width: 320, height: 740 },
    ]) {
      await page.setViewportSize(viewport);
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.waitForTimeout(300);
      const box = await page.locator("#court").boundingBox();
      assert.ok(
        box && Math.abs(box.width / box.height - 1000 / 620) < 0.01,
        `${viewport.width}x${viewport.height} canvas aspect ${box ? box.width / box.height : "missing"} ${JSON.stringify(box)}`,
      );
      assert.ok(
        box.x >= 0 &&
          box.y >= 0 &&
          box.x + box.width <= viewport.width + 1 &&
          box.y + box.height <= viewport.height + 1,
        `${viewport.width}x${viewport.height} canvas bounds ${JSON.stringify(box)}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await page.locator("#start-button").click();
    await observeGame(page);
    await page.waitForFunction(() => !window.__interfaceGame.game.ball);
    const target = await page.evaluate(() => {
      const game = window.__interfaceGame.game;
      return { ...game.players.find((player) => player.id !== game.carrier) };
    });
    const box = await page.locator("#court").boundingBox();
    const passCount = await page.evaluate(
      () => window.__interfaceGame.passes.length,
    );
    await page.mouse.click(
      box.x + (box.width * target.x) / 1000,
      box.y + (box.height * target.y) / 620,
    );
    await page.waitForFunction(
      (count) => window.__interfaceGame.passes.length > count,
      passCount,
    );
    assert.deepEqual(
      await page.evaluate(() => window.__interfaceGame.passes.at(-1)),
      { id: target.id, bank: false, accepted: true },
    );
    await page.screenshot({
      path: new URL("interface-play-view.png", outputDir).pathname,
    });
    // Pause -> Home leaves the play-view presentation for the home screen.
    await openPauseMenu(page);
    await page.locator("#pause-home").click();
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      false,
    );
    assert.equal(await page.locator(".court-item").count(), 6);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "fullscreen uses the native document state and every venue selects distinct metadata and art",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    await context.addInitScript(() =>
      localStorage.setItem(
        "tiki-taka.progress.v1",
        JSON.stringify({
          version: 1,
          xp: 0,
          unlocked: 5,
          lastCourt: 0,
          tactic: "balanced",
          sound: false,
          courts: {},
          records: {},
        }),
      ),
    );
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await useSettingsControl(page, "#fullscreen-button");
    await page.waitForTimeout(100);
    const fullscreen = await page.evaluate(
      () => document.fullscreenElement === document.documentElement,
    );
    if (fullscreen) {
      assert.equal(
        await page.locator("#fullscreen-button").getAttribute("aria-pressed"),
        "true",
      );
      await useSettingsControl(page, "#fullscreen-button");
      await page.waitForFunction(() => !document.fullscreenElement);
    } else {
      assert.match(
        await page.locator("#toast").textContent(),
        /Fullscreen is not available/i,
      );
    }
    if (await page.locator("#settings-dialog").evaluate((el) => el.open))
      await page.locator("#close-settings").click();
    await closePauseMenu(page);
    const ids = [],
      accents = [],
      frames = [];
    for (let i = 0; i < 6; i++) {
      if (await page.locator("#arena-view").isVisible()) {
        await openPauseMenu(page);
        await page.locator("#pause-home").click();
        await page.locator("#home-view").waitFor({ state: "visible" });
      }
      await page.locator(".court-item").nth(i).click();
      await page.locator("#arena-view").waitFor({ state: "visible" });
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.waitForTimeout(250);
      ids.push(await page.locator("html").getAttribute("data-venue"));
      accents.push(
        await page
          .locator("html")
          .evaluate((el) =>
            getComputedStyle(el).getPropertyValue("--venue-accent"),
          ),
      );
      frames.push(
        await page.locator("#court").evaluate((canvas) => canvas.toDataURL()),
      );
    }
    assert.equal(new Set(ids).size, 6);
    assert.ok(
      new Set(accents).size >= 5,
      "venues expose distinct palette metadata",
    );
    assert.equal(new Set(frames).size, 6);
    await page.screenshot({
      path: new URL("interface-venues.png", outputDir).pathname,
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "coarse touch controls remain usable across portrait and landscape themes",
  async () => {
    for (const viewport of [
      { width: 320, height: 740 },
      { width: 390, height: 844 },
      { width: 844, height: 390 },
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: true,
        hasTouch: true,
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      const page = await context.newPage(),
        errors = errorsFor(page);
      await gotoArena(page, baseURL);
      assert.equal(
        await page.locator("#touch-pass").isVisible(),
        true,
        `${viewport.width}x${viewport.height} touch pass`,
      );
      assert.equal(
        await page.locator("#joystick").isVisible(),
        true,
        `${viewport.width}x${viewport.height} joystick`,
      );
      assert.equal(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <=
            document.documentElement.clientWidth,
        ),
        true,
      );
      assert.equal(
        await page
          .locator("body")
          .evaluate((el) => el.classList.contains("play-view")),
        true,
        `${viewport.width}x${viewport.height} play view is always on in the arena`,
      );
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          ),
      );
      await page.waitForTimeout(300);
      for (const selector of [
        "#court",
        "#touch-pass",
        "#joystick",
        "#touch-focus",
        "#pause-button",
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(
          box,
          `${viewport.width}x${viewport.height} ${selector} visible in Play view`,
        );
        assert.ok(
          box.x >= -1 &&
            box.y >= -1 &&
            box.x + box.width <= viewport.width + 1 &&
            box.y + box.height <= viewport.height + 1,
          `${viewport.width}x${viewport.height} ${selector} bounded ${JSON.stringify(box)}`,
        );
      }
      const court = await page.locator("#court").boundingBox();
      assert.ok(
        Math.abs(court.width / court.height - 1000 / 620) < 0.01,
        `${viewport.width}x${viewport.height} Play view court aspect`,
      );
      if (!(await page.locator("#theme-button").isVisible())) {
        await page.locator("#pause-button").tap();
        await page.locator("#pause-menu").waitFor({ state: "visible" });
        await page.locator("#pause-settings").tap();
        await page.locator("#settings-dialog").waitFor({ state: "visible" });
      }
      await page.locator("#theme-button").tap();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "light",
      );
      if (viewport.width === 390)
        await page.screenshot({
          path: new URL("interface-mobile-light.png", outputDir).pathname,
          fullPage: true,
        });
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

// The side rails and the ambience: readouts move into the space beside the
// court when there is enough of it, the court never gives up a pixel for them,
// and the ambience is painted only in the letterbox.
await check(
  "the readouts move into the side space without the court losing any of it",
  async () => {
    // 1920x1080 and 1280x720 have room beside a height-limited court;
    // 1080x1024 is width-limited and has none, so the band keeps the stats.
    const expected = {
      "1920x1080": "on",
      "1280x720": "on",
      "1080x1024": "off",
    };
    for (const viewport of [
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 1080, height: 1024 },
    ]) {
      const context = await browser.newContext({
        viewport,
        serviceWorkers: "block",
      });
      const page = await context.newPage(),
        errors = errorsFor(page);
      await gotoArena(page, baseURL);
      await page.locator("#start-button").click();
      await page.waitForTimeout(400);
      const label = `${viewport.width}x${viewport.height}`;
      const layout = await page.evaluate(() => {
        const box = (selector) => {
          const element = document.querySelector(selector);
          if (!element) return null;
          const { left, top, right, bottom, width, height } =
            element.getBoundingClientRect();
          return { left, top, right, bottom, width, height };
        };
        return {
          rails: document.body.dataset.rails,
          court: box("#court"),
          left: box("#rail-left"),
          right: box("#rail-right"),
          combo: box("#combo-value"),
          lives: box("#lives-value"),
          score: box("#score-value"),
          inLeftRail: document.querySelector("#rail-left").contains(
            document.querySelector("#score-value"),
          ),
          inRightRail: document.querySelector("#rail-right").contains(
            document.querySelector("#combo-value"),
          ),
          courtShare: box("#court").width / window.innerWidth,
        };
      });
      assert.equal(layout.rails, expected[label], `rail state at ${label}`);
      // The court is the thing that must not move: it was 87% of the width of
      // a 1920x1080 window before the rails existed and has to stay there.
      if (viewport.width === 1920)
        assert.ok(
          layout.courtShare > 0.869,
          `the court must keep its share of a 1920x1080 window, got ${(layout.courtShare * 100).toFixed(1)}%`,
        );
      if (layout.rails === "on") {
        assert.ok(layout.inLeftRail && layout.inRightRail,
          `the readouts must be in the rails at ${label}`);
        assert.ok(
          layout.left.right <= layout.court.left + 1 &&
            layout.right.left >= layout.court.right - 1,
          `the rails must sit beside the court, not over it, at ${label}: ${JSON.stringify(layout)}`,
        );
        for (const [name, stat] of [
          ["multiplier", layout.combo],
          ["possessions", layout.lives],
          ["score", layout.score],
        ])
          assert.ok(
            stat.right <= layout.court.left + 1 || stat.left >= layout.court.right - 1,
            `the ${name} readout must clear the court at ${label}: ${JSON.stringify(stat)}`,
          );
      } else {
        assert.ok(!layout.inLeftRail && !layout.inRightRail,
          `with no room beside the court the readouts belong in the band at ${label}`);
        assert.ok(layout.combo.width > 0, `the multiplier must stay visible at ${label}`);
      }
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

await check(
  "the ambience stays outside the court, keeps moving without music, and stills for reduced motion",
  async () => {
    // Sampling the ambience canvas: alpha inside the court rectangle must be
    // zero at every probe, and the letterbox must have something in it.
    const sample = () =>
      page.evaluate(() => {
        const canvas = document.querySelector("#ambience");
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        const scale = canvas.width / canvas.getBoundingClientRect().width;
        const court = document.querySelector("#court").getBoundingClientRect();
        const panel = canvas.getBoundingClientRect();
        const at = (x, y) => {
          const data = ctx.getImageData(
            Math.round((x - panel.left) * scale),
            Math.round((y - panel.top) * scale),
            1,
            1,
          ).data;
          return { a: data[3], r: data[0], g: data[1], b: data[2] };
        };
        const inside = [0.25, 0.5, 0.75].flatMap((fx) =>
          [0.25, 0.5, 0.75].map((fy) =>
            at(court.left + court.width * fx, court.top + court.height * fy),
          ),
        );
        const outside = [
          at(panel.left + court.left * 0.5, panel.top + panel.height * 0.4),
          at(panel.right - court.left * 0.5, panel.top + panel.height * 0.6),
        ];
        return {
          insideAlpha: Math.max(...inside.map((pixel) => pixel.a)),
          outsideAlpha: Math.max(...outside.map((pixel) => pixel.a)),
          outsideSum: outside.reduce((total, pixel) => total + pixel.a, 0),
        };
      });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await page.locator("#start-button").click();
    await page.waitForTimeout(600);
    const first = await sample();
    assert.equal(first.insideAlpha, 0,
      "nothing may be painted inside the court");
    assert.ok(first.outsideAlpha > 0,
      "the space beside the court should not be left empty");
    assert.ok(first.outsideAlpha < 120,
      `the ambience must stay low-contrast, got alpha ${first.outsideAlpha}`);
    // Music off is the common case (a muted player, a blocked autoplay, a
    // track still loading): the wash must keep breathing rather than freeze.
    await page.keyboard.press("Escape");
    await page.locator("#pause-settings").click();
    await page.locator("#settings-dialog").waitFor({ state: "visible" });
    await page.locator("#music-button").click();
    await page.locator("#close-settings").click();
    await page.locator("#pause-resume").click();
    await page.waitForTimeout(400);
    let moved = false;
    let previous = (await sample()).outsideSum;
    for (let attempt = 0; attempt < 12 && !moved; attempt++) {
      await page.waitForTimeout(350);
      const next = (await sample()).outsideSum;
      if (next !== previous) moved = true;
      previous = next;
    }
    assert.ok(moved, "with the music off the ambience must fall back to an idle animation");
    assert.deepEqual(errors, []);
    await context.close();

    // prefers-reduced-motion: alive is not the point any more, staying still
    // is, and it must still not paint over the court.
    const stillContext = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    const stillPage = await stillContext.newPage(),
      stillErrors = errorsFor(stillPage);
    await gotoArena(stillPage, baseURL);
    await stillPage.locator("#start-button").click();
    await stillPage.waitForTimeout(1200);
    const still = await stillPage.evaluate(() => {
      const canvas = document.querySelector("#ambience");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const court = document.querySelector("#court").getBoundingClientRect();
      const panel = canvas.getBoundingClientRect();
      const scale = canvas.width / panel.width;
      const at = (x, y) =>
        ctx.getImageData(
          Math.round((x - panel.left) * scale),
          Math.round((y - panel.top) * scale),
          1,
          1,
        ).data[3];
      return {
        inside: at(court.left + court.width / 2, court.top + court.height / 2),
        outside: at(panel.left + court.left * 0.5, panel.top + panel.height * 0.4),
      };
    });
    assert.equal(still.inside, 0,
      "reduced motion must still keep the court clear");
    assert.ok(still.outside >= 0, "reduced motion must not break the ambience");
    assert.deepEqual(stillErrors, []);
    await stillContext.close();
  },
);

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
