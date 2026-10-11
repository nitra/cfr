import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { KIND_ORDER } from '../lib/get-resources.mjs';

test('cloud resource identities remain supported independently of Kubernetes CRDs', () => {
  for (const kind of ['RunService', 'RunJob', 'CloudSchedulerJob', 'EventarcTrigger',
    'PubSubTopic', 'PubSubSubscription', 'SecretManagerSecret', 'VPCAccessConnector',
    'ComputeNetwork', 'ComputeSubnetwork', 'KMSCryptoKey', 'ComputeBackendService',
    'ComputeNetworkEndpointGroup', 'ComputeURLMap', 'ComputeTargetHTTPSProxy',
    'ComputeGlobalForwardingRule', 'ComputeSSLCertificate', 'IAMWorkloadIdentityPool',
    'IAMWorkloadIdentityPoolProvider']) assert.ok(KIND_ORDER.includes(kind), kind);
});

test('runtime contains no Kubernetes transport or KCC inventory implementation', () => {
  const directory = new URL('../lib/', import.meta.url);
  const files = readdirSync(directory);
  assert.ok(!files.includes('k8s-rest.mjs'));
  assert.ok(!files.includes('kcc-inventory.mjs'));
  for (const file of files) {
    assert.doesNotMatch(readFileSync(new URL(file, directory), 'utf8'), /listCustomObjects|projectForNamespace|collectNamespace|covered_kcc/);
  }
});
