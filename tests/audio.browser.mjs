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
import { afterFrames, waitForGame, pulsePad, padUntil } from './wait.mjs';

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
  // Wait for the app to have actually built its audio contexts before
  // reading them, rather than guessing how long boot takes.
  await waitForGame(page, () => window.__audio?.contexts.length > 0, null,
    { timeout: 10000, message: 'the shell should have built its audio contexts up front' });
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
  // wall-clock: this only checks an invariant between two fields read in the
  // same evaluate() call (the hint tracks whatever the contexts' real state
  // is, whatever that state happens to be at read time), so it cannot be
  // made to fail by how many frames ran while waiting - it is giving the pad
  // press above room to be polled and possibly resume audio, not timing a
  // specific outcome.
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

await check('a relaxed autoplay policy never shows the hint', async () => {
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
  // wall-clock: proving effects stay off and music keeps playing holds
  // regardless of how many frames actually ran in this window.
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
  // Wait for the home view rather than a fixed boot delay before reading the
  // sliders' defaults.
  await page.locator('#home-view').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#effects-volume').inputValue(), '30',
    'effects should default well below the ceiling the constants set');
  assert.equal(await page.locator('#music-volume').inputValue(), '100');

  // Reach Settings from the home screen with the d-pad only, then open it with A.
  // Under the home zone model (apps/desktop/src/pad-zones.mjs), a zone's own
  // data-pad-axis decides which direction walks it: #top-bar is
  // data-pad-axis="row" in index.html, a real horizontal strip of buttons, so
  // once focus is inside it up/down hops back OUT to a neighbouring zone and
  // only left/right steps along the bar. (This used to be one flat list where
  // any direction repeated eventually reached everything; that assumption is
  // deliberately gone under zones — do not "fix" this back to a single
  // up-only walk, it would just re-break.) The action zone holds only
  // #title-play, fewer than two focusables, so it has no axis of its own and
  // any direction leaves it immediately: one UP is enough to land in the bar.
  //
  // In this test's own environment (no Supabase config, so #profile-button
  // stays hidden; 1200px wide, so #top-home is JS-reparented out past
  // #settings-button by syncHomePlacement() in main.js, and .music-more is
  // CSS-hidden above the 901px breakpoint) padFocusables' visible order for
  // the bar is: music-prev, music-toggle, music-skip, fullscreen-button,
  // settings-button — landing on music-prev needs 4 RIGHT presses to reach
  // Settings, the floor. Use padUntil (defined above), not a fixed-count
  // loop: as tests/browser.mjs:538 notes, activation is edge-sampled once per
  // animation frame, so a short synthetic pulse can land entirely between two
  // polls and simply not register on a slow runner — a fixed count that only
  // covers the floor with a little slack (the previous bound of 8 against a
  // floor of 4) is exactly what broke in CI. padUntil re-checks before every
  // press and retries until it lands, so give it real headroom instead of a
  // tight multiple.
  await padUntil(page, 12, () =>
    page.evaluate(() => Boolean(document.getElementById('top-bar')?.contains(document.activeElement))), 30);
  assert.equal(
    await page.evaluate(() => Boolean(document.getElementById('top-bar')?.contains(document.activeElement))),
    true, 'the d-pad must reach the top bar');
  await padUntil(page, 15, () =>
    page.evaluate(() => document.activeElement?.id === 'settings-button'), 30);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'settings-button',
    'the d-pad must reach Settings by walking the top bar with left/right');
  await padUntil(page, 0, () => page.locator('#settings-dialog').isVisible());
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
  // The slider only moves as the held d-pad is polled once per animation
  // frame, so wait for it to have actually risen rather than a fixed slice
  // of wall time.
  await waitForGame(page, () => Number(document.getElementById('effects-volume').value) > 30, null,
    { timeout: 10000, message: 'd-pad right should raise the effects volume' });
  await page.evaluate(() => window.__setTestPad({ button: 15, pressed: false }));
  const raised = Number(await page.locator('#effects-volume').inputValue());
  assert.ok(raised > 30, `d-pad right should raise the effects volume, got ${raised}`);
  await page.evaluate(() => window.__setTestPad({ button: 14, pressed: true }));
  await waitForGame(page, (before) => Number(document.getElementById('effects-volume').value) < before, raised,
    { timeout: 10000, message: 'd-pad left should lower the effects volume' });
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
  // The slider only moves as the held stick is polled once per animation
  // frame, so wait for it to have actually dropped rather than a fixed
  // slice of wall time.
  await waitForGame(page, () => Number(document.getElementById('music-volume').value) < 100, null,
    { timeout: 10000, message: 'the left stick should lower the music volume' });
  await page.evaluate(() => window.__setTestPad({ axes: [0, 0, 0, 0] }));
  const music = Number(await page.locator('#music-volume').inputValue());
  assert.ok(music < 100, `the left stick should lower the music volume, got ${music}`);

  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('tiki-taka.settings.v1')));
  assert.equal(Math.round(stored.effectsVolume * 100), lowered, 'the effects level must be written down');
  assert.equal(Math.round(stored.musicVolume * 100), music, 'the music level must be written down');

  await page.reload();
  // Wait for the settings values to have actually been re-applied to the
  // sliders after boot rather than a fixed reload delay.
  await waitForGame(page, (value) => Number(document.getElementById('effects-volume').value) === value, lowered,
    { timeout: 10000, message: 'the effects level should survive a reload' });
  assert.equal(Number(await page.locator('#effects-volume').inputValue()), lowered,
    'the effects level must survive a reload');
  assert.equal(Number(await page.locator('#music-volume').inputValue()), music,
    'the music level must survive a reload');
  assert.equal(await page.locator('#effects-volume-value').textContent(), `${lowered}%`);
  assert.deepEqual(errors, []);
  await context.close();
});

// The pass sound cannot be listened to from a test, so it is measured. The
// graph is rendered through an OfflineAudioContext with the real Sound class
// and the real master gain, and the numbers stand in for the ear: a body whose
// pitch falls away, a short bright transient, a length in thud territory, and
// the same loudness as the other effects with headroom left at trim 1.0.
await check('the kick renders as a pitch-dropping thud at the same level as the other effects', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  const measured = await page.evaluate(async () => {
    const { Sound } = await import('/src/audio.js');
    const sampleRate = 44100;
    const render = async (volume, play) => {
      const ctx = new OfflineAudioContext(1, sampleRate * 0.5, sampleRate);
      const sound = new Sound(true, volume);
      sound.context = ctx;
      play(sound);
      return (await ctx.startRendering()).getChannelData(0);
    };
    const analyse = data => {
      let peak = 0, sum = 0;
      for (const v of data) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
      // A naive DFT over every other sample: 256 bins to 8kHz is more than a
      // spectral centroid needs, and it saves pulling in an FFT.
      let num = 0, den = 0;
      for (let bin = 1; bin <= 256; bin++) {
        const f = (bin * 8000) / 256;
        let re = 0, im = 0;
        for (let n = 0; n < data.length; n += 2) {
          const a = (2 * Math.PI * f * n) / sampleRate;
          re += data[n] * Math.cos(a);
          im -= data[n] * Math.sin(a);
        }
        const mag = Math.hypot(re, im);
        num += f * mag;
        den += mag;
      }
      const db = v => 20 * Math.log10(v || 1e-9);
      return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / data.length)), centroid: den ? num / den : 0 };
    };
    // Frequency from the spacing between upward zero crossings rather than a
    // count per window: at 55Hz a short window holds barely one cycle, and
    // counting would quantise the sweep away.
    const pitchAt = (data, from, span) => {
      const marks = [];
      const start = Math.round(from * sampleRate), end = Math.round((from + span) * sampleRate);
      for (let i = start + 1; i < end; i++)
        if (data[i - 1] <= 0 && data[i] > 0)
          marks.push(i - 1 + data[i - 1] / (data[i - 1] - data[i]));
      if (marks.length < 2) return 0;
      return sampleRate / ((marks.at(-1) - marks[0]) / (marks.length - 1));
    };
    const kick = await render(0.3, sound => sound.play('kick'));
    const hot = await render(1, sound => sound.play('kick'));
    const wall = await render(0.3, sound => sound.play('wall'));
    let length = kick.length;
    while (length > 0 && Math.abs(kick[length - 1]) < 1e-4) length--;
    return {
      kick: analyse(kick),
      wall: analyse(wall),
      hotPeakDb: analyse(hot).peakDb,
      lengthMs: (length / sampleRate) * 1000,
      early: pitchAt(kick, 0, 0.03),
      late: pitchAt(kick, 0.08, 0.06),
    };
  });
  assert.ok(measured.early > measured.late + 30,
    `the kick's body must fall in pitch, got ${measured.early.toFixed(0)}Hz then ${measured.late.toFixed(0)}Hz`);
  assert.ok(measured.late > 40 && measured.late < 80,
    `the kick should settle near 55Hz, got ${measured.late.toFixed(0)}Hz`);
  assert.ok(measured.lengthMs > 110 && measured.lengthMs < 170,
    `a thud is over quickly, got ${measured.lengthMs.toFixed(0)}ms`);
  // A struck ball is brighter than the wall-pass tone (the transient) but
  // nowhere near a click: keep it in that band.
  assert.ok(measured.kick.centroid > measured.wall.centroid,
    `the kick needs its noise transient, got centroid ${measured.kick.centroid.toFixed(0)}Hz`);
  assert.ok(measured.kick.centroid < 1400,
    `the kick must stay a thud, not a click, got centroid ${measured.kick.centroid.toFixed(0)}Hz`);
  assert.ok(Math.abs(measured.kick.peakDb - measured.wall.peakDb) < 3,
    `the kick must sit at the other effects' level, got ${measured.kick.peakDb.toFixed(1)} vs ${measured.wall.peakDb.toFixed(1)} dBFS`);
  assert.ok(measured.kick.peakDb < -18 && measured.kick.peakDb > -28,
    `effects peak around -22 dBFS at the default trim, got ${measured.kick.peakDb.toFixed(1)}`);
  assert.ok(measured.hotPeakDb < -1,
    `the kick must not clip with the trim at 1.0, got ${measured.hotPeakDb.toFixed(1)} dBFS`);
  assert.deepEqual(errors, []);
  await context.close();
});

// The sampled-effect path, with no sample files in the tree: a decoded buffer
// must play through the same effects master (so the switch and the slider
// govern it), and a sample that cannot be loaded must leave the synthesised
// voice in place rather than going silent or throwing.
await check('a sampled effect plays through the effects master, and a missing one falls back', async () => {
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  const result = await page.evaluate(async () => {
    const { Sound } = await import('/src/audio.js');
    const sampleRate = 44100;
    const peakOf = data => {
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v));
      return peak;
    };
    const render = async (volume, prepare, play) => {
      const ctx = new OfflineAudioContext(1, sampleRate * 0.5, sampleRate);
      const sound = new Sound(true, volume);
      sound.context = ctx;
      let oscillators = 0;
      const made = ctx.createOscillator.bind(ctx);
      ctx.createOscillator = (...args) => { oscillators++; return made(...args); };
      await prepare(sound, ctx);
      play(sound);
      const data = (await ctx.startRendering()).getChannelData(0);
      return { peak: peakOf(data), oscillators };
    };
    // A real 16-bit WAV built in the page and served by a stubbed fetch: this
    // walks the whole path the dropped-in files will walk — fetch, decode,
    // cache, play — without committing an audio file to the tree.
    const wav = seconds => {
      const frames = Math.round(sampleRate * seconds);
      const bytes = new ArrayBuffer(44 + frames * 2);
      const view = new DataView(bytes);
      const ascii = (offset, text) => {
        for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
      };
      ascii(0, 'RIFF');
      view.setUint32(4, 36 + frames * 2, true);
      ascii(8, 'WAVEfmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, 1, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * 2, true);
      view.setUint16(32, 2, true);
      view.setUint16(34, 16, true);
      ascii(36, 'data');
      view.setUint32(40, frames * 2, true);
      for (let i = 0; i < frames; i++)
        view.setInt16(44 + i * 2, Math.round(0.5 * Math.sin((2 * Math.PI * 300 * i) / sampleRate) * 32767), true);
      return bytes;
    };
    const withSample = (name, gain = 1) => async sound => {
      const real = window.fetch;
      window.fetch = async () => new Response(wav(0.2), { status: 200 });
      try {
        sound.useSamples([{ name, url: '/public/audio/effects/stand-in.wav', gain }]);
        await sound.loadSamples();
      } finally {
        window.fetch = real;
      }
    };
    const sampled = await render(0.3, withSample('kick'), s => s.play('kick'));
    const trimmed = await render(0.15, withSample('kick'), s => s.play('kick'));
    const perSample = await render(0.3, withSample('kick', 0.5), s => s.play('kick'));
    const disabled = await render(0.3, async sound => {
      await withSample('kick')(sound);
      sound.enabled = false;
    }, s => s.play('kick'));
    // A URL that will not load: the decode fails, the entry is marked dead and
    // the synthesised kick plays instead.
    const missing = await render(0.3, async (sound) => {
      sound.useSamples([{ name: 'kick', url: '/public/audio/effects/not-here.ogg' }]);
      await sound.loadSamples();
    }, s => s.play('kick'));
    return {
      sampled: sampled.peak,
      sampledOscillators: sampled.oscillators,
      trimmed: trimmed.peak,
      perSample: perSample.peak,
      disabled: disabled.peak,
      missing: missing.peak,
      missingOscillators: missing.oscillators,
    };
  });
  assert.ok(result.sampled > 0.1,
    `a registered sample must be heard, got peak ${result.sampled}`);
  assert.equal(result.sampledOscillators, 0,
    'a sample replaces the synthesised voice rather than doubling it');
  assert.ok(Math.abs(result.trimmed - result.sampled / 2) < 0.01,
    `the effects slider must trim samples, got ${result.trimmed} against ${result.sampled}`);
  assert.ok(Math.abs(result.perSample - result.sampled / 2) < 0.01,
    `a per-sample gain must trim that one sample, got ${result.perSample}`);
  assert.equal(result.disabled, 0, 'the effects switch must silence samples too');
  assert.ok(result.missing > 0.001 && result.missingOscillators > 0,
    `a sample that cannot load must fall back to the synthesised effect, got peak ${result.missing}`);
  // A 404 for the absent sample is expected; nothing else is.
  assert.deepEqual(errors.filter(entry => !/not-here\.ogg|404/.test(entry)), []);
  await context.close();
});

// What the court's ambience is driven by. The reading has to be a real number
// while a track is audible and null whenever there is nothing to measure, and
// null is what tells the ambience to fall back to its idle animation instead
// of freezing on a stale value.
await check('the music bus reports its energy while playing and null when there is nothing to measure', async () => {
  const context = await relaxedBrowser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  const result = await page.evaluate(async () => {
    const { createMusic } = await import('/apps/desktop/src/music.js');
    const { TRACKS } = await import('/apps/desktop/src/playlist.js');
    const music = createMusic({
      tracks: TRACKS.slice(0, 1),
      resolve: track => new URL(`/public/audio/${track.file}`, location.origin).href,
    });
    const silent = music.energy;
    music.setEnabled(true);
    music.unlock();
    // The bus fades in over 350ms and a track has quiet moments, so this
    // waits for a settled reading rather than grabbing the first one.
    let playing = null;
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const reading = music.energy;
      if (typeof reading === 'number' && reading > 0) { playing = reading; break; }
      if (playing === null && reading !== null) playing = reading;
    }
    const state = music.state;
    music.setEnabled(false);
    await new Promise(resolve => setTimeout(resolve, 500));
    return { silent, playing, muted: music.energy, state };
  });
  assert.equal(result.silent, null, 'nothing is playing yet, so there is nothing to measure');
  assert.equal(result.state, 'playing', `the track should be running, got ${result.state}`);
  assert.equal(typeof result.playing, 'number',
    `a playing track must report a number, got ${result.playing}`);
  assert.ok(result.playing > 0 && result.playing <= 1,
    `the reading must be a 0..1 energy, got ${result.playing}`);
  assert.equal(result.muted, null, 'a muted bus must report null so the ambience idles');
  assert.deepEqual(errors, []);
  await context.close();
});

await check('holding Focus slows the source and dulls the filter, releasing restores both, and neither sticks after the round ends', async () => {
  const context = await relaxedBrowser.newContext({ viewport: { width: 1200, height: 850 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = errorsFor(page);
  await page.goto(`${baseURL}/`);
  const result = await page.evaluate(async () => {
    const { createMusic } = await import('/apps/desktop/src/music.js');
    const { TRACKS } = await import('/apps/desktop/src/playlist.js');

    // Capture the real BiquadFilterNode/BufferSourceNode music.js creates, so
    // the assertions below read actual Web Audio param values rather than a
    // flag invented for the test.
    window.__musicGraph = { filters: [], sources: [] };
    const makeFilter = AudioContext.prototype.createBiquadFilter;
    AudioContext.prototype.createBiquadFilter = function patchedFilter(...args) {
      const node = makeFilter.apply(this, args);
      window.__musicGraph.filters.push(node);
      return node;
    };
    const makeSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function patchedSource(...args) {
      const node = makeSource.apply(this, args);
      window.__musicGraph.sources.push(node);
      return node;
    };

    const music = createMusic({
      tracks: TRACKS.slice(0, 1),
      resolve: track => new URL(`/public/audio/${track.file}`, location.origin).href,
    });
    music.setEnabled(true);
    music.unlock();

    // The ramps run on the Web Audio clock (120ms), independent of animation
    // frames, so this polls real elapsed time rather than a frame condition -
    // there is nothing frame-based to wait on here.
    const until = async (predicate, timeoutMs) => {
      const start = performance.now();
      while (performance.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return predicate();
    };
    const lastFilter = () => window.__musicGraph.filters.at(-1);
    const lastSource = () => window.__musicGraph.sources.at(-1);

    await until(() => music.state === 'playing', 20_000);
    const openRate = lastSource().playbackRate.value;
    const openFreq = lastFilter().frequency.value;

    music.setFocus(true);
    await until(() => lastSource().playbackRate.value < 0.85, 2000);
    await until(() => lastFilter().frequency.value < 1500, 2000);
    const focusedRate = lastSource().playbackRate.value;
    const focusedFreq = lastFilter().frequency.value;

    music.setFocus(false);
    await until(() => lastSource().playbackRate.value > 0.95, 2000);
    await until(() => lastFilter().frequency.value > 10_000, 2000);
    const releasedRate = lastSource().playbackRate.value;
    const releasedFreq = lastFilter().frequency.value;

    // Hold Focus again, then release it the way syncHud does when the round
    // stops being "playing" (paused or finished) - nothing should stay stuck.
    music.setFocus(true);
    await until(() => lastSource().playbackRate.value < 0.85, 2000);
    music.setFocus(false);
    await until(() => lastSource().playbackRate.value > 0.95, 2000);
    await until(() => lastFilter().frequency.value > 10_000, 2000);
    const afterEndRate = lastSource().playbackRate.value;
    const afterEndFreq = lastFilter().frequency.value;

    const state = music.state;
    music.setEnabled(false);
    return {
      state, openRate, openFreq, focusedRate, focusedFreq,
      releasedRate, releasedFreq, afterEndRate, afterEndFreq,
    };
  });
  assert.equal(result.state, 'playing', `the track should be running, got ${result.state}`);
  assert.equal(result.openRate, 1, 'not focused: playback rate should be unmodified');
  assert.ok(result.openFreq > 10_000, `not focused: the filter should sit open, got ${result.openFreq}Hz`);
  assert.ok(result.focusedRate <= 0.85 && result.focusedRate >= 0.75,
    `holding Focus should slow the source to about 0.8x, got ${result.focusedRate}`);
  assert.ok(result.focusedFreq < 1500, `holding Focus should dull the filter, got ${result.focusedFreq}Hz`);
  assert.ok(result.releasedRate > 0.95, `releasing Focus should restore playback rate, got ${result.releasedRate}`);
  assert.ok(result.releasedFreq > 10_000, `releasing Focus should reopen the filter, got ${result.releasedFreq}Hz`);
  assert.ok(result.afterEndRate > 0.95,
    `nothing should stay slowed after the round stops being "playing", got ${result.afterEndRate}`);
  assert.ok(result.afterEndFreq > 10_000,
    `nothing should stay dulled after the round stops being "playing", got ${result.afterEndFreq}Hz`);
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
