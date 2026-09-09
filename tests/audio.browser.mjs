// Audio: the browser's autoplay block and the hint that explains it, the two
// independent switches, and gamepad-operable volumes that survive a reload.
//
// Effects are counted rather than listened to: every effect voice is an
// OscillatorNode and the soundtrack is an AudioBufferSourceNode, so a count of
// createOscillator() calls is exactly "how many effects were played", with the
// music contributing nothing to it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { freePort } from './free-port.mjs';

const moduleName = process.env.PLAYWRIGHT_MODULE || '@playwright/test';
const playwright = await import(moduleName);
const baseURL = process.env.BASE_URL || `http://localhost:${await freePort()}`;

let server;
try {
  if (!(await fetch(baseURL)).ok) throw new Error('server unavailable');
} catch {
  const url = new URL(baseURL);
  server = spawn(process.execPath, ['scripts/serve.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: url.port || '5173' },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { if ((await fetch(baseURL)).ok) break; } catch {}
    if (attempt === 59) throw new Error(`Could not start test server at ${baseURL}`);
  }
}

const executablePath = [process.env.PLAYWRIGHT_EXECUTABLE_PATH, '/opt/google/chrome/chrome']
  .filter(Boolean)
  .find(candidate => {
    try { accessSync(candidate, constants.X_OK); return true; } catch { return false; }
  });
const launch = args => playwright.chromium.launch({
  headless: process.env.HEADED !== '1',
  ...(executablePath && { executablePath }),
  args,
});
// The default policy is what a player's browser does. The relaxed one covers a
// browser configured to allow autoplay without a user gesture, so both paths
// are asserted rather than reasoned about.
const browser = await launch([]);
const relaxedBrowser = await launch(['--autoplay-policy=no-user-gesture-required']);
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

const countEffects = () => {
  window.__audio = { oscillators: 0, contexts: [] };
  const Ctor = window.AudioContext;
  const created = Ctor.prototype.createOscillator;
  Ctor.prototype.createOscillator = function patched(...args) {
    window.__audio.oscillators++;
    return created.apply(this, args);
  };
  window.AudioContext = class CountedAudioContext extends Ctor {
    constructor(...args) {
      super(...args);
      window.__audio.contexts.push(this);
    }
  };
};

const installPad = () => {
  const state = { connected: true, axes: [0, 0, 0, 0], pressed: Array(16).fill(false) };
  Object.defineProperty(navigator, 'getGamepads', {
    configurable: true,
    value: () => state.connected ? [{
      connected: true, index: 0, id: 'Injected standards gamepad', mapping: 'standard',
      axes: [...state.axes],
      buttons: state.pressed.map(pressed => ({ pressed, touched: pressed, value: Number(pressed) })),
    }] : [],
  });
  window.__setTestPad = ({ button, pressed, axes, connected }) => {
    if (button !== undefined) state.pressed[button] = pressed;
    if (axes) state.axes = axes;
    if (connected !== undefined) state.connected = connected;
  };
};

async function pulsePad(page, button) {
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: true }), button);
  await page.waitForTimeout(80);
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: false }), button);
  await page.waitForTimeout(80);
}

const audioState = page => page.evaluate(() => ({
  hint: !document.getElementById('audio-hint').hidden,
  music: document.body.dataset.music,
  contexts: window.__audio.contexts.map(ctx => ctx.state),
  effects: window.__audio.oscillators,
}));

const errorsFor = page => {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
};

await check('a browser that blocks audio gets a hint, and one keypress clears both', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(countEffects);
  await context.addInitScript(installPad);
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  await page.waitForTimeout(700);
  const blocked = await audioState(page);
  assert.ok(blocked.contexts.length > 0, 'the shell should have built its audio contexts up front');
  assert.equal(blocked.contexts.every(state => state !== 'running'), true,
    `a browser should refuse to resume audio before a gesture, got ${JSON.stringify(blocked.contexts)}`);
  assert.equal(blocked.music, 'waiting');
  assert.equal(blocked.hint, true, 'a blocked title screen must say how to enable sound');
  assert.match(await page.locator('#audio-hint').textContent(), /press any key or click once/i);
  // A gamepad press retries the unlock harmlessly. In a real Chromium it is
  // not a user activation gesture and the context stays suspended; this
  // headless build is more permissive and does resume on it, so rather than
  // assert a policy the test environment does not share, assert the invariant
  // that has to hold either way: the hint is shown exactly when audio is not
  // running, never on a guess about why.
  await pulsePad(page, 13);
  await page.waitForTimeout(400);
  const afterPad = await audioState(page);
  assert.equal(afterPad.hint, afterPad.contexts.some(state => state !== 'running'),
    `the hint must track the real audio state, got ${JSON.stringify(afterPad)}`);
  // One real key does it, for both buses at once.
  await page.keyboard.press('KeyZ');
  await page.waitForFunction(() => document.body.dataset.music === 'playing', null, { timeout: 10_000 });
  const unblocked = await audioState(page);
  assert.equal(unblocked.hint, false, 'the hint must disappear the moment audio runs');
  assert.equal(unblocked.contexts.every(state => state === 'running'), true,
    `one gesture should resume every context, got ${JSON.stringify(unblocked.contexts)}`);
  assert.equal(await page.locator('#audio-hint').isVisible(), false);
  assert.deepEqual(errors, []);
  await context.close();
});

await check('the packaged autoplay policy never shows the hint', async () => {
  const context = await relaxedBrowser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(countEffects);
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  await page.waitForFunction(() => document.body.dataset.music === 'playing', null, { timeout: 10_000 });
  const state = await audioState(page);
  assert.equal(state.hint, false, 'audio that already works must never be advertised as broken');
  assert.equal(state.contexts.every(s => s === 'running'), true);
  assert.equal(await page.locator('#audio-hint').isVisible(), false,
    'the packaged shell needs no gesture, so the hint must not appear there');
  assert.deepEqual(errors, []);
  await context.close();
});

await check('each switch silences its own bus and leaves the other playing', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(countEffects);
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  // Opening settings by mouse is itself the gesture the browser wanted.
  await page.locator('#settings-button').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.body.dataset.music === 'playing', null, { timeout: 10_000 });
  assert.equal(await page.locator('#effects-button').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#music-button').getAttribute('aria-pressed'), 'true');

  // Effects off, music on: a pass must make no sound while the track runs on.
  await page.locator('#effects-button').click();
  assert.equal(await page.locator('#effects-button').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#effects-volume').isDisabled(), true,
    'a silenced bus should not offer a level to set');
  await page.locator('#close-settings').click();
  await page.locator('#title-play').click();
  await page.locator('#start-button').click();
  await page.locator('#game-overlay').waitFor({ state: 'hidden' });
  const before = (await audioState(page)).effects;
  await page.keyboard.press('Space');
  await page.waitForTimeout(700);
  const muted = await audioState(page);
  assert.equal(muted.effects, before, `a pass with effects off must play no voice, got ${muted.effects - before}`);
  assert.equal(muted.music, 'playing', 'the soundtrack must keep playing when only effects are off');

  // And the other way round.
  await page.keyboard.press('Escape');
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  await page.locator('#pause-settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
  await page.locator('#effects-button').click();
  await page.locator('#music-button').click();
  assert.equal(await page.locator('#effects-button').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#music-button').getAttribute('aria-pressed'), 'false');
  await page.waitForFunction(() => document.body.dataset.music === 'muted', null, { timeout: 10_000 });
  await page.locator('#close-settings').click();
  await page.locator('#pause-resume').click();
  await page.locator('#pause-menu').waitFor({ state: 'hidden' });
  const resumed = (await audioState(page)).effects;
  await page.keyboard.press('Space');
  await page.waitForFunction(count => window.__audio.oscillators > count, resumed, { timeout: 10_000 });
  assert.equal((await audioState(page)).music, 'muted',
    'the soundtrack must stay off while effects play');
  // Silencing both is still one press on the master mute.
  await page.keyboard.press('Escape');
  await page.locator('#pause-settings').click();
  await page.locator('#sound-button').click();
  assert.equal(await page.locator('#sound-button').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#effects-button').getAttribute('aria-pressed'), 'false');
  assert.equal(await page.locator('#music-button').getAttribute('aria-pressed'), 'false');
  // Unmuting restores the shape it silenced rather than turning everything on.
  await page.locator('#sound-button').click();
  assert.equal(await page.locator('#effects-button').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#music-button').getAttribute('aria-pressed'), 'false',
    'unmuting must not switch on a bus the player had deliberately turned off');
  assert.deepEqual(errors, []);
  await context.close();
});

await check('the volumes are reachable and operable by gamepad and survive a reload', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(countEffects);
  await context.addInitScript(installPad);
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  await page.waitForTimeout(200);
  assert.equal(await page.locator('#effects-volume').inputValue(), '30',
    'effects should default well below the ceiling the constants set');
  assert.equal(await page.locator('#music-volume').inputValue(), '100');

  // Reach Settings from the title menu with the d-pad only, then open it with A.
  for (let step = 0; step < 8 && await page.evaluate(() => document.activeElement?.id) !== 'settings-button'; step++)
    await pulsePad(page, 13);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-button',
    'the d-pad must reach Settings on the title menu');
  await pulsePad(page, 0);
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });

  // And reach the effects slider inside the dialog the same way.
  let reached = false;
  for (let step = 0; step < 30 && !reached; step++) {
    await pulsePad(page, 13);
    reached = await page.evaluate(() => document.activeElement?.id === 'effects-volume');
  }
  assert.equal(reached, true, 'the d-pad must reach the effects volume slider');
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('pad-focus')), true,
    'the focused slider must be marked so a controller player can see it');

  // Right raises it, left lowers it, and the readout follows.
  await page.evaluate(() => window.__setTestPad({ button: 15, pressed: true }));
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__setTestPad({ button: 15, pressed: false }));
  const raised = Number(await page.locator('#effects-volume').inputValue());
  assert.ok(raised > 30, `d-pad right should raise the effects volume, got ${raised}`);
  await page.evaluate(() => window.__setTestPad({ button: 14, pressed: true }));
  await page.waitForTimeout(900);
  await page.evaluate(() => window.__setTestPad({ button: 14, pressed: false }));
  const lowered = Number(await page.locator('#effects-volume').inputValue());
  assert.ok(lowered < raised, `d-pad left should lower the effects volume, got ${lowered}`);
  assert.equal(await page.locator('#effects-volume-value').textContent(), `${lowered}%`,
    'the readout must follow the slider');
  // Left and right on a slider adjust it instead of walking the dialog.
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'effects-volume');

  // The music slider is reachable from there too, and takes the left stick.
  reached = false;
  for (let step = 0; step < 12 && !reached; step++) {
    await pulsePad(page, 13);
    reached = await page.evaluate(() => document.activeElement?.id === 'music-volume');
  }
  assert.equal(reached, true, 'the d-pad must reach the music volume slider');
  await page.evaluate(() => window.__setTestPad({ axes: [-1, 0, 0, 0] }));
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 0, 0] }));
  const music = Number(await page.locator('#music-volume').inputValue());
  assert.ok(music < 100, `the left stick should lower the music volume, got ${music}`);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tiki-taka.settings.v1')));
  assert.equal(Math.round(stored.effectsVolume * 100), lowered, 'the effects level must be written down');
  assert.equal(Math.round(stored.musicVolume * 100), music, 'the music level must be written down');

  await page.reload();
  await page.waitForTimeout(300);
  assert.equal(Number(await page.locator('#effects-volume').inputValue()), lowered,
    'the effects level must survive a reload');
  assert.equal(Number(await page.locator('#music-volume').inputValue()), music,
    'the music level must survive a reload');
  assert.equal(await page.locator('#effects-volume-value').textContent(), `${lowered}%`);
  assert.deepEqual(errors, []);
  await context.close();
});

await browser.close();
await relaxedBrowser.close();
if (server) server.kill();
if (failures) {
  console.error(`${failures} audio check(s) failed`);
  process.exit(1);
}
console.log('All audio checks passed.');
