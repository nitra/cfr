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

test('a full-line comment between resources: items does not end the list', () => {
  const { code, stdout } = run('comments');
  assert.equal(code, 0);
  assert.match(stdout, /^✓ /);
});

test('resources: items without indentation are still read', () => {
  const { code, stdout } = run('unindented');
  assert.equal(code, 0);
  assert.match(stdout, /^✓ /);
});

test('flow-style resources: [ ... ] is read', () => {
  const { code, stdout } = run('flow');
  assert.equal(code, 0);
  assert.match(stdout, /^✓ /);
});

test('exits 1 with a parse error instead of guessing on invalid YAML', () => {
  const { code, stderr } = run('invalid-yaml');
  assert.equal(code, 1);
  assert.match(stderr, /invalid YAML/);
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

test('top-level --help lists all inventory commands', () => {
  const { code, stdout } = runArgs('--help');
  assert.equal(code, 0);
  assert.match(stdout, /check/);
  assert.match(stdout, /kcc-inventory/);
  assert.match(stdout, /get-resources/);
  assert.match(stdout, /tofu-inventory/);
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

test('"tofu-inventory --help" needs neither KCC nor kubeconfig', () => {
  const { code, stdout } = runArgs('tofu-inventory', '--help');
  assert.equal(code, 0);
  assert.match(stdout, /--project PROJECT/);
  assert.match(stdout, /--tofu DIR/);
  assert.match(stdout, /does not read Kubernetes/);
});

test('"tofu-inventory" requires an explicit project and OpenTofu state root', () => {
  const { code, stderr } = runArgs('tofu-inventory');
  assert.equal(code, 2);
  assert.match(stderr, /usage:/);
});
