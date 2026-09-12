import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const activatePath = new URL('../deploy/activate-release', import.meta.url);

test('deployment scripts parse with Bash', async () => {
  for (const script of ['activate-release', 'prepare-incoming', 'rollback-release']) {
    const result = spawnSync('bash', ['-n', fileURLToPath(new URL(`../deploy/${script}`, import.meta.url))], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('activate-release initializes dependent readonly values under nounset', async () => {
  const source = await readFile(activatePath, 'utf8');
  const lines = source.split('\n');
  const firstDeclaration = lines.findIndex((line) => line.startsWith('readonly ROOT='));
  const lastDeclaration = lines.findIndex((line) => line.startsWith('readonly candidate='));
  assert.notEqual(firstDeclaration, -1, 'missing ROOT declaration');
  assert.notEqual(lastDeclaration, -1, 'missing candidate declaration');
  const declarations = lines.slice(firstDeclaration, lastDeclaration + 1).join('\n');
  const result = spawnSync(
    'bash',
    ['-u', '-c', `${declarations}\nprintf '%s\\n' "$archive|$checksum|$name|$candidate"`, '--',
      'run-1-1', 'v0.3.0', '0123456789abcdef0123456789abcdef01234567', '1', '1'],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    '/srv/tiki-taka/incoming/run-1-1/tiki-taka-v0.3.0.tar.gz|/srv/tiki-taka/incoming/run-1-1/tiki-taka-v0.3.0.tar.gz.sha256|v0.3.0-0123456789ab-1.1|/srv/tiki-taka/releases/v0.3.0-0123456789ab-1.1',
  );
});
