// Read-only GCP coverage inventory backed only by OpenTofu state.
import { KIND_ORDER, collectProject } from './get-resources.mjs';
import { classifyResources, collectOpenTofu } from './controller-inventory.mjs';
import { classifyRestoreDerived } from './restore-disk-ownership.mjs';
import { parseOptions } from './args.mjs';
import { applyUserIgnores, parseUserIgnoreRules } from './ignore-rules.mjs';

export const HELP = `cfr tofu-inventory — GCP OpenTofu-only drift inventory

Usage:
  npx @nitra/cfr tofu-inventory --project PROJECT --tofu DIR [--tofu DIR ...]

Compares live GCP resources in an explicitly named project with actual
OpenTofu state. It does not read Kubernetes or kubeconfig.

Ignored resources (status \`ignored\`, with a reason; listed with --show-covered
and in --json) are created by GCP/GKE/controllers or are data. Rules and their
rationale: lib/ignore-rules.mjs. A resource declared in OpenTofu state stays
covered_opentofu; only otherwise-uncovered ones become ignored.

Reports live resources absent from OpenTofu state and OpenTofu declarations
whose live GCP resource is missing. A supported resource is covered only by
OpenTofu; controller conflicts across state roots are hard errors.
Restored disks can be controller_managed when exact successful VolumeRestore
handles link them to a live RestorePlan covered by the supplied OpenTofu state.
They are reported separately from covered_opentofu resources.

Options:
  --project PROJECT   GCP project ID to scan (required).
  --tofu DIR          Read one OpenTofu state root with \`tofu -chdir=DIR show -json\` (repeatable, required).
  --show-covered      Include covered_opentofu entries in human-readable output.
  --include-system    Don't filter out GCP-managed system resources and disable the
                      built-in ignore rules (PVC disks, SecretVersion, GKE DNS, ...).
  --ignore RULE       Repeatable. RULE is KIND_OR_ASSET_TYPE:ID_REGEX, e.g.
                      'PubSubTopic:^projects/p/topics/tmp-'. Turns matching uncovered
                      resources / unsupported live assets into \`ignored\` (with reason).
  --strict            Exit 1 for uncovered/orphan resources or unsupported live/state types.
  --json              Emit JSON instead of the human-readable report.
  -h, --help          Show this help and exit.

OpenTofu must be available on PATH. GCP access uses Application Default
Credentials; no \`gcloud\` or \`kubectl\` executable is required.
`;

function ignoredDiagnostic(diag, project) {
  if (diag.type === 'unsupported-live-resource') {
    return { ...diag, project, status: 'unsupported_live_resource' };
  }
  if (diag.type === 'user-ignored') {
    return { ...diag, project, status: 'ignored' };
  }
  if (diag.type === 'asset-scope-skip') {
    return { ...diag, id: `asset_scope:${diag.assetType}:${diag.count}`, project, status: 'ignored' };
  }
  if (diag.type === 'stale-cache') {
    return { kind: diag.kind, id: `stale_asset_inventory_cache:${diag.count}`, project, status: 'ignored' };
  }
  if (diag.type === 'gke-managed-skip') {
    return { kind: diag.kind, id: `gke_managed:${diag.zones.length}`, project, status: 'ignored' };
  }
  if (diag.type === 'gke-gateway-managed-skip') {
    return { kind: diag.kind, id: `gke_gateway_managed:${diag.count}`, project, status: 'ignored' };
  }
  if (diag.type === 'gke-ingress-managed-skip') {
    return { kind: diag.kind, id: `gke_ingress_managed:${diag.count}`, project, status: 'ignored' };
  }
  if (diag.type === 'gke-private-endpoint-skip') {
    return { kind: diag.kind, id: `gke_private_endpoint:${diag.count}`, project, status: 'ignored' };
  }
  if (diag.type === 'system-resource-skip') {
    return { kind: diag.kind, id: `system_resource:${diag.count}`, reason: diag.reason, project, status: 'ignored' };
  }
  return null;
}

function printDiagnostic(diag) {
  if (diag.type === 'stale-cache') {
    const label = diag.kind === 'ComputeAddress'
      ? `проігноровано ${diag.count} запис(ів), яких уже нема в GCP (застарілий кеш Asset Inventory)`
      : diag.kind === 'ContainerNodePool'
        ? `проігноровано ${diag.count} NodePool, яких уже нема в GKE (застарілий кеш Asset Inventory)`
        : `проігноровано ${diag.count} запис(ів) від зон, яких уже нема (застарілий кеш Asset Inventory)`;
    console.log(`== ${diag.kind}: ${label} ==`);
  } else if (diag.type === 'gke-managed-skip') {
    console.log(`== ${diag.kind}: пропущено (goog-gke-node, керує сам GKE) ==`);
    for (const zone of diag.zones) console.log(`    ${zone}`);
  } else if (diag.type === 'gke-gateway-managed-skip') {
    console.log(`== ${diag.kind}: пропущено ${diag.count} ресурс(ів), якими керує GKE Gateway controller ==`);
  } else if (diag.type === 'gke-ingress-managed-skip') {
    console.log(`== ${diag.kind}: пропущено ${diag.count} ресурс(ів), якими керує GKE Ingress controller ==`);
  } else if (diag.type === 'gke-private-endpoint-skip') {
    console.log(`== ${diag.kind}: пропущено ${diag.count} private endpoint, яким керує GKE ==`);
  } else if (diag.type === 'system-resource-skip') {
    console.log(`== ${diag.kind}: пропущено ${diag.count} ресурс(ів) (${diag.reason}) ==`);
  }
  console.log('');
}

// Collectors tag system-managed live resources with `ignoreReason`. Only the
// still-uncovered ones become `ignored`; covered ones keep their status.
export function applyIgnoreTags(results) {
  return results.map(({ ignoreReason, ...result }) => (
    ignoreReason && result.status === 'uncovered' ? { ...result, status: 'ignored', reason: ignoreReason } : result));
}

export async function collectAndClassify(project, tofuPaths, {
  includeSystem = false,
  collectProjectFn = collectProject,
  collectOpenTofuFn = collectOpenTofu,
} = {}) {
  const [collected, opentofu] = await Promise.all([
    collectProjectFn(project, { includeSystem }),
    Promise.resolve().then(() => collectOpenTofuFn(tofuPaths, { defaultProject: project })),
  ]);
  const live = collected.resources.map((resource) => ({ ...resource, project }));
  const declarations = opentofu.resources.filter((resource) => resource.project === project);
  return {
    results: applyIgnoreTags(classifyRestoreDerived(classifyResources(live, declarations))),
    gcpDiagnostics: collected.diagnostics,
    tofuDiagnostics: opentofu.diagnostics,
  };
}

export function hasBlockingFindings(results, tofuDiagnostics, gcpDiagnostics = []) {
  return results.some((result) => result.status === 'uncovered' || result.status.startsWith('orphan_'))
    || tofuDiagnostics.length > 0
    || gcpDiagnostics.some((diag) => diag.type === 'unsupported-live-resource');
}

function printReport(project, results, diagnostics, showCovered) {
  console.log(`### OpenTofu -> GCP project ${project} ###`);
  const diagnosticsByKind = new Map();
  for (const diagnostic of diagnostics) {
    const list = diagnosticsByKind.get(diagnostic.kind) || [];
    list.push(diagnostic);
    diagnosticsByKind.set(diagnostic.kind, list);
  }
  const byKind = new Map(KIND_ORDER.map((kind) => [kind, []]));
  for (const result of results) byKind.get(result.kind)?.push(result);

  for (const kind of KIND_ORDER) {
    for (const diagnostic of diagnosticsByKind.get(kind) || []) printDiagnostic(diagnostic);
    const entries = byKind.get(kind);
    const visible = showCovered
      ? entries
      : entries.filter((entry) => entry.status === 'uncovered' || entry.status.startsWith('orphan_') || entry.status === 'controller_managed');
    if (!visible.length) continue;
    console.log(`== ${kind} (проєкт ${project}) ==`);
    for (const entry of visible.sort((a, b) => a.id.localeCompare(b.id))) {
      const condition = entry.condition
        ? ` [condition: ${entry.condition.title || entry.condition.expression}]`
        : '';
      const derived = entry.derivedFrom
        ? ` [${entry.derivedFrom.controller}: ${entry.derivedFrom.id}; PVC ${entry.derivedFrom.targetPvc.namespace}/${entry.derivedFrom.targetPvc.name}]` : '';
      const why = entry.reason ? ` [${entry.reason}]` : '';
      console.log(`  ${entry.status.toUpperCase()} — ${entry.id}${condition}${derived}${why}`);
    }
    console.log('');
  }
}

export async function run(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  let options;
  let userIgnoreRules;
  try {
    options = parseOptions(argv, {
      flags: ['--json', '--show-covered', '--include-system', '--strict'],
      values: ['--project', '--tofu', '--ignore'],
    });
    if (options.get('--project')?.length !== 1 || !options.get('--tofu')?.length) {
      throw new Error('--project and --tofu are required');
    }
    userIgnoreRules = parseUserIgnoreRules(options.get('--ignore'));
  } catch (err) {
    console.error(`usage: cfr tofu-inventory --project PROJECT --tofu DIR [--tofu DIR ...]: ${err.message}`);
    return 2;
  }

  const project = options.get('--project')[0];
  const tofuPaths = options.get('--tofu');
  const jsonMode = argv.includes('--json');
  const collected = await collectAndClassify(project, tofuPaths, {
    includeSystem: argv.includes('--include-system'),
  });
  const { tofuDiagnostics } = collected;
  const { results, gcpDiagnostics } = applyUserIgnores(collected.results, collected.gcpDiagnostics, userIgnoreRules);

  if (jsonMode) {
    const output = [
      ...results,
      ...gcpDiagnostics.map((diagnostic) => ignoredDiagnostic(diagnostic, project)).filter(Boolean),
      ...tofuDiagnostics.map((diagnostic) => ({ ...diagnostic, status: 'unsupported_controller_resource' })),
    ];
    console.log(JSON.stringify(output, null, 2));
  } else {
    printReport(project, results, gcpDiagnostics, argv.includes('--show-covered'));
    for (const diagnostic of gcpDiagnostics) {
      if (diagnostic.type === 'unsupported-live-resource') {
        console.log(`== GCP: unsupported ${diagnostic.assetType} — ${diagnostic.id} — ${diagnostic.reason} ==`);
      } else if (diagnostic.type === 'user-ignored') {
        console.log(`== GCP: ignored ${diagnostic.assetType} — ${diagnostic.id} — ${diagnostic.reason} ==`);
      } else if (diagnostic.type === 'asset-scope-skip') {
        console.log(`== GCP: ignored ${diagnostic.count} ${diagnostic.assetType} — ${diagnostic.reason} ==`);
      }
    }
    for (const diagnostic of tofuDiagnostics) {
      const reason = diagnostic.reason ? ` — ${diagnostic.reason}` : '';
      console.log(`== OpenTofu: unsupported ${diagnostic.resourceType} at ${diagnostic.address} (${diagnostic.source})${reason} ==`);
      console.log('');
    }
  }

  return argv.includes('--strict') && hasBlockingFindings(results, tofuDiagnostics, gcpDiagnostics) ? 1 : 0;
}
