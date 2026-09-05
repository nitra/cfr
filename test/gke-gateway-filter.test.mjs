import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDefaultNetwork,
  isGkeGatewayManaged,
  isGkeNodePoolName,
  isGkeWorkloadIdentityPool,
  isManagedZoneApexRecord,
} from '../lib/get-resources.mjs';

test('recognizes regional and global GKE Gateway controller resources', () => {
  assert.equal(isGkeGatewayManaged('us-central1/gkegw1-4v0d-adminer-adminer-hl-8080-a1b2c3'), true);
  assert.equal(isGkeGatewayManaged('global/gkegw12-4v0d-gw-main-a1b2c3'), true);
});

test('does not hide similarly scoped user-owned Load Balancer resources', () => {
  assert.equal(isGkeGatewayManaged('us-central1/adminer-backend'), false);
  assert.equal(isGkeGatewayManaged('global/public-url-map'), false);
});

test('recognizes only provider-owned default network and zone-apex records', () => {
  assert.equal(isDefaultNetwork('global/default'), true);
  assert.equal(isDefaultNetwork('global/platform'), false);
  assert.equal(isManagedZoneApexRecord('git.7n.ai.', 'NS', 'git.7n.ai.'), true);
  assert.equal(isManagedZoneApexRecord('git.7n.ai.', 'SOA', 'git.7n.ai.'), true);
  assert.equal(isManagedZoneApexRecord('child.git.7n.ai.', 'NS', 'git.7n.ai.'), false);
});

test('recognizes NodePool resource names that need direct GKE verification', () => {
  assert.equal(isGkeNodePoolName('//container.googleapis.com/projects/nitraai/zones/us-central1-a/clusters/main/nodePools/spin-t2d-benchmark'), true);
  assert.equal(isGkeNodePoolName('projects/nitraai/locations/us-central1-a/clusters/main'), false);
});

test('recognizes the GKE-managed Workload Identity pool', () => {
  assert.equal(isGkeWorkloadIdentityPool({ name: 'projects/123/locations/global/workloadIdentityPools/nitraai.svc.id.goog' }), true);
  assert.equal(isGkeWorkloadIdentityPool({ name: 'projects/123/locations/global/workloadIdentityPools/forgejo-pool' }), false);
});
