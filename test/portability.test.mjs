import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze, collectLive, run, scanLiterals, summarize } from '../lib/portability.mjs';

const P = 'example-project';
const N = '123456789012';

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cfr-port-'));
  mkdirSync(join(dir, 'docs'));
  mkdirSync(join(dir, '.terraform'));
  writeFileSync(join(dir, 'main.tf'), [
    'resource "google_storage_bucket" "state" {',
    `  name = "${P}-state"`,
    '  lifecycle_rule { condition { age = 1 } }',
    '}',
    'resource "google_storage_bucket" "ok" {',
    '  name = "${var.project_id}-data"',
    '}',
    `resource "google_service_account" "a" { project = "${P}" }`,
    `locals { sa = "ci@${P}.iam.gserviceaccount.com" }`,
    `locals { pool = "${P}.svc.id.goog[ns/sa]" }`,
    `locals { num = "projects/${N}/locations/global" }`,
    'resource "google_iam_workload_identity_pool_provider" "p" {',
    '  oidc { issuer_uri = "https://git.example.test/api/actions" }',
    '}',
    'resource "google_dns_managed_zone" "z" { dns_name = "example.test." }',
    '# create the pool manually first',
  ].join('\n'));
  writeFileSync(join(dir, 'app.yaml'), [
    `image: europe-docker.pkg.dev/${P}/repo/app:1`,
    'run: kubectl apply -k overlays/prod',
    '# bootstrap: gcloud auth login',
  ].join('\n'));
  writeFileSync(join(dir, 'README.md'), `uses ${P} and kubectl create secret generic x\n`);
  writeFileSync(join(dir, 'docs', 'skip.tf'), `project = "${P}"\n`);
  writeFileSync(join(dir, '.terraform', 'skip.tf'), `project = "${P}"\n`);
  return dir;
}

const assets = [
  ...['1', '2', '3'].map((v) => ({ assetType: 'secretmanager.googleapis.com/SecretVersion', project: `projects/${N}`, name: `//secretmanager.googleapis.com/projects/${N}/secrets/db/versions/${v}` })),
  { assetType: 'secretmanager.googleapis.com/SecretVersion', state: 'DESTROYED', name: `//secretmanager.googleapis.com/projects/${N}/secrets/db/versions/0` },
  { assetType: 'storage.googleapis.com/Bucket', displayName: `${P}-state`, name: `//storage.googleapis.com/${P}-state` },
  { assetType: 'artifactregistry.googleapis.com/Repository', name: `//artifactregistry.googleapis.com/projects/${P}/locations/eu/repositories/r` },
  { assetType: 'artifactregistry.googleapis.com/DockerImage', name: `//artifactregistry.googleapis.com/projects/${P}/locations/eu/repositories/r/dockerImages/a@sha256:1` },
  { assetType: 'compute.googleapis.com/Disk', labels: { 'kubernetes_io_created-for_pvc_name': 'x' }, name: 'd1' },
  { assetType: 'compute.googleapis.com/Disk', name: 'd2' },
  { assetType: 'compute.googleapis.com/Snapshot', name: 's1' },
  { assetType: 'iam.googleapis.com/ServiceAccount', additionalAttributes: { email: `ci@${P}.iam.gserviceaccount.com` } },
  { assetType: 'iam.googleapis.com/ServiceAccount', additionalAttributes: { email: `${N}-compute@developer.gserviceaccount.com` } },
  { assetType: 'sqladmin.googleapis.com/Instance', name: 'sql' },
];

const io = {
  searchAll: async () => assets,
  getJson: async (url) => {
    if (url.includes('/keys')) return url.includes(`ci@${P}`) ? { keys: [{ name: 'k1' }, { name: 'k2' }] } : { keys: [] };
    if (url.includes('aggregated/addresses')) return { items: {
      'regions/eu': { addresses: [
        { name: 'ip1', address: '203.0.113.5', addressType: 'EXTERNAL', status: 'IN_USE' },
        { name: 'internal', addressType: 'INTERNAL' },
        { name: 'nat', addressType: 'EXTERNAL', purpose: 'NAT_AUTO' }] } } };
    throw new Error(`unexpected ${url}`);
  },
  paginate: async (url) => {
    if (url.endsWith('/workloadIdentityPools')) return [{ name: `projects/${N}/locations/global/workloadIdentityPools/ci` }, { name: `projects/${N}/locations/global/workloadIdentityPools/${P}.svc.id.goog` }];
    return [{ name: `projects/${N}/locations/global/workloadIdentityPools/ci/providers/gh`, oidc: { issuerUri: 'https://token.actions.githubusercontent.com', allowedAudiences: ['aud'] } }];
  },
};

test('scanLiterals classifies contexts, finds number, never echoes the line', () => {
  const text = `a = "${P}"\nb = "${P}-bucket"\nc = "x@${P}.iam.gserviceaccount.com"\nd = "${N}"\ne = "other"`;
  const f = scanLiterals(text, 'x.tf', P, N);
  assert.deepEqual(f.map((x) => [x.check, x.location]), [
    ['hardcoded-project-id', 'x.tf:1'], ['hardcoded-project-id', 'x.tf:2'], ['hardcoded-project-id', 'x.tf:3'], ['hardcoded-project-number', 'x.tf:4']]);
  assert.match(f[0].category, /bare/);
  assert.match(f[1].category, /name embedding/);
  assert.match(f[2].category, /service account/);
  assert.ok(f.every((x) => !JSON.stringify(x).includes('"other"')));
});

test('collectLive reads only metadata and counts', async () => {
  const live = await collectLive(P, io);
  assert.equal(live.projectNumber, N);
  assert.equal(live.secretVersionTotal, 3);
  assert.deepEqual(live.secretVersionCounts, [['db', 3]]);
  assert.equal(live.pvcDisks, 1);
  assert.equal(live.otherDisks, 1);
  assert.equal(live.userKeys, 2);
  assert.deepEqual(live.addresses.map((a) => a.name), ['ip1']);
  assert.equal(live.providers[0].issuer, 'https://token.actions.githubusercontent.com');
  assert.equal(live.providers.length, 1);
});

test('analyze produces findings for all 8 checks and a summary', async () => {
  const dir = fixtureDir();
  const coverage = { results: [{ status: 'uncovered', kind: 'IAMServiceAccount', id: 'a' }, { status: 'covered_opentofu', kind: 'X', id: 'b' }, { status: 'orphan_opentofu', kind: 'IAMPolicyMember', id: 'c' }],
    gcpDiagnostics: [{ type: 'unsupported-live-resource', assetType: 't/T', id: 'u' }], tofuDiagnostics: [{ resourceType: 'google_x', address: 'google_x.y' }] };
  const { findings, summary } = await analyze(P, { dirs: [dir], tofuPaths: ['state'] }, {
    collectLive: (project) => collectLive(project, io), collectCoverage: async () => coverage });
  const checks = new Set(findings.map((f) => f.check));
  for (const c of ['hardcoded-project-id', 'hardcoded-project-number', 'globally-unique-names', 'data-not-in-iac', 'uncovered-or-unsupported', 'out-of-git-steps', 'external-trust', 'static-ips-and-dns']) {
    assert.ok(checks.has(c), c);
  }
  assert.ok(findings.every((f) => f.severity && f.check && f.location && f.message && f.hint));
  assert.ok(!findings.some((f) => f.location.includes('docs') || f.location.includes('.terraform')));
  const buckets = findings.filter((f) => f.check === 'globally-unique-names' && f.message.startsWith('Bucket'));
  assert.equal(buckets.length, 1);
  assert.match(buckets[0].message, /example-project-state/);
  assert.equal(findings.filter((f) => f.check === 'uncovered-or-unsupported').length, 4);
  assert.deepEqual(summary.dataToMigrate.slice(0, 2), ['SecretVersion 3', 'Storage buckets 1']);
  assert.equal(summary.blockers, findings.filter((f) => f.severity === 'error').length);
  assert.ok(findings.some((f) => f.check === 'out-of-git-steps' && f.location.endsWith('README.md:1')));
});

test('run: --json shape, exit 0 by default and 1 with --strict on errors, 2 on bad usage', async () => {
  const dir = fixtureDir();
  const deps = { collectLive: (project) => collectLive(project, io) };
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(await run(['--project', P, '--dir', dir, '--json'], deps), 0);
    const parsed = JSON.parse(logs[0]);
    assert.ok(Array.isArray(parsed.findings) && parsed.summary.blockers > 0);
    assert.equal(await run(['--project', P, '--dir', dir, '--strict'], deps), 1);
    assert.match(logs.at(-1), /blockers \(error\): \d+; warnings: \d+; data to migrate: SecretVersion 3/);
    const clean = mkdtempSync(join(tmpdir(), 'cfr-port-clean-'));
    assert.equal(await run(['--project', P, '--dir', clean, '--strict'], deps), 0);
  } finally {
    console.log = original;
  }
  const error = console.error;
  console.error = () => {};
  try { assert.equal(await run(['--bogus'], deps), 2); } finally { console.error = error; }
});

test('summarize counts severities', () => {
  assert.deepEqual(summarize([{ severity: 'error', check: 'a' }, { severity: 'warn', check: 'b' }, { severity: 'info', check: 'data-not-in-iac', dataClass: 'X', count: 2 }]),
    { blockers: 1, warnings: 1, info: 1, dataToMigrate: ['X 2'] });
});
