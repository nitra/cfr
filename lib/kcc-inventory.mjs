// Інвентаризація: що з GCP-ресурсів проєкту реально живе під KCC (Config
// Connector, описано в git), а що — "чуже" (створено повз KCC). Суто
// читання, нічого не видаляє — вхідний контракт для окремого
// cleanup-рішення, яке вирішує, що з DRIFT можна прибрати.
//
// Проєкт береться з анотації namespace (cnrm.cloud.google.com/project-id),
// не з константи — той самий скрипт працює для будь-якого namespace, що
// веде GCP-проєкт через KCC у namespaced mode.
import { spawnSync } from 'node:child_process';

export const HELP = `cfr kcc-inventory — GCP Config Connector (KCC) drift inventory

Usage:
  npx @nitra/cfr kcc-inventory <namespace>
  npx @nitra/cfr kcc-inventory --all
  npx @nitra/cfr kcc-inventory <namespace|--all> [--json] [--include-system]

Compares, per KCC namespace (namespace carrying the annotation
cnrm.cloud.google.com/project-id), what actually exists in the GCP project
against what's declared as Config Connector custom resources in that
namespace — for IAMServiceAccount, IAMServiceAccountKey,
ArtifactRegistryRepository, ContainerCluster, ContainerNodePool,
StorageBucket, ComputeAddress, DNSManagedZone, DNSRecordSet, and
IAMPolicyMember.

Reports two directions per kind:
  DRIFT   — live in GCP, not declared under KCC (adopt it or delete it)
  ORPHAN  — declared under KCC, no longer live in GCP

By default GCP-managed system noise is filtered out (Google-owned service
accounts, gcr.io shims, GKE-managed node pools/DNS zones, legacy bucket
ACL entries, ...) — pass --include-system to see it anyway.

Requires \`gcloud\` and \`kubectl\` on PATH, authenticated against the target
project/cluster. Set KUBE_CONTEXT to target a specific kubeconfig context
explicitly instead of relying on the current one.

Options:
  --json             Emit a JSON array of {kind, id, project, status} instead
                      of the human-readable report.
  --include-system   Don't filter out GCP-managed system resources.
  -h, --help         Show this help and exit.

Exits 0 on a completed scan (DRIFT/ORPHAN findings are not failures — this
is a report, not a gate), 2 on a usage error.
`;

function kubectlBase() {
  const ctx = process.env.KUBE_CONTEXT;
  return ctx ? ['kubectl', '--context', ctx] : ['kubectl'];
}

// maxBuffer: дефолтні 1MB замалі для search-all-resources на проєкті з
// сотнями активів — spawnSync мовчки падає в ENOBUFS, і виклик, що його не
// перевіряє (як тут), бачить порожній результат замість помилки.
function runCmd(cmd, args) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
}

function kubectlJson(...args) {
  const [bin, ...base] = kubectlBase();
  const proc = runCmd(bin, [...base, ...args, '-o', 'json']);
  if (proc.status !== 0 || !proc.stdout || !proc.stdout.trim()) return null;
  try {
    return JSON.parse(proc.stdout);
  } catch {
    return null;
  }
}

function kubectlField(crd, namespace, fieldFn) {
  const data = kubectlJson('get', crd, '-n', namespace);
  if (!data) return [];
  return (data.items || []).map(fieldFn).filter(Boolean);
}

function gcloudJson(...args) {
  const proc = runCmd('gcloud', [...args, '--format=json']);
  try {
    return JSON.parse(proc.stdout || '[]');
  } catch {
    return [];
  }
}

function gcloudLines(...args) {
  const proc = runCmd('gcloud', args);
  return (proc.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function stripPrefix(s, prefix) {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// --- фільтри GCP-системного шуму (див. --include-system) ------------------

const SA_SYSTEM = [
  /^[0-9]+-compute@developer\.gserviceaccount\.com$/,
  /@appspot\.gserviceaccount\.com$/,
  /@cloudservices\.gserviceaccount\.com$/,
  /^firebase-adminsdk-/,
];

const AR_SYSTEM = [/(^|\.)gcr\.io$/, /^gcf-artifacts$/];

const NODEPOOL_SYSTEM = /^nap-/;

function isSystemBucket(name, project) {
  return name.endsWith('.appspot.com') || name.startsWith('gcf-sources-') || name === `${project}_cloudbuild`;
}

// projectEditor:/projectOwner:/projectViewer: — legacy bucket ACL, GCP
// навішує на кожен бакет сам; решта — Google-керовані service agents.
const IAM_SYSTEM = [
  /^project(Editor|Owner|Viewer):/,
  /@system\.gserviceaccount\.com$/,
  /serviceAccount:service-[0-9]+@/,
  /@gcp-sa-[a-z0-9-]+\.iam\.gserviceaccount\.com$/,
  /@(cloudbuild|cloudservices|developer|appspot)\.gserviceaccount\.com$/,
  /@(container-engine-robot|serverless-robot-prod|gcf-admin-robot|firebase-rules|firebase-sa-management)\.iam\.gserviceaccount\.com$/,
];

function isSystem(patterns, value) {
  return patterns.some((p) => p.test(value));
}

// --- report: sort+diff двох списків, людський звіт і/або JSON -------------

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

// --- IAMPolicyMember: розбір id ресурсу з обох боків -----------------------

function assetResId(entry, project) {
  const assetType = entry.assetType || '';
  const res = entry.resource || '';
  if (res.endsWith(`/projects/${project}`)) return `project/${project}`;
  const mSa = res.match(/\/serviceAccounts\/([^/]+)$/);
  if (mSa && assetType === 'iam.googleapis.com/ServiceAccount') return `sa/${mSa[1]}`;
  const mAr = res.match(/\/repositories\/([^/]+)$/);
  if (mAr && assetType === 'artifactregistry.googleapis.com/Repository') return `ar/${mAr[1]}`;
  if (assetType === 'storage.googleapis.com/Bucket') return 'bucket/' + stripPrefix(res, '//storage.googleapis.com/');
  return 'other/' + stripPrefix(res, '//');
}

function kccArId(ref) {
  const ext = ref.external || '';
  const m = ext.match(/\/repositories\/([^/]+)$/);
  if (m) return m[1];
  if (ref.name) return ref.name;
  return '?';
}

function kccSaId(ref, project) {
  const ext = ref.external || '';
  const m = ext.match(/\/serviceAccounts\/([^/]+)$/);
  if (m) return m[1];
  if (ext) return ext;
  if (ref.name) return `${ref.name}@${project}.iam.gserviceaccount.com`;
  return '?';
}

function kccPolicyMemberId(item, project) {
  const ref = (item.spec && item.spec.resourceRef) || {};
  switch (ref.kind) {
    case 'Project':
      return `project/${project}`;
    case 'IAMServiceAccount':
      return 'sa/' + kccSaId(ref, project);
    case 'ArtifactRegistryRepository':
      return 'ar/' + kccArId(ref);
    case 'StorageBucket':
      return 'bucket/' + (ref.external || ref.name || '?');
    default:
      return 'other/' + (ref.external || ref.name || '?');
  }
}

// --- по одному namespace ----------------------------------------------

function scanNamespace(namespace, includeSystem, jsonMode, results) {
  const ns = kubectlJson('get', 'namespace', namespace);
  const project = ns && ns.metadata && ns.metadata.annotations
    && ns.metadata.annotations['cnrm.cloud.google.com/project-id'];
  if (!project) {
    console.error(`namespace ${namespace} не має cnrm.cloud.google.com/project-id`);
    return;
  }

  if (!jsonMode) console.log(`### namespace ${namespace} -> проєкт ${project} ###`);

  const assets = gcloudJson('asset', 'search-all-resources', `--scope=projects/${project}`);
  const byType = (...types) => assets.filter((a) => types.includes(a.assetType));

  // --- IAMServiceAccount ------------------------------------------------
  const allLiveSa = byType('iam.googleapis.com/ServiceAccount')
    .map((a) => a.additionalAttributes && a.additionalAttributes.email)
    .filter(Boolean);
  let liveSa = allLiveSa;
  if (!includeSystem) liveSa = liveSa.filter((e) => !isSystem(SA_SYSTEM, e));
  const kccSa = kubectlField(
    'iamserviceaccounts.iam.cnrm.cloud.google.com', namespace,
    (i) => i.status && i.status.email,
  );
  report('IAMServiceAccount', liveSa, kccSa, project, jsonMode, results);

  // --- IAMServiceAccountKey (тільки user-managed) ------------------------
  // Живі SA для циклу ключів беремо БЕЗ фільтра system — дешевше не
  // ускладнювати, ключ системного SA все одно рідкість.
  const liveKey = [];
  for (const email of allLiveSa) {
    liveKey.push(...gcloudLines(
      'iam', 'service-accounts', 'keys', 'list',
      `--iam-account=${email}`, '--managed-by=user',
      `--project=${project}`, '--format=value(name)',
    ));
  }
  const kccKey = kubectlField(
    'iamserviceaccountkeys.iam.cnrm.cloud.google.com', namespace,
    (i) => i.status && i.status.name,
  ).map((n) => n.split('/').pop());
  report('IAMServiceAccountKey', liveKey, kccKey, project, jsonMode, results);

  // --- ArtifactRegistryRepository -----------------------------------------
  let liveAr = byType('artifactregistry.googleapis.com/Repository')
    .map((a) => {
      const m = (a.name || '').match(/\/repositories\/([^/]+)$/);
      return m && m[1];
    })
    .filter(Boolean);
  if (!includeSystem) liveAr = liveAr.filter((r) => !isSystem(AR_SYSTEM, r));
  const kccAr = kubectlField(
    'artifactregistryrepositories.artifactregistry.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  );
  report('ArtifactRegistryRepository', liveAr, kccAr, project, jsonMode, results);

  // --- ContainerCluster + ContainerNodePool -------------------------------
  const liveCluster = byType('container.googleapis.com/Cluster').map((a) => a.displayName);
  const kccCluster = kubectlField(
    'containerclusters.container.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  );
  report('ContainerCluster', liveCluster, kccCluster, project, jsonMode, results);

  const livePool = [];
  for (const a of byType('container.googleapis.com/NodePool')) {
    const m = (a.name || '').match(/\/clusters\/([^/]+)\/nodePools\/([^/]+)$/);
    if (!m) continue;
    const [, cluster, pool] = m;
    if (includeSystem || !NODEPOOL_SYSTEM.test(pool)) livePool.push(`${cluster}/${pool}`);
  }
  const kccPool = kubectlField(
    'containernodepools.container.cnrm.cloud.google.com', namespace,
    (i) => {
      const ref = (i.spec && i.spec.clusterRef) || {};
      return `${ref.name || ref.external}/${i.spec && i.spec.resourceID}`;
    },
  );
  report('ContainerNodePool', livePool, kccPool, project, jsonMode, results);

  // --- StorageBucket -------------------------------------------------------
  let liveBucket = byType('storage.googleapis.com/Bucket').map((a) => a.displayName);
  if (!includeSystem) liveBucket = liveBucket.filter((b) => !isSystemBucket(b, project));
  const kccBucket = kubectlField(
    'storagebuckets.storage.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  );
  report('StorageBucket', liveBucket, kccBucket, project, jsonMode, results);

  // --- ComputeAddress (регіональні й глобальні) -----------------------------
  // Asset Inventory інколи повертає вже видалені адреси (перевірено
  // емпірично на azovmemo: search-all-resources показав адресу без
  // читабельного імені, якої `gcloud compute addresses describe` вже не
  // знаходить — той самий клас застарілого кешу, що й ResourceRecordSet).
  // Два дешевих прямих виклики (regional + global), не по одному на
  // ресурс, — фільтруємо ними AR-подібні привиди CAI.
  const liveAddrIds = new Set([
    ...gcloudLines('compute', 'addresses', 'list', `--project=${project}`, '--format=csv[no-heading](name,region.basename())'),
    ...gcloudLines('compute', 'addresses', 'list', '--global', `--project=${project}`, '--format=value(name)').map((n) => `${n},`),
  ].map((row) => {
    const [name, region] = row.split(',');
    return `${name}/${region || 'global'}`;
  }));
  const staleAddrCount0 = byType('compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress').length;
  const liveAddr = byType('compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress')
    .map((a) => `${a.displayName}/${a.location === 'global' ? 'global' : a.location}`)
    .filter((id) => liveAddrIds.has(id));
  const staleAddrCount = staleAddrCount0 - liveAddr.length;
  if (staleAddrCount) {
    if (jsonMode) {
      results.push({ kind: 'ComputeAddress', id: `stale_asset_inventory_cache:${staleAddrCount}`, project, status: 'ignored' });
    } else {
      console.log(`== ComputeAddress: проігноровано ${staleAddrCount} запис(ів), яких уже нема в GCP (застарілий кеш Asset Inventory) ==`);
      console.log('');
    }
  }
  const kccAddr = kubectlField(
    'computeaddresses.compute.cnrm.cloud.google.com', namespace,
    (i) => `${i.spec && i.spec.resourceID}/${(i.spec && i.spec.location) || 'global'}`,
  );
  report('ComputeAddress', liveAddr, kccAddr, project, jsonMode, results);

  // --- DNSManagedZone + DNSRecordSet ---------------------------------------
  // Зони, які GKE заводить і веде сам (label goog-gke-node) — не в diff
  // узагалі: не KCC-кандидат, і рекордсетів там сотні на Service.
  const zones = byType('dns.googleapis.com/ManagedZone');
  const gkeZoneNames = new Set(
    zones.filter((z) => z.labels && z.labels['goog-gke-node'] !== undefined).map((z) => z.displayName),
  );
  const liveZone = zones.map((z) => z.displayName).filter((n) => !gkeZoneNames.has(n));
  if (gkeZoneNames.size && !jsonMode) {
    console.log('== DNSManagedZone: пропущено (goog-gke-node, керує сам GKE) ==');
    for (const z of [...gkeZoneNames].sort()) console.log(`    ${z}`);
    console.log('');
  }
  const kccZone = kubectlField(
    'dnsmanagedzones.dns.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  );
  report('DNSManagedZone', liveZone, kccZone, project, jsonMode, results);

  // rrset .name містить числовий id зони, не читабельне ім'я — мапа
  // id->displayName будується з тих самих ManagedZone-записів.
  const zoneNameById = new Map();
  for (const z of zones) {
    const m = (z.name || '').match(/\/managedZones\/([^/]+)$/);
    if (m) zoneNameById.set(m[1], z.displayName);
  }
  // Cloud Asset Inventory інколи повертає ResourceRecordSet від зон, яких
  // уже немає (перевірено емпірично на azovmemo: rrsets посилались на три
  // різні managedZone-id, жоден з яких не збігався з id живої зони —
  // застарілий кеш після пересоздання GKE-зони). Запис без резолву в
  // zoneNameById — не дрейф, а сміття CAI, тому пропускаємо мовчки, а не
  // фолбечимось на сирий id (інакше він ніколи не збіжиться з
  // gkeZoneNames і завжди рахувався б за DRIFT).
  let staleRrsetCount = 0;
  const liveRrset = [];
  for (const a of byType('dns.googleapis.com/ResourceRecordSet')) {
    const mZid = (a.parentFullResourceName || '').match(/\/managedZones\/([^/]+)$/);
    if (!mZid) continue;
    const zname = zoneNameById.get(mZid[1]);
    if (zname === undefined) {
      staleRrsetCount += 1;
      continue;
    }
    if (gkeZoneNames.has(zname)) continue;
    const mRr = (a.name || '').match(/\/rrsets\/(.+)\/([A-Za-z]+)$/);
    if (!mRr) continue;
    liveRrset.push(`${zname}/${mRr[1]}/${mRr[2]}`);
  }
  if (staleRrsetCount) {
    if (jsonMode) {
      results.push({
        kind: 'DNSRecordSet', id: `stale_asset_inventory_cache:${staleRrsetCount}`,
        project, status: 'ignored',
      });
    } else {
      console.log(`== DNSRecordSet: проігноровано ${staleRrsetCount} запис(ів) від зон, яких уже нема (застарілий кеш Asset Inventory) ==`);
      console.log('');
    }
  }
  const kccRrset = kubectlField(
    'dnsrecordsets.dns.cnrm.cloud.google.com', namespace,
    (i) => {
      const zref = (i.spec && i.spec.managedZoneRef) || {};
      return `${zref.name}/${i.spec && i.spec.name}/${i.spec && i.spec.type}`;
    },
  );
  report('DNSRecordSet', liveRrset, kccRrset, project, jsonMode, results);

  // --- IAMPolicyMember -----------------------------------------------------
  // search-all-iam-policies — усі біндинги проєкту одразу, на будь-якому
  // типі ресурсу, не тільки на трьох раніше підтримуваних (Project/SA/AR).
  const iamPolicies = gcloudJson('asset', 'search-all-iam-policies', `--scope=projects/${project}`);
  const liveIam = [];
  for (const entry of iamPolicies) {
    const rid = assetResId(entry, project);
    for (const binding of (entry.policy && entry.policy.bindings) || []) {
      for (const member of binding.members || []) {
        if (includeSystem || !isSystem(IAM_SYSTEM, member)) {
          liveIam.push(`${rid}/${binding.role}/${member}`);
        }
      }
    }
  }

  const kccPolicyItems = kubectlJson('get', 'iampolicymembers.iam.cnrm.cloud.google.com', '-n', namespace);
  const kccIam = ((kccPolicyItems && kccPolicyItems.items) || []).map((item) => {
    const rid = kccPolicyMemberId(item, project);
    const spec = item.spec || {};
    return `${rid}/${spec.role}/${spec.member}`;
  });

  report('IAMPolicyMember', liveIam, kccIam, project, jsonMode, results);
  if (!jsonMode) console.log('');
}

export function run(argv) {
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
    const data = kubectlJson('get', 'namespace');
    namespaces = ((data && data.items) || [])
      .filter((i) => i.metadata && i.metadata.annotations && i.metadata.annotations['cnrm.cloud.google.com/project-id'])
      .map((i) => i.metadata.name);
    if (!namespaces.length) {
      console.error('жоден namespace не має cnrm.cloud.google.com/project-id');
      return 2;
    }
  } else {
    namespaces = [target];
  }

  const results = [];
  for (const ns of namespaces) scanNamespace(ns, includeSystem, jsonMode, results);

  if (jsonMode) console.log(JSON.stringify(results, null, 2));
  return 0;
}
