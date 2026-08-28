// Сирий збір фактів для одного KCC namespace: що є "живого" в GCP-проєкті і
// що заявлено як Config Connector CR у цьому namespace — для кожного з 10
// видів ресурсів. Жодного diff-у, жодного форматування, жодного I/O в
// консоль: тільки виклики gcloud/kubectl і нормалізація результату в
// плаский список. Diff і звіт — робота kcc-inventory.mjs, який споживає
// цей список.
import { spawnSync } from 'node:child_process';

export const KIND_ORDER = [
  'IAMServiceAccount',
  'IAMServiceAccountKey',
  'ArtifactRegistryRepository',
  'ContainerCluster',
  'ContainerNodePool',
  'StorageBucket',
  'ComputeAddress',
  'DNSManagedZone',
  'DNSRecordSet',
  'IAMPolicyMember',
];

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

// --- фільтри GCP-системного шуму (див. includeSystem) ----------------------

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

/**
 * Проєкт GCP, прив'язаний до namespace, або null, якщо анотація відсутня.
 */
export function projectForNamespace(namespace) {
  const ns = kubectlJson('get', 'namespace', namespace);
  return (ns && ns.metadata && ns.metadata.annotations
    && ns.metadata.annotations['cnrm.cloud.google.com/project-id']) || null;
}

/**
 * Усі namespace з анотацією cnrm.cloud.google.com/project-id.
 */
export function listKccNamespaces() {
  const data = kubectlJson('get', 'namespace');
  return ((data && data.items) || [])
    .filter((i) => i.metadata && i.metadata.annotations && i.metadata.annotations['cnrm.cloud.google.com/project-id'])
    .map((i) => i.metadata.name);
}

/**
 * Збирає сирий список ресурсів одного namespace: усе, що живе в GCP
 * (source: 'gcp'), і все, що заявлено під KCC (source: 'kcc'), для кожного
 * з KIND_ORDER. Дублікати не прибираються — це відповідальність споживача.
 *
 * diagnostics — записи, які не є ні "живим", ні "заявленим" ресурсом, а
 * приміткою про сам збір: застарілий кеш Cloud Asset Inventory, зони, якими
 * керує сам GKE.
 *
 * Повертає { namespace, project, resources, diagnostics }. project — null,
 * якщо namespace не має анотації cnrm.cloud.google.com/project-id
 * (resources і diagnostics тоді порожні).
 */
export function collectNamespace(namespace, { includeSystem = false } = {}) {
  const project = projectForNamespace(namespace);
  if (!project) return { namespace, project: null, resources: [], diagnostics: [] };

  const resources = [];
  const diagnostics = [];
  const push = (kind, ids, source) => {
    for (const id of ids) if (id) resources.push({ kind, id, source });
  };

  const assets = gcloudJson('asset', 'search-all-resources', `--scope=projects/${project}`);
  const byType = (...types) => assets.filter((a) => types.includes(a.assetType));

  // --- IAMServiceAccount ---------------------------------------------------
  const allLiveSa = byType('iam.googleapis.com/ServiceAccount')
    .map((a) => a.additionalAttributes && a.additionalAttributes.email)
    .filter(Boolean);
  let liveSa = allLiveSa;
  if (!includeSystem) liveSa = liveSa.filter((e) => !isSystem(SA_SYSTEM, e));
  push('IAMServiceAccount', liveSa, 'gcp');
  push('IAMServiceAccount', kubectlField(
    'iamserviceaccounts.iam.cnrm.cloud.google.com', namespace,
    (i) => i.status && i.status.email,
  ), 'kcc');

  // --- IAMServiceAccountKey (тільки user-managed) ---------------------------
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
  push('IAMServiceAccountKey', liveKey, 'gcp');
  push('IAMServiceAccountKey', kubectlField(
    'iamserviceaccountkeys.iam.cnrm.cloud.google.com', namespace,
    (i) => i.status && i.status.name,
  ).map((n) => n.split('/').pop()), 'kcc');

  // --- ArtifactRegistryRepository -------------------------------------------
  let liveAr = byType('artifactregistry.googleapis.com/Repository')
    .map((a) => {
      const m = (a.name || '').match(/\/repositories\/([^/]+)$/);
      return m && m[1];
    })
    .filter(Boolean);
  if (!includeSystem) liveAr = liveAr.filter((r) => !isSystem(AR_SYSTEM, r));
  push('ArtifactRegistryRepository', liveAr, 'gcp');
  push('ArtifactRegistryRepository', kubectlField(
    'artifactregistryrepositories.artifactregistry.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  ), 'kcc');

  // --- ContainerCluster + ContainerNodePool ---------------------------------
  push('ContainerCluster', byType('container.googleapis.com/Cluster').map((a) => a.displayName), 'gcp');
  push('ContainerCluster', kubectlField(
    'containerclusters.container.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  ), 'kcc');

  const livePool = [];
  for (const a of byType('container.googleapis.com/NodePool')) {
    const m = (a.name || '').match(/\/clusters\/([^/]+)\/nodePools\/([^/]+)$/);
    if (!m) continue;
    const [, cluster, pool] = m;
    if (includeSystem || !NODEPOOL_SYSTEM.test(pool)) livePool.push(`${cluster}/${pool}`);
  }
  push('ContainerNodePool', livePool, 'gcp');
  push('ContainerNodePool', kubectlField(
    'containernodepools.container.cnrm.cloud.google.com', namespace,
    (i) => {
      const ref = (i.spec && i.spec.clusterRef) || {};
      return `${ref.name || ref.external}/${i.spec && i.spec.resourceID}`;
    },
  ), 'kcc');

  // --- StorageBucket ---------------------------------------------------------
  let liveBucket = byType('storage.googleapis.com/Bucket').map((a) => a.displayName);
  if (!includeSystem) liveBucket = liveBucket.filter((b) => !isSystemBucket(b, project));
  push('StorageBucket', liveBucket, 'gcp');
  push('StorageBucket', kubectlField(
    'storagebuckets.storage.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  ), 'kcc');

  // --- ComputeAddress (регіональні й глобальні) -------------------------------
  // Asset Inventory інколи повертає вже видалені адреси (перевірено
  // емпірично на azovmemo: search-all-resources показав адресу без
  // читабельного імені, якої `gcloud compute addresses describe` вже не
  // знаходить — той самий клас застарілого кешу, що й ResourceRecordSet).
  // Два дешевих прямих виклики (regional + global), не по одному на
  // ресурс, — фільтруємо ними ці привиди CAI.
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
  if (staleAddrCount) diagnostics.push({ kind: 'ComputeAddress', type: 'stale-cache', count: staleAddrCount });
  push('ComputeAddress', liveAddr, 'gcp');
  push('ComputeAddress', kubectlField(
    'computeaddresses.compute.cnrm.cloud.google.com', namespace,
    (i) => `${i.spec && i.spec.resourceID}/${(i.spec && i.spec.location) || 'global'}`,
  ), 'kcc');

  // --- DNSManagedZone + DNSRecordSet -------------------------------------------
  // Зони, які GKE заводить і веде сам (label goog-gke-node) — не в diff
  // узагалі: не KCC-кандидат, і рекордсетів там сотні на Service.
  const zones = byType('dns.googleapis.com/ManagedZone');
  const gkeZoneNames = new Set(
    zones.filter((z) => z.labels && z.labels['goog-gke-node'] !== undefined).map((z) => z.displayName),
  );
  const liveZone = zones.map((z) => z.displayName).filter((n) => !gkeZoneNames.has(n));
  if (gkeZoneNames.size) {
    diagnostics.push({ kind: 'DNSManagedZone', type: 'gke-managed-skip', zones: [...gkeZoneNames].sort() });
  }
  push('DNSManagedZone', liveZone, 'gcp');
  push('DNSManagedZone', kubectlField(
    'dnsmanagedzones.dns.cnrm.cloud.google.com', namespace,
    (i) => i.spec && i.spec.resourceID,
  ), 'kcc');

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
  if (staleRrsetCount) diagnostics.push({ kind: 'DNSRecordSet', type: 'stale-cache', count: staleRrsetCount });
  push('DNSRecordSet', liveRrset, 'gcp');
  push('DNSRecordSet', kubectlField(
    'dnsrecordsets.dns.cnrm.cloud.google.com', namespace,
    (i) => {
      const zref = (i.spec && i.spec.managedZoneRef) || {};
      return `${zref.name}/${i.spec && i.spec.name}/${i.spec && i.spec.type}`;
    },
  ), 'kcc');

  // --- IAMPolicyMember ---------------------------------------------------------
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
  push('IAMPolicyMember', liveIam, 'gcp');

  const kccPolicyItems = kubectlJson('get', 'iampolicymembers.iam.cnrm.cloud.google.com', '-n', namespace);
  push('IAMPolicyMember', ((kccPolicyItems && kccPolicyItems.items) || []).map((item) => {
    const rid = kccPolicyMemberId(item, project);
    const spec = item.spec || {};
    return `${rid}/${spec.role}/${spec.member}`;
  }), 'kcc');

  return { namespace, project, resources, diagnostics };
}
