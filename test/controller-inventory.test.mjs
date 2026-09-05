import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyResources,
  collectOpenTofu,
  normalizeTofuState,
  parseOwnership,
} from '../lib/controller-inventory.mjs';

const pool = {
  project: 'nitraai',
  kind: 'IAMWorkloadIdentityPool',
  id: 'global/forgejo-pool',
};

test('merges KCC, OpenTofu, and ownership and leaves only the remainder uncovered', () => {
  const live = [
    pool,
    { project: 'nitraai', kind: 'StorageBucket', id: 'state' },
    { project: 'nitraai', kind: 'StorageBucket', id: 'unmanaged' },
  ];
  const declarations = [
    { ...pool, controller: 'opentofu', source: 'tofu' },
    { project: 'nitraai', kind: 'StorageBucket', id: 'state', controller: 'ownership', owner: 'bootstrap', source: 'ownership.json' },
  ];

  const results = classifyResources(live, declarations);
  assert.equal(results.find((item) => item.id === 'global/forgejo-pool').status, 'covered_opentofu');
  assert.equal(results.find((item) => item.id === 'state').status, 'covered_ownership');
  assert.equal(results.find((item) => item.id === 'state').owner, 'bootstrap');
  assert.equal(results.find((item) => item.id === 'unmanaged').status, 'uncovered');
});

test('reports controller-specific orphans', () => {
  const [result] = classifyResources([], [{ ...pool, controller: 'opentofu', source: 'tofu' }]);
  assert.equal(result.status, 'orphan_opentofu');
});

test('rejects overlapping declarations instead of choosing a controller by precedence', () => {
  assert.throws(() => classifyResources([pool], [
    { ...pool, controller: 'kcc', source: 'nitraai' },
    { ...pool, controller: 'opentofu', source: 'tofu' },
  ]), /controller conflict.*kcc and opentofu/);
});

test('normalizes root and child OpenTofu modules and diagnoses unsupported resources', () => {
  const state = {
    values: {
      root_module: {
        resources: [{
          address: 'google_iam_workload_identity_pool.forgejo',
          mode: 'managed',
          type: 'google_iam_workload_identity_pool',
          values: { project: 'nitraai', workload_identity_pool_id: 'forgejo-pool' },
        }],
        child_modules: [{
          resources: [{
            address: 'module.example.google_unknown.resource',
            mode: 'managed',
            type: 'google_unknown',
            values: { project: 'nitraai' },
          }],
        }],
      },
    },
  };

  const result = normalizeTofuState(state, 'infra/tofu');
  assert.deepEqual(result.resources[0], {
    ...pool,
    controller: 'opentofu',
    source: 'infra/tofu',
    address: 'google_iam_workload_identity_pool.forgejo',
  });
  assert.equal(result.diagnostics[0].resourceType, 'google_unknown');
});

test('runs tofu show against every repeatable --tofu directory', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: JSON.stringify({ values: {} }), stderr: '' };
  };
  collectOpenTofu(['one', 'two'], spawn);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'tofu');
  assert.match(calls[0][1][0], /^-chdir=.*one$/);
  assert.deepEqual(calls[0][1].slice(1), ['show', '-json']);
});

test('parses ownership catalogs as explicit ownership coverage', () => {
  const [resource] = parseOwnership(JSON.stringify({
    version: 1,
    resources: [{ ...pool, controller: 'bootstrap', source: 'README.md' }],
  }));
  assert.equal(resource.controller, 'ownership');
  assert.equal(resource.owner, 'bootstrap');
});
