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
        version: 2,
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
  // With no Supabase configuration (scripts/serve.mjs never sets
  // import.meta.env, so this is the default here), there is no account
  // system at all: the header chip and the settings-dialog entry point are
  // both hidden rather than offered disabled, and guest progress still saves
  // and reloads on its own.
  await page.goto(baseURL);
  assert.equal(await page.locator("#xp-label").textContent(), "30 / 80 XP");
  assert.equal(await page.locator("#profile-button").isVisible(), false);
  await page.locator("#settings-button").click();
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#sound-button").textContent(), "Sound off");
  await page.locator("#sound-button").click();
  assert.equal(await page.locator("#sound-button").textContent(), "Sound on");
  await page.locator("#close-settings").click();
  await page.reload();
  assert.equal(await page.locator("#xp-label").textContent(), "30 / 80 XP");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
  assert.equal(await page.locator("#profile-button").isVisible(), false);
  await page.locator("#settings-button").click();
  await page.locator("#settings-dialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#sound-button").textContent(), "Sound on");
  await page.locator("#close-settings").click();
  console.log(
    "✓ with no Supabase configuration, no account UI is offered and guest progress saves and reloads",
  );

  const accountPage = await browser.newPage({ serviceWorkers: "block" });
  await accountPage.addInitScript(() => {
    const bindings = {
      moveUp: ["KeyW", "ArrowUp"], moveDown: ["KeyS", "ArrowDown"],
      moveLeft: ["KeyA", "ArrowLeft"], moveRight: ["KeyD", "ArrowRight"],
      smartPass: ["Space"], direct1: ["Digit1"], direct2: ["Digit2"],
      direct3: ["Digit3"], direct4: ["Digit4"], wallToggle: ["KeyB"],
      wallHold: ["ShiftLeft"], focusHold: ["KeyE"], boostHold: ["KeyR"],
      shout: ["KeyF"], pause: ["Escape"],
    };
    const data = () => ({
      progress: { version: 2, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: "balanced", lastCourt: 0 },
      settings: { theme: "dark", effectsOn: true, effectsVolume: 0.3, musicOn: true, musicVolume: 1, audioMigrated: true, preset: "wasd", bindings },
      stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 },
      preferences: { scoreSaveChoice: "ask" },
    });
    window.__scoreAdapter = { profile: null, preference: "ask", rounds: [] };
    window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
      kind: "supabase",
      async getSession() { return window.__scoreAdapter.profile ? { profile: window.__scoreAdapter.profile } : null; },
      async loadUserData() { const next = data(); next.preferences.scoreSaveChoice = window.__scoreAdapter.preference; if (window.__scoreAdapter.deferLoads) return new Promise((resolve) => window.__scoreAdapter.loadResolvers.push(() => resolve(next))); if (window.__scoreAdapter.failInitialLoad) { window.__scoreAdapter.failInitialLoad = false; throw new Error("Offline"); } return next; },
      async saveUserData(update) { if (update.preferences) window.__scoreAdapter.preference = update.preferences.scoreSaveChoice; return data(); },
      async register({ email, username }) { window.__scoreAdapter.profile = { id: "player-1", email, username, authMode: "supabase" }; return window.__scoreAdapter.profile; },
      async login({ identifier }) { window.__scoreAdapter.profile = { id: "player-1", email: identifier, username: "FlowPlayer", authMode: "supabase" }; return window.__scoreAdapter.profile; },
      async logout() { window.__scoreAdapter.profile = null; },
      async recordRound(round) { if (window.__scoreAdapter.failNextRound) { window.__scoreAdapter.failNextRound = false; window.__scoreAdapter.failedId = round.id; throw new Error("Network unavailable"); } window.__scoreAdapter.rounds.push(round); return { games: window.__scoreAdapter.rounds.length, bestScore: round.score, totalPasses: round.passes, bestOneTouch: round.bestOneTouch }; },
      async getLeaderboard() { return { entries: [] }; },
      onAuthStateChange() { return () => {}; },
    });
  });
  await accountPage.goto(baseURL);
  await accountPage.waitForFunction(() => window.__TIKI_TAKA_TEST_HOOKS__);
  await accountPage.evaluate(() => window.__TIKI_TAKA_TEST_HOOKS__.finishRound());
  await accountPage.waitForFunction(() => document.querySelector("#score-save-dialog").open);
  assert.equal(await accountPage.locator("#score-save-always").isVisible(), true);
  await accountPage.locator("#score-save-always").click();
  await accountPage.waitForFunction(() => document.querySelector("#account-dialog").open);
  await accountPage.locator("#register-email").fill("flow@example.com");
  await accountPage.locator("#register-username").fill("FlowPlayer");
  await accountPage.locator("#register-password").fill("correct-password-1");
  await accountPage.locator("#register-form button").click();
  await accountPage.waitForFunction(() => window.__scoreAdapter.rounds.length === 1);
  assert.equal(await accountPage.evaluate(() => window.__scoreAdapter.preference), "always");
  const firstId = await accountPage.evaluate(() => window.__scoreAdapter.rounds[0].id);
  await accountPage.evaluate(() => window.__TIKI_TAKA_TEST_HOOKS__.finishRound());
  await accountPage.waitForFunction(() => window.__scoreAdapter.rounds.length === 2);
  assert.notEqual(await accountPage.evaluate(() => window.__scoreAdapter.rounds[1].id), firstId);
  assert.equal(await accountPage.locator("#score-save-dialog").evaluate((el) => el.open), false);
  await accountPage.evaluate(() => {
    window.__scoreAdapter.preference = "ask";
    window.__TIKI_TAKA_TEST_HOOKS__.setScoreSaveChoice("ask");
    window.__TIKI_TAKA_TEST_HOOKS__.prepareRound();
    window.__TIKI_TAKA_TEST_HOOKS__.finishRound();
  });
  await accountPage.waitForFunction(() => document.querySelector("#score-save-dialog").open);
  await accountPage.locator("#score-save-later").click();
  assert.equal(await accountPage.evaluate(() => window.__scoreAdapter.preference), "ask");
  await accountPage.evaluate(() => {
    window.__TIKI_TAKA_TEST_HOOKS__.prepareRound();
    window.__TIKI_TAKA_TEST_HOOKS__.finishRound();
  });
  await accountPage.waitForFunction(() => document.querySelector("#score-save-dialog").open);
  await accountPage.locator("#score-save-never").click();
  assert.equal(await accountPage.evaluate(() => window.__scoreAdapter.preference), "never");
  await accountPage.evaluate(() => {
    window.__scoreAdapter.preference = "ask";
    window.__TIKI_TAKA_TEST_HOOKS__.setScoreSaveChoice("ask");
    window.__scoreAdapter.failNextRound = true;
    window.__TIKI_TAKA_TEST_HOOKS__.prepareRound();
    window.__TIKI_TAKA_TEST_HOOKS__.finishRound();
  });
  await accountPage.waitForFunction(() => document.querySelector("#score-save-dialog").open);
  await accountPage.locator("#score-save-always").click();
  await accountPage.waitForFunction(() => document.querySelector("#score-save-status").textContent.includes("could not be saved"));
  assert.equal(await accountPage.evaluate(() => window.__scoreAdapter.rounds.length), 2);
  await accountPage.locator("#score-save-always").click();
  await accountPage.waitForFunction(() => window.__scoreAdapter.rounds.length === 3);
  assert.equal(await accountPage.evaluate(() => window.__scoreAdapter.rounds[2].id), await accountPage.evaluate(() => window.__scoreAdapter.failedId));
  assert.equal(await accountPage.evaluate(() => window.__scoreAdapter.preference), "always");
  await accountPage.evaluate(() => {
    window.__scoreAdapter.failNextRound = true;
    window.__TIKI_TAKA_TEST_HOOKS__.prepareRound();
    window.__TIKI_TAKA_TEST_HOOKS__.finishRound();
  });
  await accountPage.waitForFunction(() => document.querySelector("#toast").textContent.includes("retry"));
  const autoRetryId = await accountPage.evaluate(() => window.__scoreAdapter.failedId);
  await accountPage.evaluate(() => {
    window.__TIKI_TAKA_TEST_HOOKS__.prepareRound();
    window.__TIKI_TAKA_TEST_HOOKS__.finishRound();
  });
  await accountPage.waitForFunction(() => window.__scoreAdapter.rounds.some((round) => round.id === window.__scoreAdapter.failedId));
  assert.equal(await accountPage.evaluate((id) => window.__scoreAdapter.rounds.filter((round) => round.id === id).length, autoRetryId), 1);
  await accountPage.evaluate(() => { window.__scoreAdapter.deferLoads = true; window.__scoreAdapter.loadResolvers = []; });
  const race = await accountPage.evaluate(() => {
    const hooks = window.__TIKI_TAKA_TEST_HOOKS__;
    const older = hooks.switchContext({ id: "older", email: "older@example.com", username: "Older", authMode: "supabase" });
    const newer = hooks.switchContext({ id: "newer", email: "newer@example.com", username: "Newer", authMode: "supabase" });
    return { pending: window.__scoreAdapter.loadResolvers.length };
  });
  assert.equal(race.pending, 2);
  await accountPage.evaluate(() => {
    window.__scoreAdapter.loadResolvers[1]();
    window.__scoreAdapter.loadResolvers[0]();
  });
  await accountPage.waitForFunction(() => document.querySelector("#profile-chip-name").textContent === "Newer");
  const offlinePage = await browser.newPage({ serviceWorkers: "block" });
  await offlinePage.addInitScript(() => {
    const bindings = Object.fromEntries(["moveUp", "moveDown", "moveLeft", "moveRight", "smartPass", "direct1", "direct2", "direct3", "direct4", "wallToggle", "wallHold", "focusHold", "boostHold", "shout", "pause"].map((key) => [key, []]));
    const fallback = { progress: { version: 2, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: "balanced", lastCourt: 0 }, settings: { theme: "dark", effectsOn: true, effectsVolume: 0.3, musicOn: true, musicVolume: 1, audioMigrated: true, preset: "wasd", bindings }, stats: { games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 }, preferences: { scoreSaveChoice: "ask" } };
    window.__offlineAdapter = { online: false, rounds: [] };
    window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
      kind: "supabase",
      async getSession() { return { profile: { id: "offline", email: "offline@example.com", username: window.__offlineAdapter.online ? "Recovered" : "Offline", authMode: "supabase" } }; },
      async loadUserData() { if (!window.__offlineAdapter.online) throw new Error("offline"); return { ...fallback, progress: { ...fallback.progress, xp: 77 }, preferences: { scoreSaveChoice: "always" } }; },
      async saveUserData() { throw new Error("offline"); },
      async register() {}, async login() {}, async logout() {}, async recordRound(round) { if (!window.__offlineAdapter.online) throw new Error("offline"); window.__offlineAdapter.rounds.push(round); return fallback.stats; },
      onAuthStateChange() { return () => {}; },
    });
  });
  await offlinePage.goto(baseURL);
  await offlinePage.waitForFunction(() => document.querySelector("#profile-chip-name").textContent === "Offline");
  assert.equal(await offlinePage.locator("#register-password-row").evaluate((el) => el.hidden), false);
  await offlinePage.locator("#settings-button").click();
  await offlinePage.locator("#account-button").click();
  assert.match(await offlinePage.locator("#account-note").textContent(), /temporarily unavailable/);
  await offlinePage.locator("#account-dialog").evaluate((dialog) => dialog.close());
  await offlinePage.evaluate(() => {
    window.__TIKI_TAKA_TEST_HOOKS__.setScoreSaveChoice("always");
    window.__TIKI_TAKA_TEST_HOOKS__.finishRound();
  });
  await offlinePage.waitForFunction(() => document.querySelector("#toast").textContent.includes("retry"));
  await offlinePage.evaluate(() => { window.__offlineAdapter.online = true; window.dispatchEvent(new Event("online")); });
  await offlinePage.waitForFunction(() => window.__offlineAdapter.rounds.length === 1);
  assert.equal(await offlinePage.locator("#profile-chip-name").textContent(), "Recovered");
  assert.equal(await offlinePage.locator("#xp-label").textContent(), "7 / 80 XP");
  console.log("✓ remote bootstrap failure preserves the configured account adapter and offline identity");
  console.log("✓ Supabase account handoff saves one stable pending score and always-save persists");
} finally {
  await browser.close();
  if (server) server.kill();
}
