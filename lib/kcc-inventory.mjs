// Diff і звіт над сирим списком з get-resources.mjs: що з GCP-ресурсів
// проєкту реально живе під KCC (описано в git), а що — "чуже" (створено
// повз KCC). Суто читання, нічого не видаляє — вхідний контракт для
// окремого cleanup-рішення, яке вирішує, що з DRIFT можна прибрати.
import { collectNamespace, listKccNamespaces, KIND_ORDER } from './get-resources.mjs';
import {
  classifyResources,
  collectOpenTofu,
  loadOwnership,
} from './controller-inventory.mjs';

export const HELP = `cfr kcc-inventory — GCP Config Connector (KCC) drift inventory

Usage:
  npx @nitra/cfr kcc-inventory <namespace>
  npx @nitra/cfr kcc-inventory --all
  npx @nitra/cfr kcc-inventory <namespace|--all> [options]

Compares, per KCC namespace (namespace carrying the annotation
cnrm.cloud.google.com/project-id), what actually exists in the GCP project
against the union of Config Connector declarations, OpenTofu state, and
explicit ownership catalogs. It covers IAM, Artifact Registry, GKE, Cloud Run, Scheduler,
Eventarc, Pub/Sub, Secret Manager, VPC Access, selected network/LB
resources, KMS, Cloud DNS, and IAMPolicyMember.

Reports resources not covered by any declared controller and declarations
whose live GCP resource is missing. Controller conflicts are hard errors.

By default GCP-managed system noise is filtered out (Google-owned service
accounts, Artifact Registry shims, GCP default network/subnets, GKE-managed Gateway
resources, node pools/DNS zones, Cloud DNS zone-apex NS/SOA records, legacy bucket
ACL entries, ...) — pass --include-system to see it anyway.

No \`gcloud\` or \`kubectl\` CLI needed — both the GCP side (Cloud Asset
Inventory, IAM, Compute Engine) and the cluster side talk REST directly,
authenticated with Application Default Credentials (\`gcloud auth
application-default login\` locally, a service account key via
GOOGLE_APPLICATION_CREDENTIALS, or the ambient credentials on
GCE/GKE/Cloud Build). Cluster connection details (server, CA) still come
from your kubeconfig (KUBECONFIG, default ~/.kube/config); set
KUBE_CONTEXT to target a specific context explicitly instead of relying
on current-context. Only tested against GKE — the cluster-side REST calls
assume a GCP OAuth2 token is a valid bearer token for the API server,
which isn't true for every cluster type.

Options:
  --json             Emit a JSON array of {kind, id, project, status} instead
                      of the human-readable report.
  --ownership PATH   Merge a version-1 ownership catalog (repeatable).
  --tofu DIR         Merge resources from \`tofu show -json\` state (repeatable).
  --show-covered     Include covered_kcc, covered_opentofu, and
                      covered_ownership entries in human-readable output.
  --include-system   Don't filter out GCP-managed system resources.
  -h, --help         Show this help and exit.

Exits 0 on a completed scan (DRIFT/ORPHAN findings are not failures — this
is a report, not a gate), 2 on a usage error.
`;

function optionValues(argv, option) {
  const values = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== option) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${option} requires a path`);
    values.push(value);
    index += 1;
  }
  return values;
}

function printDiagnostic(diag, jsonMode, results, project) {
  if (diag.type === 'stale-cache') {
    const label = diag.kind === 'ComputeAddress'
      ? `проігноровано ${diag.count} запис(ів), яких уже нема в GCP (застарілий кеш Asset Inventory)`
      : diag.kind === 'ContainerNodePool'
        ? `проігноровано ${diag.count} NodePool, яких уже нема в GKE (застарілий кеш Asset Inventory)`
        : `проігноровано ${diag.count} запис(ів) від зон, яких уже нема (застарілий кеш Asset Inventory)`;
    if (jsonMode) {
      results.push({ kind: diag.kind, id: `stale_asset_inventory_cache:${diag.count}`, project, status: 'ignored' });
    } else {
      console.log(`== ${diag.kind}: ${label} ==`);
      console.log('');
    }
  } else if (diag.type === 'gke-managed-skip' && !jsonMode) {
    console.log(`== ${diag.kind}: пропущено (goog-gke-node, керує сам GKE) ==`);
    for (const z of diag.zones) console.log(`    ${z}`);
    console.log('');
  } else if (diag.type === 'gke-gateway-managed-skip') {
    if (jsonMode) {
      results.push({ kind: diag.kind, id: `gke_gateway_managed:${diag.count}`, project, status: 'ignored' });
    } else {
      console.log(`== ${diag.kind}: пропущено ${diag.count} ресурс(ів), якими керує GKE Gateway controller ==`);
      console.log('');
    }
  } else if (diag.type === 'system-resource-skip') {
    if (jsonMode) {
      results.push({ kind: diag.kind, id: `system_resource:${diag.count}`, project, status: 'ignored' });
    } else {
      console.log(`== ${diag.kind}: пропущено ${diag.count} ресурс(ів) (${diag.reason}) ==`);
      console.log('');
    }
  }
}

// Groups the flat resources list from get-resources.mjs back into
// per-kind {live, kcc} arrays, diffs and prints each kind in KIND_ORDER,
// interleaving each kind's diagnostics (if any) right before its report —
// same order a human reading top to bottom expects.
function diffAndReport(collected, externalDeclarations, externalDiagnostics, jsonMode, showCovered, results) {
  const { project, resources, diagnostics } = collected;
  const live = resources.filter((resource) => resource.source === 'gcp').map((resource) => ({ ...resource, project }));
  const kcc = resources.filter((resource) => resource.source === 'kcc').map((resource) => ({
    ...resource,
    project,
    controller: 'kcc',
    source: collected.namespace,
  }));
  const classified = classifyResources(
    live,
    [...kcc, ...externalDeclarations.filter((resource) => resource.project === project)],
  );
  results.push(...classified);

  const diagByKind = new Map();
  for (const d of diagnostics) {
    const entries = diagByKind.get(d.kind) || [];
    entries.push(d);
    diagByKind.set(d.kind, entries);
  }

  const byKind = new Map(KIND_ORDER.map((kind) => [kind, []]));
  for (const resource of classified) byKind.get(resource.kind)?.push(resource);

  for (const kind of KIND_ORDER) {
    for (const diag of diagByKind.get(kind) || []) printDiagnostic(diag, jsonMode, results, project);
    if (jsonMode) continue;
    const entries = byKind.get(kind);
    const visible = showCovered ? entries : entries.filter((entry) => entry.status === 'uncovered' || entry.status.startsWith('orphan_'));
    if (!visible.length) continue;
    console.log(`== ${kind} (проєкт ${project}) ==`);
    for (const entry of visible.sort((a, b) => a.id.localeCompare(b.id))) {
      const owner = entry.owner ? ` (${entry.owner})` : '';
      console.log(`  ${entry.status.toUpperCase()}${owner} — ${entry.id}`);
    }
    console.log('');
  }

  if (!jsonMode) {
    for (const diagnostic of externalDiagnostics) {
      if (diagnostic.project && diagnostic.project !== project) continue;
      console.log(`== OpenTofu: unsupported ${diagnostic.resourceType} at ${diagnostic.address} (${diagnostic.source}) ==`);
      console.log('');
    }
  }
}

async function scanNamespace(namespace, options, results) {
  const collected = await collectNamespace(namespace, { includeSystem: options.includeSystem });
  if (!collected.project) {
    console.error(`namespace ${namespace} не має cnrm.cloud.google.com/project-id`);
    return;
  }
  if (!options.jsonMode) console.log(`### namespace ${namespace} -> проєкт ${collected.project} ###`);
  diffAndReport(collected, options.declarations, options.diagnostics, options.jsonMode, options.showCovered, results);
  if (!options.jsonMode) console.log('');
}

export async function run(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const target = argv[0];
  if (!target) {
    console.error('usage: cfr kcc-inventory <namespace|--all> [--json] [--include-system]  (KUBE_CONTEXT=... для явного контексту)');
    return 2;
  }
  const jsonMode = argv.includes('--json');
  const includeSystem = argv.includes('--include-system');
  const showCovered = argv.includes('--show-covered');
  const ownershipPaths = optionValues(argv, '--ownership');
  const tofuPaths = optionValues(argv, '--tofu');
  const ownership = loadOwnership(ownershipPaths);
  const opentofu = collectOpenTofu(tofuPaths);
  const declarations = [...ownership, ...opentofu.resources];

  let namespaces;
  if (target === '--all') {
    namespaces = await listKccNamespaces();
    if (!namespaces.length) {
      console.error('жоден namespace не має cnrm.cloud.google.com/project-id');
      return 2;
    }
  } else {
    namespaces = [target];
  }

  const results = [];
  const options = {
    includeSystem,
    jsonMode,
    showCovered,
    declarations,
    diagnostics: opentofu.diagnostics,
  };
  for (const ns of namespaces) await scanNamespace(ns, options, results);

  if (jsonMode) {
    for (const diagnostic of opentofu.diagnostics) {
      results.push({ ...diagnostic, status: 'unsupported_controller_resource' });
    }
    console.log(JSON.stringify(results, null, 2));
  }
  return 0;
}
