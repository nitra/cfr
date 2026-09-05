import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export function resourceKey({ project, kind, id }) {
  return `${project}\u0000${kind}\u0000${id}`;
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

const TOFU_TYPES = {
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
};

export function normalizeTofuState(state, source) {
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
    const normalized = normalize(resource.values || {});
    if (!normalized.project || !normalized.id) {
      throw new Error(`${source}: cannot normalize ${resource.address}`);
    }
    resources.push({ ...normalized, controller: 'opentofu', source, address: resource.address });
  }
  return { resources, diagnostics };
}

export function collectOpenTofu(paths, spawn = spawnSync) {
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
    const normalized = normalizeTofuState(JSON.parse(result.stdout), path);
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
