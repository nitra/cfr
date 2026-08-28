import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'cli.mjs');
const fixtures = join(here, 'fixtures');

function runArgs(...args) {
  try {
    const stdout = execFileSync('node', [cli, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

function run(target) {
  return runArgs(join(fixtures, target));
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

test('"check" subcommand behaves the same as the bare default', () => {
  const { code, stdout } = runArgs('check', join(fixtures, 'ok'));
  assert.equal(code, 0);
  assert.match(stdout, /^✓ /);
});

test('top-level --help lists all three commands', () => {
  const { code, stdout } = runArgs('--help');
  assert.equal(code, 0);
  assert.match(stdout, /check/);
  assert.match(stdout, /kcc-inventory/);
  assert.match(stdout, /get-resources/);
});

test('"kcc-inventory --help" shows its own usage without touching gcloud/kubectl', () => {
  const { code, stdout } = runArgs('kcc-inventory', '--help');
  assert.equal(code, 0);
  assert.match(stdout, /kcc-inventory <namespace>/);
});

test('"kcc-inventory" with no target exits 2 with a usage error', () => {
  const { code, stderr } = runArgs('kcc-inventory');
  assert.equal(code, 2);
  assert.match(stderr, /usage:/);
});

test('"get-resources --help" shows its own usage without touching gcloud/kubectl', () => {
  const { code, stdout } = runArgs('get-resources', '--help');
  assert.equal(code, 0);
  assert.match(stdout, /get-resources <namespace>/);
});

test('"get-resources" with no target exits 2 with a usage error', () => {
  const { code, stderr } = runArgs('get-resources');
  assert.equal(code, 2);
  assert.match(stderr, /usage:/);
});
