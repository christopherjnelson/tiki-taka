// Capture screenshots for the README and documentation.
//
// Boots the static server against the current build (or builds first if dist/
// is absent), takes:
//   - desktop Home screen 1600x900
//   - desktop in-round gameplay mid-play
//   - phone portrait in-round (390x844, deviceScaleFactor 2)
//
// Output: docs/screenshots/{home,gameplay-desktop,gameplay-phone-portrait}.png
//
// Usage:
//   npm run build           # ensure an up-to-date dist/desktop/
//   npm run screenshots
//
// Or let the script build for you:
//   npm run screenshots     # runs build automatically if dist/desktop/ is missing

import { chromium } from "@playwright/test";
import { execFile } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { freePort } from "../tests/free-port.mjs";

const execFileAsync = promisify(execFile);

// Compress a PNG in place with pngquant if it is available.
async function optimizePng(filePath) {
  try {
    await execFileAsync("pngquant", [
      "--quality=70-85",
      "--force",
      "--output",
      filePath,
      filePath,
    ]);
  } catch {
    // pngquant not installed — skip silently
  }
}

const ROOT = new URL("..", import.meta.url);
const OUT = new URL("docs/screenshots/", ROOT);
await mkdir(OUT, { recursive: true });

// ------------------------------------------------------------------
// Ensure the static build exists
// ------------------------------------------------------------------
async function distExists() {
  try {
    await stat(new URL("dist/desktop/index.html", ROOT));
    return true;
  } catch {
    return false;
  }
}

if (!(await distExists())) {
  console.log("dist/desktop/ not found — running npm run build first…");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/build.mjs"], {
      cwd: fileURLToPath(ROOT),
      stdio: "inherit",
    });
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build failed (exit ${code})`))
    );
  });
}

// ------------------------------------------------------------------
// Start static server
// ------------------------------------------------------------------
const port = await freePort();
const baseURL = `http://localhost:${port}`;
const server = spawn(process.execPath, ["scripts/serve.mjs"], {
  cwd: fileURLToPath(ROOT),
  env: { ...process.env, PORT: String(port) },
  stdio: "ignore",
});

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
  }
  throw new Error(`Server at ${url} did not start`);
}

await waitForServer(baseURL);
console.log(`Server ready at ${baseURL}`);

const browser = await chromium.launch({ headless: true });

// ------------------------------------------------------------------
// Helper: navigate to arena, dismiss pre-round modal, let game run
// ------------------------------------------------------------------
async function gotoArenaAndRun(page, runMs = 2500) {
  await page.goto(`${baseURL}/`);
  await page.locator("#home-view").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("#title-play").click();
  await page.locator("#arena-view").waitFor({ state: "visible", timeout: 10000 });
  // Dismiss the pre-round invitation card — "Play the court" button (#start-button)
  const startBtn = page.locator("#start-button");
  try {
    await startBtn.waitFor({ state: "visible", timeout: 4000 });
    await startBtn.click();
  } catch {
    // Not visible yet or already gone
  }
  // Wait for the overlay card to be hidden (round is active)
  try {
    await page.locator("#overlay-card").waitFor({ state: "hidden", timeout: 5000 });
  } catch {}
  // Let the round run so players and ball are actively moving
  await page.waitForTimeout(runMs);
}

// ------------------------------------------------------------------
// 1. Desktop Home screen 1600x900
// ------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${baseURL}/`);
  await page.locator("#home-view").waitFor({ state: "visible", timeout: 10000 });
  // Brief pause for fonts/animations to settle
  await page.waitForTimeout(500);
  const path = fileURLToPath(new URL("home.png", OUT));
  await page.screenshot({ path, fullPage: false });
  await optimizePng(path);
  console.log(`Saved: docs/screenshots/home.png`);
  await context.close();
}

// ------------------------------------------------------------------
// 2. Desktop in-round gameplay 1600x900
// ------------------------------------------------------------------
{
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  await gotoArenaAndRun(page, 2500);
  const path = fileURLToPath(new URL("gameplay-desktop.png", OUT));
  await page.screenshot({ path, fullPage: false });
  await optimizePng(path);
  console.log(`Saved: docs/screenshots/gameplay-desktop.png`);
  await context.close();
}

// ------------------------------------------------------------------
// 3. Phone portrait in-round 390x844 @2x
// ------------------------------------------------------------------
{
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await gotoArenaAndRun(page, 2500);
  const path = fileURLToPath(new URL("gameplay-phone-portrait.png", OUT));
  await page.screenshot({ path, fullPage: false });
  await optimizePng(path);
  console.log(`Saved: docs/screenshots/gameplay-phone-portrait.png`);
  await context.close();
}

await browser.close();
server.kill();
console.log("Done.");
