import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAdditionalProjectAssets, collectComputeProjectSettings } from '../lib/project-assets.mjs';
import { classifyResources, normalizeTofuState } from '../lib/controller-inventory.mjs';
import { applyIgnoreTags } from '../lib/tofu-inventory.mjs';
import { gkeSecurityBulletinPolicyReason } from '../lib/ignore-rules.mjs';
import { policyHasBinding, verifyIamOrphans } from '../lib/iam-orphan-verify.mjs';

const P = 'example-project';
const N = '123456789012';
const asset = (assetType, name, extra = {}) => ({ assetType, name, ...extra });
const tags = (resources) => Object.fromEntries(resources.map((r) => [`${r.kind}:${r.id}`, r.ignoreReason]));

test('Project, ProjectBillingInfo and default tiers are tagged as ignorable; --include-system disables', () => {
  const assets = [
    asset('cloudresourcemanager.googleapis.com/Project', `//cloudresourcemanager.googleapis.com/projects/${P}`),
    asset('cloudbilling.googleapis.com/ProjectBillingInfo', `//cloudbilling.googleapis.com/projects/${P}/billingInfo`),
  ];
  const t = tags(collectAdditionalProjectAssets(assets).resources);
  assert.match(t['Project:project'], /bootstrap/);
  assert.match(t['ProjectBillingInfo:billingInfo'], /bootstrap/);
  assert.equal(Object.values(tags(collectAdditionalProjectAssets(assets, { includeSystem: true }).resources)).filter(Boolean).length, 0);
  const tiers = collectComputeProjectSettings({ commonInstanceMetadata: { items: [] }, defaultNetworkTier: 'PREMIUM', cloudArmorTier: 'CA_STANDARD' });
  assert.ok(tiers.resources.every((r) => /default setting/.test(r.ignoreReason)));
  assert.ok(collectComputeProjectSettings({ commonInstanceMetadata: { items: [] }, defaultNetworkTier: 'PREMIUM', cloudArmorTier: 'x' }, { includeSystem: true })
    .resources.every((r) => !r.ignoreReason));
});

const bulletin = { displayName: 'GKE Security Bulletin Affecting Your Cluster', conditions: [{ conditionMatchedLog: {
  filter: 'log_id("container.googleapis.com/notifications") AND jsonPayload.@type="type.googleapis.com/google.container.v1beta1.SecurityBulletinEvent"' } }] };

test('GKE security bulletin alert needs exact name AND log signature; other alerts stay visible', () => {
  assert.ok(gkeSecurityBulletinPolicyReason(bulletin));
  assert.equal(gkeSecurityBulletinPolicyReason({ ...bulletin, displayName: 'My alert' }), null);
  assert.equal(gkeSecurityBulletinPolicyReason({ displayName: bulletin.displayName, conditions: [{ conditionThreshold: {} }] }), null);
  const assets = ['1', '2'].map((id) => asset('monitoring.googleapis.com/AlertPolicy', `//monitoring.googleapis.com/projects/${N}/alertPolicies/${id}`, { displayName: bulletin.displayName }));
  const t = tags(collectAdditionalProjectAssets(assets, { alertPolicies: new Map([['1', bulletin], ['2', { displayName: bulletin.displayName, conditions: [] }]]) }).resources);
  assert.ok(t['MonitoringAlertPolicy:1']);
  assert.equal(t['MonitoringAlertPolicy:2'], undefined);
  assert.equal(tags(collectAdditionalProjectAssets(assets).resources)['MonitoringAlertPolicy:1'], undefined);
});

test('only the exact default internet route of the default network is tagged', () => {
  const route = (name, extra) => ({ name, network: `https://x/projects/${P}/global/networks/default`, destRange: '0.0.0.0/0',
    nextHopGateway: `https://x/projects/${P}/global/gateways/default-internet-gateway`, ...extra });
  const names = ['default-route-0123abcd', 'default-route-fffe0001', 'default-route-aaaa1111', 'my-route'];
  const assets = names.map((n) => asset('compute.googleapis.com/Route', `//compute.googleapis.com/projects/${P}/global/routes/${n}`));
  const routes = [route(names[0]), route(names[1], { nextHopGateway: undefined, nextHopIp: '10.0.0.1' }),
    route(names[2], { network: `https://x/projects/${P}/global/networks/custom` }), route(names[3])];
  const t = tags(collectAdditionalProjectAssets(assets, { routes }).resources);
  assert.match(t['ComputeRoute:global/default-route-0123abcd'], /default internet route/);
  assert.equal(t['ComputeRoute:global/default-route-fffe0001'], undefined);
  assert.equal(t['ComputeRoute:global/default-route-aaaa1111'], undefined);
  assert.equal(t['ComputeRoute:global/my-route'], undefined);
});

function state(type, values, address = `${type}.x`) {
  return normalizeTofuState({ values: { root_module: { resources: [{ mode: 'managed', type, address, values: { project: P, ...values } }] } } }, 'root');
}
const cover = (assets, tofu, options) => {
  const live = collectAdditionalProjectAssets(assets, options).resources.map((r) => ({ ...r, project: P }));
  return classifyResources(live, tofu.resources).map((r) => r.status);
};

test('security policies, notification channels, certificates and DNS authorizations map both ways', () => {
  const cases = [
    [asset('compute.googleapis.com/SecurityPolicy', `//compute.googleapis.com/projects/${P}/global/securityPolicies/waf`), 'google_compute_security_policy', { name: 'waf' }],
    [asset('compute.googleapis.com/SecurityPolicy', `//compute.googleapis.com/projects/${P}/regions/eu1/securityPolicies/geo`), 'google_compute_region_security_policy', { name: 'geo', region: 'eu1' }],
    [asset('monitoring.googleapis.com/NotificationChannel', `//monitoring.googleapis.com/projects/${N}/notificationChannels/77`), 'google_monitoring_notification_channel', { name: `projects/${P}/notificationChannels/77` }],
    [asset('certificatemanager.googleapis.com/Certificate', `//certificatemanager.googleapis.com/projects/${P}/locations/eu1/certificates/wild`), 'google_certificate_manager_certificate', { name: 'wild', location: 'eu1' }],
    [asset('certificatemanager.googleapis.com/Certificate', `//certificatemanager.googleapis.com/projects/${P}/locations/global/certificates/g`), 'google_certificate_manager_certificate', { name: 'g' }],
    [asset('certificatemanager.googleapis.com/DnsAuthorization', `//certificatemanager.googleapis.com/projects/${P}/locations/eu1/dnsAuthorizations/auth`), 'google_certificate_manager_dns_authorization', { name: 'auth', location: 'eu1' }],
  ];
  for (const [live, type, values] of cases) {
    assert.deepEqual(state(type, values).diagnostics, [], type);
    assert.deepEqual(cover([live], state(type, values)), ['covered_opentofu'], type);
    assert.deepEqual(cover([live], { resources: [] }), ['uncovered'], type);
    assert.deepEqual(classifyResources([], state(type, values).resources).map((r) => r.status), ['orphan_opentofu'], type);
  }
});

test('custom roles: covered/uncovered, soft-deleted ones are not live, no false orphan', () => {
  const role = (id) => asset('iam.googleapis.com/Role', `//iam.googleapis.com/projects/${P}/roles/${id}`);
  const assets = [role('active'), role('manual'), role('gone')];
  const options = { activeRoleIds: new Set(['active', 'manual']) };
  const tofu = state('google_project_iam_custom_role', { role_id: 'active' });
  const { resources, diagnostics } = collectAdditionalProjectAssets(assets, options);
  assert.deepEqual(resources.map((r) => r.id), ['active', 'manual']);
  assert.equal(diagnostics.find((d) => d.kind === 'SoftDeleted').count, 1);
  assert.deepEqual(unsupportedOf(diagnostics), []);
  assert.deepEqual(cover(assets, tofu, options), ['covered_opentofu', 'uncovered']);
});
const unsupportedOf = (diagnostics) => diagnostics.filter((d) => d.type === 'unsupported-live-resource');

test('tagged resources: ignored when uncovered, covered when declared', () => {
  const assets = [asset('cloudresourcemanager.googleapis.com/Project', `//x/projects/${P}`)];
  const live = collectAdditionalProjectAssets(assets).resources.map((r) => ({ ...r, project: P }));
  assert.equal(applyIgnoreTags(classifyResources(live, []))[0].status, 'ignored');
  const tofu = state('google_project', { project_id: P });
  assert.equal(applyIgnoreTags(classifyResources(live, tofu.resources))[0].status, 'covered_opentofu');
});

// --- orphan IAM verification --------------------------------------------------
const orphan = (extra = {}) => ({ status: 'orphan_opentofu', kind: 'IAMPolicyMember', id: 'x', project: P,
  iamTarget: `sa/plan@${P}.iam.gserviceaccount.com`, role: 'roles/iam.workloadIdentityUser', member: 'principalSet://a/b', ...extra });
const policy = { bindings: [{ role: 'roles/iam.workloadIdentityUser', members: ['principalSet://a/b'] }] };

test('orphan IAM member found by getIamPolicy becomes covered with verified_via', async () => {
  const { results, warnings } = await verifyIamOrphans([orphan()], { fetchPolicy: async () => policy });
  assert.equal(results[0].status, 'covered_opentofu');
  assert.equal(results[0].verified_via, 'getIamPolicy');
  assert.deepEqual(warnings, []);
});

test('orphan stays when the binding is absent, role/condition differ, or is not an IAM orphan', async () => {
  const other = { bindings: [{ role: 'roles/other', members: ['principalSet://a/b'] }] };
  assert.equal((await verifyIamOrphans([orphan()], { fetchPolicy: async () => other })).results[0].status, 'orphan_opentofu');
  assert.equal(policyHasBinding({ bindings: [{ role: 'r', members: ['m'], condition: { title: 'c', expression: 'e' } }] }, { role: 'r', member: 'm' }), false);
  assert.equal(policyHasBinding({ bindings: [{ role: 'r', members: ['serviceAccount:A@x'] }] }, { role: 'r', member: 'serviceAccount:a@x' }), true);
  const untouched = [{ status: 'covered_opentofu', kind: 'IAMPolicyMember', id: 'y' }, { status: 'orphan_opentofu', kind: 'StorageBucket', id: 'z' }];
  const out = await verifyIamOrphans(untouched, { fetchPolicy: async () => { throw new Error('must not be called'); } });
  assert.deepEqual(out.results, untouched);
});

test('verification failure keeps the orphan with a warning; calls are cached per target and capped', async () => {
  const denied = await verifyIamOrphans([orphan()], { fetchPolicy: async () => { throw new Error('403 denied'); } });
  assert.equal(denied.results[0].status, 'orphan_opentofu');
  assert.match(denied.results[0].verification, /^failed/);
  assert.match(denied.warnings[0], /cannot verify/);

  let calls = 0;
  const fetchPolicy = async () => { calls += 1; return policy; };
  const same = await verifyIamOrphans([orphan(), orphan({ member: 'principalSet://a/b' })], { fetchPolicy });
  assert.equal(calls, 1);
  assert.equal(same.results.filter((r) => r.status === 'covered_opentofu').length, 2);

  calls = 0;
  const many = ['a', 'b', 'c'].map((n) => orphan({ iamTarget: `bucket/${n}` }));
  const capped = await verifyIamOrphans(many, { fetchPolicy, maxCalls: 2 });
  assert.equal(calls, 2);
  assert.match(capped.results[2].verification, /^skipped/);
  assert.match(capped.warnings.at(-1), /capped/);
});

test('state IAM declarations carry target/role/member for verification', () => {
  const { resources } = state('google_project_iam_member', { role: 'roles/viewer', member: 'user:a@example.com' });
  assert.deepEqual([resources[0].iamTarget, resources[0].role, resources[0].member], [`project/${P}`, 'roles/viewer', 'user:a@example.com']);
});
