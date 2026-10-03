import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PROJECT_TOFU_TYPES } from './project-assets.mjs';

export function iamConditionKey(condition) {
  if (!condition) return '';
  const normalize = (value) => typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ')
    : '';
  return JSON.stringify({
    title: normalize(condition.title),
    description: normalize(condition.description),
    expression: normalize(condition.expression),
  });
}

export function resourceKey({ project, kind, id, condition }) {
  const conditionKey = kind === 'IAMPolicyMember' ? iamConditionKey(condition) : '';
  return `${project}\u0000${kind}\u0000${id}\u0000${conditionKey}`;
}

function requireString(value, field, index, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${path}: resources[${index}].${field} must be a non-empty string`);
  }
}

export function parseOwnership(text, path = '<ownership>') {
  const parsed = JSON.parse(text);
  if (parsed.version !== 1 || !Array.isArray(parsed.resources)) {
    throw new Error(`${path}: expected version 1 and a resources array`);
  }

  const seen = new Set();
  return parsed.resources.map((resource, index) => {
    for (const field of ['project', 'kind', 'id', 'controller', 'source']) {
      requireString(resource[field], field, index, path);
    }
    const normalized = { ...resource, controller: 'ownership', owner: resource.controller };
    const key = resourceKey(normalized);
    if (seen.has(key)) throw new Error(`${path}: duplicate ownership entry for ${resource.kind}/${resource.id}`);
    seen.add(key);
    return normalized;
  });
}

export function loadOwnership(paths) {
  return paths.flatMap((path) => parseOwnership(readFileSync(resolve(path), 'utf8'), path));
}

function flattenModules(module, resources = []) {
  if (!module) return resources;
  resources.push(...(module.resources || []));
  for (const child of module.child_modules || []) flattenModules(child, resources);
  return resources;
}

function scopedId(...parts) {
  return parts.every((part) => typeof part === 'string' && part) ? parts.join('/') : undefined;
}

function leaf(value) {
  return typeof value === 'string' ? value.split('/').filter(Boolean).at(-1) : undefined;
}

function globalOrRegionalId(values) {
  return scopedId(values.region || 'global', leaf(values.name));
}

function kmsCryptoKeyId(values) {
  const keyRing = typeof values.key_ring === 'string' ? values.key_ring : values.id;
  const match = keyRing && keyRing.match(/\/locations\/([^/]+)\/keyRings\/([^/]+)/);
  return match && scopedId(match[1], match[2], leaf(values.name || values.id));
}

function resourceLocation(values) {
  if (typeof values.location === 'string' && values.location) return values.location;
  if (typeof values.region === 'string' && values.region) return values.region;
  const resourceName = typeof values.id === 'string' ? values.id : values.name;
  const match = typeof resourceName === 'string' && resourceName.match(/\/locations\/([^/]+)\//);
  return match && match[1];
}

function computeLocation(values) {
  if (typeof values.zone === 'string' && values.zone) return leaf(values.zone);
  if (typeof values.region === 'string' && values.region) return leaf(values.region);
  const match = typeof values.id === 'string' && values.id.match(/\/(?:zones|regions)\/([^/]+)\//);
  return match && match[1];
}

function cloudRunServiceName(values) {
  const metadata = Array.isArray(values.metadata) ? values.metadata[0] : values.metadata;
  return leaf((metadata && metadata.name) || values.name || values.id);
}

function projectFromResourceName(value, fallback) {
  const match = typeof value === 'string' && value.match(/(?:^|\/)projects\/([^/]+)/);
  return match ? match[1] : fallback;
}

function conditionFromState(values) {
  const condition = Array.isArray(values.condition) ? values.condition[0] : values.condition;
  if (!condition || typeof condition !== 'object') return undefined;
  return {
    ...(typeof condition.title === 'string' ? { title: condition.title } : {}),
    ...(typeof condition.description === 'string' ? { description: condition.description } : {}),
    ...(typeof condition.expression === 'string' ? { expression: condition.expression } : {}),
  };
}

function iamBindingResources(values, target, members) {
  const condition = conditionFromState(values);
  return members.filter((member) => typeof member === 'string' && member).map((member) => ({
    project: values.project,
    kind: 'IAMPolicyMember',
    id: scopedId(target, values.role, member),
    ...(condition ? { condition } : {}),
  }));
}

function iamMemberResources(values, target) {
  const members = Array.isArray(values.members)
    ? values.members
    : [values.member];
  return iamBindingResources(values, target, members);
}

function iamPolicyResources(values, target) {
  if (typeof values.policy_data !== 'string') {
    return unsupported('policy_data is absent from OpenTofu state');
  }
  const policy = JSON.parse(values.policy_data);
  return (policy.bindings || []).flatMap((binding) => iamBindingResources({
    ...values,
    role: binding.role,
    condition: binding.condition,
  }, target, binding.members || []));
}

function serviceAccountIamTarget(values) {
  const serviceAccount = values.service_account_id || values.service_account;
  return `sa/${leaf(serviceAccount)}`;
}

function serviceAccountIamValues(values) {
  const serviceAccount = values.service_account_id || values.service_account;
  return { ...values, project: projectFromResourceName(serviceAccount, values.project) };
}

function artifactRegistryIamTarget(values) {
  return `ar/${leaf(values.repository)}`;
}

function cloudRunIamTarget(values) {
  return scopedId('run-service', resourceLocation(values), leaf(values.service || values.name || values.id));
}

function unsupported(reason) {
  return { unsupported: reason };
}

function serverlessNeg(values) {
  const type = values.network_endpoint_type || 'SERVERLESS';
  if (type !== 'SERVERLESS') {
    return unsupported(`network_endpoint_type ${type} is outside the serverless NEG inventory`);
  }
  return {
    project: values.project,
    kind: 'ComputeNetworkEndpointGroup',
    id: globalOrRegionalId(values),
  };
}

const TOFU_TYPES = {
  ...PROJECT_TOFU_TYPES,
  google_iam_workload_identity_pool(values) {
    return {
      project: values.project,
      kind: 'IAMWorkloadIdentityPool',
      id: `global/${values.workload_identity_pool_id}`,
    };
  },
  google_iam_workload_identity_pool_provider(values) {
    return {
      project: values.project,
      kind: 'IAMWorkloadIdentityPoolProvider',
      id: `global/${values.workload_identity_pool_id}/${values.workload_identity_pool_provider_id}`,
    };
  },
  google_storage_bucket(values) {
    return { project: values.project, kind: 'StorageBucket', id: values.name };
  },
  google_artifact_registry_repository(values) {
    return {
      project: values.project,
      kind: 'ArtifactRegistryRepository',
      id: `${values.location}/${values.repository_id}`,
    };
  },
  google_container_cluster(values) {
    return {
      project: values.project,
      kind: 'ContainerCluster',
      id: scopedId(values.location, values.name),
    };
  },
  google_container_node_pool(values) {
    const cluster = typeof values.cluster === 'string' ? values.cluster.split('/').at(-1) : undefined;
    return {
      project: values.project,
      kind: 'ContainerNodePool',
      id: scopedId(values.location, cluster, values.name),
    };
  },
  google_service_account(values) {
    return { project: values.project, kind: 'IAMServiceAccount', id: values.email };
  },
  google_service_account_key(values) {
    return { project: values.project, kind: 'IAMServiceAccountKey', id: leaf(values.name || values.id) };
  },
  google_compute_address(values) {
    return { project: values.project, kind: 'ComputeAddress', id: globalOrRegionalId(values) };
  },
  google_compute_global_address(values) {
    return { project: values.project, kind: 'ComputeAddress', id: scopedId('global', leaf(values.name)) };
  },
  google_compute_disk(values) {
    return {
      project: values.project,
      kind: 'ComputeDisk',
      id: scopedId(computeLocation(values), leaf(values.name)),
    };
  },
  google_compute_router(values) {
    return {
      project: values.project,
      kind: 'ComputeRouter',
      id: scopedId(computeLocation(values), leaf(values.name)),
    };
  },
  google_compute_router_nat(values) {
    return {
      project: values.project,
      kind: 'ComputeRouterNAT',
      id: scopedId(computeLocation(values) || values.id?.match(/^[^/]+\/([^/]+)\/[^/]+\/[^/]+$/)?.[1], leaf(values.router), leaf(values.name)),
    };
  },
  google_gke_backup_backup_plan(values) {
    return {
      project: values.project,
      kind: 'GKEBackupPlan',
      id: scopedId(resourceLocation(values), leaf(values.name)),
    };
  },
  google_cloudbuild_trigger(values) {
    return {
      project: values.project,
      kind: 'CloudBuildTrigger',
      id: scopedId(values.location || 'global', values.trigger_id || leaf(values.id)),
    };
  },
  google_dns_managed_zone(values) {
    return { project: values.project, kind: 'DNSManagedZone', id: leaf(values.name) };
  },
  google_dns_record_set(values) {
    return {
      project: values.project,
      kind: 'DNSRecordSet',
      id: scopedId(leaf(values.managed_zone), values.name, values.type),
    };
  },
  google_pubsub_topic(values) {
    return { project: values.project, kind: 'PubSubTopic', id: values.id };
  },
  google_pubsub_subscription(values) {
    return { project: values.project, kind: 'PubSubSubscription', id: values.id };
  },
  google_secret_manager_secret(values) {
    return { project: values.project, kind: 'SecretManagerSecret', id: leaf(values.secret_id) };
  },
  google_vpc_access_connector(values) {
    return {
      project: values.project,
      kind: 'VPCAccessConnector',
      id: scopedId(values.region, leaf(values.name)),
    };
  },
  google_compute_network(values) {
    return { project: values.project, kind: 'ComputeNetwork', id: scopedId('global', leaf(values.name)) };
  },
  google_compute_subnetwork(values) {
    return {
      project: values.project,
      kind: 'ComputeSubnetwork',
      id: scopedId(values.region, leaf(values.name)),
    };
  },
  google_kms_crypto_key(values) {
    return { project: values.project, kind: 'KMSCryptoKey', id: kmsCryptoKeyId(values) };
  },
  google_cloud_run_service(values) {
    return {
      project: values.project,
      kind: 'RunService',
      id: scopedId(resourceLocation(values), cloudRunServiceName(values)),
    };
  },
  google_cloud_run_v2_service(values) {
    return {
      project: values.project,
      kind: 'RunService',
      id: scopedId(resourceLocation(values), cloudRunServiceName(values)),
    };
  },
  google_cloud_run_v2_job(values) {
    return {
      project: values.project,
      kind: 'RunJob',
      id: scopedId(resourceLocation(values), leaf(values.name || values.id)),
    };
  },
  google_cloud_scheduler_job(values) {
    return {
      project: values.project,
      kind: 'CloudSchedulerJob',
      id: scopedId(resourceLocation(values), leaf(values.name || values.id)),
    };
  },
  google_eventarc_trigger(values) {
    return {
      project: values.project,
      kind: 'EventarcTrigger',
      id: scopedId(resourceLocation(values), leaf(values.name || values.id)),
    };
  },
  google_project_iam_member(values) {
    return iamMemberResources(values, scopedId('project', values.project));
  },
  google_project_iam_binding(values) {
    return iamMemberResources(values, scopedId('project', values.project));
  },
  google_project_iam_policy(values) {
    return iamPolicyResources(values, scopedId('project', values.project));
  },
  google_storage_bucket_iam_member(values) {
    return iamMemberResources(values, `bucket/${leaf(values.bucket)}`);
  },
  google_storage_bucket_iam_binding(values) {
    return iamMemberResources(values, `bucket/${leaf(values.bucket)}`);
  },
  google_storage_bucket_iam_policy(values) {
    return iamPolicyResources(values, `bucket/${leaf(values.bucket)}`);
  },
  google_service_account_iam_member(values) {
    const scopedValues = serviceAccountIamValues(values);
    return iamMemberResources(scopedValues, serviceAccountIamTarget(scopedValues));
  },
  google_service_account_iam_binding(values) {
    const scopedValues = serviceAccountIamValues(values);
    return iamMemberResources(scopedValues, serviceAccountIamTarget(scopedValues));
  },
  google_service_account_iam_policy(values) {
    const scopedValues = serviceAccountIamValues(values);
    return iamPolicyResources(scopedValues, serviceAccountIamTarget(scopedValues));
  },
  google_artifact_registry_repository_iam_member(values) {
    return iamMemberResources(values, artifactRegistryIamTarget(values));
  },
  google_artifact_registry_repository_iam_binding(values) {
    return iamMemberResources(values, artifactRegistryIamTarget(values));
  },
  google_artifact_registry_repository_iam_policy(values) {
    return iamPolicyResources(values, artifactRegistryIamTarget(values));
  },
  google_cloud_run_service_iam_member(values) {
    return iamMemberResources(values, cloudRunIamTarget(values));
  },
  google_cloud_run_service_iam_binding(values) {
    return iamMemberResources(values, cloudRunIamTarget(values));
  },
  google_cloud_run_service_iam_policy(values) {
    return iamPolicyResources(values, cloudRunIamTarget(values));
  },
  google_cloud_run_v2_service_iam_member(values) {
    return iamMemberResources(values, cloudRunIamTarget(values));
  },
  google_cloud_run_v2_service_iam_binding(values) {
    return iamMemberResources(values, cloudRunIamTarget(values));
  },
  google_cloud_run_v2_service_iam_policy(values) {
    return iamPolicyResources(values, cloudRunIamTarget(values));
  },
  google_compute_backend_service(values) {
    return {
      project: values.project,
      kind: 'ComputeBackendService',
      id: scopedId('global', leaf(values.name)),
    };
  },
  google_compute_region_backend_service(values) {
    return {
      project: values.project,
      kind: 'ComputeBackendService',
      id: scopedId(values.region, leaf(values.name)),
    };
  },
  google_compute_region_network_endpoint_group(values) {
    return serverlessNeg(values);
  },
  google_compute_global_network_endpoint_group(values) {
    return serverlessNeg(values);
  },
  google_compute_url_map(values) {
    return {
      project: values.project,
      kind: 'ComputeURLMap',
      id: scopedId('global', leaf(values.name)),
    };
  },
  google_compute_region_url_map(values) {
    return {
      project: values.project,
      kind: 'ComputeURLMap',
      id: scopedId(values.region, leaf(values.name)),
    };
  },
  google_compute_target_https_proxy(values) {
    return {
      project: values.project,
      kind: 'ComputeTargetHTTPSProxy',
      id: scopedId('global', leaf(values.name)),
    };
  },
  google_compute_region_target_https_proxy(values) {
    return {
      project: values.project,
      kind: 'ComputeTargetHTTPSProxy',
      id: scopedId(values.region, leaf(values.name)),
    };
  },
  google_compute_global_forwarding_rule(values) {
    return {
      project: values.project,
      kind: 'ComputeGlobalForwardingRule',
      id: scopedId('global', leaf(values.name)),
    };
  },
  google_compute_ssl_certificate(values) {
    return {
      project: values.project,
      kind: 'ComputeSSLCertificate',
      id: scopedId('global', leaf(values.name)),
    };
  },
  google_compute_managed_ssl_certificate(values) {
    return {
      project: values.project,
      kind: 'ComputeSSLCertificate',
      id: scopedId('global', leaf(values.name)),
    };
  },
  google_compute_region_ssl_certificate(values) {
    return {
      project: values.project,
      kind: 'ComputeSSLCertificate',
      id: scopedId(values.region, leaf(values.name)),
    };
  },
};

export function normalizeTofuState(state, source, { defaultProject } = {}) {
  const resources = [];
  const diagnostics = [];
  for (const resource of flattenModules(state.values && state.values.root_module)) {
    if (resource.mode !== 'managed' || !resource.type.startsWith('google_')) continue;
    const normalize = TOFU_TYPES[resource.type];
    if (!normalize) {
      diagnostics.push({
        type: 'unsupported-controller-resource',
        controller: 'opentofu',
        resourceType: resource.type,
        address: resource.address,
        source,
      });
      continue;
    }
    const values = { ...(resource.values || {}) };
    if (!values.project) values.project = defaultProject;
    const normalized = normalize(values);
    if (normalized && normalized.unsupported) {
      diagnostics.push({
        type: 'unsupported-controller-resource',
        controller: 'opentofu',
        resourceType: resource.type,
        address: resource.address,
        source,
        reason: normalized.unsupported,
      });
      continue;
    }
    const normalizedResources = Array.isArray(normalized) ? normalized : [normalized];
    if (normalizedResources.some((entry) => !entry || !entry.project || !entry.id)) {
      throw new Error(`${source}: cannot normalize ${resource.address}`);
    }
    resources.push(...normalizedResources.map((entry) => ({
      ...entry,
      controller: 'opentofu',
      source,
      address: resource.address,
    })));
  }
  return { resources, diagnostics };
}

export function collectOpenTofu(paths, { defaultProject } = {}, spawn = spawnSync) {
  const resources = [];
  const diagnostics = [];
  for (const path of paths) {
    const directory = resolve(path);
    const result = spawn('tofu', [`-chdir=${directory}`, 'show', '-json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error) throw new Error(`${path}: cannot run tofu: ${result.error.message}`);
    if (result.status !== 0) throw new Error(result.stderr.trim() || `${path}: tofu show failed`);
    const normalized = normalizeTofuState(JSON.parse(result.stdout), path, { defaultProject });
    resources.push(...normalized.resources);
    diagnostics.push(...normalized.diagnostics);
  }
  return { resources, diagnostics };
}

export function classifyResources(live, declarations) {
  const liveByKey = new Map(live.map((resource) => [resourceKey(resource), resource]));
  const declaredByKey = new Map();

  for (const declaration of declarations) {
    const key = resourceKey(declaration);
    const existing = declaredByKey.get(key);
    if (existing) {
      throw new Error(
        `controller conflict for ${declaration.project}/${declaration.kind}/${declaration.id}: `
        + `${existing.controller} and ${declaration.controller}`,
      );
    }
    declaredByKey.set(key, declaration);
  }

  const results = [];
  for (const [key, resource] of liveByKey) {
    const declaration = declaredByKey.get(key);
    results.push(declaration
      ? { ...resource, status: `covered_${declaration.controller}`, source: declaration.source, owner: declaration.owner }
      : { ...resource, status: 'uncovered' });
  }
  for (const [key, declaration] of declaredByKey) {
    if (!liveByKey.has(key)) results.push({ ...declaration, status: `orphan_${declaration.controller}` });
  }
  return results;
}
