import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { stringify } from 'yaml';
import { validateBundles } from '../lib/contract.mjs';

const hash = `sha256:${'a'.repeat(64)}`;
const source = (name = 'release', ref = { digest: hash }) => ({
  apiVersion: 'source.toolkit.fluxcd.io/v1', kind: 'OCIRepository',
  metadata: { name, namespace: 'flux-system' },
  spec: { url: `oci://example.com/${name}`, interval: '5m', ref },
});
const child = (name = 'app') => ({
  apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization',
  metadata: { name, namespace: 'flux-system' },
  spec: { sourceRef: { kind: 'OCIRepository', name: 'release' }, path: './',
    interval: '10m', timeout: '5m', prune: true, wait: true },
});
const report = (...objects) => validateBundles([{ source: 'test.yaml', text: objects.map((o) => stringify(o)).join('---\n') }]);
const rules = (result) => result.findings.map((f) => f.rule);

test('separates root SemVer channel from digest-pinned children', () => {
  const root = child('flux-system');
  root.spec = { ...root.spec, prune: false, wait: false, sourceRef: { kind: 'OCIRepository', name: 'root' } };
  assert.equal(report(source('root', { semver: '>=1.0.0 <2.0.0' }), root, source(), child()).ok, true);
});

test('rejects floating child sources, Git transport, and duplicate owners', () => {
  assert.ok(rules(report(source('release', { semver: '*' }), child())).includes('source-pin'));
  assert.ok(rules(report({ ...source(), kind: 'GitRepository' })).includes('source-transport'));
  assert.ok(rules(report(source(), source())).includes('duplicate-owner'));
});

test('rejects cloud CRs and controller installation through manifests, charts or OLM', () => {
  for (const object of [
    { apiVersion: 'storage.cnrm.cloud.google.com/v1beta1', kind: 'StorageBucket' },
    { apiVersion: 'core.cnrm.cloud.google.com/v1beta1', kind: 'ConfigConnector' },
    { apiVersion: 'rbac.authorization.k8s.io/v1', kind: 'ClusterRole', rules: [{ apiGroups: ['iam.cnrm.cloud.google.com'] }] },
    { apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', spec: { chart: { spec: { chart: 'config-connector' } } } },
    { apiVersion: 'olm.operatorframework.io/v1', kind: 'ClusterExtension', spec: { source: { catalog: { packageName: 'config-connector' } } } },
    { apiVersion: 'kustomize.toolkit.fluxcd.io/v1', kind: 'Kustomization', spec: { path: './platform/kcc/operator' } },
  ]) assert.ok(rules(report({ metadata: { name: 'test' }, ...object })).includes('cloud-owner'));
});

test('reports missing dependencies and cycles in the supplied bundle', () => {
  const a = child('a');
  const b = child('b');
  a.spec.dependsOn = [{ name: 'b' }];
  b.spec.dependsOn = [{ name: 'a' }];
  assert.ok(rules(report(a)).includes('missing-source'));
  assert.ok(rules(report(source(), a)).includes('missing-dependency'));
  assert.ok(rules(report(source(), a, b)).includes('dependency-cycle'));
});

test('validates health modes without confusing wait:true and healthChecks', () => {
  const app = child();
  app.spec.healthChecks = [{ apiVersion: 'apps/v1', kind: 'Deployment', name: 'app', namespace: 'app' }];
  assert.ok(rules(report(source(), app)).includes('health-policy'));
  app.spec.wait = false;
  assert.equal(report(source(), app).ok, true);
  assert.ok(rules(report(source(), child('flux-system'))).includes('root-policy'));
});

test('requires immutable images and rejects Secret payloads without echoing them', () => {
  const pod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'app' }, spec: { containers: [{ name: 'app', image: 'app:latest' }] } };
  assert.ok(rules(report(pod)).includes('image-pin'));
  pod.spec.containers[0].image = `app@${hash}`;
  assert.equal(report(pod).ok, true);
  const result = report({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'app' }, stringData: { password: 'sensitive-fixture-value' } });
  assert.ok(rules(result).includes('secret-payload'));
  assert.doesNotMatch(JSON.stringify(result), /sensitive-fixture-value/);
});

test('rejects unrendered configs, templates, malformed YAML and empty bundles', () => {
  assert.ok(rules(report({ apiVersion: 'kustomize.config.k8s.io/v1beta1', kind: 'Kustomization', metadata: { name: 'config' } })).includes('render-required'));
  assert.ok(rules(report({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: '<< inputs.name >>' } })).includes('unresolved-template'));
  assert.ok(rules(validateBundles([{ source: 'bad', text: '[invalid' }])).includes('yaml'));
  assert.ok(rules(validateBundles([{ source: 'empty', text: '' }])).includes('empty-bundle'));
});

test('exact external Helm chart tags are distinct from workload artifact pins', () => {
  const helm = { apiVersion: 'helm.toolkit.fluxcd.io/v2', kind: 'HelmRelease', metadata: { name: 'db', namespace: 'flux-system' },
    spec: { releaseName: 'db', targetNamespace: 'db', storageNamespace: 'db', interval: '10m', chartRef: { kind: 'OCIRepository', name: 'chart' } } };
  assert.equal(report(source('chart', { tag: '0.29.1' }), helm).ok, true);
  assert.ok(rules(report(source('chart', { tag: 'latest' }), helm)).includes('source-pin'));
});

test('invalid field shapes produce findings instead of crashing', () => {
  const app = child();
  app.spec.dependsOn = 'not-a-list';
  app.spec.images = {};
  const oci = source();
  oci.spec.url = 1;
  assert.equal(report(app, oci).ok, false);
});

test('CLI reads stdin and returns machine-readable verdicts', () => {
  for (const [input, status] of [[stringify(source()), 0], [stringify({ apiVersion: 'v1', kind: 'Secret', stringData: { password: 'sensitive-fixture-value' } }), 1], ['', 1]]) {
    const result = spawnSync(process.execPath, ['bin/cli.mjs', 'contract', '--json', '-'], { cwd: new URL('../', import.meta.url), input, encoding: 'utf8' });
    assert.equal(result.status, status, result.stderr);
    assert.equal(JSON.parse(result.stdout).ok, status === 0);
    assert.doesNotMatch(result.stdout, /sensitive-fixture-value/);
  }
});
