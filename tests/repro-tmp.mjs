import { chromium } from '@playwright/test';

const baseURL = process.argv[2];
const throttleRate = Number(process.argv[3] || '1');
const useOldBound = process.argv[4] === 'old';
const trials = Number(process.argv[5] || '1');
const attempts = Number(process.argv[6] || '30');

const throttleRaf = (intervalMs) => {
  const real = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = (cb) => real((now) => {
    if (now - last < intervalMs) {
      window.requestAnimationFrame(cb);
      return;
    }
    last = now;
    cb(now);
  });
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

const isDpad = button => button >= 12 && button <= 15;
async function pulsePad(page, button, hold = isDpad(button) ? 80 : 250) {
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: true }), button);
  await page.waitForTimeout(hold);
  await page.evaluate(index => window.__setTestPad({ button: index, pressed: false }), button);
  await page.waitForTimeout(hold);
}
async function padUntil(page, button, ready, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await ready()) return true;
    await pulsePad(page, button);
  }
  return await ready();
}

let passes = 0, fails = 0;
const browser = await chromium.launch({ headless: true });
for (let trial = 0; trial < trials; trial++) {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  await context.addInitScript(installPad);
  if (throttleRate > 1) await context.addInitScript(throttleRaf, throttleRate * 16.7);
  const page = await context.newPage();
  await page.goto(`${baseURL}/`);
  await page.waitForFunction(() => document.activeElement?.id === 'title-play', null, { timeout: 20000, polling: 100 });
  try {
    if (useOldBound) {
      let inBar = false;
      for (let step = 0; step < 8 && !inBar; step++) {
        await pulsePad(page, 12);
        inBar = await page.evaluate(() => Boolean(document.getElementById('top-bar')?.contains(document.activeElement)));
      }
      if (!inBar) throw new Error('never reached top bar');
      let onSettings = await page.evaluate(() => document.activeElement?.id === 'settings-button');
      for (let step = 0; step < 8 && !onSettings; step++) {
        await pulsePad(page, 15);
        onSettings = await page.evaluate(() => document.activeElement?.id === 'settings-button');
      }
      const id = await page.evaluate(() => document.activeElement?.id);
      if (id !== 'settings-button') throw new Error(`old bound: landed on '${id}', not settings-button`);
    } else {
      await padUntil(page, 12, () => page.evaluate(() => Boolean(document.getElementById('top-bar')?.contains(document.activeElement))), attempts);
      const inBar = await page.evaluate(() => Boolean(document.getElementById('top-bar')?.contains(document.activeElement)));
      if (!inBar) throw new Error('never reached top bar');
      await padUntil(page, 15, () => page.evaluate(() => document.activeElement?.id === 'settings-button'), attempts);
      const id = await page.evaluate(() => document.activeElement?.id);
      if (id !== 'settings-button') throw new Error(`new bound: landed on '${id}', not settings-button`);
    }
    passes++;
    console.log(`trial ${trial}: PASS`);
  } catch (err) {
    fails++;
    console.log(`trial ${trial}: FAIL - ${err.message}`);
  }
  await context.close();
}
await browser.close();
console.log(`\n${passes}/${trials} passed, ${fails}/${trials} failed (throttle=${throttleRate}x, bound=${useOldBound ? 'old(8)' : `new(padUntil ${attempts})`})`);
