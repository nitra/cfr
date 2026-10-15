import test from 'node:test';
import assert from 'node:assert/strict';
import { liveIamPolicyResources, projectNumberFromAssets } from '../lib/get-resources.mjs';
import { classifyResources, normalizeTofuState } from '../lib/controller-inventory.mjs';

const NUMBER = '123456789012';
const secretPolicy = (secret, bindings) => ({
  assetType: 'secretmanager.googleapis.com/Secret',
  resource: `//secretmanager.googleapis.com/projects/${NUMBER}/secrets/${secret}`,
  policy: { bindings },
});
const SA = 'serviceAccount:sync@demo.iam.gserviceaccount.com';

function stateOf(resources) {
  return normalizeTofuState({ values: { root_module: { resources } } }, 'root', { defaultProject: 'demo' });
}

test('secret IAM member: project number in live name matches project ID in state', () => {
  assert.equal(projectNumberFromAssets([{ project: `projects/${NUMBER}` }, { project: `projects/${NUMBER}` }, {}]), NUMBER);
  assert.equal(projectNumberFromAssets([{ project: 'projects/1' }, { project: 'projects/2' }]), undefined);

  const live = liveIamPolicyResources([
    secretPolicy('db-url', [{ role: 'roles/secretmanager.secretAccessor', members: [SA] }]),
    secretPolicy('db-url-orphaned', [{ role: 'roles/secretmanager.secretAccessor', members: [SA] }]),
  ], 'demo', false, NUMBER).map((r) => ({ ...r, kind: 'IAMPolicyMember', project: 'demo' }));
  const state = stateOf([{
    mode: 'managed', type: 'google_secret_manager_secret_iam_member', address: 'google_secret_manager_secret_iam_member.a',
    values: { secret_id: 'projects/demo/secrets/db-url', role: 'roles/secretmanager.secretAccessor', member: SA },
  }]);
  assert.deepEqual(state.diagnostics, []);
  const status = Object.fromEntries(classifyResources(live, state.resources).map((r) => [r.id.split('/secrets/')[1].split('/')[0], r.status]));
  assert.deepEqual(status, { 'db-url': 'covered_opentofu', 'db-url-orphaned': 'uncovered' });
});

test('secret IAM member absent from live stays orphan; without number the live id is left as is', () => {
  const state = stateOf([{
    mode: 'managed', type: 'google_secret_manager_secret_iam_member', address: 'x.y',
    values: { secret_id: 'projects/demo/secrets/gone', role: 'roles/secretmanager.secretAccessor', member: SA },
  }]);
  assert.deepEqual(classifyResources([], state.resources).map((r) => r.status), ['orphan_opentofu']);
  const raw = liveIamPolicyResources([secretPolicy('s', [{ role: 'roles/x', members: [SA] }])], 'demo');
  assert.ok(raw[0].id.includes(`/projects/${NUMBER}/`));
});

test('IAM ids from state and live search agree for WIF, custom-role and viewer bindings (orphan regression)', () => {
  const PROJECT = 'demo';
  const WIF = 'principalSet://iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/pool/attribute.job_scope/plan';
  const live = liveIamPolicyResources([
    { assetType: 'iam.googleapis.com/ServiceAccount', resource: '//iam.googleapis.com/projects/demo/serviceAccounts/plan@demo.iam.gserviceaccount.com',
      policy: { bindings: [{ role: 'roles/iam.workloadIdentityUser', members: [WIF] }] } },
    { assetType: 'cloudresourcemanager.googleapis.com/Project', resource: '//cloudresourcemanager.googleapis.com/projects/demo',
      policy: { bindings: [
        { role: 'roles/container.clusterViewer', members: ['serviceAccount:pub@demo.iam.gserviceaccount.com'] },
        { role: 'projects/demo/roles/readRole', members: ['serviceAccount:pub@demo.iam.gserviceaccount.com'] },
      ] } },
  ], PROJECT, false, NUMBER).map((r) => ({ ...r, kind: 'IAMPolicyMember', project: PROJECT }));
  const state = stateOf([
    { mode: 'managed', type: 'google_service_account_iam_member', address: 'a',
      values: { service_account_id: 'projects/demo/serviceAccounts/plan@demo.iam.gserviceaccount.com', role: 'roles/iam.workloadIdentityUser', member: WIF } },
    { mode: 'managed', type: 'google_project_iam_member', address: 'b',
      values: { project: 'demo', role: 'roles/container.clusterViewer', member: 'serviceAccount:pub@demo.iam.gserviceaccount.com' } },
    { mode: 'managed', type: 'google_project_iam_member', address: 'c',
      values: { project: 'demo', role: 'projects/demo/roles/readRole', member: 'serviceAccount:pub@demo.iam.gserviceaccount.com' } },
  ]);
  assert.deepEqual(classifyResources(live, state.resources).map((r) => r.status), ['covered_opentofu', 'covered_opentofu', 'covered_opentofu']);
});
