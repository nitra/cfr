import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdditionalProjectAssets } from '../lib/project-assets.mjs';
import { applyUserIgnores, containerAnalysisTopicReason, parseUserIgnoreRules, pvcDiskReason } from '../lib/ignore-rules.mjs';
import { applyIgnoreTags, collectAndClassify, hasBlockingFindings } from '../lib/tofu-inventory.mjs';

const skipped = (diagnostics, assetType) => diagnostics.find((d) => d.type === 'asset-scope-skip' && d.assetType === assetType);
const unsupported = (diagnostics) => diagnostics.filter((d) => d.type === 'unsupported-live-resource').map((d) => d.id);

test('SecretVersion is ignored as data, not infrastructure', () => {
  const { diagnostics, resources } = collectAdditionalProjectAssets([
    { assetType: 'secretmanager.googleapis.com/SecretVersion', name: '//secretmanager.googleapis.com/projects/1/secrets/s/versions/1' },
    { assetType: 'secretmanager.googleapis.com/SecretVersion', name: '//secretmanager.googleapis.com/projects/1/secrets/s/versions/2' },
  ]);
  assert.equal(resources.length, 0);
  assert.equal(skipped(diagnostics, 'secretmanager.googleapis.com/SecretVersion').count, 2);
  assert.deepEqual(unsupported(diagnostics), []);
});

test('only predefined IAM roles are ignored; custom roles stay unsupported', () => {
  const { diagnostics } = collectAdditionalProjectAssets([
    { assetType: 'iam.googleapis.com/Role', name: '//iam.googleapis.com/roles/viewer' },
    { assetType: 'iam.googleapis.com/Role', name: '//iam.googleapis.com/projects/p/roles/customRole' },
    { assetType: 'iam.googleapis.com/Role', name: '//iam.googleapis.com/organizations/1/roles/orgRole' },
  ]);
  assert.equal(skipped(diagnostics, 'iam.googleapis.com/Role').count, 1);
  assert.deepEqual(unsupported(diagnostics), [
    '//iam.googleapis.com/projects/p/roles/customRole', '//iam.googleapis.com/organizations/1/roles/orgRole']);
});

test('only Dataplex @system entry groups are ignored', () => {
  const { diagnostics } = collectAdditionalProjectAssets([
    { assetType: 'dataplex.googleapis.com/EntryGroup', name: '//dataplex.googleapis.com/projects/p/locations/global/entryGroups/@bigquery' },
    { assetType: 'dataplex.googleapis.com/EntryGroup', name: '//dataplex.googleapis.com/projects/p/locations/global/entryGroups/mine' },
  ]);
  assert.equal(skipped(diagnostics, 'dataplex.googleapis.com/EntryGroup').count, 1);
  assert.deepEqual(unsupported(diagnostics), ['//dataplex.googleapis.com/projects/p/locations/global/entryGroups/mine']);
});

test('GKE Cloud DNS response policies and rules are ignored, user ones are not', () => {
  const policy = (id, displayName) => ({ assetType: 'dns.googleapis.com/ResponsePolicy', name: `//dns.googleapis.com/projects/1/locations/global/responsePolicies/${id}`, displayName });
  const rule = (policyId, name) => ({ assetType: 'dns.googleapis.com/ResponsePolicyRule', name: `//dns.googleapis.com/projects/1/locations/global/responsePolicies/${policyId}/rules/${name}` });
  const { diagnostics } = collectAdditionalProjectAssets([
    policy('100'), rule('100', 'gke-abc-svc-1'),
    policy('200'), rule('200', 'gke-abc-svc-2'), rule('200', 'corp-override'),
    policy('300'),
    policy('400', 'gke-cluster-rp'),
  ]);
  assert.equal(skipped(diagnostics, 'dns.googleapis.com/ResponsePolicyRule').count, 2);
  assert.equal(skipped(diagnostics, 'dns.googleapis.com/ResponsePolicy').count, 2);
  assert.deepEqual(unsupported(diagnostics).sort(), [
    '//dns.googleapis.com/projects/1/locations/global/responsePolicies/200',
    '//dns.googleapis.com/projects/1/locations/global/responsePolicies/200/rules/corp-override',
    '//dns.googleapis.com/projects/1/locations/global/responsePolicies/300',
  ]);
});

test('GKE firewalls (incl. ipv6) are ignored, user firewalls stay', () => {
  const fw = (name) => ({ assetType: 'compute.googleapis.com/Firewall', name: `//compute.googleapis.com/projects/p/global/firewalls/${name}` });
  const { resources, diagnostics } = collectAdditionalProjectAssets([
    fw('gke-cluster-8b5e95b5-ipv6-all'), fw('gke-cluster-8b5e95b5-vms'), fw('allow-hc'), fw('gke-custom-by-user')]);
  assert.deepEqual(resources.map((r) => r.id).sort(), ['global/allow-hc', 'global/gke-custom-by-user']);
  assert.equal(skipped(diagnostics, 'compute.googleapis.com/Firewall').count, 2);
});

test('empty InstanceSettings are tagged, non-empty ones are not; --include-system disables', () => {
  const assets = ['a', 'b'].map((z) => ({ assetType: 'compute.googleapis.com/InstanceSettings', name: `//compute.googleapis.com/projects/p/zones/${z}/instanceSettings` }));
  const instanceSettings = new Map([['a', { fingerprint: 'x' }], ['b', { metadata: { items: [{ key: 'k', value: 'v' }] } }]]);
  const byId = (resources) => Object.fromEntries(resources.map((r) => [r.id, r.ignoreReason]));
  assert.match(byId(collectAdditionalProjectAssets(assets, { instanceSettings }).resources).a, /InstanceSettings/);
  assert.equal(byId(collectAdditionalProjectAssets(assets, { instanceSettings }).resources).b, undefined);
  assert.equal(byId(collectAdditionalProjectAssets(assets, { instanceSettings, includeSystem: true }).resources).a, undefined);
  assert.equal(byId(collectAdditionalProjectAssets(assets).resources).a, undefined);
});

test('PVC disk and Container Analysis topic markers are exact', () => {
  assert.ok(pvcDiskReason({ labels: { 'kubernetes_io_created-for_pvc_name': 'data' } }));
  assert.ok(pvcDiskReason({ description: '{"kubernetes.io/created-for/pvc/name":"data"}' }));
  assert.equal(pvcDiskReason({ name: 'pvc-0123' }), null);
  assert.equal(pvcDiskReason({ labels: { team: 'a' }, description: 'manual disk' }), null);
  assert.ok(containerAnalysisTopicReason('projects/p/topics/container-analysis-notes-v1beta1'));
  assert.equal(containerAnalysisTopicReason('projects/p/topics/container-analysis-custom'), null);
  assert.equal(containerAnalysisTopicReason('projects/p/topics/billing'), null);
});

test('tagged resources become ignored only when uncovered and do not block strict', async () => {
  const { results, tofuDiagnostics, gcpDiagnostics } = await collectAndClassify('p', ['x'], {
    collectProjectFn: async () => ({ diagnostics: [], resources: [
      { kind: 'ComputeDisk', id: 'z/pvc-1', source: 'gcp', ignoreReason: 'Kubernetes PVC disk' },
      { kind: 'ComputeDisk', id: 'z/pvc-declared', source: 'gcp', ignoreReason: 'Kubernetes PVC disk' },
      { kind: 'ComputeDisk', id: 'z/manual', source: 'gcp' },
    ] }),
    collectOpenTofuFn: () => ({ diagnostics: [], resources: [
      { project: 'p', kind: 'ComputeDisk', id: 'z/pvc-declared', controller: 'opentofu', source: 'x' }] }),
  });
  const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
  assert.deepEqual(status, { 'z/pvc-1': 'ignored', 'z/pvc-declared': 'covered_opentofu', 'z/manual': 'uncovered' });
  assert.equal(results.find((r) => r.id === 'z/pvc-1').reason, 'Kubernetes PVC disk');
  assert.ok(results.every((r) => !('ignoreReason' in r)));
  assert.equal(hasBlockingFindings(results, tofuDiagnostics, gcpDiagnostics), true);
  assert.equal(hasBlockingFindings(applyIgnoreTags([{ status: 'ignored' }]), [], []), false);
});

test('--ignore rules only affect uncovered resources and unsupported assets', () => {
  const rules = parseUserIgnoreRules(['PubSubTopic:^tmp-', 'certificatemanager.googleapis.com/Certificate:wildcard']);
  const { results, gcpDiagnostics } = applyUserIgnores([
    { kind: 'PubSubTopic', id: 'tmp-a', status: 'uncovered' },
    { kind: 'PubSubTopic', id: 'tmp-b', status: 'covered_opentofu' },
    { kind: 'PubSubTopic', id: 'prod', status: 'uncovered' },
  ], [
    { type: 'unsupported-live-resource', assetType: 'certificatemanager.googleapis.com/Certificate', id: '//x/wildcard-1' },
    { type: 'unsupported-live-resource', assetType: 'certificatemanager.googleapis.com/Certificate', id: '//x/other' },
  ], rules);
  assert.deepEqual(results.map((r) => r.status), ['ignored', 'covered_opentofu', 'uncovered']);
  assert.match(results[0].reason, /--ignore/);
  assert.deepEqual(gcpDiagnostics.map((d) => d.type), ['user-ignored', 'unsupported-live-resource']);
  assert.throws(() => parseUserIgnoreRules(['nocolon']));
});
