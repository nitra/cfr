import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gkeNodePoolScopedId,
  isDefaultNetwork,
  isGkeGatewayManaged,
  isGkeIngressManaged,
  isGkeNodePoolName,
  isGkePrivateEndpointAddress,
  isAutomaticNatAddress,
  gkePrivateEndpointSubnetworkIds,
  isGkeWorkloadIdentityPool,
  isManagedZoneApexRecord,
} from '../lib/get-resources.mjs';

test('controller ownership uses API evidence for NAT addresses and GKE private endpoint subnetworks', () => {
  assert.equal(isAutomaticNatAddress({ purpose: 'NAT_AUTO' }), true);
  assert.equal(isAutomaticNatAddress({ name: 'nat-auto-ip-user', purpose: 'GCE_ENDPOINT' }), false);
  const clusters = [
    { controlPlaneEndpointsConfig: { ipEndpointsConfig: { privateEndpointSubnetwork: 'projects/demo/regions/eu/subnetworks/managed' } } },
    { privateClusterConfig: { privateEndpointSubnetwork: 'projects/demo/regions/eu/subnetworks/legacy' } },
    { privateClusterConfig: { privateEndpointSubnetwork: 'projects/other/regions/eu/subnetworks/shared' } },
    { name: 'gke-looking' },
  ];
  assert.deepEqual([...gkePrivateEndpointSubnetworkIds(clusters, 'demo')], ['eu/managed', 'eu/legacy']);
});

test('recognizes regional and global GKE Gateway controller resources', () => {
  assert.equal(isGkeGatewayManaged('us-central1/gkegw1-4v0d-adminer-adminer-hl-8080-a1b2c3'), true);
  assert.equal(isGkeGatewayManaged('global/gkegw12-4v0d-gw-main-a1b2c3'), true);
});

test('does not hide similarly scoped user-owned Load Balancer resources', () => {
  assert.equal(isGkeGatewayManaged('us-central1/adminer-backend'), false);
  assert.equal(isGkeGatewayManaged('global/public-url-map'), false);
});

test('recognizes GKE Ingress resources without hiding a project-owned IP', () => {
  assert.equal(isGkeIngressManaged('global/k8s2-fr-abcd-default-web-1234'), true);
  assert.equal(isGkeIngressManaged('global/mcrt-12345678-1234-1234-1234-123456789abc'), true);
  assert.equal(isGkeIngressManaged('global/web-static-ip'), false);
  assert.equal(isGkePrivateEndpointAddress('europe-west3/gke-pda-41f03645-803b237c-pe'), true);
  assert.equal(isGkePrivateEndpointAddress('europe-west3/gke-outward-ip'), false);
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

test('keeps the location in canonical GKE NodePool IDs', () => {
  assert.equal(
    gkeNodePoolScopedId('//container.googleapis.com/projects/nitraai/zones/us-central1-a/clusters/main/nodePools/general-arm64'),
    'us-central1-a/main/general-arm64',
  );
  assert.equal(
    gkeNodePoolScopedId('//container.googleapis.com/projects/nitraai/regions/us-central1/clusters/main/nodePools/general-arm64'),
    'us-central1/main/general-arm64',
  );
});

test('recognizes the GKE-managed Workload Identity pool', () => {
  assert.equal(isGkeWorkloadIdentityPool({ name: 'projects/123/locations/global/workloadIdentityPools/nitraai.svc.id.goog' }), true);
  assert.equal(isGkeWorkloadIdentityPool({ name: 'projects/123/locations/global/workloadIdentityPools/forgejo-pool' }), false);
});
