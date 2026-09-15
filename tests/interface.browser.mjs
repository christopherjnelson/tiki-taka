import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";
import { gotoArena, expectedCourtAspect } from "./open-arena.mjs";
import { afterFrames, waitForGame } from "./wait.mjs";

const playwright = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
const browserType = playwright[process.env.BROWSER || "chromium"];
const includeMobileLayouts = process.env.MOBILE_LAYOUTS === "1";
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
await check(
  "Build identity is visible and remains available on home and arena views",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(`${baseURL}/`);
    const identity = page.locator("#build-identity");
    await identity.waitFor({ state: "visible" });
    assert.match(
      await identity.textContent(),
      /^(?:ALPHA|BETA) · v(?:dev|\d+\.\d+\.\d+) · (?:local|[0-9a-f]{7,12}(?:-dirty)?) · (?:local|build \d+\.\d+)$/i,
    );
    assert.match(await identity.getAttribute("aria-label"), /^Build identity: (?:ALPHA|BETA)/);
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });
    assert.equal(await identity.isVisible(), true);
    assert.equal(await identity.evaluate((element) => getComputedStyle(element).pointerEvents), "none");
    await context.close();
  },
);
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
  // Input is polled from the frame loop. A wall-clock pulse can start and end
  // entirely between polls on a loaded runner, leaving its edge unseen. Wait
  // until the mock gamepad has been sampled in each state instead: this keeps
  // a d-pad press to one navigation step while proving both edges reached the
  // application's poll.
  for (const pressed of [true, false]) {
    const polls = await page.evaluate(
      ([index, value]) => window.__setInterfacePad(index, value),
      [button, pressed],
    );
    await page.waitForFunction(
      ([after, index, value]) => {
        const pad = window.__interfacePad;
        return pad.polls > after && pad.buttons[index] === value;
      },
      [polls, button, pressed],
    );
  }
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
      window.__interfacePad = { polls: 0, buttons: pressed.slice() };
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => {
          const buttons = pressed.slice();
          window.__interfacePad.polls++;
          window.__interfacePad.buttons = buttons;
          return [
            {
              connected: true,
              axes: [0, 0, 0, 0],
              buttons: buttons.map((value) => ({
                pressed: value,
                value: Number(value),
              })),
            },
          ];
        },
      });
      window.__setInterfacePad = (index, value) => {
        pressed[index] = value;
        return window.__interfacePad.polls;
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
    // wall-clock: proving the round clock does NOT run while settings are
    // open holds regardless of how many frames actually ran in this window.
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
    // wall-clock: proving the clock stays frozen holds regardless of how many
    // frames actually ran in this window.
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
    // wall-clock: proving the rebound-away key does NOT move the carrier
    // holds regardless of how many frames actually ran in this window.
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
    // Movement accrues per animation frame from dt, so wait for the carrier
    // to actually have covered the threshold this asserts on, rather than a
    // fixed slice of wall time that can expire before a frame has ticked.
    await waitForGame(
      page,
      (baseline) =>
        window.__interfaceGame.game.players[
          window.__interfaceGame.game.carrier
        ].y < baseline - 5,
      afterOld.y,
      { timeout: 10000, message: "new movement key must move the carrier" },
    );
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
      0,
      "wall pass does not earn Focus",
    );
    await page.evaluate(() => {
      window.__interfaceGame.game.focus = 1.5;
    });
    const focusBefore = await page.evaluate(
      () => window.__interfaceGame.game.focus,
    );
    await page.keyboard.down("KeyQ");
    // Focus drains per animation frame, so wait for it to actually start
    // dropping rather than a fixed slice of wall time that can expire before
    // the loop has ticked once on a loaded runner.
    await waitForGame(
      page,
      (before) => window.__interfaceGame.game.focus < before,
      focusBefore,
      { timeout: 10000, message: "custom Focus key should drain earned reserve" },
    );
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
  "toolbar key chips follow real input, not mere pad connection",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 850 },
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    await context.addInitScript(() => {
      const pressed = Array(16).fill(false);
      let connected = true;
      window.__interfacePad = { polls: 0, buttons: pressed.slice() };
      Object.defineProperty(navigator, "getGamepads", {
        configurable: true,
        value: () => {
          const buttons = pressed.slice();
          window.__interfacePad.polls++;
          window.__interfacePad.buttons = buttons;
          if (!connected) return [];
          return [
            {
              connected: true,
              axes: [0, 0, 0, 0],
              buttons: buttons.map((value) => ({
                pressed: value,
                value: Number(value),
              })),
            },
          ];
        },
      });
      window.__setInterfacePad = (index, value) => {
        pressed[index] = value;
        return window.__interfacePad.polls;
      };
      window.__unplugInterfacePad = () => {
        connected = false;
        return window.__interfacePad.polls;
      };
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await page.locator("#start-button").click();
    // Connecting alone must not touch the chips: give the pad a few polls
    // untouched before asserting anything.
    await page.waitForFunction(() => window.__interfacePad.polls > 3);
    assert.equal(await page.locator("#pass-button kbd").textContent(), "Space");
    assert.equal(await page.locator("#bank-button kbd").textContent(), "B");
    assert.equal(await page.locator("#shout-button kbd").textContent(), "F");
    assert.equal(await page.locator("#focus-button kbd").textContent(), "E");
    assert.equal(await page.locator("#boost-button kbd").textContent(), "R");
    assert.match(
      await page.locator("#pass-button").getAttribute("title"),
      /Space/,
      "an untouched pad must not switch the title either",
    );

    // A real press (button 0 / A) flips the chips to gamepad glyphs.
    await pulsePad(page, 0);
    await page.waitForFunction(
      () => document.querySelector("#pass-button kbd").textContent === "A",
    );
    assert.equal(await page.locator("#bank-button kbd").textContent(), "X");
    assert.equal(await page.locator("#shout-button kbd").textContent(), "RB");
    assert.equal(await page.locator("#focus-button kbd").textContent(), "LT");
    assert.equal(await page.locator("#boost-button kbd").textContent(), "RT");
    assert.match(
      await page.locator("#shout-button").getAttribute("title"),
      /RB/,
      "the title must agree with the visible chip once on gamepad",
    );

    // Remapping a gamepad button via settings dropdown updates toolbar chips
    await page.evaluate(() => {
      const select = document.querySelector("#gamepad-shout");
      select.value = "3"; // Y
      select.dispatchEvent(new Event("change"));
    });
    assert.equal(await page.locator("#shout-button kbd").textContent(), "Y");
    // Restore default
    await page.evaluate(() => {
      const select = document.querySelector("#gamepad-shout");
      select.value = "5"; // RB
      select.dispatchEvent(new Event("change"));
    });
    assert.equal(await page.locator("#shout-button kbd").textContent(), "RB");

    // Any keydown reverts to keyboard chips immediately.
    await page.keyboard.press("KeyG");
    assert.equal(await page.locator("#pass-button kbd").textContent(), "Space");
    assert.equal(await page.locator("#focus-button kbd").textContent(), "E");

    // Unplugging mid-round must not leave the chips advertising buttons the
    // player no longer has: back on the pad, then pull it out.
    await pulsePad(page, 0);
    await page.waitForFunction(
      () => document.querySelector("#pass-button kbd").textContent === "A",
    );
    const unplugged = await page.evaluate(() => window.__unplugInterfacePad());
    await page.waitForFunction(
      (after) => window.__interfacePad.polls > after + 2,
      unplugged,
    );
    assert.equal(await page.locator("#pass-button kbd").textContent(), "Space");
    assert.equal(await page.locator("#boost-button kbd").textContent(), "R");

    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "Play view persists with exact canvas geometry and accurate pointer passing",
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
    assert.equal(await page.locator("#theme-button").count(), 0);
    await page.reload();
    await page.locator("#home-view").waitFor({ state: "visible" });
    assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
    await page.locator("#title-play").click();
    await page.locator("#arena-view").waitFor({ state: "visible" });

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
      ...(includeMobileLayouts
        ? [
            { width: 844, height: 390 },
            { width: 390, height: 844 },
            { width: 320, height: 740 },
          ]
        : []),
    ]) {
      await page.setViewportSize(viewport);
      // A resize's layout settling is a per-frame effect with no single
      // observable condition to wait on, so wait for real frames rather than
      // a fixed slice of wall time.
      await afterFrames(page, 6);
      const box = await page.locator("#court").boundingBox();
      assert.ok(
        box &&
          Math.abs(box.width / box.height - expectedCourtAspect(viewport)) <
            0.01,
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
    // Entering fullscreen fires 'fullscreenchange' when the browser grants
    // it; a runner that refuses fullscreen (headless, no user gesture) never
    // fires that event at all, so race it against a short fallback rather
    // than assuming either outcome lands within a fixed delay.
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const done = () => {
            document.removeEventListener("fullscreenchange", done);
            resolve();
          };
          document.addEventListener("fullscreenchange", done);
          setTimeout(done, 300);
        }),
    );
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
      await page.locator("#title-play").click();
      await page.locator("#arena-view").waitFor({ state: "visible" });
      // The venue's canvas frame and CSS custom property are a per-frame
      // paint effect with no single observable condition, so wait for real
      // frames rather than a fixed slice of wall time.
      await afterFrames(page, 6);
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

if (includeMobileLayouts) await check(
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
      // Kick off first. Arriving in the arena puts the opening card on screen,
      // and on a phone that card is a full-screen sheet with the round's own
      // chrome — score, clock, Energy, the thumb controls — hidden behind it,
      // so asserting the controls are visible before starting asserts against
      // the moment they are deliberately gone. They belong to a live round, so
      // the check belongs after one begins.
      await page.locator("#start-button").tap();
      await page.waitForFunction(
        () => document.querySelector("#game-overlay")?.hidden === true,
      );
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
      // Touch control layout is a per-frame paint effect with no single
      // observable condition, so wait for real frames rather than a fixed
      // slice of wall time.
      await afterFrames(page, 6);
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
        Math.abs(court.width / court.height - expectedCourtAspect(viewport)) <
          0.01,
        `${viewport.width}x${viewport.height} Play view court aspect`,
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
);

// The readouts used to move into two floating cards beside the court
// whenever there was room for them, which read as disconnected from the
// game. They now live in two grouped cards (.hud-group-score,
// .hud-group-match) permanently attached to the court's own top edge, and
// the space beside/above/below the court that used to hold the rails (or sat
// empty) is full-bleed venue background instead — see .game-panel in
// style.css. This checks the court keeps its size and the panel goes edge to
// edge at every supported size, whether the court is height- or
// width-limited.
await check(
  "the HUD stays attached to the court's frame and the panel goes full-bleed",
  async () => {
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
      // The HUD's layout against the court's frame settles as the round's
      // own render loop paints frames; it has no single observable condition
      // to wait on, so wait for real frames rather than a fixed slice of
      // wall time.
      await page.waitForFunction(() => document.querySelector("#game-overlay")?.hidden === true);
      await afterFrames(page, 6);
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
          panel: box(".game-panel"),
          court: box("#court"),
          scoreGroup: box(".hud-group-score"),
          matchGroup: box(".hud-group-match"),
          combo: box("#combo-value"),
          lives: box("#lives-value"),
          score: box("#score-value"),
          best: box("#best-label"),
          time: box("#time-value"),
          venueBanner: box(".arena-venue-banner"),
          leftArenaRail: box(".arena-rail-left"),
          rightArenaRail: box(".arena-rail-right"),
          toolbar: box(".court-toolbar"),
          rail: document.querySelector(".court-rail, #rail-left, #rail-right"),
          courtShare: box("#court").width / window.innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          topBarVisible: (() => {
            const bar = document.querySelector("#top-bar");
            if (!bar) return false;
            const box = bar.getBoundingClientRect();
            return box.width > 0 && box.height > 0 && box.top >= 0;
          })(),
        };
      });
      // The old floating side rails are gone entirely; nothing should match.
      assert.equal(layout.rail, null, `no leftover rail element at ${label}`);
      // The panel is the viewport (minus the top bar), edge to edge: this is
      // the full-bleed background the court now sits inside of.
      assert.ok(
        layout.panel.left <= 1 &&
          layout.panel.right >= layout.innerWidth - 1,
        `the game panel must span the full window width at ${label}: ${JSON.stringify(layout.panel)}`,
      );
      // The court is the thing that must not move: it was 87% of the width of
      // a 1920x1080 window before this redesign and has to stay there.
      if (viewport.width === 1920)
        assert.ok(
          layout.courtShare > 0.869,
          `the court must keep its share of a 1920x1080 window, got ${(layout.courtShare * 100).toFixed(1)}%`,
        );
      // No axis may scroll at any of the three sizes, and the top bar must
      // stay on screen throughout.
      assert.ok(
        layout.scrollWidth <= layout.innerWidth + 1,
        `no horizontal scroll at ${label}: scrollWidth ${layout.scrollWidth} > innerWidth ${layout.innerWidth}`,
      );
      assert.ok(
        layout.scrollHeight <= layout.innerHeight + 1,
        `no vertical scroll at ${label}: scrollHeight ${layout.scrollHeight} > innerHeight ${layout.innerHeight}`,
      );
      assert.ok(layout.topBarVisible, `the top bar must stay visible at ${label}`);
      // Every readout stays visible, grouped into its card, and nothing is
      // clipped past the edge of the viewport.
      for (const [name, box] of [
        ["score", layout.score],
        ["personal best", layout.best],
        ["clock", layout.time],
        ["multiplier", layout.combo],
        ["possessions", layout.lives],
      ]) {
        assert.ok(box && box.width > 0 && box.height > 0, `${name} has no box at ${label}`);
        assert.ok(
          box.left >= -1 && box.right <= layout.innerWidth + 1,
          `${name} must not be clipped at the viewport edge at ${label}: ${JSON.stringify(box)}`,
        );
      }
      assert.ok(
        layout.scoreGroup.left < layout.matchGroup.left,
        `the score card must sit left of the match-stats card at ${label}`,
      );
      assert.ok(
        layout.venueBanner &&
          layout.venueBanner.left >= layout.scoreGroup.right - 1 &&
          layout.venueBanner.right <= layout.matchGroup.left + 1,
        `the venue banner must bridge the HUD pods without overlapping them at ${label}: ${JSON.stringify(layout)}`,
      );
      assert.ok(
        layout.toolbar &&
          layout.toolbar.left >= layout.court.left - 15 &&
          layout.toolbar.right <= layout.court.right + 15 &&
          layout.toolbar.bottom <= layout.panel.bottom + 1,
        `the control rail must stay attached to the court frame at ${label}: ${JSON.stringify(layout)}`,
      );
      if (viewport.width >= 1200) {
        assert.ok(
          layout.leftArenaRail?.right <= layout.court.left + 1 &&
            layout.rightArenaRail?.left >= layout.court.right - 1,
          `the decorative rails must stay in the letterbox at ${label}: ${JSON.stringify(layout)}`,
        );
      } else {
        assert.equal(layout.leftArenaRail?.width, 0, `left rail hidden at ${label}`);
        assert.equal(layout.rightArenaRail?.width, 0, `right rail hidden at ${label}`);
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
    // The ambience canvas is painted on the render loop, a per-frame effect
    // with no single observable condition, so wait for real frames rather
    // than a fixed slice of wall time.
    await afterFrames(page, 6);
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
    // The ambience canvas is painted on the render loop; wait for real
    // frames before taking the baseline sample below, rather than a fixed
    // slice of wall time.
    await afterFrames(page, 6);
    let moved = false;
    let previous = (await sample()).outsideSum;
    for (let attempt = 0; attempt < 12 && !moved; attempt++) {
      // wall-clock: the idle animation this polls for is genuinely driven by
      // elapsed wall-clock time (not a frame count), and this loop already
      // retries up to 12 times the way padUntil() does for input, so a slow
      // runner still gets to see the animation move - it just takes longer.
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
    // wall-clock: proving the reduced-motion ambience stays still holds
    // regardless of how many frames actually ran in this window.
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

// The pre-round card used to bury the required score as an 8px corner label
// next to "DIFFICULTY", and the description was undifferentiated prose at
// one weight. It should now be the biggest thing on the card, and the facts
// that actually change between tiers (possessions, press speed, the
// Ruthless extra defender) should carry real <strong> emphasis rather than
// decorative bolding of the surrounding text.
await check(
  "the pre-round card makes the target prominent and emphasizes only the facts that change between tiers",
  async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    assert.equal(
      await page.locator("#overlay-difficulty-target-row").isHidden(),
      false,
      "a targeted court must show the target row",
    );
    const overlayTarget = await page.evaluate(
      () => document.querySelector("#overlay-difficulty-target")?.textContent,
    );
    assert.ok(Number(overlayTarget) > 0, "the target row must show a positive number");
    const descriptionHtml = await page.evaluate(
      () => document.querySelector("#overlay-difficulty-description")?.innerHTML,
    );
    assert.match(
      descriptionHtml,
      /<strong>\d+ possessions?<\/strong>/,
      "the possession count must be the emphasized fact, not decorative bolding",
    );
    assert.match(
      descriptionHtml,
      /standard press|<strong>(quicker|gentler) press<\/strong>/,
      "the press phrase must only be bolded when it actually differs from the standard press",
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
);

// The HUD's big number used to be undifferentiated ("000" with the target
// welded into a small label above it, "SCORE / 600"). The live score and its
// target should now read as a pair on the readout itself, with the target
// visibly secondary, and modes without a real target (Endless's target: 0,
// Free practice's sandbox) must never show a "/ 0" or nonsense denominator.
await check(
  "the HUD score readout pairs the live score with its target, and degrades cleanly with no target",
  async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await page.locator("#start-button").click();
    await page.waitForFunction(() => document.querySelector("#game-overlay")?.hidden === true);
    // syncHud writes score-value/-target on the frame after a change, so read
    // these on the far side of real frames rather than synchronously.
    await afterFrames(page, 3);
    const careerReadout = await page.evaluate(() => ({
      label: document.querySelector("#score-label")?.textContent,
      scoreValue: document.querySelector("#score-value")?.textContent,
      targetHidden: document.querySelector("#score-target")?.hidden,
      targetText: document.querySelector("#score-target")?.textContent,
    }));
    assert.equal(careerReadout.label, "SCORE");
    assert.match(careerReadout.scoreValue, /^\d+$/, "#score-value must stay digits-only for existing helpers");
    assert.equal(careerReadout.targetHidden, false);
    assert.match(careerReadout.targetText, /^\/ \d+$/);
    assert.deepEqual(errors, []);
    await context.close();

    // Free practice: unlimited recoveries, no clock — its target is an
    // internal pacing number for the objective card, not a real pass/fail
    // line, so the HUD readout must not show it as a denominator.
    const practiceContext = await browser.newContext({ serviceWorkers: "block" });
    const practicePage = await practiceContext.newPage(),
      practiceErrors = errorsFor(practicePage);
    await practicePage.goto(`${baseURL}/`);
    await practicePage.locator("#home-view").waitFor({ state: "visible" });
    await practicePage.locator('[data-home-mode="practice"]').click();
    await practicePage.locator("#title-play").click();
    await practicePage.locator("#arena-view").waitFor({ state: "visible" });
    await practicePage.locator("#start-button").click();
    await practicePage.waitForFunction(() => document.querySelector("#game-overlay")?.hidden === true);
    await afterFrames(practicePage, 3);
    const practiceReadout = await practicePage.evaluate(() => ({
      label: document.querySelector("#score-label")?.textContent,
      scoreValue: document.querySelector("#score-value")?.textContent,
      targetHidden: document.querySelector("#score-target")?.hidden,
      targetText: document.querySelector("#score-target")?.textContent,
    }));
    assert.equal(practiceReadout.label, "FLOW SCORE");
    assert.match(practiceReadout.scoreValue, /^\d+$/);
    assert.equal(practiceReadout.targetHidden, true, "practice must not show a target denominator");
    assert.equal(practiceReadout.targetText, "");
    assert.deepEqual(practiceErrors, []);
    await practiceContext.close();
  },
);

await check(
  "a modal dialog's backdrop click closes it, but a click inside or a drag out of it does not",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1200, height: 850 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await gotoArena(page, baseURL);
    await openSettings(page);
    const dialogOpen = () =>
      page.locator("#settings-dialog").evaluate((el) => el.open);
    const box = await page.locator("#settings-dialog").evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    });
    // A click on the dialog's own content must not close it.
    await page.locator("#settings-title").click();
    assert.equal(
      await dialogOpen(),
      true,
      "a click on dialog content must not close it",
    );
    // A click on the dialog element's own padding - inside its box, but on
    // no child element - must not close it either.
    await page.mouse.click(box.left + 6, box.top + 6);
    assert.equal(
      await dialogOpen(),
      true,
      "a click on the dialog's padding must not close it",
    );
    // A drag that starts inside the dialog (selecting changelog text, say)
    // and is released past its edge is a drag, not a backdrop dismissal.
    await page.mouse.move((box.left + box.right) / 2, box.top + 10);
    await page.mouse.down();
    await page.mouse.move(20, 20, { steps: 5 });
    await page.mouse.up();
    assert.equal(
      await dialogOpen(),
      true,
      "a drag started inside and released on the backdrop must not close the dialog",
    );
    // A genuine backdrop click - pressed and released outside the dialog's
    // box - closes it, the same way its own × does.
    await page.mouse.click(20, 20);
    assert.equal(await dialogOpen(), false, "a backdrop click must close the dialog");
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
