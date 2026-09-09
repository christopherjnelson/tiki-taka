import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";

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
    await page.goto(`${baseURL}/#play`);
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
      await page.locator("#game-overlay").isVisible(),
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
    await page.goto(`${baseURL}/#play`);
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
    assert.equal(
      await page.locator("html").getAttribute("data-theme"),
      "light",
    );
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
    // Pause -> Courts leaves the play-view presentation for the courts screen.
    await openPauseMenu(page);
    await page.locator("#pause-courts").click();
    await page.locator("#courts-view").waitFor({ state: "visible" });
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
    await page.goto(`${baseURL}/#play`);
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
        await page.locator("#pause-courts").click();
        await page.locator("#courts-view").waitFor({ state: "visible" });
      }
      await page.locator(".court-item").nth(i).click();
      await page.waitForTimeout(80);
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
      await page.goto(`${baseURL}/#play`);
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

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
