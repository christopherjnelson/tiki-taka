import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { TRACK_FILES } from '../apps/desktop/src/playlist.js';
import { freePort } from './free-port.mjs';
import { gotoArena } from "./open-arena.mjs";

const moduleName = process.env.PLAYWRIGHT_MODULE || '@playwright/test';
const playwright = await import(moduleName);
const browserName = process.env.BROWSER || 'chromium';
const browserType = playwright[browserName];
if (!browserType) throw new Error(`Unsupported BROWSER=${browserName}; use chromium, firefox, or webkit`);
const includeMobileLayouts = process.env.MOBILE_LAYOUTS === '1';
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;
const outputDir = new URL('../test-results/', import.meta.url);
await mkdir(outputDir, { recursive: true });

let server;
try {
  const response = await fetch(baseURL);
  if (!response.ok) throw new Error(String(response.status));
} catch {
  const url = new URL(baseURL);
  server = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: url.port || '5173' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { if ((await fetch(baseURL)).ok) break; } catch {}
    if (attempt === 49) throw new Error(`Could not start test server at ${baseURL}`);
  }
}

const browserCandidates = [
  process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  browserName === 'chromium' ? '/opt/google/chrome/chrome' : undefined,
].filter(Boolean);
const executablePath = browserCandidates.find(candidate => {
  try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
});
const browser = await browserType.launch({ headless: process.env.HEADED !== '1', ...(executablePath && { executablePath }) });
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

function watchErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

async function expectText(locator, pattern, timeout = 5000) {
  await locator.waitFor({ state: 'visible', timeout });
  const text = await locator.textContent();
  assert.match(text || '', pattern);
}

// Under page.clock a round no longer resumes itself after a turnover, so a
// scripted run has to answer the prompt the way a player does. Returns once
// the round is over or the budget runs out.
async function runRound(page, { steps = 60, stepMs = 500, onStep } = {}) {
  for (let step = 0; step < steps; step++) {
    if (!(await page.locator('#game-overlay').isHidden())) return;
    if (await page.locator('#resume-prompt').isVisible()) {
      await page.clock.runFor(400);
      await page.keyboard.press('Space');
      await page.locator('#resume-prompt').waitFor({ state: 'hidden' });
    }
    if (onStep) await onStep();
    await page.clock.runFor(stepMs);
  }
}

async function waitForScore(page, previous = 0, timeout = 30000) {
  await page.waitForFunction(value => Number(document.querySelector('#score-value')?.textContent) > value, previous, { timeout });
  return Number(await page.locator('#score-value').textContent());
}

async function focusSeconds(page) {
  return page.evaluate(() => window.__observedGame.game.focus);
}

async function waitForPassToSettle(page, previousPasses = 0, timeout = 30000) {
  await page.waitForFunction(count => {
    const game = window.__observedGame?.game;
    return game && game.passes > count && !game.ball && game.lock === 0 && game.passCooldown === 0;
  }, previousPasses, { timeout });
}

// Button activation is edge-triggered (`tap()` compares against the previous
// poll) and polling happens once per animation frame. An 80ms press could begin
// and end between two frames on a slow runner and never be observed, which made
// this the only test failing in CI while passing locally. Hold long enough that
// several frames must see the press, then several more must see the release.
// Menu navigation is level-triggered and was never affected - and it must keep
// the short press, because holding a direction past the 0.2s repeat gate moves
// focus twice.
const isDpad = button => button >= 12 && button <= 15;
// The court repaints on a rAF loop whose rate collapses on a loaded runner, so
// waiting a fixed number of milliseconds can capture a stale frame - which is
// how two captures that must differ came back identical in CI. window.__targets
// grows once per rendered frame, so wait on real render progress, not a clock.
async function framesRendered(page, count, timeout = 20000) {
  const from = await page.evaluate(() => window.__targets.length);
  await page.waitForFunction(
    ([start, n]) => window.__targets.length >= start + n,
    [from, count],
    { timeout },
  );
}

async function pulsePad(page, button, hold = isDpad(button) ? 80 : 250) {
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: true }), button);
  await page.waitForTimeout(hold);
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: false }), button);
  await page.waitForTimeout(hold);
}

// A single pulsePad() can be the one that lands entirely between two polls
// (see above) and never register at all. `ready` is a bounded wait for the
// effect the press should cause; presses repeat, the way a real player would
// press again, until that effect is observed or attempts run out. Mirrors
// padUntil() in tests/audio.browser.mjs.
async function padUntil(page, button, ready, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await ready()) return true;
    await pulsePad(page, button);
  }
  return await ready();
}

// A pass in flight is not safe to retry into: doPass() queues a second pass
// on top of a first that is still travelling (game.ball ? queuePass : pass in
// apps/desktop/src/main.js), so pressing A again after a real accepted press
// would corrupt the very outcome being waited for. Confirm the press actually
// reached doPass - via observeGame's hook, which records every call
// synchronously in the same frame the input is read, so this check is never
// itself waiting out travel time - and only retry the press while that count
// has not moved. Once it has, the frame loop's dt clamp (50ms/frame, see
// apps/desktop/src/main.js) means a CPU-starved runner may still take a while
// to play the pass out, so give it a single generous, non-repeating wait.
async function passesRecorded(page) {
  return page.evaluate(() => window.__observedGame.passes.length);
}
async function pressUntilAccepted(page, button, attempts = 6) {
  const before = await passesRecorded(page);
  const registered = await padUntil(page, button,
    async () => (await passesRecorded(page)) > before, attempts);
  assert.equal(registered, true, `${button === 0 ? 'A' : `button ${button}`} should register with the game`);
}

async function observeGame(page) {
  await page.evaluate(async () => {
    const { Game } = await import('/src/game.js');
    window.__observedGame = { game: null, input: null, passes: [], movementX: 0, movementY: 0 };
    const update = Game.prototype.update;
    const pass = Game.prototype.pass;
    Game.prototype.update = function(dt, input) {
      // The title screen's attract demo is a Game too; this probe must follow
      // the player's round, not the one running behind the menu.
      if (!this.config.attract) window.__observedGame.game = this;
      window.__observedGame.input = { ...input };
      const carrier = this.carrier, before = { ...this.players[carrier] };
      const result = update.call(this, dt, input);
      if (this.carrier === carrier && this.players[carrier]) {
        window.__observedGame.movementX += this.players[carrier].x - before.x;
        window.__observedGame.movementY += this.players[carrier].y - before.y;
      }
      return result;
    };
    Game.prototype.pass = function(id, bank) {
      const accepted = pass.call(this, id, bank);
      window.__observedGame.passes.push({ id, bank: !!bank, accepted });
      return accepted;
    };
  });
  await page.waitForFunction(() => window.__observedGame?.game);
}

await check('desktop gameplay, controls, progression, help, and full run', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => localStorage.setItem('tiki-taka.progress.v1', JSON.stringify({
    version: 1, xp: 650, unlocked: 3, lastCourt: 2, tactic: 'maestro', sound: false,
    courts: { 0: { stars: 3, best: 520 }, 1: { stars: 2, best: 480 }, 2: { stars: 1, best: 460 } },
    records: { 'court-0': 520, 'court-1': 480, 'court-2': 460 },
  })));
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL, { waitUntil: 'networkidle' });

  assert.match(await page.locator('#level-label').textContent(), /LEVEL 3/);
  assert.equal(await page.locator('#court-title').textContent(), 'El Patio');
  assert.equal(await page.locator('#tactic-select').inputValue(), 'maestro');
  assert.equal(await page.locator('.court-item').nth(3).isDisabled(), false);
  assert.equal(await page.locator('.court-item').nth(4).isDisabled(), true);

  // The arena always presents Play view, and the pause menu is now the only
  // route to Settings, which is where the utility buttons live.
  assert.equal(await page.evaluate(() => document.body.classList.contains('play-view')), true);
  assert.equal(await page.locator('#sidebar-toggle').count(), 0, 'the navigation drawer is gone');
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await page.locator('#pause-settings').click();
  assert.equal(await page.locator('#settings-dialog').evaluate(dialog => dialog.open), true);
  await page.locator('#help-button').click();
  assert.equal(await page.locator('#help-dialog').evaluate(dialog => dialog.open), true);
  await expectText(page.locator('#help-dialog'), /Gamepad:.*left stick/s);
  await page.locator('#close-help').click();
  await page.locator('#close-settings').click();
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu').waitFor({ state: 'hidden' });

  await page.locator('#start-button').click();
  await observeGame(page);
  assert.equal(await page.locator('#focus-button').isVisible(), true);
  assert.equal(await page.locator('#boost-button').isVisible(), true);
  assert.equal(await page.locator('#shout-button').isVisible(), true);
  // Keep this round focused on input and exact Focus rewards, independent of
  // runner speed. Restarting below and the separate career test retain live AI.
  await page.evaluate(() => {
    const game = window.__observedGame.game;
    game.defenders = [];
    game.zone = { x: -1000, y: -1000, r: 1 };
    game.zoneTimer = Infinity;
  });
  assert.equal(await page.locator('#game-overlay').isHidden(), true);
  assert.equal(await page.locator('#tactic-select').isDisabled(), true);

  const playerBefore = await page.evaluate(() => ({ ...window.__observedGame.game.players[window.__observedGame.game.carrier] }));
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(350);
  await page.keyboard.up('ArrowRight');
  const playerAfter = await page.evaluate(() => ({ ...window.__observedGame.game.players[window.__observedGame.game.carrier] }));
  assert.ok(playerAfter.x > playerBefore.x + 10, `keyboard movement should move the carrier (${playerBefore.x} → ${playerAfter.x})`);

  assert.equal(await focusSeconds(page), 0, 'focus should start empty');
  const emptyWidth = parseFloat(await page.locator('#energy-fill').evaluate(el => el.style.width));
  await page.waitForTimeout(650);
  assert.equal(await focusSeconds(page), 0, 'focus should not refill while idle');
  assert.equal(parseFloat(await page.locator('#energy-fill').evaluate(el => el.style.width)), emptyWidth);
  await page.locator('#focus-button').click();
  assert.equal(await page.locator('#focus-button').getAttribute('aria-pressed'), 'false');
  await expectText(page.locator('#toast'), /earn energy|wall pass|triangle|bonus zone/i);

  await page.keyboard.press('KeyB');
  assert.equal(await page.locator('#bank-button').getAttribute('aria-pressed'), 'true');
  const passesBeforeWall = await page.evaluate(() => window.__observedGame.game.passes);
  await page.locator('#court').focus();
  await page.keyboard.press('Space');
  await waitForPassToSettle(page, passesBeforeWall);
  assert.equal(await focusSeconds(page), 0, 'a completed wall pass should not earn focus');
  await page.evaluate(() => { window.__observedGame.game.focus = 1.5; });

  const focusBefore = await focusSeconds(page);
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(400);
  await page.keyboard.up('KeyE');
  const focusAfter = await focusSeconds(page);
  assert.ok(focusAfter < focusBefore, `focus meter should drain (${focusBefore} → ${focusAfter})`);

  const keyboardTarget = await page.evaluate(() => {
    const game = window.__observedGame.game;
    return game.players.find(player => player.id !== game.carrier).id + 1;
  });
  await page.keyboard.press(`Digit${keyboardTarget}`);
  const keyboardScore = await waitForScore(page);
  await page.waitForFunction(() => !window.__observedGame.game.ball && window.__observedGame.game.lock === 0 && window.__observedGame.game.passCooldown === 0);
  await page.keyboard.press('KeyB');
  assert.equal(await page.locator('#bank-button').getAttribute('aria-pressed'), 'true');
  await page.locator('#court').focus();
  await page.keyboard.press('Space');
  await page.waitForFunction(() => window.__observedGame.passes.some(pass => pass.bank && pass.accepted));

  const box = await page.locator('#court').boundingBox();
  assert.ok(box);
  await page.waitForFunction(() => !window.__observedGame.game.ball && window.__observedGame.game.lock === 0 && window.__observedGame.game.passCooldown === 0);
  const teammate = await page.evaluate(() => {
    const game = window.__observedGame.game;
    return { ...game.players.find(player => player.id !== game.carrier) };
  });
  const passCount = await page.evaluate(() => window.__observedGame.passes.length);
  await page.mouse.click(box.x + box.width * teammate.x / 1000, box.y + box.height * teammate.y / 620);
  await page.waitForFunction(count => window.__observedGame.passes.length > count, passCount);
  const mousePass = await page.evaluate(() => window.__observedGame.passes.at(-1));
  assert.deepEqual(mousePass, { id: teammate.id, bank: false, accepted: true });
  assert.ok(Number(await page.locator('#score-value').textContent()) >= keyboardScore);

  await page.locator('#focus-button').click();
  assert.equal(await page.locator('#focus-button').getAttribute('aria-pressed'), 'true');
  await page.waitForFunction(() => document.querySelector('#focus-button')?.getAttribute('aria-pressed') === 'false');
  assert.equal(await focusSeconds(page), 0, 'focus should auto-toggle off when depleted');
  // The HUD pause button opens the same menu the pause key does.
  await page.locator('#pause-button').click();
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await expectText(page.locator('#pause-title'), /paused/i);
  assert.equal(await page.locator('#focus-button').getAttribute('aria-pressed'), 'false');
  await page.locator('#pause-resume').click();
  await page.locator('#pause-menu').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#game-overlay').isHidden(), true);
  // Restart from the pause menu returns to a fresh invitation card.
  await page.keyboard.press('Escape');
  await page.locator('#pause-restart').click();
  await expectText(page.locator('#overlay-title'), /Keep it beautiful/i);
  assert.equal(await page.locator('#score-value').textContent(), '000');

  await page.clock.install();
  await page.locator('#start-button').click();
  await runRound(page, { steps: 40, stepMs: 1000 });
  // Full time is a distinct result screen, with its outcome and match stats
  // visible before any action can take another input.
  await expectText(page.locator('#overlay-kicker'), /^(VICTORY · COURT CLEARED|DEFEAT · (POSSESSIONS LOST|TARGET MISSED))/);
  assert.match(await page.locator('#game-overlay').getAttribute('data-result'), /^(victory|defeat)$/);
  for (const selector of ['#result-score', '#result-passes', '#result-streak', '#result-xp'])
    assert.equal(await page.locator(selector).isVisible(), true, `${selector} is visible at full time`);
  const resultCard = await page.locator('#overlay-card').boundingBox();
  assert.ok(resultCard && resultCard.width * resultCard.height < 1440 * 1000 * .3,
    `the result card should occupy roughly a quarter-screen, got ${JSON.stringify(resultCard)}`);
  await page.clock.runFor(1200);
  // Both buttons on this overlay replay the court; they must say which is
  // which rather than leaving the player to guess.
  await expectText(page.locator('#start-button'), /^Retry$/);
  await expectText(page.locator('#secondary-button'), /^Change difficulty$/);
  await expectText(page.locator('#tertiary-button'), /^Home$/);
  assert.equal(
    await page.evaluate(() => [...document.querySelectorAll('#game-overlay button')].some(el => /courts/i.test(el.textContent))),
    false,
    'the round-end overlay must not offer "courts" now that home is the court picker',
  );
  assert.match(await page.locator('#result-score').textContent(), /^\d+$/);
  assert.match(await page.locator('#result-xp').textContent(), /^\+\d+$/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tiki-taka.progress.v1')));
  assert.ok(saved.xp > 650, 'finished run should persist awarded XP');
  await page.screenshot({ path: new URL('desktop.png', outputDir).pathname, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});

await check('a complete playable career run clears and unlocks the next court', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  await page.clock.install();
  await page.locator('#start-button').click();
  await runRound(page, {
    steps: 180,
    async onStep() {
      const target = (await page.locator('#target-label').textContent())?.match(/→\s*([1-4])/);
      if (target) await page.keyboard.press(`Digit${target[1]}`);
    },
  });
  await expectText(page.locator('#overlay-kicker'), /^VICTORY · COURT CLEARED/);
  assert.equal(await page.locator('#game-overlay').getAttribute('data-result'), 'victory');
  await expectText(page.locator('#result-cheer'), /COURT ERUPTS/);
  await page.clock.runFor(1200);
  // A cleared career court is the one case where the primary button advances
  // rather than replays, and it has to say so — this is exactly the "does it
  // replay, advance or abandon?" the old "Next court"/"Back to court" pair
  // left the player guessing at.
  await expectText(page.locator('#start-button'), /^Play the next court$/);
  await expectText(page.locator('#secondary-button'), /^Change difficulty$/);
  await expectText(page.locator('#tertiary-button'), /^Home$/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tiki-taka.progress.v1')));
  assert.equal(saved.unlocked, 1);
  // Stars and bests are tracked per difficulty tier now; the default
  // selection is Standard, so that is the tier this run's clear lands under.
  assert.ok(saved.courts['0'].standard.stars >= 1);
  assert.ok(saved.records['court-0-standard'] >= 180);
  assert.equal(await page.locator('.court-item').nth(1).isDisabled(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('Boost and Shout work through remappable keyboard controls and analog gamepad triggers', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const state = { connected: true, axes: [0, 0, 0, 0], values: Array(16).fill(0) };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => state.connected ? [{
      connected: true, index: 0, id: 'Analog controls gamepad', mapping: 'standard',
      axes: [...state.axes],
      buttons: state.values.map(value => ({ pressed: value >= 1, touched: value > 0, value })),
    }] : [] });
    window.__setAbilityPad = ({ button, value, axes }) => {
      if (button !== undefined) state.values[button] = value;
      if (axes) state.axes = axes;
    };
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  await page.locator('#start-button').click();
  await observeGame(page);
  await page.evaluate(() => {
    const game = window.__observedGame.game;
    game.focus = 2;
    game.zone = { x: 735, y: 430, r: 92 };
  });
  await page.locator('#focus-button').click();
  assert.equal(await page.locator('#focus-button').getAttribute('aria-pressed'), 'true');
  await page.locator('#boost-button').click();
  assert.equal(await page.locator('#focus-button').getAttribute('aria-pressed'), 'false', 'click controls are mutually exclusive');
  assert.equal(await page.locator('#boost-button').getAttribute('aria-pressed'), 'true');
  await page.locator('#boost-button').click();
  const focusBeforeKeyboardBoost = await focusSeconds(page);
  await page.keyboard.down('KeyR');
  await page.waitForFunction(() => window.__observedGame.input?.boost === true);
  await page.waitForTimeout(180);
  await page.keyboard.up('KeyR');
  assert.ok(await focusSeconds(page) < focusBeforeKeyboardBoost, 'R should hold Boost and consume Focus');

  await page.evaluate(() => window.__observedGame.game.focus = 2);
  const focusBeforeTriggerBoost = await focusSeconds(page);
  await page.evaluate(() => window.__setAbilityPad({ button: 7, value: 0.8 }));
  await page.waitForFunction(() => window.__observedGame.input?.boost === true);
  await page.waitForTimeout(180);
  await page.evaluate(() => window.__setAbilityPad({ button: 7, value: 0 }));
  assert.ok(await focusSeconds(page) < focusBeforeTriggerBoost, 'an analog RT pull should hold Boost');

  await page.evaluate(() => {
    const game = window.__observedGame.game;
    game.focus = 2;
    game.players[0].x = 250; game.players[0].y = 310;
    game.players[1].x = 500; game.players[1].y = 155;
    game.players[2].x = 770; game.players[2].y = 290;
    game.players[3].x = 510; game.players[3].y = 470;
  });
  await page.evaluate(() => window.__setAbilityPad({ axes: [0, 0, 1, 0] }));
  const target = await page.waitForFunction(() => {
    const value = document.querySelector('#court-wrap')?.dataset.target;
    return /^\d$/.test(value || '') ? Number(value) : null;
  });
  await page.evaluate(() => window.__setAbilityPad({ button: 5, value: 1 }));
  await page.waitForFunction(id => Boolean(window.__observedGame.game.players[id]?.shoutTarget), await target.jsonValue());
  await page.evaluate(() => window.__setAbilityPad({ button: 5, value: 0 }));
  await page.evaluate(id => { window.__observedGame.game.players[id].shoutTarget = null; }, await target.jsonValue());
  await page.keyboard.press('KeyF');
  await page.waitForFunction(id => Boolean(window.__observedGame.game.players[id]?.shoutTarget), await target.jsonValue());
  await page.evaluate(() => window.__setAbilityPad({ axes: [0, 0, 0, 0] }));
  assert.deepEqual(errors, []);
  await context.close();
});

await check('actual gamepad polling supports menus, play, focus, pause, and disconnect', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const state = { connected: true, axes: [0, 0, 0, 0], pressed: Array(16).fill(false) };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => state.connected ? [{
      connected: true, index: 0, id: 'Injected standards gamepad', mapping: 'standard',
      axes: [...state.axes], buttons: state.pressed.map(pressed => ({ pressed, touched: pressed, value: Number(pressed) })),
    }] : [] });
    window.__setTestPad = ({ button, pressed, axes, connected }) => {
      if (button !== undefined) state.pressed[button] = pressed;
      if (axes) state.axes = axes;
      if (connected !== undefined) state.connected = connected;
    };
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${baseURL}/`);
  await page.waitForTimeout(150);
  const firstFocus = await page.evaluate(() => document.activeElement?.textContent?.trim());
  await pulsePad(page, 13);
  const nextFocus = await page.evaluate(() => document.activeElement?.textContent?.trim());
  assert.notEqual(nextFocus, firstFocus, 'D-pad should move menu focus');
  assert.equal(
    await page.evaluate(() => Boolean(document.querySelector('#home-view')?.contains(document.activeElement))),
    true,
    'title-screen navigation should stay inside the home view',
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('pad-focus')),
    true,
    'gamepad focus should be visibly marked',
  );
  await gotoArena(page, baseURL);
  // Wait for the arena to actually be live before driving the pad: until the
  // view switches, pollGamepad is still in the title-menu branch and A
  // activates a menu item instead of the overlay's start button. A fixed wait
  // was long enough on a workstation and not on a CI runner.
  await page.locator('#game-overlay').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(
    () => !document.querySelector('#arena-view')?.hidden,
    null,
    { timeout: 10000 },
  );
  await page.locator('#start-button').focus();
  // Activation is edge-triggered and sampled once per animation frame. On a
  // CPU-starved runner the synthetic pad's press can sit entirely between two
  // polls, so a single press is not reliably observed - a real player would
  // simply press again. Retry a few times before calling it a failure, so this
  // still proves A starts the round rather than proving the runner is fast.
  let started = false;
  for (let attempt = 0; attempt < 6 && !started; attempt++) {
    await pulsePad(page, 0);
    started = await page.locator('#game-overlay').isHidden();
  }
  assert.equal(started, true, 'A should activate focused start');
  await observeGame(page);
  // A alone must complete a pass and move the score. One press can be the one
  // that lands entirely between two polls (see pulsePad above), so confirm it
  // registered - retrying only until it does, never after - then give the
  // resulting pass its own generous, un-retried travel time.
  await pressUntilAccepted(page, 0);
  await waitForScore(page, 0, 20000);
  await waitForPassToSettle(page, 0, 20000);
  assert.equal(await focusSeconds(page), 0);
  const gamepadPasses = await page.evaluate(() => window.__observedGame.game.passes);
  await page.evaluate(() => window.__setTestPad({ button: 6, pressed: true }));
  const armed = await padUntil(page, 2,
    () => page.locator('#bank-button').getAttribute('aria-pressed').then(v => v === 'true'));
  assert.equal(armed, true, 'X should arm the wall pass');
  assert.equal(await page.evaluate(() => window.__observedGame.game.passes), gamepadPasses, 'X alone should not complete a pass');
  await pressUntilAccepted(page, 0);
  await waitForPassToSettle(page, gamepadPasses, 20000);
  assert.equal(await page.locator('#bank-button').getAttribute('aria-pressed'), 'false', 'playing the armed wall pass should disarm it');
  assert.equal(await focusSeconds(page), 0, 'gamepad wall pass should not earn focus');
  await page.evaluate(() => { window.__observedGame.game.focus = 1.5; });
  await page.waitForTimeout(150);
  assert.equal(await focusSeconds(page), 1.5, 'focus held while empty should require release before using later earnings');
  await page.evaluate(() => window.__setTestPad({ button: 6, pressed: false }));
  await page.waitForTimeout(80);
  const focusBefore = await focusSeconds(page);
  await page.evaluate(() => window.__setTestPad({ button: 6, pressed: true, axes: [1, 0, 0, 0] }));
  await page.waitForTimeout(350);
  await page.evaluate(() => window.__setTestPad({ button: 6, pressed: false, axes: [0, 0, 0, 0] }));
  const focusAfter = await focusSeconds(page);
  assert.ok(focusAfter < focusBefore, 'LT should consume focus through the real animation poll');
  await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer.js');
    window.__renderAims = [];
    const render = Renderer.prototype.render;
    Renderer.prototype.render = function(game, options = {}) {
      window.__renderAims.push(options.aim ? { ...options.aim } : null);
      return render.call(this, game, options);
    };
  });
  await page.evaluate(() => window.__setTestPad({ axes: [1, -1, 0, 0] }));
  await page.waitForTimeout(250);
  const playingAims = await page.evaluate(() => window.__renderAims);
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 0, 0] }));
  assert.ok(playingAims.some(aim => aim && (aim.x || aim.y)),
    `the stick should aim the court while playing, got ${JSON.stringify(playingAims.slice(0, 5))}`);
  const paused = await padUntil(page, 9,
    () => page.locator('#pause-menu').waitFor({ state: 'visible', timeout: 4000 }).then(() => true, () => false));
  assert.equal(paused, true, 'Start should open the pause menu');
  await expectText(page.locator('#pause-title'), /paused/i);
  // A paused round must ignore the stick: no aim reaches the renderer, so the
  // court cannot keep repainting target lanes behind the pause menu.
  await page.evaluate(() => { window.__renderAims.length = 0; });
  await page.evaluate(() => window.__setTestPad({ axes: [1, -1, 1, -1] }));
  await page.waitForTimeout(300);
  const pausedAims = await page.evaluate(() => window.__renderAims);
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 0, 0] }));
  assert.ok(pausedAims.length > 3, `the paused court should still be rendering, got ${pausedAims.length} frames`);
  assert.equal(pausedAims.every(aim => aim === null), true,
    `stick movement while paused must not aim the court, got ${JSON.stringify(pausedAims.slice(0, 5))}`);
  const pausedMovement = await page.evaluate(() => window.__observedGame.movementX);
  await page.evaluate(() => window.__setTestPad({ axes: [1, 0, 0, 0] }));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.__observedGame.movementX), pausedMovement,
    'the stick must not move the carrier while paused');
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 0, 0] }));
  const menuButtons = await page.evaluate(() => [...document.querySelectorAll('#pause-menu button')]
    .filter(el => !el.disabled && !el.closest('[hidden]') && el.getClientRects().length).map(el => el.id));
  assert.deepEqual(menuButtons, ['pause-resume', 'pause-restart', 'pause-home', 'pause-settings'],
    'the pause menu should offer resume, restart, home and settings');
  await page.evaluate(() => document.activeElement?.blur());
  const visited = [];
  for (let step = 0; step < 4; step++) {
    await pulsePad(page, 13);
    visited.push(await page.evaluate(() => ({
      id: document.activeElement?.id,
      inMenu: Boolean(document.querySelector('#pause-menu')?.contains(document.activeElement)),
      marked: Boolean(document.activeElement?.classList.contains('pad-focus')),
    })));
  }
  assert.equal(visited.every(v => v.inMenu && v.marked), true,
    `paused d-pad focus must stay inside the pause menu, got ${JSON.stringify(visited)}`);
  assert.deepEqual([...new Set(visited.map(v => v.id))].sort(),
    ['pause-home', 'pause-restart', 'pause-resume', 'pause-settings'],
    `paused d-pad should cycle only the pause menu, got ${JSON.stringify(visited)}`);
  const upFrom = visited.at(-1).id;
  await pulsePad(page, 12);
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), upFrom, 'up on the d-pad should move too');
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('#pause-menu')?.contains(document.activeElement))), true);
  const resumed = await padUntil(page, 9,
    () => page.locator('#pause-menu').waitFor({ state: 'hidden', timeout: 4000 }).then(() => true, () => false));
  assert.equal(resumed, true, 'Start should close the pause menu');
  await page.evaluate(() => window.__setTestPad({ connected: false }));
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Controller disconnected'));
  await expectText(page.locator('#toast'), /Controller disconnected/);
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await expectText(page.locator('#pause-title'), /paused/i);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('full-time results consume early gamepad presses before revealing actions', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const state = { pressed: Array(16).fill(false) };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [{
      connected: true, index: 0, id: 'Injected standards gamepad', mapping: 'standard',
      axes: [0, 0, 0, 0],
      buttons: state.pressed.map(pressed => ({ pressed, touched: pressed, value: Number(pressed) })),
    }] });
    window.__setTestPad = ({ button, pressed }) => { state.pressed[button] = pressed; };
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  await page.locator('#start-button').click();
  await observeGame(page);
  await page.evaluate(() => {
    const overlay = document.querySelector('#game-overlay');
    const observer = new MutationObserver(() => {
      if (overlay.dataset.actions !== 'waiting') return;
      observer.disconnect();
      // Press on the first full-time frame, release only after the app has
      // polled that edge, then let it poll the release as a separate state.
      window.__setTestPad({ button: 0, pressed: true });
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          window.__setTestPad({ button: 0, pressed: false });
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              // Capture the state here, in the page, at the moment the pulse
              // finishes — not over a round-trip afterwards. The actions are
              // revealed on a 1200ms wall-clock timer (RESULT_ACTION_DELAY in
              // main.js), so querying them from the test after the fact races
              // that timer: on a loaded runner the reveal lands first and the
              // check reports the beat never happened. What is being tested is
              // that the press during the beat was swallowed, and that is
              // settled by now regardless of how slow the trip back is.
              window.__actionsHiddenDuringBeat =
                document.querySelector('#overlay-actions').hidden;
              window.__overlayVisibleDuringBeat =
                !document.querySelector('#game-overlay').hidden;
              window.__resultPulseComplete = true;
            }),
          );
        }),
      );
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['data-actions'] });
    const game = window.__observedGame.game;
    game.turnovers = 2;
    game.turnover('CAUGHT IN POSSESSION');
  });
  await page.locator('#game-overlay[data-result="defeat"]').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.__resultPulseComplete === true);
  assert.equal(await page.evaluate(() => window.__overlayVisibleDuringBeat), true,
    'A during the result beat must not replay the round');
  assert.equal(await page.evaluate(() => window.__actionsHiddenDuringBeat), true,
    'actions stay absent during the result beat');
  await page.locator('#game-overlay[data-actions="ready"]').waitFor({ state: 'visible', timeout: 4000 });
  assert.equal(await page.locator('#overlay-actions').isVisible(), true);
  const replayed = await padUntil(page, 0,
    () => page.locator('#game-overlay').isHidden());
  assert.equal(replayed, true, 'a fresh A after the reveal may replay');
  assert.deepEqual(errors, []);
  await context.close();
});

if (includeMobileLayouts) await check('portrait and landscape touch layouts remain usable without horizontal overflow', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.locator('#start-button').tap();
  await observeGame(page);
  // Checked after kick-off, not before it: the opening card is a full-screen
  // sheet on a phone and deliberately hides the round's controls while it is
  // up, so these are only meant to be on screen once a round is running.
  await page.waitForFunction(() => document.querySelector('#game-overlay')?.hidden === true);
  assert.equal(await page.locator('#joystick').isVisible(), true);
  assert.equal(await page.locator('#touch-pass').isVisible(), true);
  await page.locator('#touch-bank').tap();
  assert.equal(await page.locator('#touch-bank').getAttribute('aria-pressed'), 'true');
  await page.locator('#touch-pass').tap();
  await page.waitForFunction(() => document.querySelector('#touch-bank')?.getAttribute('aria-pressed') === 'false');
  await waitForPassToSettle(page);
  // A wall pass banks; it does not pay Energy. This asserted 0.5 Energy until
  // FOCUS_REWARDS.wall became 0, when Energy was restricted to Triangle, Zone
  // and Split — the assertion outlived the rule by several releases because
  // the mobile groups it lives in were frozen behind MOBILE_LAYOUTS. What the
  // check is actually for is that the touch Wall button arms and then fires a
  // real wall pass, so it now counts the bank the engine records.
  assert.equal(await page.evaluate(() => window.__observedGame.game.banks), 1, 'the touch Wall button should bank a pass off the boundary');
  const joystick = await page.locator('#joystick').boundingBox();
  assert.ok(joystick);
  await page.waitForFunction(() => !window.__observedGame.game.ball && window.__observedGame.game.lock === 0);
  const touchStart = await page.evaluate(() => window.__observedGame.movementX);
  const center = { x: joystick.x + joystick.width / 2, y: joystick.y + joystick.height / 2 };
  // Which way to push depends on the orientation, because the stick is read in
  // screen space and converted to the world by renderer.screenVectorToWorld():
  // in portrait the pitch is drawn rotated a quarter turn, so world +x (the
  // direction movementX below measures) is *down* the screen, not right. This
  // pushed right unconditionally and passed for as long as the court was always
  // landscape; once portrait actually rotated, the drag moved the carrier along
  // world y and input.x never rose, so the wait timed out. Pushing the way the
  // player sees the pitch run keeps the assertion measuring what it means to.
  const portrait = await page.evaluate(() => matchMedia('(orientation: portrait)').matches);
  const push = portrait ? { x: 0, y: 34 } : { x: 34, y: 0 };
  const cdp = browserName === 'chromium' ? await context.newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: center.x, y: center.y, id: 7 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: center.x + push.x, y: center.y + push.y, id: 7 }] });
  } else {
    await page.locator('#joystick').evaluate(element => {
      // Synthetic PointerEvents do not enter Firefox's native active-pointer registry.
      element.setPointerCapture = () => {};
      element.releasePointerCapture = () => {};
    });
    await page.locator('#joystick').dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: center.x, clientY: center.y, buttons: 1 });
    await page.locator('#joystick').dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: center.x + push.x, clientY: center.y + push.y, buttons: 1 });
  }
  await page.waitForFunction(() => window.__observedGame.input?.x > .5);
  await page.waitForTimeout(250);
  const touchMoved = await page.evaluate(() => window.__observedGame.movementX);
  assert.ok(touchMoved > touchStart + 1, 'joystick drag should move the carrier');
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.locator('#joystick').dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: center.x + push.x, clientY: center.y + push.y });
  await page.waitForFunction(() => Math.abs(window.__observedGame.input?.x || 0) < .05);
  // The wall pass above used to leave 0.5 Energy behind, and that is what made
  // Focus available to toggle here. Wall stopped paying Energy when rewards
  // were restricted to Triangle, Zone and Split, so Focus now has nothing to
  // spend and the button correctly refuses to arm. Grant the charge directly
  // rather than scripting a triangle: what this section is for is the touch
  // Focus button's wiring and its auto-toggle-off after a pass, not the
  // earning rules, which tests/game.test.mjs covers on the engine directly.
  await page.evaluate(() => { window.__observedGame.game.focus = 0.5; });
  await page.waitForFunction(() => !document.querySelector('#touch-focus')?.disabled);
  await page.locator('#touch-focus').tap();
  assert.equal(await page.locator('#touch-focus').getAttribute('aria-pressed'), 'true');
  await page.locator('#touch-bank').tap();
  const activePasses = await page.evaluate(() => window.__observedGame.game.passes);
  await page.locator('#touch-pass').tap();
  await waitForPassToSettle(page, activePasses);
  await page.waitForFunction(() => document.querySelector('#touch-focus')?.getAttribute('aria-pressed') === 'false');
  assert.equal(await focusSeconds(page), 0, 'touch focus should consume the earned charge and auto-toggle off');
  assert.equal(await page.evaluate(() => window.__observedGame.game.banks), 2);
  assert.equal(await focusSeconds(page), 0, 'a wall completed while focus was active should not earn focus');
  await page.screenshot({ path: new URL('mobile.png', outputDir).pathname, fullPage: true });

  assert.deepEqual(errors, []);
  await context.close();

  const landscapeContext = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const landscape = await landscapeContext.newPage();
  const landscapeErrors = watchErrors(landscape);
  await gotoArena(landscape, baseURL);
  assert.equal(await landscape.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  // Same as portrait above: the controls belong to a running round, and the
  // opening card covers the screen until one starts.
  await landscape.locator('#start-button').tap();
  await landscape.waitForFunction(() => document.querySelector('#game-overlay')?.hidden === true);
  assert.equal(await landscape.locator('#joystick').isVisible(), true);
  assert.equal(await landscape.locator('#touch-pass').isVisible(), true);
  const court = await landscape.locator('#court').boundingBox();
  assert.ok(court && court.x >= 0 && court.x + court.width <= 844.5, 'landscape court must fit the viewport');
  assert.deepEqual(landscapeErrors, []);
  await landscapeContext.close();
});

await check('service worker serves a complete app reload offline', async () => {
  // The only service worker the app ships is the one scripts/build.mjs generates
  // into dist/desktop, so this suite exercises the built output rather than the
  // raw dev sources.
  try {
    accessSync(new URL('../dist/desktop/sw.js', import.meta.url), constants.R_OK);
  } catch {
    throw new Error('dist/desktop/sw.js is missing; run `npm run build` before the browser suites');
  }
  const buildPort = Number(process.env.BUILD_PORT || await freePort());
  const buildURL = `http://localhost:${buildPort}`;
  const buildServer = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(buildPort), SERVE_DIR: 'dist/desktop' },
    stdio: 'ignore',
  });
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { if ((await fetch(buildURL)).ok) break; } catch {}
      if (attempt === 49) throw new Error(`Could not start build server at ${buildURL}`);
    }
    await offlineReload(buildURL);
  } finally {
    buildServer.kill();
  }
});

async function offlineReload(baseURL) {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  try {
    // Vite reads .env from the repository root, so a developer with Supabase
    // credentials configured builds a bundle that would boot the real adapter
    // here and call the live project. This check is about the service worker,
    // not accounts, so pin a guest adapter through the test-only seam: the
    // result must not depend on whether credentials happen to be present.
    await context.addInitScript(() => {
      const bindings = {
        moveUp: ['KeyW', 'ArrowUp'], moveDown: ['KeyS', 'ArrowDown'],
        moveLeft: ['KeyA', 'ArrowLeft'], moveRight: ['KeyD', 'ArrowRight'],
        smartPass: ['Space'], direct1: ['Digit1'], direct2: ['Digit2'],
        direct3: ['Digit3'], direct4: ['Digit4'], wallToggle: ['KeyB'],
        wallHold: ['ShiftLeft'], focusHold: ['KeyE'], boostHold: ['KeyR'],
        shout: ['KeyF'], pause: ['Escape'],
      };
      const stats = () => ({ games: 0, bestScore: 0, totalPasses: 0, bestOneTouch: 0 });
      const data = () => ({
        progress: { version: 1, xp: 0, unlocked: 0, courts: {}, records: {}, sound: true, tactic: 'balanced', lastCourt: 0 },
        settings: { theme: 'dark', effectsOn: true, effectsVolume: 0.3, musicOn: true, musicVolume: 1, audioMigrated: true, preset: 'wasd', bindings },
        stats: stats(),
        preferences: { scoreSaveChoice: 'ask' },
      });
      window.__TIKI_TAKA_TEST_DATA_ADAPTER_FACTORY__ = () => ({
        kind: 'local',
        async getSession() { return null; },
        async loadUserData() { return data(); },
        async saveUserData() { return data(); },
        async recordRound() { return stats(); },
        async getLeaderboard() { return { entries: [] }; },
        onAuthStateChange() { return () => {}; },
      });
    });
    const page = await context.newPage();
    const errors = watchErrors(page);
    await gotoArena(page, baseURL, { waitUntil: 'networkidle' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    await page.reload({ waitUntil: 'networkidle' });
    const trackPath = `/audio/${TRACK_FILES[0]}`;
    const onlineTrack = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
    }, trackPath);
    assert.equal(onlineTrack.ok, true, 'online audio fetch must succeed');
    const onlineTrackBytes = onlineTrack.bytes;
    await page.waitForFunction(
      async (path) => Boolean(await caches.match(path)),
      trackPath,
    );
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const offlineTrack = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { ok: response.ok, bytes: (await response.arrayBuffer()).byteLength };
    }, trackPath);
    assert.equal(offlineTrack.ok, true, 'a fetched track must remain available offline');
    assert.equal(offlineTrack.bytes, onlineTrackBytes);
    // A reload is a cold load, and cold loads open the title screen whatever
    // the hash says, so the way to the arena offline is the same menu a player
    // would use. That the menu renders at all is itself the precache working.
    await page.locator('#home-view').waitFor({ state: 'visible' });
    await page.locator('#title-play').click();
    await page.locator('#arena-view').waitFor({ state: 'visible' });
    // Play view hides the court heading, so read the arena's live labels instead.
    assert.match(await page.locator('#court-title').textContent(), /Courtyard/);
    // The kicker is the pre-round card's own copy, read here to prove the
    // offline reload served the real app and not a cached shell. It said
    // "FOUR PLAYERS. ONE BALL." until the card was reworked around the brand
    // line; what matters to this check is that some live kicker text arrives.
    await expectText(page.locator('#overlay-kicker'), /NO GOALS/i);
    await page.locator('#start-button').click();
    assert.equal(await page.locator('#game-overlay').isHidden(), true);
    // Audio is not install-time precached. The fetch above proves that the
    // worker retains a track for offline use after its first online request.
    assert.deepEqual(errors, []);
    await context.setOffline(false);
  } finally {
    // A failure here used to leave an offline context open for the rest of the
    // suite, which starved every test that ran after it.
    await context.close();
  }
}


await check('losing possession holds the round until a fresh button press', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  await page.locator('#start-button').click();
  await observeGame(page);
  // A key held from before the turnover must not dismiss the prompt: this is
  // exactly the "still pressing pass when I lost it" case.
  await page.keyboard.down('KeyW');
  await page.evaluate(() => window.__observedGame.game.turnover('PASS INTERCEPTED'));
  await page.locator('#resume-prompt').waitFor({ state: 'visible' });
  await expectText(page.locator('#resume-reason'), /INTERCEPTED/i);
  await page.waitForTimeout(450);
  assert.equal(await page.locator('#resume-prompt').isVisible(), true,
    'a key that was already down must not release the hold');
  // The round is genuinely frozen while it waits.
  const held = await page.evaluate(() => window.__observedGame.game.time);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(time => Math.abs(window.__observedGame.game.time - time) < 0.01, held), true,
    'the clock must not run while the round waits for the player');
  // The turnover message stays legible for as long as the hold lasts, instead
  // of timing out after 2.5s the way the live announcement banner does.
  await expectText(page.locator('#resume-reason'), /INTERCEPTED/i);
  await page.keyboard.up('KeyW');
  // Pausing on top of a hold works, and coming back returns to the hold.
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#resume-prompt').isHidden(), true,
    'the pause menu owns the screen while it is open');
  await page.locator('#pause-resume').click();
  await page.locator('#resume-prompt').waitFor({ state: 'visible' });
  // Any fresh key resumes. Wait on the hold gate itself, not a stopwatch:
  // holdElapsed accumulates clamped dt, so its rate depends on frame rate.
  await page.waitForFunction(() => document.body.dataset.resumeReady === "1", null, { timeout: 10000 });
  await page.keyboard.press('KeyW');
  await page.locator('#resume-prompt').waitFor({ state: 'hidden' });
  // The engine still plays out its own 1.2s reset after a turnover, during
  // which it holds the clock, so give the round long enough to come back.
  const resumed = await page.evaluate(() => window.__observedGame.game.time);
  await page.waitForFunction(time => window.__observedGame.game.time < time, resumed, { timeout: 5000 });
  assert.equal(await page.evaluate(() => window.__observedGame.game.lock), 0,
    'the engine reset finished once the round was live again');
  // A pointer press works too, for mouse and touch players.
  await page.evaluate(() => window.__observedGame.game.turnover('CAUGHT IN POSSESSION'));
  await page.locator('#resume-prompt').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.body.dataset.resumeReady === "1", null, { timeout: 10000 });
  await page.mouse.click(200, 400);
  await page.locator('#resume-prompt').waitFor({ state: 'hidden' });
  // The third turnover ends the round outright, so the finish overlay wins and
  // the hold never appears on top of it.
  await page.evaluate(() => {
    const game = window.__observedGame.game;
    game.turnovers = 2;
    game.turnover('CAUGHT IN POSSESSION');
  });
  await page.locator('#game-overlay').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#resume-prompt').isHidden(), true,
    'the end of a round must not leave a press-any-button prompt behind');
  assert.deepEqual(errors, []);
  await context.close();
});

await check('a turnover says its piece exactly once', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  // Every string the game draws on a canvas is recorded, which is how the
  // renderer's floating copy of the turnover text gets caught: it is painted
  // on the court, not in the DOM, so nothing else here would see it.
  await context.addInitScript(() => {
    window.__drawnText = [];
    const fillText = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, ...rest) {
      window.__drawnText.push(String(text));
      return fillText.call(this, text, ...rest);
    };
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  await page.locator('#start-button').click();
  await observeGame(page);
  // A milestone announcement is already on screen when possession is lost. The
  // hold has to take the screen over, not stack a bigger message on top of one
  // that is still sitting there.
  await page.evaluate(() => window.__observedGame.game.emit(
    'one-touch', 'THREE ONE-TOUCH PASSES', 500, 310, { milestone: true, streak: 3 }));
  await expectText(page.locator('#game-announcement'), /ONE-TOUCH/i);
  await page.evaluate(() => { window.__drawnText.length = 0; });
  await page.evaluate(() => window.__observedGame.game.turnover('PASS INTERCEPTED'));
  await page.locator('#resume-prompt').waitFor({ state: 'visible' });
  // Once, in the hold overlay — which is also the live region a screen reader
  // hears, since #resume-reason is role=status aria-live=assertive.
  await expectText(page.locator('#resume-reason'), /INTERCEPTED/i);
  await page.waitForTimeout(500);
  assert.equal((await page.locator('#game-announcement').textContent()).trim(), '',
    'the hold overlay owns the message, so the announcement strip must be empty');
  const painted = await page.evaluate(() => window.__drawnText.filter(text => /INTERCEPTED/i.test(text)));
  assert.deepEqual(painted, [],
    'the renderer must not float the same words across the court under the hold overlay');
  const shown = await page.evaluate(() => [...document.querySelectorAll('body *')]
    .filter(el => !el.children.length && /INTERCEPTED/i.test(el.textContent) && el.getClientRects().length)
    .map(el => el.id || el.className));
  assert.equal(shown.length, 1, `the turnover message must appear once, found ${JSON.stringify(shown)}`);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('the right stick picks the smart-pass target and marks it on the court', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    const state = { connected: true, axes: [0, 0, 0, 0], pressed: Array(16).fill(false) };
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => state.connected ? [{
      connected: true, index: 0, id: 'Injected standards gamepad', mapping: 'standard',
      axes: [...state.axes], buttons: state.pressed.map(pressed => ({ pressed, touched: pressed, value: Number(pressed) })),
    }] : [] });
    window.__setTestPad = ({ button, pressed, axes, connected }) => {
      if (button !== undefined) state.pressed[button] = pressed;
      if (axes) state.axes = axes;
      if (connected !== undefined) state.connected = connected;
    };
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await gotoArena(page, baseURL);
  await page.locator('#start-button').click();
  await observeGame(page);
  await page.evaluate(async () => {
    const { Renderer } = await import('/src/renderer.js');
    window.__targets = [];
    const render = Renderer.prototype.render;
    Renderer.prototype.render = function (game, options = {}) {
      window.__targets.push(options.target);
      return render.call(this, game, options);
    };
  });
  // Park the four players at known spots so aiming is deterministic, then sweep
  // the right stick around and collect which teammate A would pass to.
  await page.evaluate(() => {
    const game = window.__observedGame.game;
    game.carrier = 0;
    game.defenders = [];
    game.grace = 100;
    game.hold = 0;
    game.players[0].x = 500; game.players[0].y = 310;
    game.players[1].x = 500; game.players[1].y = 110;
    game.players[2].x = 850; game.players[2].y = 310;
    game.players[3].x = 500; game.players[3].y = 520;
  });
  const chosen = new Set();
  for (const axes of [[0, 0, 0, -1], [0, 0, 1, 0], [0, 0, 0, 1]]) {
    await page.evaluate(a => window.__setTestPad({ axes: a }), axes);
    await page.waitForTimeout(200);
    const target = await page.locator('#court-wrap').getAttribute('data-target');
    assert.match(target || '', /^[0-3]$/, `the stick must select a teammate, got ${target}`);
    chosen.add(target);
    // The renderer is told about the same player, so the lane preview and the
    // selection ring both point at it.
    assert.equal(await page.evaluate(() => window.__targets.at(-1)), Number(target));
    assert.match(await page.locator('#target-label').textContent(), new RegExp(`→\\s*${Number(target) + 1}`));
  }
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 0, 0] }));
  assert.ok(chosen.size >= 2,
    `sweeping the right stick must change the chosen teammate, got ${[...chosen].join()}`);
  // The highlight is painted onto the canvas, so a frame drawn with a target
  // must differ from one drawn without: pausing clears the selection.
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 1, 0] }));
  // Wait for the app to actually select a target, then for frames painted with
  // it, before sampling. The aim updates in pollGamepad but the highlight only
  // exists once renderer.render has drawn a frame carrying that target.
  await page.waitForFunction(
    () => Number.isInteger(window.__targets.at(-1)),
    null,
    { timeout: 20000 },
  );
  await framesRendered(page, 3);
  const withTarget = await page.locator('#court').evaluate(c => c.toDataURL());
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#court-wrap').getAttribute('data-target'), '',
    'a paused round selects nobody');
  assert.equal(await page.evaluate(() => window.__targets.at(-1)), null);
  await page.locator('#pause-menu').evaluate(el => (el.style.display = 'none'));
  await framesRendered(page, 3);
  const withoutTarget = await page.locator('#court').evaluate(c => c.toDataURL());
  await page.locator('#pause-menu').evaluate(el => (el.style.display = ''));
  assert.notEqual(withTarget, withoutTarget,
    'the selected teammate must be visibly marked on the court');
  assert.deepEqual(errors, []);
  await context.close();
});

await browser.close();
server?.kill();
if (failures) process.exitCode = 1;
else console.log('All browser smoke tests passed.');
