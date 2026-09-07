import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import { freePort } from "./free-port.mjs";

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
async function openSidebar(page) {
  if (!(await page.locator("#home-button").isVisible()))
    await page.locator("#sidebar-toggle").click();
  await page.locator("#home-button").waitFor({ state: "visible" });
}

await check(
  "fresh launch presents a complete Home with real modes, tour, and progress",
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
    assert.equal(await page.locator("[data-home-mode]").count(), 4);
    assert.equal(await page.locator(".court-item").count(), 6);
    assert.match(await page.locator("#level-label").textContent(), /LEVEL 1/i);
    assert.equal(await page.locator("#home-stars").textContent(), "0");
    assert.match(await page.locator("#home-cleared").textContent(), /^0/);
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
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "Continue, Home modes, unlocked courts, leave confirmation, and history preserve rounds",
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
      await page.locator("#home-continue-copy").textContent(),
      /El Patio|Barcelona/i,
    );
    await page.locator("#home-continue").click();
    assert.equal(page.url().endsWith("#play"), true);
    assert.equal(await page.locator("#court-title").textContent(), "El Patio");
    await page.evaluate(async () => {
      const { Game } = await import("/src/game.js");
      const update = Game.prototype.update;
      window.__navGame = null;
      Game.prototype.update = function (...args) {
        window.__navGame = this;
        return update.apply(this, args);
      };
    });
    await page.locator("#start-button").click();
    await page.waitForFunction(() => window.__navGame);
    await page.waitForTimeout(180);
    const beforeHome = await page.evaluate(() => ({
      time: window.__navGame.time,
    }));
    await page.locator("#arena-home-button").click();
    assert.equal(await page.locator("#home-view").isVisible(), true);
    assert.match(
      await page.locator("#home-continue").textContent(),
      /Resume round/i,
    );
    const frozen = await page.evaluate(() => window.__navGame.time);
    await page.waitForTimeout(180);
    assert.equal(
      await page.evaluate(
        (time) => Math.abs(window.__navGame.time - time) < 0.01,
        frozen,
      ),
      true,
      "Home must freeze the active round",
    );
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
    await page.locator("#arena-home-button").click();
    await page.locator('[data-home-mode="daily"]').click();
    await page.locator("#secondary-button").click();
    assert.match(await page.locator("#mode-label").textContent(), /DAILY/i);
    await page.goBack();
    await page.waitForFunction(() => !location.hash);
    assert.equal(await page.locator("#home-view").isVisible(), true);
    await page.locator(".court-item").nth(4).click();
    assert.match(await page.locator("#court-title").textContent(), /The Cage/i);
    assert.equal(page.url().endsWith("#play"), true);
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "desktop sidebar collapse persists and settings remain reachable in Play view",
  async () => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
    });
    const page = await context.newPage(),
      errors = errorsFor(page);
    await page.goto(`${baseURL}/#play`);
    await page.locator("#sidebar-toggle").click();
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("sidebar-collapsed")),
      true,
    );
    await page.reload();
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("sidebar-collapsed")),
      true,
    );
    await openSidebar(page);
    await page.locator("#play-view-button").click();
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("play-view")),
      true,
    );
    await openSidebar(page);
    await page.screenshot({
      path: new URL("play-view-menu-desktop.png", outputDir).pathname,
      fullPage: true,
    });
    await page.locator("#settings-button").click();
    assert.equal(
      await page.locator("#settings-dialog").evaluate((el) => el.open),
      true,
    );
    await page.locator("#close-settings").click();
    assert.deepEqual(errors, []);
    await context.close();
  },
);

await check(
  "mobile drawer traps intent, closes by Escape and backdrop, and restores focus",
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
    await page.goto(`${baseURL}/#play`);
    await page.locator("#start-button").click();
    await page.keyboard.press("KeyP");
    assert.equal(
      await page.locator("#game-overlay").isVisible(),
      true,
      "custom pause key works in Arena",
    );
    await page.locator("#start-button").click();
    await page.locator("#sidebar-toggle").focus();
    await page.locator("#sidebar-toggle").click();
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("sidebar-open")),
      true,
    );
    assert.equal(await page.locator("#settings-button").isVisible(), true);
    await page.keyboard.press("KeyP");
    assert.equal(
      await page.locator("#game-overlay").isVisible(),
      true,
      "gameplay key cannot resume behind drawer",
    );
    assert.equal(await page.locator("#arena-view").getAttribute("inert"), "");
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "home-button",
    );
    await page.keyboard.press("Escape");
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("sidebar-open")),
      false,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.id),
      "sidebar-toggle",
    );
    await page.locator("#sidebar-toggle").click();
    await page.mouse.click(385, 420);
    assert.equal(
      await page
        .locator("body")
        .evaluate((el) => el.classList.contains("sidebar-open")),
      false,
    );
    assert.equal(
      await page.evaluate(() => {
        const el = document.activeElement;
        return !el || !el.closest("[hidden],[inert]");
      }),
      true,
    );
    await page.locator("#arena-home-button").click();
    await page.keyboard.press("KeyP");
    assert.equal(
      await page.locator("#home-view").isVisible(),
      true,
      "custom pause key cannot activate hidden Arena controls from Home",
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
      await page.goto(`${baseURL}/#play`);
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
      for (const selector of ["#court", ".court-toolbar", ".below-court"]) {
        const box = await page.locator(selector).boundingBox();
        assert.ok(
          box && box.x >= -1 && box.x + box.width <= width + 1,
          `${width}x${height} ${selector} ${JSON.stringify(box)}`,
        );
      }
      if (width >= 1280) {
        for (const selector of ["#court", ".court-toolbar", ".below-court"]) {
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
  "Home and its complete menu remain usable at portrait and compact landscape sizes",
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
      await page.screenshot({
        path: new URL(`home-${suffix}.png`, outputDir).pathname,
        fullPage: true,
      });
      await page.locator("#sidebar-toggle").click();
      assert.equal(await page.locator("#settings-button").isVisible(), true);
      assert.equal(await page.locator("#fullscreen-button").isVisible(), true);
      await page.screenshot({
        path: new URL(`menu-${suffix}.png`, outputDir).pathname,
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
