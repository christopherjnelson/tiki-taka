// Shared waiting helpers for the Playwright browser suites.
//
// The pad and the HUD it drives are both sampled once per animation frame
// (see apps/desktop/src/main.js's pollGamepad loop and the render loop it
// feeds). A fixed `page.waitForTimeout(ms)` assumes those frames arrive at a
// roughly constant rate; on a loaded CI runner they can arrive far slower, or
// not at all inside the window, so a test built on wall-clock time reads
// state from before its own input ever lands and fails for reasons that have
// nothing to do with what it is testing. These helpers wait for the actual
// per-frame effect (afterFrames) or a real predicate over game/DOM state
// (waitForGame) instead of a clock.
//
// A wall-clock wait is still correct when the thing under test is genuinely
// about elapsed time rather than frames — proving something did NOT change
// while idle, or a real timer/debounce in app code (see tests/wall-clock.test.mjs,
// which enforces that every remaining `waitForTimeout` in the browser suites
// carries a `// wall-clock:` comment explaining why).

// Wait for `count` animation frames to have been requested and serviced by
// the page. Used wherever a per-frame effect (a pad poll, a repaint) has no
// single observable condition to wait on directly - only "enough frames have
// gone by that the effect must have happened by now" - so this scales with
// however fast the runner is actually ticking, instead of assuming a rate.
export async function afterFrames(page, count = 3) {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  }, count);
}

// A thin wrapper around page.waitForFunction that fails with a message aimed
// at the next person to see it fail in CI, rather than a bare "timeout
// exceeded" with no clue what it was waiting for.
export async function waitForGame(page, predicate, arg, options = {}) {
  const { message, ...waitOptions } = options;
  try {
    return await page.waitForFunction(predicate, arg, waitOptions);
  } catch (error) {
    const timeout = waitOptions.timeout ?? 5000;
    const detail = message ? `${message}\n` : '';
    throw new Error(
      `${detail}waitForGame timed out after ${timeout}ms waiting for: ${predicate}\n` +
      'The pad and the HUD it feeds are both sampled once per animation frame ' +
      '(see afterFrames() and pollGamepad() in apps/desktop/src/main.js), so a ' +
      'condition that depends on player input or a render often needs more real ' +
      'time on a loaded runner, not a longer guess at a fixed delay. If this ' +
      'really is about elapsed wall-clock time (proving something did NOT ' +
      'change while idle, or a real timer/debounce in app code) use ' +
      'page.waitForTimeout with a `// wall-clock:` justification comment instead.\n' +
      `${error.message}`,
    );
  }
}

// Activation is edge-triggered (see isDpad below) and polled once per
// animation frame, so a short synthetic press can start and end entirely
// between two polls on a CPU-starved runner and never be observed at all.
// Hold long enough that several frames must see the press, then several more
// must see the release. D-pad presses stay short: holding one past the 0.2s
// repeat gate moves focus twice, which is why isDpad presses use a shorter
// hold than every other button.
const isDpad = (button) => button >= 12 && button <= 15;

export async function pulsePad(page, button, hold = isDpad(button) ? 80 : 250) {
  await page.evaluate((index) => window.__setTestPad({ button: index, pressed: true }), button);
  // wall-clock: a synthetic press has to occupy real time for the poll loop to
  // sample it while it is down; there is no single "the frame loop saw this"
  // condition to wait on instead, and padUntil() above already retries the
  // whole pulse if this one lands between two polls and is missed.
  await page.waitForTimeout(hold);
  await page.evaluate((index) => window.__setTestPad({ button: index, pressed: false }), button);
  // wall-clock: same reasoning as the press above, for the release edge.
  await page.waitForTimeout(hold);
}

// A single pulsePad() can be the one that lands entirely between two polls
// (see above) and never register at all. `ready` is a bounded wait for the
// effect the press should cause; presses repeat, the way a real player would
// press again, until that effect is observed or attempts run out.
export async function padUntil(page, button, ready, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await ready()) return true;
    await pulsePad(page, button);
  }
  return await ready();
}
