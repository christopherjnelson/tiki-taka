import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { freePort } from './free-port.mjs';

const moduleName = process.env.PLAYWRIGHT_MODULE || '@playwright/test';
const playwright = await import(moduleName);
const browserName = process.env.BROWSER || 'chromium';
const browserType = playwright[browserName];
if (!browserType) throw new Error(`Unsupported BROWSER=${browserName}; use chromium, firefox, or webkit`);
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

async function waitForScore(page, previous = 0) {
  await page.waitForFunction(value => Number(document.querySelector('#score-value')?.textContent) > value, previous);
  return Number(await page.locator('#score-value').textContent());
}

async function focusSeconds(page) {
  return page.evaluate(() => window.__observedGame.game.focus);
}

async function waitForPassToSettle(page, previousPasses = 0) {
  await page.waitForFunction(count => {
    const game = window.__observedGame?.game;
    return game && game.passes > count && !game.ball && game.lock === 0 && game.passCooldown === 0;
  }, previousPasses);
}

async function pulsePad(page, button) {
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: true }), button);
  await page.waitForTimeout(80);
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: false }), button);
  await page.waitForTimeout(80);
}

async function observeGame(page) {
  await page.evaluate(async () => {
    const { Game } = await import('/src/game.js');
    window.__observedGame = { game: null, input: null, passes: [], movementX: 0, movementY: 0 };
    const update = Game.prototype.update;
    const pass = Game.prototype.pass;
    Game.prototype.update = function(dt, input) {
      window.__observedGame.game = this;
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
  await page.goto(`${baseURL}/#play`, { waitUntil: 'networkidle' });

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
  const emptyWidth = parseFloat(await page.locator('#focus-fill').evaluate(el => el.style.width));
  await page.waitForTimeout(650);
  assert.equal(await focusSeconds(page), 0, 'focus should not refill while idle');
  assert.equal(parseFloat(await page.locator('#focus-fill').evaluate(el => el.style.width)), emptyWidth);
  await page.locator('#focus-button').click();
  assert.equal(await page.locator('#focus-button').getAttribute('aria-pressed'), 'false');
  await expectText(page.locator('#toast'), /earn focus|wall pass|triangle|bonus zone/i);

  await page.keyboard.press('KeyB');
  assert.equal(await page.locator('#bank-button').getAttribute('aria-pressed'), 'true');
  const passesBeforeWall = await page.evaluate(() => window.__observedGame.game.passes);
  await page.locator('#court').focus();
  await page.keyboard.press('Space');
  await waitForPassToSettle(page, passesBeforeWall);
  assert.equal(await focusSeconds(page), 0.5, 'a completed wall pass should earn 0.5 seconds of focus');

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
  await expectText(page.locator('#overlay-kicker'), /ROUND COMPLETE|PERSONAL BEST/);
  await expectText(page.locator('#overlay-copy'), /points · \d+ passes · \d+ triangles · best one-touch \d+ · \+\d+ XP/);
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
  await page.goto(`${baseURL}/#play`);
  await page.clock.install();
  await page.locator('#start-button').click();
  await runRound(page, {
    steps: 180,
    async onStep() {
      const target = (await page.locator('#target-label').textContent())?.match(/→\s*([1-4])/);
      if (target) await page.keyboard.press(`Digit${target[1]}`);
    },
  });
  await expectText(page.locator('#overlay-kicker'), /COURT CLEARED/);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tiki-taka.progress.v1')));
  assert.equal(saved.unlocked, 1);
  assert.ok(saved.courts['0'].stars >= 1);
  assert.ok(saved.records['court-0'] >= 180);
  assert.equal(await page.locator('.court-item').nth(1).isDisabled(), false);
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
    await page.evaluate(() => Boolean(document.querySelector('#title-menu')?.contains(document.activeElement))),
    true,
    'title-screen navigation should stay inside the title menu',
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.classList.contains('pad-focus')),
    true,
    'gamepad focus should be visibly marked',
  );
  await page.goto(`${baseURL}/#play`);
  await page.waitForTimeout(150);
  await page.locator('#start-button').focus();
  await pulsePad(page, 0);
  assert.equal(await page.locator('#game-overlay').isHidden(), true, 'A should activate focused start');
  await observeGame(page);
  await pulsePad(page, 0);
  await waitForScore(page);
  await waitForPassToSettle(page);
  assert.equal(await focusSeconds(page), 0);
  const gamepadPasses = await page.evaluate(() => window.__observedGame.game.passes);
  await page.evaluate(() => window.__setTestPad({ button: 6, pressed: true }));
  await pulsePad(page, 2);
  assert.equal(await page.locator('#bank-button').getAttribute('aria-pressed'), 'true', 'X should arm the wall pass');
  assert.equal(await page.evaluate(() => window.__observedGame.game.passes), gamepadPasses, 'X alone should not complete a pass');
  await pulsePad(page, 0);
  await waitForPassToSettle(page, gamepadPasses);
  assert.equal(await page.locator('#bank-button').getAttribute('aria-pressed'), 'false', 'playing the armed wall pass should disarm it');
  assert.equal(await focusSeconds(page), 0.5, 'gamepad wall pass should earn focus');
  await page.waitForTimeout(150);
  assert.equal(await focusSeconds(page), 0.5, 'focus held while empty should require release before using later earnings');
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
  await pulsePad(page, 9);
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
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
  assert.deepEqual(menuButtons, ['pause-resume', 'pause-restart', 'pause-courts', 'pause-settings'],
    'the pause menu should offer resume, restart, courts and settings (quit is shell only)');
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
    ['pause-courts', 'pause-restart', 'pause-resume', 'pause-settings'],
    `paused d-pad should cycle only the pause menu, got ${JSON.stringify(visited)}`);
  const upFrom = visited.at(-1).id;
  await pulsePad(page, 12);
  assert.notEqual(await page.evaluate(() => document.activeElement?.id), upFrom, 'up on the d-pad should move too');
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('#pause-menu')?.contains(document.activeElement))), true);
  await pulsePad(page, 9);
  assert.equal(await page.locator('#pause-menu').isHidden(), true);
  await page.evaluate(() => window.__setTestPad({ connected: false }));
  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Controller disconnected'));
  await expectText(page.locator('#toast'), /Controller disconnected/);
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await expectText(page.locator('#pause-title'), /paused/i);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('portrait and landscape touch layouts remain usable without horizontal overflow', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${baseURL}/#play`);
  assert.equal(await page.locator('#joystick').isVisible(), true);
  assert.equal(await page.locator('#touch-pass').isVisible(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.locator('#start-button').tap();
  await observeGame(page);
  await page.locator('#touch-bank').tap();
  assert.equal(await page.locator('#touch-bank').getAttribute('aria-pressed'), 'true');
  await page.locator('#touch-pass').tap();
  await page.waitForFunction(() => document.querySelector('#touch-bank')?.getAttribute('aria-pressed') === 'false');
  await waitForPassToSettle(page);
  assert.equal(await focusSeconds(page), 0.5, 'touch wall pass should earn focus');
  const joystick = await page.locator('#joystick').boundingBox();
  assert.ok(joystick);
  await page.waitForFunction(() => !window.__observedGame.game.ball && window.__observedGame.game.lock === 0);
  const touchStart = await page.evaluate(() => window.__observedGame.movementX);
  const center = { x: joystick.x + joystick.width / 2, y: joystick.y + joystick.height / 2 };
  const cdp = browserName === 'chromium' ? await context.newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: center.x, y: center.y, id: 7 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: center.x + 34, y: center.y, id: 7 }] });
  } else {
    await page.locator('#joystick').evaluate(element => {
      // Synthetic PointerEvents do not enter Firefox's native active-pointer registry.
      element.setPointerCapture = () => {};
      element.releasePointerCapture = () => {};
    });
    await page.locator('#joystick').dispatchEvent('pointerdown', { pointerId: 7, pointerType: 'touch', clientX: center.x, clientY: center.y, buttons: 1 });
    await page.locator('#joystick').dispatchEvent('pointermove', { pointerId: 7, pointerType: 'touch', clientX: center.x + 34, clientY: center.y, buttons: 1 });
  }
  await page.waitForFunction(() => window.__observedGame.input?.x > .5);
  await page.waitForTimeout(250);
  const touchMoved = await page.evaluate(() => window.__observedGame.movementX);
  assert.ok(touchMoved > touchStart + 1, 'joystick drag should move the carrier');
  if (cdp) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  else await page.locator('#joystick').dispatchEvent('pointerup', { pointerId: 7, pointerType: 'touch', clientX: center.x + 34, clientY: center.y });
  await page.waitForFunction(() => Math.abs(window.__observedGame.input?.x || 0) < .05);
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
  await landscape.goto(`${baseURL}/#play`);
  assert.equal(await landscape.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
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
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${baseURL}/#play`, { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  // Play view hides the court heading, so read the arena's live labels instead.
  assert.match(await page.locator('#court-title').textContent(), /Courtyard/);
  await expectText(page.locator('#overlay-kicker'), /FOUR PLAYERS/i);
  await page.locator('#start-button').click();
  assert.equal(await page.locator('#game-overlay').isHidden(), true);
  // The soundtrack is precached with everything else, so it plays offline too.
  await page.waitForFunction(() => document.body.dataset.music !== 'unavailable');
  assert.deepEqual(errors, []);
  await context.setOffline(false);
  await context.close();
}


await check('losing possession holds the round until a fresh button press', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = watchErrors(page);
  await page.goto(`${baseURL}/#play`);
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
  // Any fresh key resumes.
  await page.waitForTimeout(350);
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
  await page.waitForTimeout(350);
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
  await page.goto(`${baseURL}/#play`);
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
  await page.waitForTimeout(200);
  const withTarget = await page.locator('#court').evaluate(c => c.toDataURL());
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#court-wrap').getAttribute('data-target'), '',
    'a paused round selects nobody');
  assert.equal(await page.evaluate(() => window.__targets.at(-1)), null);
  await page.locator('#pause-menu').evaluate(el => (el.style.display = 'none'));
  await page.waitForTimeout(120);
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
