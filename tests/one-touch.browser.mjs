import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
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
].filter(Boolean);
const executablePath = candidates.find((candidate) => {
  try {
    const path = statSync(candidate).isDirectory()
      ? `${candidate}/chrome-headless-shell`
      : candidate;
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return false;
  }
});
const browser = await chromium.launch({ headless: true, executablePath });

try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 850 },
    serviceWorkers: "block",
  });
  await context.addInitScript(() =>
    localStorage.setItem(
      "tiki-taka.progress.v1",
      JSON.stringify({ version: 1, sound: false }),
    ),
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await gotoArena(page, baseURL);
  await page.locator("#start-button").click();
  await page.evaluate(async () => {
    const { Game } = await import("/src/game.js");
    window.__oneTouch = { game: null, queues: [] };
    const update = Game.prototype.update;
    const queuePass = Game.prototype.queuePass;
    Game.prototype.update = function (dt, input) {
      // The title screen's attract demo is a Game too. Leave it alone: this
      // fixture strips defenders and slows the ball, which would be wrong for
      // the demo and would point the probe at the wrong round.
      if (this.config.attract) return update.call(this, dt, input);
      window.__oneTouch.game = this;
      // Isolated UI fixture: remove interceptions and slow only this game's
      // ball so real pointer/key input has a stable in-flight queue window.
      if (!this.__oneTouchFixture) {
        this.__oneTouchFixture = true;
        this.defenders = [];
        this.tactic = { ...this.tactic, ballSpeed: 240 };
      }
      return update.call(this, dt, input);
    };
    Game.prototype.queuePass = function (id, bank) {
      const accepted = queuePass.call(this, id, bank);
      window.__oneTouch.queues.push({ id, bank: !!bank, accepted });
      return accepted;
    };
  });
  await page.waitForFunction(() => window.__oneTouch?.game);

  await page.keyboard.press("Space");
  await page.waitForFunction(() => window.__oneTouch.game.ball);

  const click = await page.evaluate(() => {
    const game = window.__oneTouch.game;
    const target = game.players.find((player) => player.id !== game.ball.to);
    const rect = document.querySelector("#court").getBoundingClientRect();
    return {
      x: rect.left + (target.x / 1000) * rect.width,
      y: rect.top + (target.y / 620) * rect.height,
      id: target.id,
    };
  });
  await page.mouse.click(click.x, click.y);
  await page.waitForFunction(
    (id) =>
      window.__oneTouch.game.queuedPass?.id === id &&
      document.querySelector("#target-label")?.textContent.includes("QUEUED"),
    click.id,
  );
  assert.match(await page.locator("#target-label").textContent(), /QUEUED/);

  for (let streak = 1; streak <= 10; streak++) {
    await page.waitForFunction(
      (minimum) =>
        window.__oneTouch.game.oneTouchStreak >= minimum ||
        (window.__oneTouch.game.ball && !window.__oneTouch.game.queuedPass),
      streak,
    );
    if (await page.evaluate((n) => window.__oneTouch.game.oneTouchStreak < n, streak)) {
      const key = await page.evaluate(() => {
        const game = window.__oneTouch.game;
        const id = game.players.find(
          (player) => player.id !== game.ball.to,
        ).id;
        return `Digit${id + 1}`;
      });
      await page.keyboard.press(key);
    }
    await page.waitForFunction(
      (minimum) => window.__oneTouch.game.oneTouchStreak >= minimum,
      streak,
    );
  }
  assert.equal(
    await page.evaluate(() => window.__oneTouch.game.bestOneTouch),
    10,
  );
  await page.waitForFunction(() =>
    document.querySelector("#game-announcement")?.textContent.includes("10"),
  );
  await page.screenshot({
    path: new URL("one-touch-milestone.png", outputDir).pathname,
  });

  await page.waitForFunction(
    () => window.__oneTouch.game.ball && !window.__oneTouch.game.queuedPass,
  );
  const cancelKey = await page.evaluate(() => {
    const game = window.__oneTouch.game;
    return `Digit${game.players.find((p) => p.id !== game.ball.to).id + 1}`;
  });
  await page.keyboard.press(cancelKey);
  await page.waitForFunction(() => window.__oneTouch.game.queuedPass);
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => window.__oneTouch.game.queuedPass), null);
  assert.equal(await page.locator("#sound-button").getAttribute("aria-pressed"), "false");
  assert.deepEqual(errors, []);
  assert.ok(
    await page.evaluate(() =>
      window.__oneTouch.queues.some((entry) => entry.accepted),
    ),
  );
  // The olé readout used to be painted on the canvas at the court's top right,
  // underneath the floating scoreboard, so MULTIPLIER and POSSESSIONS covered
  // it. It is a DOM element now, which means the overlap is a box test rather
  // than a screenshot: no intersection at any supported size.
  const overlaps = (a, b) =>
    a.right > b.left && b.right > a.left && a.bottom > b.top && b.bottom > a.top;
  for (const size of [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
    { width: 1080, height: 1024 },
  ]) {
    await page.setViewportSize(size);
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    // Drive the streak straight in: this is a layout assertion, and the chain
    // above already proved the streak itself is earned by real input.
    await page.evaluate(() => {
      window.__oneTouch.game.oneTouchStreak = 12;
    });
    await page.waitForFunction(
      () => !document.querySelector("#one-touch-readout").hidden,
    );
    const boxes = await page.evaluate(() => {
      const box = (selector, closest) => {
        const node = document.querySelector(selector);
        const element = closest ? node.closest(closest) : node;
        const { left, top, right, bottom, width, height } =
          element.getBoundingClientRect();
        return { left, top, right, bottom, width, height };
      };
      return {
        ole: box("#one-touch-readout .one-touch-pill"),
        multiplier: box("#combo-value", ".stat"),
        possessions: box("#lives-value", ".stat"),
      };
    });
    const label = `${size.width}x${size.height}`;
    assert.ok(
      boxes.ole.width > 0 && boxes.ole.height > 0,
      `olé readout has no box at ${label}`,
    );
    assert.ok(
      !overlaps(boxes.ole, boxes.multiplier),
      `olé readout overlaps the multiplier at ${label}: ${JSON.stringify(boxes)}`,
    );
    assert.ok(
      !overlaps(boxes.ole, boxes.possessions),
      `olé readout overlaps possessions at ${label}: ${JSON.stringify(boxes)}`,
    );
  }
  assert.deepEqual(errors, []);
  console.log("✓ real keyboard and pointer input queue a ten-pass one-touch chain; pause clears it while muted");
  console.log("✓ the olé readout clears the multiplier and possessions at 1920x1080, 1280x720 and 1080x1024");
  await context.close();
} finally {
  await browser.close();
  if (server) server.kill();
}
