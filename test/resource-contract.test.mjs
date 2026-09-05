import test from 'node:test';
import assert from 'node:assert/strict';
import { KIND_ORDER } from '../lib/get-resources.mjs';
import { CRD_GVR } from '../lib/k8s-rest.mjs';

test('Cloud Run, trigger, dependency, and frontend inventory kinds have KCC GVRs', () => {
  const expected = [
    'RunService', 'RunJob', 'CloudSchedulerJob', 'EventarcTrigger',
    'PubSubTopic', 'PubSubSubscription', 'SecretManagerSecret',
    'VPCAccessConnector', 'ComputeNetwork', 'ComputeSubnetwork',
    'KMSCryptoKey', 'ComputeBackendService', 'ComputeNetworkEndpointGroup',
    'ComputeURLMap', 'ComputeTargetHTTPSProxy', 'ComputeGlobalForwardingRule',
    'ComputeSSLCertificate',
  ];
  for (const kind of expected) {
    assert.ok(KIND_ORDER.includes(kind), `${kind} is reported`);
    assert.match(CRD_GVR[kind].group, /\.cnrm\.cloud\.google\.com$/);
    assert.ok(CRD_GVR[kind].plural);
  }
});

test('Workload Identity pool and provider have inventory kinds and KCC GVRs', () => {
  for (const kind of ['IAMWorkloadIdentityPool', 'IAMWorkloadIdentityPoolProvider']) {
    assert.ok(KIND_ORDER.includes(kind), `${kind} is reported`);
    assert.equal(CRD_GVR[kind].group, 'iam.cnrm.cloud.google.com');
    assert.ok(CRD_GVR[kind].plural);
  }
});
