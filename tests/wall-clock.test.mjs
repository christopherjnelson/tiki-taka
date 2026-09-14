// Guards against a fixed `page.waitForTimeout(ms)` creeping back into the
// browser suites without someone having actually thought about whether wall
// time is the right thing to wait on.
//
// The pad and the HUD it feeds are both sampled once per animation frame, not
// on a wall-clock schedule (see afterFrames() and waitForGame() in
// tests/wait.mjs, and pollGamepad() in apps/desktop/src/main.js). A fixed
// waitForTimeout assumes frames arrive at a roughly constant rate; on a
// contended CI runner they can arrive far slower, or not tick at all inside
// the window, so a test built on wall-clock time reads state from before its
// own input ever lands and fails for reasons that have nothing to do with
// what it is testing - see commits bb7e08c and c0c3477 for two examples that
// actually happened.
//
// A wall-clock wait is still the RIGHT tool when what is under test is
// genuinely about elapsed time rather than frames: proving something did NOT
// change while idle (Focus not refilling, a clock staying frozen), or a real
// timer/debounce in app code (a result screen's reveal delay, a performance
// sample window). Those calls are legitimate - they just have to say so, with
// a `// wall-clock: <reason>` comment on the line directly above (or as part
// of a contiguous comment block ending on the line above) explaining why
// elapsed wall time, and not a frame or a DOM condition, is what the wait is
// actually testing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const testsDir = fileURLToPath(new URL('.', import.meta.url));

// Every browser suite (tests/browser.mjs, tests/*.browser.mjs) plus the
// shared helper module they draw waiting utilities from.
const browserFiles = readdirSync(testsDir).filter(
  name => name === 'browser.mjs' || name.endsWith('.browser.mjs') || name === 'wait.mjs',
);

function unjustifiedWaits(source) {
  const lines = source.split('\n');
  const offenders = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//')) return; // mentioned in prose, not a real call
    if (!/\.waitForTimeout\s*\(/.test(line)) return;
    let cursor = index - 1;
    let justified = false;
    while (cursor >= 0 && /^\s*\/\//.test(lines[cursor])) {
      if (/wall-clock:/.test(lines[cursor])) justified = true;
      cursor--;
    }
    if (!justified) offenders.push({ line: index + 1, text: trimmed });
  });
  return offenders;
}

test('every waitForTimeout in the browser suites is justified as genuinely wall-clock', () => {
  const violations = [];
  for (const file of browserFiles) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const offender of unjustifiedWaits(source)) {
      violations.push(`${file}:${offender.line}: ${offender.text}`);
    }
  }
  assert.deepEqual(
    violations,
    [],
    [
      `Found ${violations.length} unjustified page.waitForTimeout() call(s):`,
      ...violations.map(v => `  ${v}`),
      '',
      'The pad and the HUD are sampled once per animation frame, not on a wall-clock',
      'schedule, so a fixed waitForTimeout assumes frames arrive at a roughly constant',
      'rate. On a loaded CI runner they can arrive far slower, or not tick at all inside',
      'the window, and the test then reads state from before its own input ever landed -',
      'failing for reasons that have nothing to do with what it is testing.',
      '',
      'If this wait is watching for something to CHANGE (a value moved, an element',
      'appeared, a meter drained), replace it with tests/wait.mjs\'s waitForGame() (a',
      'well-messaged waitForFunction) or afterFrames() (when the effect is per-frame',
      'with no single condition to name, like a repaint after a resize).',
      '',
      'A wall-clock wait IS legitimate when elapsed real time is genuinely what is under',
      'test: proving something did NOT change while idle, or a real timer/debounce in',
      'app code. In that case, keep the wait and add a `// wall-clock: <reason>` comment',
      'immediately above it explaining why.',
    ].join('\n'),
  );
});
