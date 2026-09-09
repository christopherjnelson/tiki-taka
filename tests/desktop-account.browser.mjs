import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { freePort } from "./free-port.mjs";

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE || "@playwright/test"
);
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
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
const executablePath = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  "/opt/google/chrome/chrome",
]
  .filter(Boolean)
  .map((candidate) => {
    try {
      return statSync(candidate).isDirectory()
        ? `${candidate}/chrome-headless-shell`
        : candidate;
    } catch {
      return candidate;
    }
  })
  .find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
const browser = await chromium.launch({ headless: true, executablePath });
try {
  const page = await browser.newPage({ serviceWorkers: "block" });
  await page.addInitScript(() =>
    localStorage.setItem(
      "tiki-taka.progress.v1",
      JSON.stringify({
        version: 1,
        xp: 180,
        unlocked: 0,
        courts: {},
        records: {},
        sound: false,
        tactic: "balanced",
        lastCourt: 0,
      }),
    ),
  );
  // The sidebar drawer that used to hold the profile button is gone: every
  // utility lives in the settings dialog now, so the dialog has to be open
  // before the profile button can be clicked.
  const openAccount = async () => {
    if (!(await page.locator("#settings-dialog").evaluate((el) => el.open)))
      await page.locator("#settings-button").click();
    await page.locator("#account-button").click();
  };
  await page.goto(baseURL);
  assert.equal(await page.locator("#xp-label").textContent(), "180 / 300 XP");
  await openAccount();
  await page.locator("#register-email").fill("demo@example.com");
  await page
    .locator("#register-username")
    .fill("<img src=x onerror=__injected=1>");
  await page.locator("#register-form button").click();
  await page.waitForFunction(
    () => !document.querySelector("#account-dialog").open,
  );
  assert.equal(await page.locator("#xp-label").textContent(), "0 / 300 XP");
  assert.equal(await page.locator("#account-button img").count(), 0);
  assert.equal(await page.evaluate(() => window.__injected), undefined);
  await openAccount();
  await page.locator("#logout-button").click();
  await page.waitForFunction(
    () => !document.querySelector("#account-dialog").open,
  );
  assert.equal(await page.locator("#xp-label").textContent(), "180 / 300 XP");
  console.log(
    "✓ local demo profile UI isolates guest progress and renders usernames as text",
  );
} finally {
  await browser.close();
  if (server) server.kill();
}
