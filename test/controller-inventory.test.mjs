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

test('keeps IAM bindings with distinct conditions as separate resources', () => {
  const base = {
    project: 'nitraai',
    kind: 'IAMPolicyMember',
    id: 'project/nitraai/roles/iam.workloadIdentityPoolAdmin/serviceAccount:kcc-nitraai@nitraai.iam.gserviceaccount.com',
  };
  const live = [
    { ...base, condition: { title: 'provider-only', expression: 'resource.name == provider' } },
    { ...base, condition: { title: 'pool-and-provider', expression: 'resource.name == pool || resource.name == provider' } },
  ];

  const results = classifyResources(live, []);

  assert.equal(results.length, 2);
  assert.deepEqual(results.map((resource) => resource.condition.title), [
    'provider-only',
    'pool-and-provider',
  ]);
  assert.ok(results.every((resource) => resource.status === 'uncovered'));
});

test('normalizes condition whitespace when matching KCC and live IAM bindings', () => {
  const base = {
    project: 'nitraai',
    kind: 'IAMPolicyMember',
    id: 'project/nitraai/roles/viewer/user:reader@example.com',
  };
  const [result] = classifyResources(
    [{ ...base, condition: { title: 'scoped', expression: 'resource.name == provider' } }],
    [{
      ...base,
      controller: 'kcc',
      source: 'nitraai',
      condition: { title: ' scoped ', expression: 'resource.name   ==   provider' },
    }],
  );

  assert.equal(result.status, 'covered_kcc');
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

test('normalizes OpenTofu GKE resources to canonical inventory IDs', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          {
            address: 'google_container_cluster.main',
            mode: 'managed',
            type: 'google_container_cluster',
            values: { project: 'nitraai', location: 'us-central1-a', name: 'main' },
          },
          {
            address: 'google_container_node_pool.pools["general-arm64"]',
            mode: 'managed',
            type: 'google_container_node_pool',
            values: {
              project: 'nitraai',
              location: 'us-central1-a',
              cluster: 'projects/nitraai/locations/us-central1-a/clusters/main',
              name: 'general-arm64',
            },
          },
        ],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/gke-main');
  assert.deepEqual(result.resources.map(({ kind, id }) => ({ kind, id })), [
    { kind: 'ContainerCluster', id: 'us-central1-a/main' },
    { kind: 'ContainerNodePool', id: 'us-central1-a/main/general-arm64' },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('normalizes basic GCP resources and uses the explicit inventory project as a provider fallback', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          { address: 'google_service_account.app', mode: 'managed', type: 'google_service_account', values: { email: 'app@nitraai.iam.gserviceaccount.com' } },
          { address: 'google_service_account_key.app', mode: 'managed', type: 'google_service_account_key', values: { name: 'projects/nitraai/serviceAccounts/app@nitraai.iam.gserviceaccount.com/keys/key-1' } },
          { address: 'google_compute_address.public', mode: 'managed', type: 'google_compute_address', values: { region: 'europe-west4', name: 'public' } },
          { address: 'google_compute_global_address.private', mode: 'managed', type: 'google_compute_global_address', values: { name: 'private' } },
          { address: 'google_dns_managed_zone.main', mode: 'managed', type: 'google_dns_managed_zone', values: { name: 'main-zone' } },
          { address: 'google_dns_record_set.txt', mode: 'managed', type: 'google_dns_record_set', values: { managed_zone: 'main-zone', name: 'app.example.com.', type: 'TXT' } },
          { address: 'google_pubsub_topic.events', mode: 'managed', type: 'google_pubsub_topic', values: { id: 'projects/nitraai/topics/events' } },
          { address: 'google_pubsub_subscription.events', mode: 'managed', type: 'google_pubsub_subscription', values: { id: 'projects/nitraai/subscriptions/events' } },
          { address: 'google_secret_manager_secret.token', mode: 'managed', type: 'google_secret_manager_secret', values: { secret_id: 'api-token' } },
          { address: 'google_vpc_access_connector.run', mode: 'managed', type: 'google_vpc_access_connector', values: { region: 'europe-west4', name: 'run' } },
          { address: 'google_compute_network.platform', mode: 'managed', type: 'google_compute_network', values: { name: 'platform' } },
          { address: 'google_compute_subnetwork.platform', mode: 'managed', type: 'google_compute_subnetwork', values: { region: 'europe-west4', name: 'platform' } },
          { address: 'google_kms_crypto_key.app', mode: 'managed', type: 'google_kms_crypto_key', values: { key_ring: 'projects/nitraai/locations/europe-west4/keyRings/app', name: 'data' } },
        ],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/gcp', { defaultProject: 'nitraai' });
  assert.deepEqual(result.resources.map(({ project, kind, id }) => ({ project, kind, id })), [
    { project: 'nitraai', kind: 'IAMServiceAccount', id: 'app@nitraai.iam.gserviceaccount.com' },
    { project: 'nitraai', kind: 'IAMServiceAccountKey', id: 'key-1' },
    { project: 'nitraai', kind: 'ComputeAddress', id: 'europe-west4/public' },
    { project: 'nitraai', kind: 'ComputeAddress', id: 'global/private' },
    { project: 'nitraai', kind: 'DNSManagedZone', id: 'main-zone' },
    { project: 'nitraai', kind: 'DNSRecordSet', id: 'main-zone/app.example.com./TXT' },
    { project: 'nitraai', kind: 'PubSubTopic', id: 'projects/nitraai/topics/events' },
    { project: 'nitraai', kind: 'PubSubSubscription', id: 'projects/nitraai/subscriptions/events' },
    { project: 'nitraai', kind: 'SecretManagerSecret', id: 'api-token' },
    { project: 'nitraai', kind: 'VPCAccessConnector', id: 'europe-west4/run' },
    { project: 'nitraai', kind: 'ComputeNetwork', id: 'global/platform' },
    { project: 'nitraai', kind: 'ComputeSubnetwork', id: 'europe-west4/platform' },
    { project: 'nitraai', kind: 'KMSCryptoKey', id: 'europe-west4/app/data' },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('normalizes Cloud Run, Scheduler, and Eventarc state to live GCP identities', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          { address: 'google_cloud_run_service.v1', mode: 'managed', type: 'google_cloud_run_service', values: { project: 'nitraai', location: 'europe-west4', metadata: [{ name: 'legacy' }] } },
          { address: 'google_cloud_run_v2_service.v2', mode: 'managed', type: 'google_cloud_run_v2_service', values: { project: 'nitraai', location: 'europe-west4', name: 'modern' } },
          { address: 'google_cloud_run_v2_job.cleanup', mode: 'managed', type: 'google_cloud_run_v2_job', values: { project: 'nitraai', name: 'projects/nitraai/locations/europe-west4/jobs/cleanup' } },
          { address: 'google_cloud_scheduler_job.daily', mode: 'managed', type: 'google_cloud_scheduler_job', values: { project: 'nitraai', region: 'europe-west4', name: 'daily' } },
          { address: 'google_eventarc_trigger.upload', mode: 'managed', type: 'google_eventarc_trigger', values: { project: 'nitraai', location: 'europe-west4', name: 'upload' } },
        ],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/serverless');
  assert.deepEqual(result.resources.map(({ kind, id }) => ({ kind, id })), [
    { kind: 'RunService', id: 'europe-west4/legacy' },
    { kind: 'RunService', id: 'europe-west4/modern' },
    { kind: 'RunJob', id: 'europe-west4/cleanup' },
    { kind: 'CloudSchedulerJob', id: 'europe-west4/daily' },
    { kind: 'EventarcTrigger', id: 'europe-west4/upload' },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('normalizes legacy GKE adoption resources to live GCP identities', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          { address: 'google_compute_disk.mysql', mode: 'managed', type: 'google_compute_disk', values: { project: 'nitraai', zone: 'europe-west4-b', name: 'pvc-mysql' } },
          { address: 'google_compute_router.egress', mode: 'managed', type: 'google_compute_router', values: { project: 'nitraai', region: 'europe-west4', name: 'egress' } },
          { address: 'google_compute_router_nat.egress', mode: 'managed', type: 'google_compute_router_nat', values: { project: 'nitraai', region: 'europe-west4', router: 'egress', name: 'outward' } },
          { address: 'google_gke_backup_backup_plan.daily', mode: 'managed', type: 'google_gke_backup_backup_plan', values: { project: 'nitraai', location: 'europe-west4', name: 'daily' } },
          { address: 'google_cloudbuild_trigger.app', mode: 'managed', type: 'google_cloudbuild_trigger', values: { project: 'nitraai', location: 'global', trigger_id: 'trigger-id' } },
        ],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/legacy-gke');
  assert.deepEqual(result.resources.map(({ kind, id }) => ({ kind, id })), [
    { kind: 'ComputeDisk', id: 'europe-west4-b/pvc-mysql' },
    { kind: 'ComputeRouter', id: 'europe-west4/egress' },
    { kind: 'ComputeRouterNAT', id: 'europe-west4/egress/outward' },
    { kind: 'GKEBackupPlan', id: 'europe-west4/daily' },
    { kind: 'CloudBuildTrigger', id: 'global/trigger-id' },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('expands OpenTofu IAM members, bindings, and policies to canonical bindings', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          { address: 'google_project_iam_member.viewer', mode: 'managed', type: 'google_project_iam_member', values: { project: 'nitraai', role: 'roles/viewer', member: 'user:reader@example.com' } },
          { address: 'google_project_iam_binding.editor', mode: 'managed', type: 'google_project_iam_binding', values: { project: 'nitraai', role: 'roles/editor', members: ['user:one@example.com', 'user:two@example.com'], condition: [{ title: 'expires', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' }] } },
          { address: 'google_storage_bucket_iam_policy.state', mode: 'managed', type: 'google_storage_bucket_iam_policy', values: { project: 'nitraai', bucket: 'state-bucket', policy_data: JSON.stringify({ bindings: [{ role: 'roles/storage.objectViewer', members: ['allUsers'] }] }) } },
          { address: 'google_service_account_iam_member.token', mode: 'managed', type: 'google_service_account_iam_member', values: { project: 'wrong-project', service_account_id: 'projects/nitraai/serviceAccounts/app@nitraai.iam.gserviceaccount.com', role: 'roles/iam.serviceAccountTokenCreator', member: 'serviceAccount:runner@nitraai.iam.gserviceaccount.com' } },
          { address: 'google_artifact_registry_repository_iam_binding.reader', mode: 'managed', type: 'google_artifact_registry_repository_iam_binding', values: { project: 'nitraai', repository: 'projects/nitraai/locations/europe-west4/repositories/apps', role: 'roles/artifactregistry.reader', members: ['serviceAccount:reader@nitraai.iam.gserviceaccount.com'] } },
          { address: 'google_cloud_run_v2_service_iam_member.invoker', mode: 'managed', type: 'google_cloud_run_v2_service_iam_member', values: { project: 'nitraai', location: 'europe-west4', name: 'api', role: 'roles/run.invoker', member: 'allUsers' } },
        ],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/iam');
  assert.deepEqual(result.resources.map(({ project, kind, id, condition }) => ({ project, kind, id, condition })), [
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'project/nitraai/roles/viewer/user:reader@example.com', condition: undefined },
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'project/nitraai/roles/editor/user:one@example.com', condition: { title: 'expires', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' } },
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'project/nitraai/roles/editor/user:two@example.com', condition: { title: 'expires', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' } },
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'bucket/state-bucket/roles/storage.objectViewer/allUsers', condition: undefined },
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'sa/app@nitraai.iam.gserviceaccount.com/roles/iam.serviceAccountTokenCreator/serviceAccount:runner@nitraai.iam.gserviceaccount.com', condition: undefined },
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'ar/apps/roles/artifactregistry.reader/serviceAccount:reader@nitraai.iam.gserviceaccount.com', condition: undefined },
    { project: 'nitraai', kind: 'IAMPolicyMember', id: 'run-service/europe-west4/api/roles/run.invoker/allUsers', condition: undefined },
  ]);
  assert.deepEqual(result.diagnostics, []);
});

test('recognizes every supported IAM controller resource variant', () => {
  const types = [
    'google_project_iam_member',
    'google_project_iam_binding',
    'google_project_iam_policy',
    'google_storage_bucket_iam_member',
    'google_storage_bucket_iam_binding',
    'google_storage_bucket_iam_policy',
    'google_service_account_iam_member',
    'google_service_account_iam_binding',
    'google_service_account_iam_policy',
    'google_artifact_registry_repository_iam_member',
    'google_artifact_registry_repository_iam_binding',
    'google_artifact_registry_repository_iam_policy',
    'google_cloud_run_service_iam_member',
    'google_cloud_run_service_iam_binding',
    'google_cloud_run_service_iam_policy',
    'google_cloud_run_v2_service_iam_member',
    'google_cloud_run_v2_service_iam_binding',
    'google_cloud_run_v2_service_iam_policy',
  ];
  const valuesFor = (type) => ({
    project: 'nitraai',
    role: 'roles/viewer',
    member: 'user:reader@example.com',
    members: ['user:reader@example.com'],
    policy_data: JSON.stringify({ bindings: [{ role: 'roles/viewer', members: ['user:reader@example.com'] }] }),
    ...(type.includes('storage_bucket') ? { bucket: 'state' } : {}),
    ...(type.includes('service_account') ? { service_account_id: 'projects/nitraai/serviceAccounts/app@nitraai.iam.gserviceaccount.com' } : {}),
    ...(type.includes('artifact_registry') ? { repository: 'projects/nitraai/locations/europe-west4/repositories/apps' } : {}),
    ...(type.includes('cloud_run') ? { location: 'europe-west4', service: 'api', name: 'api' } : {}),
  });
  const state = {
    values: {
      root_module: {
        resources: types.map((type) => ({
          address: `${type}.test`,
          mode: 'managed',
          type,
          values: valuesFor(type),
        })),
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/iam-variants');
  assert.equal(result.resources.length, types.length);
  assert.ok(result.resources.every((resource) => resource.kind === 'IAMPolicyMember'));
  assert.deepEqual(result.diagnostics, []);
});

test('reports an IAM policy with no policy data as unsupported instead of treating it as empty', () => {
  const state = {
    values: {
      root_module: {
        resources: [{
          address: 'google_project_iam_policy.invalid',
          mode: 'managed',
          type: 'google_project_iam_policy',
          values: { project: 'nitraai' },
        }],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/iam-invalid');
  assert.deepEqual(result.resources, []);
  assert.deepEqual(result.diagnostics, [{
    type: 'unsupported-controller-resource',
    controller: 'opentofu',
    resourceType: 'google_project_iam_policy',
    address: 'google_project_iam_policy.invalid',
    source: 'tofu/iam-invalid',
    reason: 'policy_data is absent from OpenTofu state',
  }]);
});

test('normalizes the global and regional serverless load-balancer chain', () => {
  const state = {
    values: {
      root_module: {
        resources: [
          { address: 'google_compute_backend_service.global', mode: 'managed', type: 'google_compute_backend_service', values: { project: 'nitraai', name: 'global-backend' } },
          { address: 'google_compute_region_backend_service.regional', mode: 'managed', type: 'google_compute_region_backend_service', values: { project: 'nitraai', region: 'europe-west4', name: 'regional-backend' } },
          { address: 'google_compute_region_network_endpoint_group.serverless', mode: 'managed', type: 'google_compute_region_network_endpoint_group', values: { project: 'nitraai', region: 'europe-west4', name: 'serverless-neg', network_endpoint_type: 'SERVERLESS' } },
          { address: 'google_compute_global_network_endpoint_group.serverless', mode: 'managed', type: 'google_compute_global_network_endpoint_group', values: { project: 'nitraai', name: 'global-serverless-neg', network_endpoint_type: 'SERVERLESS' } },
          { address: 'google_compute_url_map.global', mode: 'managed', type: 'google_compute_url_map', values: { project: 'nitraai', name: 'global-map' } },
          { address: 'google_compute_region_url_map.regional', mode: 'managed', type: 'google_compute_region_url_map', values: { project: 'nitraai', region: 'europe-west4', name: 'regional-map' } },
          { address: 'google_compute_target_https_proxy.global', mode: 'managed', type: 'google_compute_target_https_proxy', values: { project: 'nitraai', name: 'global-proxy' } },
          { address: 'google_compute_region_target_https_proxy.regional', mode: 'managed', type: 'google_compute_region_target_https_proxy', values: { project: 'nitraai', region: 'europe-west4', name: 'regional-proxy' } },
          { address: 'google_compute_global_forwarding_rule.https', mode: 'managed', type: 'google_compute_global_forwarding_rule', values: { project: 'nitraai', name: 'https' } },
          { address: 'google_compute_ssl_certificate.global', mode: 'managed', type: 'google_compute_ssl_certificate', values: { project: 'nitraai', name: 'global-cert' } },
          { address: 'google_compute_managed_ssl_certificate.global', mode: 'managed', type: 'google_compute_managed_ssl_certificate', values: { project: 'nitraai', name: 'managed-cert' } },
          { address: 'google_compute_region_ssl_certificate.regional', mode: 'managed', type: 'google_compute_region_ssl_certificate', values: { project: 'nitraai', region: 'europe-west4', name: 'regional-cert' } },
          { address: 'google_compute_region_network_endpoint_group.vm', mode: 'managed', type: 'google_compute_region_network_endpoint_group', values: { project: 'nitraai', region: 'europe-west4', name: 'vm-neg', network_endpoint_type: 'GCE_VM_IP_PORT' } },
        ],
      },
    },
  };

  const result = normalizeTofuState(state, 'tofu/lb');
  assert.deepEqual(result.resources.map(({ kind, id }) => ({ kind, id })), [
    { kind: 'ComputeBackendService', id: 'global/global-backend' },
    { kind: 'ComputeBackendService', id: 'europe-west4/regional-backend' },
    { kind: 'ComputeNetworkEndpointGroup', id: 'europe-west4/serverless-neg' },
    { kind: 'ComputeNetworkEndpointGroup', id: 'global/global-serverless-neg' },
    { kind: 'ComputeURLMap', id: 'global/global-map' },
    { kind: 'ComputeURLMap', id: 'europe-west4/regional-map' },
    { kind: 'ComputeTargetHTTPSProxy', id: 'global/global-proxy' },
    { kind: 'ComputeTargetHTTPSProxy', id: 'europe-west4/regional-proxy' },
    { kind: 'ComputeGlobalForwardingRule', id: 'global/https' },
    { kind: 'ComputeSSLCertificate', id: 'global/global-cert' },
    { kind: 'ComputeSSLCertificate', id: 'global/managed-cert' },
    { kind: 'ComputeSSLCertificate', id: 'europe-west4/regional-cert' },
  ]);
  assert.deepEqual(result.diagnostics, [{
    type: 'unsupported-controller-resource',
    controller: 'opentofu',
    resourceType: 'google_compute_region_network_endpoint_group',
    address: 'google_compute_region_network_endpoint_group.vm',
    source: 'tofu/lb',
    reason: 'network_endpoint_type GCE_VM_IP_PORT is outside the serverless NEG inventory',
  }]);
});

test('runs tofu show against every repeatable --tofu directory', () => {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, args]);
    return { status: 0, stdout: JSON.stringify({ values: {} }), stderr: '' };
  };
  collectOpenTofu(['one', 'two'], {}, spawn);
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
