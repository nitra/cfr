import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cli = readFileSync(join(here, '..', 'bin', 'cli.mjs'), 'utf8');
const executable = cli.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');

test('CLI lets JSON stdout drain instead of force-exiting the process', () => {
  assert.doesNotMatch(executable, /process\.exit\s*\(/);
  assert.match(executable, /process\.exitCode\s*=\s*code/);
});
