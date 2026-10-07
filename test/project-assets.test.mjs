import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdditionalProjectAssets, collectComputeProjectSettings, enabledServiceIds } from '../lib/project-assets.mjs';
import { normalizeTofuState, classifyResources } from '../lib/controller-inventory.mjs';
import { hasBlockingFindings } from '../lib/tofu-inventory.mjs';

test('matches project-number live assets with imported Firestore, Monitoring, Logging and snapshot state', () => {
  const fixtures = [
    ['firestore.googleapis.com/Database', 'projects/123/databases/(default)', 'google_firestore_database', { name: '(default)' }],
    ['monitoring.googleapis.com/AlertPolicy', 'projects/123/alertPolicies/345', 'google_monitoring_alert_policy', { name: 'projects/demo/alertPolicies/345', display_name: 'Same display name' }],
    ['logging.googleapis.com/LogBucket', 'projects/123/locations/eu/buckets/app', 'google_logging_project_bucket_config', { location: 'eu', bucket_id: 'app' }],
    ['logging.googleapis.com/LogSink', 'projects/123/sinks/export', 'google_logging_project_sink', { name: 'export' }],
    ['compute.googleapis.com/Snapshot', 'projects/123/global/snapshots/recovery', 'google_compute_snapshot', { name: 'recovery' }],
    ['gkebackup.googleapis.com/RestorePlan', 'projects/123/locations/eu/restorePlans/recovery', 'google_gke_backup_restore_plan', { location: 'eu', name: 'recovery' }],
  ];
  const assets = fixtures.map(([assetType, name]) => ({ assetType, name: `//${assetType.split('/')[0]}/${name}` }));
  const { resources, diagnostics } = collectAdditionalProjectAssets(assets);
  const tofu = normalizeTofuState({ values: { root_module: { resources: fixtures.map(([, , type, values], i) => ({
    mode: 'managed', type, address: `${type}.test${i}`, values: { project: 'demo', ...values },
  })) } } }, 'infra');
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(tofu.diagnostics, []);
  const results = classifyResources(resources.map((r) => ({ ...r, project: 'demo' })), tofu.resources);
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.status === 'covered_opentofu'));
});

test('keeps alert policy IDs distinct and Service Directory hierarchy intact', () => {
  const assets = [
    { assetType: 'monitoring.googleapis.com/AlertPolicy', name: '//monitoring.googleapis.com/projects/123/alertPolicies/1', displayName: 'Alert' },
    { assetType: 'monitoring.googleapis.com/AlertPolicy', name: '//monitoring.googleapis.com/projects/123/alertPolicies/2', displayName: 'Alert' },
    { assetType: 'servicedirectory.googleapis.com/Endpoint', name: '//servicedirectory.googleapis.com/projects/123/locations/eu/namespaces/a/services/b/endpoints/c' },
    { assetType: 'servicedirectory.googleapis.com/Endpoint', name: '//servicedirectory.googleapis.com/projects/123/locations/eu/namespaces/d/services/b/endpoints/c' },
  ];
  const { resources } = collectAdditionalProjectAssets(assets);
  assert.deepEqual(resources.map((r) => r.id), ['1', '2', 'eu/namespaces/a/services/b/endpoints/c', 'eu/namespaces/d/services/b/endpoints/c']);
});

test('keeps user-owned Compute resources and snapshots while accounting for controller assets', () => {
  const assets = [
    { assetType: 'compute.googleapis.com/Instance', name: '//compute.googleapis.com/projects/demo/zones/eu-a/instances/gke-looking-user-vm' },
    { assetType: 'compute.googleapis.com/Instance', name: '//compute.googleapis.com/projects/demo/zones/eu-a/instances/node', labels: { 'goog-gke-node': '' } },
    { assetType: 'compute.googleapis.com/Snapshot', name: '//compute.googleapis.com/projects/demo/global/snapshots/manual', additionalAttributes: { sourceDisk: 'pvc-data' } },
    { assetType: 'compute.googleapis.com/Route', name: '//compute.googleapis.com/projects/demo/global/routes/subnet-route' },
    { assetType: 'compute.googleapis.com/Route', name: '//compute.googleapis.com/projects/demo/global/routes/custom' },
    { assetType: 'compute.googleapis.com/NetworkEndpointGroup', name: '//compute.googleapis.com/projects/demo/zones/eu-a/networkEndpointGroups/k8s1-abc-app' },
    { assetType: 'logging.googleapis.com/LogBucket', name: '//logging.googleapis.com/projects/demo/locations/global/buckets/_Required' },
  ];
  const routes = [{ name: 'subnet-route', nextHopNetwork: 'default' }, { name: 'custom', nextHopGateway: 'internet' }];
  const result = collectAdditionalProjectAssets(assets, { routes });
  assert.deepEqual(result.resources.map((r) => r.id), ['eu-a/gke-looking-user-vm', 'global/manual', 'global/custom']);
  assert.equal(result.diagnostics.filter((d) => d.type === 'asset-scope-skip').reduce((sum, d) => sum + d.count, 0), 4);
  const all = collectAdditionalProjectAssets(assets, { includeSystem: true, routes });
  assert.equal(all.resources.length, 7);
});

test('unknown live infrastructure fails strict mode; runtime objects have explicit reasons', () => {
  const { diagnostics } = collectAdditionalProjectAssets([
    { assetType: 'new.googleapis.com/Thing', name: '//new.googleapis.com/projects/demo/things/one' },
    { assetType: 'apps.k8s.io/Deployment', name: 'deployment' },
    { assetType: 'gkebackup.googleapis.com/Backup', name: 'backup' },
  ]);
  assert.equal(hasBlockingFindings([], [], diagnostics), true);
  assert.equal(diagnostics.filter((d) => d.type === 'unsupported-live-resource').length, 1);
  assert.equal(diagnostics.filter((d) => d.type === 'asset-scope-skip').length, 2);
  assert.equal(hasBlockingFindings([], [], diagnostics.filter((d) => d.type === 'asset-scope-skip')), false);
});

test('maintenance operations are counted without hiding affected infrastructure or unknown maintenance types', () => {
  const operations = ['one', 'two'].map((id) => ({
    assetType: 'maintenance.googleapis.com/ResourceMaintenance',
    name: `//maintenance.googleapis.com/projects/demo/locations/eu/resourceMaintenances/${id}`,
  }));
  for (const includeSystem of [false, true]) {
    const runtime = collectAdditionalProjectAssets(operations, { includeSystem });
    assert.deepEqual(runtime.resources, []);
    assert.equal(runtime.diagnostics.length, 1);
    assert.equal(runtime.diagnostics[0].type, 'asset-scope-skip');
    assert.equal(runtime.diagnostics[0].kind, 'RuntimeContent');
    assert.equal(runtime.diagnostics[0].count, 2);
    assert.match(runtime.diagnostics[0].reason, /maintenance operation status/);
    assert.equal(hasBlockingFindings([], [], runtime.diagnostics), false);

    const affected = collectAdditionalProjectAssets([...operations, {
      assetType: 'compute.googleapis.com/Instance',
      name: '//compute.googleapis.com/projects/demo/zones/eu-a/instances/user-vm',
    }], { includeSystem });
    const findings = classifyResources(affected.resources.map((r) => ({ ...r, project: 'demo' })), []);
    assert.equal(findings[0].status, 'uncovered');
    assert.equal(hasBlockingFindings(findings, [], affected.diagnostics), true);

    const unknown = collectAdditionalProjectAssets([...operations, {
      assetType: 'maintenance.googleapis.com/MaintenancePolicy', name: 'policy',
    }], { includeSystem });
    assert.equal(unknown.diagnostics.filter((d) => d.type === 'unsupported-live-resource').length, 1);
    assert.equal(hasBlockingFindings([], [], unknown.diagnostics), true);
  }
});

test('rejects incomplete identities instead of inventing a covered resource', () => {
  assert.throws(() => collectAdditionalProjectAssets([{ assetType: 'compute.googleapis.com/Snapshot' }]), /cannot normalize live/);
  assert.throws(() => normalizeTofuState({ values: { root_module: { resources: [{
    mode: 'managed', type: 'google_compute_instance', address: 'google_compute_instance.bad',
    values: { project: 'demo', name: 'vm' },
  }] } } }, 'infra'), /cannot normalize/);
});

test('matches singleton project and billing assets and zonal settings without depending on project numbers', () => {
  const { resources } = collectAdditionalProjectAssets([
    { assetType: 'cloudbilling.googleapis.com/ProjectBillingInfo', name: '//cloudbilling.googleapis.com/projects/123/billingInfo' },
    { assetType: 'cloudresourcemanager.googleapis.com/Project', name: '//cloudresourcemanager.googleapis.com/projects/123' },
    { assetType: 'compute.googleapis.com/InstanceSettings', name: '//compute.googleapis.com/projects/123/zones/eu-a/instanceSettings/InstanceSettings' },
  ]);
  const state = normalizeTofuState({ values: { root_module: { resources: [
    { mode: 'managed', address: 'google_project.main', type: 'google_project', values: { project_id: 'demo' } },
    { mode: 'managed', address: 'google_billing_project_info.main', type: 'google_billing_project_info', values: { project: 'demo' } },
    { mode: 'managed', address: 'google_compute_instance_settings.main', type: 'google_compute_instance_settings', values: { project: 'demo', zone: 'eu-a' } },
  ] } } }, 'infra', { defaultProject: 'another-project' });
  const result = classifyResources(resources.map((r) => ({ ...r, project: 'demo' })), state.resources);
  assert.equal(result.length, 3);
  assert.ok(result.every((r) => r.status === 'covered_opentofu'));
});

test('splits Compute project settings and preserves GKE ownership without exposing metadata values', () => {
  const data = { commonInstanceMetadata: { items: [
    { key: 'app-setting', value: 'sensitive-value' },
    { key: 'gke-pda-41f03645-secondary-ranges', value: 'controller-value' },
  ] }, defaultNetworkTier: 'PREMIUM', cloudArmorTier: 'CA_STANDARD', xpnProjectStatus: 'UNSPECIFIED_XPN_PROJECT_STATUS', quotas: [] };
  const asset = { assetType: 'compute.googleapis.com/Project', name: '//compute.googleapis.com/projects/123' };
  const live = collectAdditionalProjectAssets([asset], { computeProject: data });
  const state = normalizeTofuState({ values: { root_module: { resources: [
    { mode: 'managed', type: 'google_compute_project_metadata_item', address: 'google_compute_project_metadata_item.app', values: { project: 'demo', key: 'app-setting', value: 'sensitive-value' } },
    { mode: 'managed', type: 'google_compute_project_default_network_tier', address: 'google_compute_project_default_network_tier.main', values: { project: 'demo', network_tier: 'PREMIUM' } },
    { mode: 'managed', type: 'google_compute_project_cloud_armor_tier', address: 'google_compute_project_cloud_armor_tier.main', values: { project: 'demo', cloud_armor_tier: 'CA_STANDARD' } },
  ] } } }, 'infra');
  const results = classifyResources(live.resources.map((r) => ({ ...r, project: 'demo' })), state.resources);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.status === 'covered_opentofu'));
  assert.equal(hasBlockingFindings(results, state.diagnostics, live.diagnostics), false);
  assert.ok(!JSON.stringify(live).includes('sensitive-value'));
  assert.equal(collectComputeProjectSettings(data, { includeSystem: true }).resources.length, 4);
  assert.equal(collectAdditionalProjectAssets([asset]).diagnostics[0].type, 'unsupported-live-resource');
});

test('unmapped Compute project fields and Shared VPC or usage export settings still fail strict', () => {
  const data = { commonInstanceMetadata: {}, defaultNetworkTier: 'PREMIUM', cloudArmorTier: 'CA_STANDARD',
    xpnProjectStatus: 'HOST', usageExportLocation: { bucketName: 'audit' }, newSetting: true };
  const { diagnostics } = collectComputeProjectSettings(data);
  assert.equal(diagnostics.filter((d) => d.type === 'unsupported-live-resource').length, 3);
  assert.equal(hasBlockingFindings([], [], diagnostics), true);
  assert.equal(hasBlockingFindings([], [], collectComputeProjectSettings({}).diagnostics), true);
});

test('matches NAT state with provider-default region recorded only in the canonical import ID', () => {
  const { resources } = normalizeTofuState({ values: { root_module: { resources: [{
    mode: 'managed', type: 'google_compute_router_nat', address: 'google_compute_router_nat.test',
    values: { project: 'demo', region: null, router: 'restore', name: 'restore', id: 'demo/europe-west3/restore/restore' },
  }] } } }, 'infra');
  assert.equal(resources[0].id, 'europe-west3/restore/restore');
});

test('API enablement comes from current Service Usage state, with disabled declarations reported as orphan', () => {
  const services = [
    { name: 'projects/123/services/iam.googleapis.com', state: 'ENABLED' },
    { name: 'projects/123/services/disabled.googleapis.com', state: 'DISABLED' },
  ];
  const state = normalizeTofuState({ values: { root_module: { resources: services.map((s, i) => ({
    mode: 'managed', type: 'google_project_service', address: `google_project_service.api${i}`,
    values: { project: 'demo', service: s.name.split('/').at(-1) },
  })) } } }, 'infra');
  const live = enabledServiceIds(services).map((id) => ({ project: 'demo', kind: 'ServiceUsageService', id }));
  const results = classifyResources(live, state.resources);
  assert.equal(results.find((r) => r.id === 'iam.googleapis.com').status, 'covered_opentofu');
  assert.equal(results.find((r) => r.id === 'disabled.googleapis.com').status, 'orphan_opentofu');
  assert.equal(hasBlockingFindings(results, state.diagnostics), true);
  assert.deepEqual(state.diagnostics, []);
  assert.throws(() => enabledServiceIds([{ state: 'ENABLED' }]), /Invalid enabled/);
});
