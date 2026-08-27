import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'cli.mjs');
const fixtures = join(here, 'fixtures');

function run(target) {
  try {
    const stdout = execFileSync('node', [cli, join(fixtures, target)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

test('exits 0 when resources: matches the directory', () => {
  const { code, stdout } = run('ok');
  assert.equal(code, 0);
  assert.match(stdout, /^✓ /);
});

test('exits 1 and names the file missing from resources:', () => {
  const { code, stderr } = run('missing');
  assert.equal(code, 1);
  assert.match(stderr, /b\.yaml/);
  assert.match(stderr, /missing from resources:/);
});

test('exits 1 and names the dangling resources: entry', () => {
  const { code, stderr } = run('dangling');
  assert.equal(code, 1);
  assert.match(stderr, /gone\.yaml/);
  assert.match(stderr, /missing on disk/);
});

test('exits 1 with a clear error when kustomization.yaml is absent', () => {
  const { code, stderr } = run('..');
  assert.equal(code, 1);
  assert.match(stderr, /no kustomization\.yaml/);
});
