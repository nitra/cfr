import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyResources, normalizeTofuState } from '../lib/controller-inventory.mjs';

const state = (type, values) => normalizeTofuState({
  values: { root_module: { resources: [{ address: `${type}.x`, mode: 'managed', type, values }] } },
}, 'infra', { defaultProject: 'demo' }).resources;

test('serverless NEG with a self-link region matches the live regional ID', () => {
  const declared = state('google_compute_region_network_endpoint_group', {
    project: 'demo',
    name: 'api',
    network_endpoint_type: 'SERVERLESS',
    region: 'https://www.googleapis.com/compute/v1/projects/demo/regions/europe-west4',
  });
  const live = [{ project: 'demo', kind: 'ComputeNetworkEndpointGroup', id: 'europe-west4/api', source: 'gcp' }];
  assert.deepEqual(
    classifyResources(live, declared).map((r) => [r.id, r.status]),
    [['europe-west4/api', 'covered_opentofu']],
  );
});

test('short region names keep working', () => {
  const declared = state('google_compute_region_network_endpoint_group', {
    project: 'demo', name: 'api', network_endpoint_type: 'SERVERLESS', region: 'europe-west4',
  });
  assert.equal(declared[0].id, 'europe-west4/api');
});
