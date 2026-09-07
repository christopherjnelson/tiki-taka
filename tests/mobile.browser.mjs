import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
const mobileURL = `${baseURL}/mobile/`;
await mkdir(new URL("../test-results/", import.meta.url), { recursive: true });
let server;
try {
  if (!(await fetch(mobileURL)).ok) throw new Error();
} catch {
  const url = new URL(baseURL);
  server = spawn(process.execPath, ["scripts/serve.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PORT: url.port || "1234" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if ((await fetch(mobileURL)).ok) break;
    } catch {}
    if (i === 59) throw new Error(`Could not start ${mobileURL}`);
  }
}
const executablePath = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/opt/google/chrome/chrome",
]
  .filter(Boolean)
  .find((path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const browser = await chromium.launch({ headless: true, executablePath });
let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (e) {
    failures++;
    console.error(`✗ ${name}\n${e.stack || e}`);
  }
}
async function touch(cdp, type, points) {
  await cdp.send("Input.dispatchTouchEvent", {
    type,
    touchPoints: points.map((p) => ({
      x: p.x,
      y: p.y,
      id: p.id,
      radiusX: 8,
      radiusY: 8,
      force: 1,
    })),
  });
}
const center = (box) => ({
  x: box.x + box.width / 2,
  y: box.y + box.height / 2,
});
const insideViewport = (box, viewport) =>
  box &&
  box.x >= -0.5 &&
  box.y >= -0.5 &&
  box.x + box.width <= viewport.width + 0.5 &&
  box.y + box.height <= viewport.height + 0.5;
async function tapPoint(cdp, point, id = 1) {
  await touch(cdp, "touchStart", [{ ...point, id }]);
  await touch(cdp, "touchEnd", []);
}

await check(
  "dedicated mobile Home exposes modes, profile, settings, and all shared venues",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(mobileURL);
    assert.equal(await page.locator("#home-screen").isVisible(), true);
    assert.equal(await page.locator("[data-mode]").count(), 4);
    assert.equal(await page.locator(".court-button").count(), 6);
    await page.locator('[data-screen="profile"]').tap();
    assert.equal(await page.locator("#profile-screen").isVisible(), true);
    await page.locator('[data-screen="settings"]').tap();
    assert.equal(await page.locator("#settings-screen").isVisible(), true);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "real simultaneous touches preserve movement and Focus while armed wall passes queue and consume",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(mobileURL);
    await page.locator("#continue-button").tap();
    await page.evaluate(async () => {
      const { Game } = await import("/packages/engine/src/game.js");
      const { Renderer } = await import(
        "/packages/presentation/src/renderer.js"
      );
      window.__mobileGame = null;
      window.__mobileInput = null;
      window.__mobileLanes = [];
      const update = Game.prototype.update;
      Game.prototype.update = function (dt, input) {
        window.__mobileGame = this;
        window.__mobileInput = {
          ...input,
          move: { x: input.x, y: input.y },
        };
        return update.call(this, dt, input);
      };
      const drawLane = Renderer.prototype.drawLane;
      Renderer.prototype.drawLane = function (...args) {
        window.__mobileLanes.push({ bank: args[4], preview: args[5] });
        if (window.__mobileLanes.length > 60) window.__mobileLanes.shift();
        return drawLane.apply(this, args);
      };
    });
    await page.locator("#start-button").tap();
    await page.waitForFunction(() => window.__mobileGame);
    const cdp = await context.newCDPSession(page),
      joy = await page.locator("#joystick").boundingBox(),
      pass = await page.locator("#pass-action").boundingBox(),
      wall = await page.locator("#wall-action").boundingBox(),
      focus = await page.locator("#focus-action").boundingBox();
    assert.ok(joy && pass && wall && focus);
    const j = { ...center(joy), id: 1 };
    j.x += joy.width * 0.28;
    const p = { ...center(pass), id: 2 };
    const before = await page.evaluate(() => ({
      ...window.__mobileGame.players[window.__mobileGame.carrier],
    }));
    await page.evaluate(() => (window.__mobileLanes = []));
    await tapPoint(cdp, center(wall), 8);
    assert.equal(
      await page.locator("#wall-action").getAttribute("aria-pressed"),
      "true",
    );
    assert.equal(await page.evaluate(() => window.__mobileGame.ball), null);
    await page.waitForFunction(() =>
      window.__mobileLanes.some((lane) => lane.bank),
    );
    await touch(cdp, "touchStart", [j]);
    await page.waitForTimeout(180);
    await touch(cdp, "touchStart", [j, p]);
    await page.waitForFunction(() => window.__mobileGame.ball?.bank === true);
    assert.equal(
      await page.evaluate(() => window.__mobileGame.ball.bank),
      true,
    );
    assert.equal(
      await page.locator("#wall-action").getAttribute("aria-pressed"),
      "false",
    );
    await page.waitForFunction(() =>
      window.__mobileLanes.some((lane) => lane.bank),
    );
    await touch(cdp, "touchEnd", [j]);
    await page.waitForTimeout(180);
    const after = await page.evaluate(() => ({
      ...window.__mobileGame.players[
        window.__mobileGame.ball?.from ?? window.__mobileGame.carrier
      ],
    }));
    assert.ok(
      after.x > before.x + 2,
      "movement finger remains active after PASS finger lifts",
    );
    await page.waitForFunction(
      () => !window.__mobileGame.ball && !window.__mobileGame.passCooldown,
    );
    await page.evaluate(() => {
      window.__mobileGame.focus = 2;
      window.__mobileGame.focusNeedsRelease = false;
    });
    const f = { ...center(focus), id: 6 },
      focusPass = { ...center(pass), id: 7 };
    await touch(cdp, "touchStart", [j, f]);
    await page.waitForTimeout(140);
    const focusWhileHeld = await page.evaluate(() => window.__mobileGame.focus);
    assert.ok(focusWhileHeld < 2, "Focus drains while its own finger is held");
    await touch(cdp, "touchStart", [j, f, focusPass]);
    await page.waitForFunction(() => window.__mobileGame.ball);
    await touch(cdp, "touchEnd", [j, f]);
    await page.waitForTimeout(100);
    const focusAfterPassRelease = await page.evaluate(
      () => window.__mobileGame.focus,
    );
    assert.ok(
      focusAfterPassRelease < focusWhileHeld,
      "releasing PASS does not release the independent Focus finger",
    );
    await touch(cdp, "touchEnd", [j]);
    await page.waitForTimeout(100);
    const focusAfterFocusRelease = await page.evaluate(
      () => window.__mobileGame.focus,
    );
    await page.waitForTimeout(100);
    assert.ok(
      Math.abs(
        (await page.evaluate(() => window.__mobileGame.focus)) -
          focusAfterFocusRelease,
      ) < 0.02,
      "Focus stops draining when only the movement finger remains",
    );
    await touch(cdp, "touchEnd", []);
    await page.waitForFunction(
      () => !window.__mobileGame.ball && !window.__mobileGame.passCooldown,
    );
    await touch(cdp, "touchStart", [j, p]);
    await page.waitForFunction(() => window.__mobileGame.ball?.bank === false);
    await touch(cdp, "touchEnd", [j]);
    await tapPoint(cdp, center(wall), 9);
    assert.equal(
      await page.locator("#wall-action").getAttribute("aria-pressed"),
      "true",
    );
    const q = { ...center(pass), id: 4 };
    await touch(cdp, "touchStart", [j, q]);
    await page.waitForFunction(
      () => window.__mobileGame.queuedPass?.bank === true,
    );
    assert.equal(
      await page.evaluate(() => window.__mobileGame.queuedPass.bank),
      true,
    );
    assert.equal(
      await page.locator("#wall-action").getAttribute("aria-pressed"),
      "false",
    );
    await touch(cdp, "touchCancel", []);
    await page.waitForTimeout(50);
    assert.equal(
      await page
        .locator("#joystick-thumb")
        .evaluate((el) => el.style.transform),
      "",
    );
    await page.locator("#pause-button").tap();
    assert.equal(
      await page.evaluate(() => window.__mobileGame.queuedPass),
      null,
    );
    await context.close();
  },
);

await check(
  "gameplay fills portrait and landscape safely without page overflow or blocked controls",
  async () => {
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 360, height: 640 },
      { width: 844, height: 390 },
      { width: 667, height: 375 },
    ]) {
      const context = await browser.newContext({
        viewport,
        isMobile: true,
        hasTouch: true,
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      await page.goto(mobileURL);
      await page.locator("#continue-button").tap();
      const court = await page.locator("#court").boundingBox();
      const shell = await page.locator("#court-shell").boundingBox();
      const hud = await page.locator(".scorebar").boundingBox();
      assert.ok(
        insideViewport(court, viewport),
        `${viewport.width}×${viewport.height}: court bounds`,
      );
      assert.ok(
        insideViewport(hud, viewport),
        `${viewport.width}×${viewport.height}: HUD bounds`,
      );
      assert.ok(
        hud.y + hud.height + 2 <= court.y,
        `${viewport.width}×${viewport.height}: HUD must remain outside the court ${JSON.stringify({ hud, court })}`,
      );
      assert.ok(
        court.width >= shell.width * 0.95 &&
          court.height >= shell.height * 0.95,
      );
      const portrait = viewport.height > viewport.width;
      const expectedRatio = portrait ? 620 / 1000 : 1000 / 620;
      assert.ok(Math.abs(court.width / court.height - expectedRatio) < 0.015);
      for (const selector of [
        "#pause-button",
        "#joystick",
        "#focus-action",
        "#wall-action",
        "#pass-action",
        "#start-button",
      ]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(
          insideViewport(box, viewport),
          `${viewport.width}×${viewport.height}: ${selector}`,
        );
      }
      const metrics = await page.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        height: document.documentElement.scrollHeight,
        innerWidth,
        innerHeight,
      }));
      assert.ok(
        metrics.width <= metrics.innerWidth &&
          metrics.height <= metrics.innerHeight,
      );
      await page.screenshot({
        path: `test-results/mobile-new-${viewport.width}x${viewport.height}.png`,
      });
      await context.close();
    }
  },
);

await check(
  "portrait projection maps exact teammate taps and screen-right movement before rotation releases input",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(mobileURL);
    await page.locator("#continue-button").tap();
    await page.evaluate(async () => {
      const { Game } = await import("/packages/engine/src/game.js");
      const update = Game.prototype.update;
      Game.prototype.update = function (dt, input) {
        window.__portraitGame = this;
        window.__portraitInput = {
          ...input,
          move: { x: input.x, y: input.y },
        };
        return update.call(this, dt, input);
      };
    });
    await page.locator("#start-button").tap();
    await page.waitForFunction(() => window.__portraitGame);
    const cdp = await context.newCDPSession(page);
    const joy = await page.locator("#joystick").boundingBox();
    const focus = await page.locator("#focus-action").boundingBox();
    const j = { ...center(joy), id: 21 };
    j.x += joy.width * 0.3;
    await touch(cdp, "touchStart", [j]);
    await page.waitForFunction(() => window.__portraitInput?.move?.y < -0.5);
    const mapped = await page.evaluate(() => window.__portraitInput.move);
    assert.ok(Math.abs(mapped.x) < 0.2 && mapped.y < -0.5);
    await touch(cdp, "touchEnd", []);
    const court = await page.locator("#court").boundingBox();
    const target = await page.evaluate(() => {
      const game = window.__portraitGame;
      return game.players.find((player) => player.id !== game.carrier);
    });
    const targetPoint = {
      x: court.x + ((620 - target.y) / 620) * court.width,
      y: court.y + (target.x / 1000) * court.height,
    };
    await tapPoint(cdp, targetPoint, 22);
    await page.waitForFunction(
      (id) => window.__portraitGame.ball?.to === id,
      target.id,
    );
    await page.waitForFunction(() => !window.__portraitGame.ball);
    const passes = await page.evaluate(() => window.__portraitGame.passes);
    await tapPoint(cdp, { x: court.x + 4, y: court.y + 4 }, 23);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => window.__portraitGame.passes),
      passes,
    );
    await page.evaluate(() => {
      window.__portraitGame.focus = 2;
      window.__portraitGame.focusNeedsRelease = false;
    });
    await touch(cdp, "touchStart", [j, { ...center(focus), id: 24 }]);
    await page.waitForTimeout(100);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(120);
    assert.equal(
      await page
        .locator("#joystick-thumb")
        .evaluate((el) => el.style.transform),
      "",
    );
    assert.equal(await page.locator("#game-overlay").isVisible(), true);
    await context.close();
  },
);

await check(
  "instant wall preference persists while game chrome suppresses selection and forms remain editable",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(mobileURL);
    await page.locator('[data-screen="settings"]').tap();
    await page.locator("#wall-mode-select").selectOption("instant");
    await page.reload();
    await page.locator('[data-screen="settings"]').tap();
    assert.equal(
      await page.locator("#wall-mode-select").inputValue(),
      "instant",
    );
    await page.locator('[data-screen="profile"]').tap();
    const input = page.locator('#register-form input[name="username"]');
    await input.fill("Editable name");
    await input.evaluate((element) => element.setSelectionRange(0, 8));
    assert.deepEqual(
      await input.evaluate((element) => [
        element.selectionStart,
        element.selectionEnd,
      ]),
      [0, 8],
    );
    await page.locator('[data-screen="home"]').tap();
    await page.locator("#continue-button").tap();
    await page.locator("#start-button").tap();
    await page.evaluate(async () => {
      const { Game } = await import("/packages/engine/src/game.js");
      const update = Game.prototype.update;
      Game.prototype.update = function (...args) {
        window.__instantGame = this;
        return update.apply(this, args);
      };
    });
    await page.waitForFunction(() => window.__instantGame);
    const cdp = await context.newCDPSession(page);
    await tapPoint(
      cdp,
      center(await page.locator("#wall-action").boundingBox()),
      31,
    );
    await page.waitForFunction(() => window.__instantGame.ball?.bank === true);
    assert.equal(
      await page.locator("#wall-action").getAttribute("aria-pressed"),
      "false",
    );
    const suppression = await page.evaluate(() => {
      const court = document.querySelector("#court");
      const event = new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
      });
      court.dispatchEvent(event);
      return {
        userSelect: getComputedStyle(court).userSelect,
        contextPrevented: event.defaultPrevented,
      };
    });
    assert.equal(suppression.userSelect, "none");
    assert.equal(suppression.contextPrevented, true);
    await context.close();
  },
);

await check(
  "passwordless local profiles keep stats isolated from guest and each other",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(mobileURL);
    await page.locator('[data-screen="profile"]').tap();
    await page
      .locator('#register-form input[name="email"]')
      .fill("alpha@example.com");
    await page.locator('#register-form input[name="username"]').fill("Alpha");
    await page.locator("#register-form .cta").tap();
    await page.waitForFunction(
      () => document.querySelector("#profile-name")?.textContent === "Alpha",
    );
    await page.evaluate(async () => {
      const { createLocalDataAdapter } = await import(
        "/packages/data/src/index.js"
      );
      await createLocalDataAdapter({ storage: localStorage }).recordRound({
        score: 777,
        passes: 42,
        bestOneTouch: 12,
      });
    });
    await page.locator('[data-screen="home"]').tap();
    await page.locator('[data-screen="profile"]').tap();
    await page.waitForFunction(
      () => document.querySelector("#stat-score")?.textContent === "777",
    );
    await page.locator("#logout-button").tap();
    await page
      .locator('#register-form input[name="email"]')
      .fill("beta@example.com");
    await page.locator('#register-form input[name="username"]').fill("Beta");
    await page.locator("#register-form .cta").tap();
    await page.waitForFunction(
      () => document.querySelector("#profile-name")?.textContent === "Beta",
    );
    assert.equal(await page.locator("#stat-score").textContent(), "0");
    await page.locator("#logout-button").tap();
    await page
      .locator('#login-form input[name="identifier"]')
      .fill("alpha@example.com");
    await page.locator("#login-form .cta").tap();
    await page.waitForFunction(
      () => document.querySelector("#profile-name")?.textContent === "Alpha",
    );
    assert.equal(await page.locator("#stat-score").textContent(), "777");
    await context.close();
  },
);

await check(
  "a completed shared-engine round reaches the mobile result UI and profile stats",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    await page.goto(mobileURL);
    await page.locator('[data-mode="practice"]').tap();
    await page.evaluate(async () => {
      const { Game } = await import("/packages/engine/src/game.js");
      const update = Game.prototype.update;
      Game.prototype.update = function (...args) {
        window.__finishedMobileGame = this;
        return update.apply(this, args);
      };
    });
    await page.locator("#start-button").tap();
    await page.waitForFunction(() => window.__finishedMobileGame);
    await page.evaluate(() => {
      window.__finishedMobileGame.score =
        window.__finishedMobileGame.config.target;
      window.__finishedMobileGame.time = 0.001;
    });
    await page.waitForFunction(() =>
      /Court cleared/i.test(
        document.querySelector("#overlay-title")?.textContent || "",
      ),
    );
    await page.locator("#game-back").tap();
    await page.locator('[data-screen="profile"]').tap();
    await page.waitForFunction(
      () => Number(document.querySelector("#stat-games")?.textContent) === 1,
    );
    assert.ok(Number(await page.locator("#stat-score").textContent()) >= 120);
    await page.reload();
    await page.locator('[data-screen="profile"]').tap();
    assert.equal(await page.locator("#stat-games").textContent(), "1");
    await context.close();
  },
);

await browser.close();
if (server) server.kill();
if (failures) process.exitCode = 1;
