import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { _electron: electron } = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
if (process.env.TIKI_TAKA_ISOLATED_TEST !== "1")
  throw new Error(
    "Run Electron tests through `npm run test:electron` so they use an isolated display.",
  );
const executablePath = path.resolve(
  process.env.ELECTRON_EXECUTABLE ||
    "release/electron/linux-unpacked/tiki-taka",
);
await access(executablePath);
await chmod(executablePath, 0o755);
const testRoot = await mkdtemp(path.join(os.tmpdir(), "tiki-taka-electron-"));
const testUserData = path.join(testRoot, "fresh", "profile");
const stabilityMs = Number(process.env.ELECTRON_STABILITY_MS || 120_000);
process.once("exit", () => rmSync(testRoot, { recursive: true, force: true }));
const processLogs = [];
let expectedClose = false;

async function launch() {
  const application = await electron.launch({
    executablePath,
    timeout: 30_000,
    env: { ...process.env, TIKI_TAKA_USER_DATA: testUserData },
  });
  const child = application.process();
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk) => processLogs.push(String(chunk)));
  application.on("close", () => {
    if (!expectedClose)
      processLogs.push("Electron application closed unexpectedly");
  });
  return application;
}
async function waitForNativeFullscreen(application, expected) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const actual = await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFullScreen(),
    );
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Native fullscreen did not become ${expected}`);
}

let app = await launch();
let userData;
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(5_000);
  page.setDefaultNavigationTimeout(5_000);
  const mark = (step) => console.log(`electron smoke: ${step}`);
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(message.text());
  });
  await page.waitForSelector("#home-view:not([hidden])");
  mark("local home loaded");
  assert.match(await page.title(), /tiki-taka/i);
  assert.equal(new URL(page.url()).protocol, "tiki:");
  assert.equal(await page.evaluate(() => typeof process), "undefined");
  assert.equal(await page.evaluate(() => typeof require), "undefined");
  assert.equal(
    await page.evaluate(() => Array.isArray([...navigator.getGamepads()])),
    true,
  );
  assert.equal(await page.evaluate(() => window.electron), undefined);
  userData = await app.evaluate(({ app }) => app.getPath("userData"));
  assert.equal(userData, testUserData);
  await page.evaluate(() =>
    localStorage.setItem("electron.package.probe", "stable"),
  );
  assert.equal(
    await page.evaluate(() => window.open("https://example.com")),
    null,
  );
  await page.locator("#fullscreen-button").click();
  await page.waitForFunction(
    () => document.fullscreenElement === document.documentElement,
    null,
    { timeout: 5_000 },
  );
  await page.evaluate(() => document.exitFullscreen());
  await page.waitForFunction(() => document.fullscreenElement === null, null, {
    timeout: 5_000,
  });
  await waitForNativeFullscreen(app, false);
  mark("HTML fullscreen toggled");
  await app.evaluate(({ BrowserWindow }) => {
    globalThis.__tikiInputEvents = [];
    const win = BrowserWindow.getAllWindows()[0];
    win.focus();
    win.webContents.on("before-input-event", (_event, input) => {
      globalThis.__tikiInputEvents.push({
        code: input.code,
        key: input.key,
        type: input.type,
      });
    });
  });
  await page.bringToFront();
  // CDP keyboard events bypass Electron's before-input-event handler.
  // Send native input through Electron to exercise the shell shortcut.
  const pressF11 = () => app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.sendInputEvent({ type: "keyDown", keyCode: "F11" });
    contents.sendInputEvent({ type: "keyUp", keyCode: "F11" });
  });
  await pressF11();
  try {
    await waitForNativeFullscreen(app, true);
  } catch (error) {
    const inputs = await app.evaluate(() => globalThis.__tikiInputEvents);
    error.message += `; captured input=${JSON.stringify(inputs)}`;
    throw error;
  }
  await pressF11();
  await waitForNativeFullscreen(app, false);
  mark("F11 fullscreen toggled");
  await page.locator("#home-continue").click();
  await page.locator("#start-button").click();
  await page.keyboard.press("Space");
  await page.locator("#pause-button").click();
  await page.locator("#settings-button").click();
  assert.equal(
    await page.locator("#settings-dialog").evaluate((dialog) => dialog.open),
    true,
  );
  mark("gameplay and settings controls exercised");
  await page.locator("#close-settings").click();
  if (await page.locator("#game-overlay").isVisible())
    await page.locator("#start-button").click();
  const stabilityEnd = Date.now() + stabilityMs;
  let step = 0;
  while (Date.now() < stabilityEnd) {
    assert.equal(page.isClosed(), false, processLogs.join("\n"));
    if (await page.locator("#game-overlay").isVisible())
      await page.locator("#start-button").click();
    else if (step % 4 === 0) {
      await page.keyboard.down("KeyW");
      await page.keyboard.down("KeyD");
      await page.waitForTimeout(120);
      await page.keyboard.up("KeyD");
      await page.keyboard.up("KeyW");
    } else if (step % 4 === 1) {
      await page.keyboard.press("KeyB");
      await page.keyboard.press("Space");
    } else if (step % 4 === 2) {
      await page.keyboard.down("KeyE");
      await page.waitForTimeout(120);
      await page.keyboard.up("KeyE");
    } else await page.keyboard.press("Space");
    step++;
    await page.waitForTimeout(500);
  }
  mark("stability interval completed");
  assert.deepEqual(rendererErrors, []);
  await app.evaluate(async ({ BrowserWindow }) => {
    globalThis.__tikiNavigationAttempt = null;
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    contents.once("will-navigate", (event, url) => {
      globalThis.__tikiNavigationAttempt = {
        prevented: event.defaultPrevented,
        url,
      };
    });
    await contents.executeJavaScript(
      "setTimeout(() => { location.href = 'https://example.com/blocked'; }, 0); true",
    );
  });
  let navigationAttempt;
  for (let attempt = 0; attempt < 20; attempt++) {
    navigationAttempt = await app.evaluate(
      () => globalThis.__tikiNavigationAttempt,
    );
    if (navigationAttempt) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.deepEqual(navigationAttempt, {
    prevented: true,
    url: "https://example.com/blocked",
  });
  mark("renderer navigation denied");
} catch (error) {
  error.message += `\nElectron output:\n${processLogs.join("\n")}`;
  throw error;
} finally {
  expectedClose = true;
  await app.close();
}

expectedClose = false;
app = await launch();
try {
  const page = await app.firstWindow();
  page.setDefaultTimeout(5_000);
  await page.waitForSelector("#home-view:not([hidden])");
  assert.equal(
    await page.evaluate(() => localStorage.getItem("electron.package.probe")),
    "stable",
  );
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("userData")),
    userData,
  );
  assert.equal(
    processLogs.some((line) =>
      /unexpectedly|render-process-gone|crash/i.test(line),
    ),
    false,
    processLogs.join("\n"),
  );
  console.log(
    `✓ packaged Electron loads local assets securely and persists isolated data at ${userData}`,
  );
  console.log(
    "✓ packaged renderer has no Node bridge; navigation and new windows are denied",
  );
  console.log(
    "✓ UI fullscreen, F11, gameplay controls, and Gamepad API are available",
  );
  console.log(
    `✓ gameplay remained responsive for ${Math.round(stabilityMs / 1000)} seconds`,
  );
} catch (error) {
  error.message += `\nElectron output:\n${processLogs.join("\n")}`;
  throw error;
} finally {
  expectedClose = true;
  await app.close();
  await rm(testRoot, { recursive: true, force: true });
}
