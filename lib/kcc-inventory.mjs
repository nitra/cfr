// Diff і звіт над сирим списком з get-resources.mjs: що з GCP-ресурсів
// проєкту реально живе під KCC (описано в git), а що — "чуже" (створено
// повз KCC). Суто читання, нічого не видаляє — вхідний контракт для
// окремого cleanup-рішення, яке вирішує, що з DRIFT можна прибрати.
import { collectNamespace, listKccNamespaces, KIND_ORDER } from './get-resources.mjs';

export const HELP = `cfr kcc-inventory — GCP Config Connector (KCC) drift inventory

Usage:
  npx @nitra/cfr kcc-inventory <namespace>
  npx @nitra/cfr kcc-inventory --all
  npx @nitra/cfr kcc-inventory <namespace|--all> [--json] [--include-system]

Compares, per KCC namespace (namespace carrying the annotation
cnrm.cloud.google.com/project-id), what actually exists in the GCP project
against what's declared as Config Connector custom resources in that
namespace. It covers IAM, Artifact Registry, GKE, Cloud Run, Scheduler,
Eventarc, Pub/Sub, Secret Manager, VPC Access, selected network/LB
resources, KMS, Cloud DNS, and IAMPolicyMember.

Reports two directions per kind:
  DRIFT   — live in GCP, not declared under KCC (adopt it or delete it)
  ORPHAN  — declared under KCC, no longer live in GCP

By default GCP-managed system noise is filtered out (Google-owned service
accounts, gcr.io shims, GKE-managed node pools/DNS zones, legacy bucket
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
  --include-system   Don't filter out GCP-managed system resources.
  -h, --help         Show this help and exit.

Exits 0 on a completed scan (DRIFT/ORPHAN findings are not failures — this
is a report, not a gate), 2 on a usage error.
`;

// --- diff+звіт по одному kind: sort+diff двох списків, людський звіт і/або JSON

function report(kind, liveIds, kccIds, project, jsonMode, results) {
  const live = [...new Set(liveIds.filter(Boolean))].sort();
  const kcc = [...new Set(kccIds.filter(Boolean))].sort();
  const kccSet = new Set(kcc);
  const liveSet = new Set(live);
  const drift = live.filter((x) => !kccSet.has(x)).sort();
  const orphan = kcc.filter((x) => !liveSet.has(x)).sort();

  if (!jsonMode) {
    console.log(`== ${kind} (проєкт ${project}) ==`);
    if (drift.length) {
      console.log('  DRIFT — є в GCP, немає в KCC:');
      for (const x of drift) console.log(`    ${x}`);
    }
    if (orphan.length) {
      console.log('  ORPHAN — є в KCC, зникло з GCP:');
      for (const x of orphan) console.log(`    ${x}`);
    }
    if (!drift.length && !orphan.length) {
      console.log(`  чисто (${live.length} live, ${kcc.length} kcc)`);
    }
    console.log('');
  }

  for (const x of drift) results.push({ kind, id: x, project, status: 'drift' });
  for (const x of orphan) results.push({ kind, id: x, project, status: 'orphan' });
}

function printDiagnostic(diag, jsonMode, results, project) {
  if (diag.type === 'stale-cache') {
    const label = diag.kind === 'ComputeAddress'
      ? `проігноровано ${diag.count} запис(ів), яких уже нема в GCP (застарілий кеш Asset Inventory)`
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
  }
}

// Groups the flat resources list from get-resources.mjs back into
// per-kind {live, kcc} arrays, diffs and prints each kind in KIND_ORDER,
// interleaving each kind's diagnostics (if any) right before its report —
// same order a human reading top to bottom expects.
function diffAndReport(collected, jsonMode, results) {
  const { project, resources, diagnostics } = collected;
  const byKind = new Map(KIND_ORDER.map((k) => [k, { live: [], kcc: [] }]));
  for (const { kind, id, source } of resources) {
    const bucket = byKind.get(kind);
    if (!bucket) continue;
    bucket[source === 'kcc' ? 'kcc' : 'live'].push(id);
  }
  const diagByKind = new Map();
  for (const d of diagnostics) diagByKind.set(d.kind, d);

  for (const kind of KIND_ORDER) {
    const diag = diagByKind.get(kind);
    if (diag) printDiagnostic(diag, jsonMode, results, project);
    const { live, kcc } = byKind.get(kind);
    report(kind, live, kcc, project, jsonMode, results);
  }
}

async function scanNamespace(namespace, includeSystem, jsonMode, results) {
  const collected = await collectNamespace(namespace, { includeSystem });
  if (!collected.project) {
    console.error(`namespace ${namespace} не має cnrm.cloud.google.com/project-id`);
    return;
  }
  if (!jsonMode) console.log(`### namespace ${namespace} -> проєкт ${collected.project} ###`);
  diffAndReport(collected, jsonMode, results);
  if (!jsonMode) console.log('');
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
  for (const ns of namespaces) await scanNamespace(ns, includeSystem, jsonMode, results);

  if (jsonMode) console.log(JSON.stringify(results, null, 2));
  return 0;
}
