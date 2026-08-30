// Сирий збір фактів для одного KCC namespace: що є "живого" в GCP-проєкті і
// що заявлено як Config Connector CR у цьому namespace — для кожного з
// видів ресурсів. Жодного diff-у, жодного форматування, жодного I/O в
// консоль: тільки звернення до GCP REST API (gcp-rest.mjs) і Kubernetes
// REST API (k8s-rest.mjs), і нормалізація результату в плаский список.
// Diff і звіт — робота kcc-inventory.mjs, який споживає цей список.
//
// Обидва боки йдуть напряму через REST (Application Default Credentials),
// без gcloud/kubectl на PATH: без повільного старту процесу на кожен
// виклик (сам по собі перевірений внесок у затримку — один
// search-all-resources на проєкті з сотнями активів під gcloud займав
// ~100с), і з реальною помилкою замість мовчазного порожнього результату
// при збої автентифікації.
import { getJson, paginate } from './gcp-rest.mjs';
import { getNamespace, listNamespaces, listCustomObjects } from './k8s-rest.mjs';

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
  'RunService',
  'RunJob',
  'CloudSchedulerJob',
  'EventarcTrigger',
  'PubSubTopic',
  'PubSubSubscription',
  'SecretManagerSecret',
  'VPCAccessConnector',
  'ComputeNetwork',
  'ComputeSubnetwork',
  'KMSCryptoKey',
  'ComputeBackendService',
  'ComputeNetworkEndpointGroup',
  'ComputeURLMap',
  'ComputeTargetHTTPSProxy',
  'ComputeGlobalForwardingRule',
  'ComputeSSLCertificate',
  'IAMPolicyMember',
];

// Ресурси, якими свідомо керує інший declarative controller, а не KCC.
// Це вузький каталог ownership, не фільтр: запис лишається у inventory з
// власним source і kcc-inventory показує його як covered.
const CONTROLLED_RESOURCES = [
  {
    project: 'nitraai',
    kind: 'ArtifactRegistryRepository',
    id: 'us-central1/forgejo-remote',
    source: 'opentofu',
  },
];

export function controlledResources(project, kind) {
  return CONTROLLED_RESOURCES.filter((resource) => resource.project === project && resource.kind === kind);
}

async function kccField(kind, namespace, fieldFn) {
  const items = await listCustomObjects(kind, namespace);
  return items.map(fieldFn).filter(Boolean);
}

const ASSET_API = 'https://cloudasset.googleapis.com/v1';
const IAM_API = 'https://iam.googleapis.com/v1';
const COMPUTE_API = 'https://compute.googleapis.com/compute/v1';
const DNS_API = 'https://dns.googleapis.com/dns/v1';
const GKE_API = 'https://container.googleapis.com/v1';

function searchAllResources(project) {
  return paginate(`${ASSET_API}/projects/${project}:searchAllResources`, { pageSize: 500 }, 'results');
}

function searchAllIamPolicies(project) {
  return paginate(`${ASSET_API}/projects/${project}:searchAllIamPolicies`, { pageSize: 500 }, 'results');
}

// projects/-/serviceAccounts/{email} — валідний шлях в IAM API, project
// беремо з листа `-`: не треба окремо передавати project поруч з email.
async function listUserManagedKeyIds(email) {
  const data = await getJson(`${IAM_API}/projects/-/serviceAccounts/${email}/keys`, { keyTypes: 'USER_MANAGED' });
  return (data.keys || []).map((k) => k.name.split('/').pop());
}

// aggregatedList: один виклик на всі регіони одразу, а не по одному на
// регіон. items — мапа "regions/{region}" -> {addresses: [...]}, не
// плаский масив під nextPageToken, тому власна пагінація, не paginate().
async function listRegionalAddressIds(project) {
  const out = [];
  let pageToken;
  do {
    const data = await getJson(`${COMPUTE_API}/projects/${project}/aggregated/addresses`, { pageSize: 500, pageToken });
    for (const [scopeKey, val] of Object.entries(data.items || {})) {
      if (!val.addresses) continue;
      const region = scopeKey.replace(/^regions\//, '');
      for (const a of val.addresses) out.push(`${region}/${a.name}`);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function listGlobalAddressIds(project) {
  const items = await paginate(`${COMPUTE_API}/projects/${project}/global/addresses`, { pageSize: 500 }, 'items');
  return items.map((a) => `global/${a.name}`);
}

async function listDefaultSubnetworkIds(project) {
  const out = [];
  let pageToken;
  do {
    const data = await getJson(`${COMPUTE_API}/projects/${project}/aggregated/subnetworks`, { pageSize: 500, pageToken });
    for (const [scopeKey, val] of Object.entries(data.items || {})) {
      const region = scopeKey.replace(/^regions\//, '');
      for (const subnet of val.subnetworks || []) {
        if (subnet.name === 'default' && subnet.network?.endsWith('/global/networks/default')) out.push(`${region}/default`);
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out;
}

async function listManagedZoneDnsNames(project) {
  const zones = await paginate(`${DNS_API}/projects/${project}/managedZones`, { maxResults: 500 }, 'managedZones');
  return new Map(zones.map((z) => [z.name, z.dnsName]));
}

function gkeNodePoolIdentity(name, parent) {
  const match = name.match(/\/(?:locations|zones|regions)\/[^/]+\/clusters\/([^/]+)\/nodePools\/([^/]+)$/);
  if (match) return `${match[1]}/${match[2]}`;
  const cluster = parent?.match(/\/clusters\/([^/]+)$/)?.[1];
  return cluster && name && !name.includes('/') ? `${cluster}/${name}` : null;
}

function gkeClusterParent(name) {
  const match = name.match(/\/projects\/([^/]+)\/(?:locations|zones|regions)\/([^/]+)\/clusters\/([^/]+)\/nodePools\/[^/]+$/);
  return match && `projects/${match[1]}/locations/${match[2]}/clusters/${match[3]}`;
}

async function listGkeNodePoolIds(parents) {
  const pools = await Promise.all([...parents].map(async (parent) => {
    const { nodePools: items = [] } = await getJson(`${GKE_API}/${parent}/nodePools`);
    return items.map((pool) => gkeNodePoolIdentity(pool.name, parent)).filter(Boolean);
  }));
  return new Set(pools.flat());
}

function stripPrefix(s, prefix) {
  return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}

// Один ID для всіх location/region/zone ресурсів: location/name. Це не дає
// однаковим іменам у різних регіонах зливатися в один inventory запис.
function assetScopedId(asset, collection) {
  const m = (asset.name || '').match(new RegExp(`/(?:locations|regions|zones)/([^/]+)/${collection}/([^/]+)$`));
  return m && `${m[1]}/${m[2]}`;
}

function kccScopedId(item, { defaultLocation, name = (i) => i.spec && i.spec.resourceID } = {}) {
  const spec = item.spec || {};
  const resourceName = name(item) || (item.metadata && item.metadata.name);
  const location = spec.location || spec.region || spec.zone || defaultLocation;
  return location && resourceName ? `${location}/${resourceName}` : null;
}

function resourceId(item) {
  return (item.spec && item.spec.resourceID) || (item.metadata && item.metadata.name);
}

function liveScopedIds(assets, type, collection) {
  return assets.filter((a) => a.assetType === type).map((a) => assetScopedId(a, collection)).filter(Boolean);
}

function assetGlobalOrScopedId(asset, collection) {
  const scoped = assetScopedId(asset, collection);
  if (scoped) return scoped;
  const global = (asset.name || '').match(new RegExp(`/global/${collection}/([^/]+)$`));
  return global && `global/${global[1]}`;
}

function liveGlobalOrScopedIds(assets, type, collection) {
  return assets.filter((a) => a.assetType === type).map((a) => assetGlobalOrScopedId(a, collection)).filter(Boolean);
}

// --- фільтри GCP-системного шуму (див. includeSystem) ----------------------

const SA_SYSTEM = [
  /^[0-9]+-compute@developer\.gserviceaccount\.com$/,
  /@appspot\.gserviceaccount\.com$/,
  /@cloudservices\.gserviceaccount\.com$/,
  /^firebase-adminsdk-/,
];

const AR_SYSTEM = [/(^|\/)(?:gcr\.io|(?:asia|eu|us)\.gcr\.io)$/, /(^|\/)gcf-artifacts$/];

const NODEPOOL_SYSTEM = /^nap-/;
// GKE Gateway controller names the Compute resources it owns
// `gkegw<generation>-<namespace>-...`. They are derived from Gateway API
// objects and must not be adopted by a second controller such as KCC.
const GKE_GATEWAY_SYSTEM = /(^|\/)gkegw\d+-/;

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

export function isGkeGatewayManaged(id) {
  return GKE_GATEWAY_SYSTEM.test(id);
}

export function isDefaultNetwork(id) {
  return id === 'global/default';
}

export function isManagedZoneApexRecord(recordName, type, dnsName) {
  return (type === 'NS' || type === 'SOA') && recordName === dnsName;
}

export function isGkeNodePoolName(name) {
  return Boolean(gkeNodePoolIdentity(name));
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
  const mRunService = res.match(/\/projects\/[^/]+\/locations\/([^/]+)\/services\/([^/]+)$/);
  if (mRunService && assetType === 'run.googleapis.com/Service') return `run-service/${mRunService[1]}/${mRunService[2]}`;
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

function kccPolicyMemberId(item, project, runServiceRefs) {
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
    case 'RunService': {
      const external = ref.external || '';
      const m = external.match(/projects\/[^/]+\/locations\/([^/]+)\/services\/([^/]+)$/);
      if (m) return `run-service/${m[1]}/${m[2]}`;
      return runServiceRefs.get(ref.name) || `run-service/?/${ref.name || '?'}`;
    }
    default:
      return 'other/' + (ref.external || ref.name || '?');
  }
}

/**
 * Проєкт GCP, прив'язаний до namespace, або null, якщо анотація відсутня.
 */
export async function projectForNamespace(namespace) {
  const ns = await getNamespace(namespace);
  return (ns && ns.metadata && ns.metadata.annotations
    && ns.metadata.annotations['cnrm.cloud.google.com/project-id']) || null;
}

/**
 * Усі namespace з анотацією cnrm.cloud.google.com/project-id.
 */
export async function listKccNamespaces() {
  const items = await listNamespaces();
  return items
    .filter((i) => i.metadata && i.metadata.annotations && i.metadata.annotations['cnrm.cloud.google.com/project-id'])
    .map((i) => i.metadata.name);
}

/**
 * Збирає сирий список ресурсів одного namespace: усе, що живе в GCP
 * (source: 'gcp'), і все, що заявлено під KCC (source: 'kcc'), для кожного
 * з KIND_ORDER. Дублікати не прибираються — це відповідальність споживача.
 *
 * diagnostics — записи, які не є ні "живим", ні "заявленим" ресурсом, а
 * приміткою про сам збір: застарілий кеш Cloud Asset Inventory, зони й
 * Compute Load Balancer ресурси, якими керує сам GKE.
 *
 * Повертає { namespace, project, resources, diagnostics }. project — null,
 * якщо namespace не має анотації cnrm.cloud.google.com/project-id
 * (resources і diagnostics тоді порожні).
 */
export async function collectNamespace(namespace, { includeSystem = false } = {}) {
  const project = await projectForNamespace(namespace);
  if (!project) return { namespace, project: null, resources: [], diagnostics: [] };

  const resources = [];
  const diagnostics = [];
  const push = (kind, ids, source) => {
    for (const id of ids) if (id) resources.push({ kind, id, source });
  };

  const assets = await searchAllResources(project);
  const byType = (...types) => assets.filter((a) => types.includes(a.assetType));

  // --- IAMServiceAccount ---------------------------------------------------
  const allLiveSa = byType('iam.googleapis.com/ServiceAccount')
    .map((a) => a.additionalAttributes && a.additionalAttributes.email)
    .filter(Boolean);
  let liveSa = allLiveSa;
  if (!includeSystem) liveSa = liveSa.filter((e) => !isSystem(SA_SYSTEM, e));
  push('IAMServiceAccount', liveSa, 'gcp');
  push('IAMServiceAccount', await kccField(
    'IAMServiceAccount', namespace,
    (i) => i.status && i.status.email,
  ), 'kcc');

  // --- IAMServiceAccountKey (тільки user-managed) ---------------------------
  // Живі SA для циклу ключів беремо БЕЗ фільтра system — дешевше не
  // ускладнювати, ключ системного SA все одно рідкість. Один REST-виклик
  // на SA, усі паралельно — раніше це був послідовний цикл окремих
  // процесів gcloud, найповільніша частина всього скану.
  const liveKey = (await Promise.all(allLiveSa.map(listUserManagedKeyIds))).flat();
  push('IAMServiceAccountKey', liveKey, 'gcp');
  push('IAMServiceAccountKey', (await kccField(
    'IAMServiceAccountKey', namespace,
    (i) => i.status && i.status.name,
  )).map((n) => n.split('/').pop()), 'kcc');

  // --- ArtifactRegistryRepository -------------------------------------------
  let liveAr = liveScopedIds(assets, 'artifactregistry.googleapis.com/Repository', 'repositories');
  if (!includeSystem) {
    const systemAr = liveAr.filter((r) => isSystem(AR_SYSTEM, r));
    if (systemAr.length) diagnostics.push({ kind: 'ArtifactRegistryRepository', type: 'system-resource-skip', count: systemAr.length, reason: 'GCP-managed Artifact Registry repository' });
    liveAr = liveAr.filter((r) => !isSystem(AR_SYSTEM, r));
  }
  push('ArtifactRegistryRepository', liveAr, 'gcp');
  for (const resource of controlledResources(project, 'ArtifactRegistryRepository')) {
    push(resource.kind, [resource.id], resource.source);
  }
  push('ArtifactRegistryRepository', await kccField(
    'ArtifactRegistryRepository', namespace,
    (i) => kccScopedId(i),
  ), 'kcc');

  // --- ContainerCluster + ContainerNodePool ---------------------------------
  push('ContainerCluster', liveScopedIds(assets, 'container.googleapis.com/Cluster', 'clusters'), 'gcp');
  const containerClusterItems = await listCustomObjects('ContainerCluster', namespace);
  push('ContainerCluster', containerClusterItems.map((i) => kccScopedId(i)).filter(Boolean), 'kcc');
  const clusterRefs = new Map(containerClusterItems.map((i) => [i.metadata && i.metadata.name, kccScopedId(i)]));

  const poolAssets = [];
  const gkeClusterParents = new Set();
  for (const a of byType('container.googleapis.com/NodePool')) {
    const m = (a.name || '').match(/\/clusters\/([^/]+)\/nodePools\/([^/]+)$/);
    if (!m) continue;
    const [, cluster, pool] = m;
    const location = (a.name || '').match(/\/locations\/([^/]+)\/clusters\/[^/]+\/nodePools\/[^/]+$/)?.[1];
    const parent = gkeClusterParent(a.name || '');
    if (parent) gkeClusterParents.add(parent);
    poolAssets.push({ id: location ? `${location}/${cluster}/${pool}` : `${cluster}/${pool}`, identity: `${cluster}/${pool}`, pool });
  }
  const gkeNodePoolIds = await listGkeNodePoolIds(gkeClusterParents);
  const stalePoolCount = poolAssets.filter(({ identity }) => !gkeNodePoolIds.has(identity)).length;
  if (stalePoolCount) diagnostics.push({ kind: 'ContainerNodePool', type: 'stale-cache', count: stalePoolCount });
  const livePool = poolAssets
    .filter(({ identity }) => gkeNodePoolIds.has(identity))
    .filter(({ pool }) => includeSystem || !NODEPOOL_SYSTEM.test(pool))
    .map(({ id }) => id);
  push('ContainerNodePool', livePool, 'gcp');
  push('ContainerNodePool', await kccField(
    'ContainerNodePool', namespace,
    (i) => {
      const ref = (i.spec && i.spec.clusterRef) || {};
      const external = ref.external || '';
      const m = external.match(/\/locations\/([^/]+)\/clusters\/([^/]+)$/);
      return m ? `${m[1]}/${m[2]}/${resourceId(i)}` : `${clusterRefs.get(ref.name) || ref.name || external}/${resourceId(i)}`;
    },
  ), 'kcc');

  // --- StorageBucket ---------------------------------------------------------
  let liveBucket = byType('storage.googleapis.com/Bucket').map((a) => a.displayName);
  if (!includeSystem) liveBucket = liveBucket.filter((b) => !isSystemBucket(b, project));
  push('StorageBucket', liveBucket, 'gcp');
  push('StorageBucket', await kccField(
    'StorageBucket', namespace,
    (i) => i.spec && i.spec.resourceID,
  ), 'kcc');

  // --- ComputeAddress (регіональні й глобальні) -------------------------------
  // Asset Inventory інколи повертає вже видалені адреси (перевірено
  // емпірично на azovmemo: search-all-resources показав адресу без
  // читабельного імені, якої `gcloud compute addresses describe` вже не
  // знаходить — той самий клас застарілого кешу, що й ResourceRecordSet).
  // Два дешевих прямих виклики (regional + global), не по одному на
  // ресурс, — фільтруємо ними ці привиди CAI.
  const [regionalAddrIds, globalAddrIds] = await Promise.all([
    listRegionalAddressIds(project),
    listGlobalAddressIds(project),
  ]);
  const liveAddrIds = new Set([...regionalAddrIds, ...globalAddrIds]);
  const staleAddrCount0 = byType('compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress').length;
  const liveAddr = byType('compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress')
    .map((a) => `${a.location === 'global' ? 'global' : a.location}/${a.displayName}`)
    .filter((id) => liveAddrIds.has(id));
  const staleAddrCount = staleAddrCount0 - liveAddr.length;
  if (staleAddrCount) diagnostics.push({ kind: 'ComputeAddress', type: 'stale-cache', count: staleAddrCount });
  push('ComputeAddress', liveAddr, 'gcp');
  push('ComputeAddress', await kccField(
    'ComputeAddress', namespace,
    (i) => kccScopedId(i, { defaultLocation: 'global' }),
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
  push('DNSManagedZone', await kccField(
    'DNSManagedZone', namespace,
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
  let apexRrsetCount = 0;
  const zoneDnsNameByName = includeSystem ? new Map() : await listManagedZoneDnsNames(project);
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
    if (!includeSystem && isManagedZoneApexRecord(mRr[1], mRr[2], zoneDnsNameByName.get(zname))) {
      apexRrsetCount += 1;
      continue;
    }
    liveRrset.push(`${zname}/${mRr[1]}/${mRr[2]}`);
  }
  if (staleRrsetCount) diagnostics.push({ kind: 'DNSRecordSet', type: 'stale-cache', count: staleRrsetCount });
  if (apexRrsetCount) diagnostics.push({ kind: 'DNSRecordSet', type: 'system-resource-skip', count: apexRrsetCount, reason: 'Cloud DNS zone-apex NS/SOA record' });
  push('DNSRecordSet', liveRrset, 'gcp');
  push('DNSRecordSet', await kccField(
    'DNSRecordSet', namespace,
    (i) => {
      const zref = (i.spec && i.spec.managedZoneRef) || {};
      return `${zref.name}/${i.spec && i.spec.name}/${i.spec && i.spec.type}`;
    },
  ), 'kcc');

  // --- Cloud Run та його тригери/залежності ---------------------------------
  push('RunService', liveScopedIds(assets, 'run.googleapis.com/Service', 'services'), 'gcp');
  const runServiceItems = await listCustomObjects('RunService', namespace);
  push('RunService', runServiceItems.map((i) => kccScopedId(i)).filter(Boolean), 'kcc');

  push('RunJob', liveScopedIds(assets, 'run.googleapis.com/Job', 'jobs'), 'gcp');
  push('RunJob', await kccField('RunJob', namespace, (i) => kccScopedId(i)), 'kcc');

  push('CloudSchedulerJob', liveScopedIds(assets, 'cloudscheduler.googleapis.com/Job', 'jobs'), 'gcp');
  push('CloudSchedulerJob', await kccField('CloudSchedulerJob', namespace, (i) => kccScopedId(i)), 'kcc');

  push('EventarcTrigger', liveScopedIds(assets, 'eventarc.googleapis.com/Trigger', 'triggers'), 'gcp');
  push('EventarcTrigger', await kccField('EventarcTrigger', namespace, (i) => kccScopedId(i)), 'kcc');

  push('PubSubTopic', byType('pubsub.googleapis.com/Topic').map((a) => a.displayName), 'gcp');
  push('PubSubTopic', await kccField('PubSubTopic', namespace, resourceId), 'kcc');
  push('PubSubSubscription', byType('pubsub.googleapis.com/Subscription').map((a) => a.displayName), 'gcp');
  push('PubSubSubscription', await kccField('PubSubSubscription', namespace, resourceId), 'kcc');

  push('SecretManagerSecret', byType('secretmanager.googleapis.com/Secret').map((a) => a.displayName), 'gcp');
  push('SecretManagerSecret', await kccField('SecretManagerSecret', namespace, resourceId), 'kcc');

  push('VPCAccessConnector', liveScopedIds(assets, 'vpcaccess.googleapis.com/Connector', 'connectors'), 'gcp');
  push('VPCAccessConnector', await kccField('VPCAccessConnector', namespace, (i) => kccScopedId(i)), 'kcc');
  let liveNetwork = liveGlobalOrScopedIds(assets, 'compute.googleapis.com/Network', 'networks');
  if (!includeSystem) {
    const defaultNetwork = liveNetwork.filter(isDefaultNetwork);
    if (defaultNetwork.length) diagnostics.push({ kind: 'ComputeNetwork', type: 'system-resource-skip', count: defaultNetwork.length, reason: 'GCP default network' });
    liveNetwork = liveNetwork.filter((id) => !isDefaultNetwork(id));
  }
  push('ComputeNetwork', liveNetwork, 'gcp');
  push('ComputeNetwork', await kccField('ComputeNetwork', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })), 'kcc');
  let liveSubnetwork = liveScopedIds(assets, 'compute.googleapis.com/Subnetwork', 'subnetworks');
  if (!includeSystem) {
    const defaultSubnetworkIds = new Set(await listDefaultSubnetworkIds(project));
    const defaultSubnetworks = liveSubnetwork.filter((id) => defaultSubnetworkIds.has(id));
    if (defaultSubnetworks.length) diagnostics.push({ kind: 'ComputeSubnetwork', type: 'system-resource-skip', count: defaultSubnetworks.length, reason: 'GCP default-network subnetwork' });
    liveSubnetwork = liveSubnetwork.filter((id) => !defaultSubnetworkIds.has(id));
  }
  push('ComputeSubnetwork', liveSubnetwork, 'gcp');
  push('ComputeSubnetwork', await kccField('ComputeSubnetwork', namespace, (i) => kccScopedId(i)), 'kcc');

  // KMS key ідентифікується не лише ім'ям: keyRing теж є частиною URI.
  const cryptoKeyId = (a) => {
    const m = (a.name || '').match(/\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)$/);
    return m && `${m[1]}/${m[2]}/${m[3]}`;
  };
  push('KMSCryptoKey', byType('cloudkms.googleapis.com/CryptoKey').map(cryptoKeyId).filter(Boolean), 'gcp');
  push('KMSCryptoKey', await kccField('KMSCryptoKey', namespace, (i) => {
    const ref = (i.spec && i.spec.keyRingRef) || {};
    const m = (ref.external || '').match(/\/locations\/([^/]+)\/keyRings\/([^/]+)$/);
    return m ? `${m[1]}/${m[2]}/${resourceId(i)}` : null;
  }), 'kcc');

  // --- HTTP(S) LB, що часто стоїть перед Cloud Run ---------------------------
  const liveLoadBalancer = (kind, assetType, collection) => {
    const ids = liveGlobalOrScopedIds(assets, assetType, collection);
    if (includeSystem) return ids;
    const gatewayManaged = ids.filter(isGkeGatewayManaged);
    if (gatewayManaged.length) {
      diagnostics.push({ kind, type: 'gke-gateway-managed-skip', count: gatewayManaged.length });
    }
    return ids.filter((id) => !isGkeGatewayManaged(id));
  };
  push('ComputeBackendService', liveLoadBalancer('ComputeBackendService', 'compute.googleapis.com/BackendService', 'backendServices'), 'gcp');
  push('ComputeBackendService', await kccField('ComputeBackendService', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })), 'kcc');
  const isServerlessNeg = (a) => (a.additionalAttributes && a.additionalAttributes.networkEndpointType) === 'SERVERLESS'
    || (a.resource && a.resource.data && a.resource.data.networkEndpointType) === 'SERVERLESS';
  push('ComputeNetworkEndpointGroup', byType('compute.googleapis.com/NetworkEndpointGroup')
    .filter(isServerlessNeg).map((a) => assetGlobalOrScopedId(a, 'networkEndpointGroups')).filter(Boolean), 'gcp');
  push('ComputeNetworkEndpointGroup', await kccField('ComputeNetworkEndpointGroup', namespace, (i) => {
    const type = i.spec && i.spec.networkEndpointType;
    return type === 'SERVERLESS' ? kccScopedId(i, { defaultLocation: 'global' }) : null;
  }), 'kcc');
  push('ComputeURLMap', liveLoadBalancer('ComputeURLMap', 'compute.googleapis.com/UrlMap', 'urlMaps'), 'gcp');
  push('ComputeURLMap', await kccField('ComputeURLMap', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })), 'kcc');
  push('ComputeTargetHTTPSProxy', liveLoadBalancer('ComputeTargetHTTPSProxy', 'compute.googleapis.com/TargetHttpsProxy', 'targetHttpsProxies'), 'gcp');
  push('ComputeTargetHTTPSProxy', await kccField('ComputeTargetHTTPSProxy', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })), 'kcc');
  push('ComputeGlobalForwardingRule', byType('compute.googleapis.com/ForwardingRule')
    .map((a) => assetGlobalOrScopedId(a, 'forwardingRules')).filter((id) => id && id.startsWith('global/')), 'gcp');
  push('ComputeGlobalForwardingRule', await kccField('ComputeGlobalForwardingRule', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })), 'kcc');
  push('ComputeSSLCertificate', liveGlobalOrScopedIds(assets, 'compute.googleapis.com/SslCertificate', 'sslCertificates'), 'gcp');
  const sslKcc = await Promise.all([
    kccField('ComputeSSLCertificate', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })),
    kccField('ComputeManagedSSLCertificate', namespace, (i) => kccScopedId(i, { defaultLocation: 'global' })),
  ]);
  push('ComputeSSLCertificate', sslKcc.flat(), 'kcc');

  // --- IAMPolicyMember ---------------------------------------------------------
  // search-all-iam-policies — усі біндинги проєкту одразу, на будь-якому
  // типі ресурсу, не тільки на трьох раніше підтримуваних (Project/SA/AR).
  const iamPolicies = await searchAllIamPolicies(project);
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

  const runServiceRefs = new Map(runServiceItems.map((i) => [i.metadata && i.metadata.name, kccScopedId(i)]));
  push('IAMPolicyMember', await kccField(
    'IAMPolicyMember', namespace,
    (item) => {
      const rid = kccPolicyMemberId(item, project, runServiceRefs);
      const spec = item.spec || {};
      return `${rid}/${spec.role}/${spec.member}`;
    },
  ), 'kcc');

  return { namespace, project, resources, diagnostics };
}

// --- CLI: `cfr get-resources` — collectNamespace() as its own subcommand,
// no diffing. What kcc-inventory consumes, exposed directly for anyone
// who wants the raw facts (piping into jq, feeding a different tool).

export const HELP = `cfr get-resources — raw KCC/GCP resource list, no diff

Usage:
  npx @nitra/cfr get-resources <namespace>
  npx @nitra/cfr get-resources --all
  npx @nitra/cfr get-resources <namespace|--all> [--json] [--include-system]

The mechanism kcc-inventory is built on, callable on its own: per KCC
namespace (namespace carrying the annotation
cnrm.cloud.google.com/project-id), lists every resource found live in the
GCP project (source: gcp) and every one declared as a Config Connector
custom resource in that namespace. It covers IAM, Artifact Registry, GKE,
Cloud Run (services and jobs), Scheduler, Eventarc, Pub/Sub, Secret Manager,
VPC Access, selected network/LB resources, KMS, Cloud DNS, and
IAMPolicyMember. No drift/orphan diff — that's
\`cfr kcc-inventory\`.

By default GCP-managed system noise is filtered out (Google-owned service
accounts, Artifact Registry shims, GCP default network/subnets, GKE Gateway resources,
node pools/DNS zones, Cloud DNS zone-apex NS/SOA records, legacy bucket
ACL entries, ...) — pass --include-system to see it anyway.

No \`gcloud\` or \`kubectl\` CLI needed — both the GCP side and the cluster
side talk REST directly, authenticated with Application Default
Credentials. Cluster connection details (server, CA) still come from your
kubeconfig (KUBECONFIG, default ~/.kube/config); set KUBE_CONTEXT to
target a specific context explicitly instead of relying on
current-context. Only tested against GKE.

Options:
  --json             Emit {resources, diagnostics} as JSON instead of the
                      human-readable listing.
  --include-system   Don't filter out GCP-managed system resources.
  -h, --help         Show this help and exit.

Exits 0 on a completed scan, 2 on a usage error.
`;

function printHuman(namespace, collected) {
  console.log(`### namespace ${namespace} -> проєкт ${collected.project} ###`);
  const byKind = new Map(KIND_ORDER.map((k) => [k, []]));
  for (const r of collected.resources) byKind.get(r.kind)?.push(r);
  for (const kind of KIND_ORDER) {
    const entries = byKind.get(kind);
    if (!entries.length) continue;
    console.log(`== ${kind} ==`);
    for (const { source, id } of [...entries].sort((a, b) => a.id.localeCompare(b.id))) {
      console.log(`  ${source}: ${id}`);
    }
  }
  if (collected.diagnostics.length) {
    console.log('== diagnostics ==');
    for (const d of collected.diagnostics) {
      if (d.type === 'stale-cache') console.log(`  ${d.kind}: застарілий кеш Asset Inventory, ${d.count} запис(ів)`);
      else if (d.type === 'gke-managed-skip') console.log(`  ${d.kind}: керує сам GKE — ${d.zones.join(', ')}`);
      else if (d.type === 'gke-gateway-managed-skip') console.log(`  ${d.kind}: GKE Gateway controller — ${d.count} ресурс(ів)`);
      else if (d.type === 'system-resource-skip') console.log(`  ${d.kind}: ${d.reason} — ${d.count} ресурс(ів)`);
    }
  }
  console.log('');
}

export async function run(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const target = argv[0];
  if (!target) {
    console.error('usage: cfr get-resources <namespace|--all> [--json] [--include-system]  (KUBE_CONTEXT=... для явного контексту)');
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

  const resources = [];
  const diagnostics = [];
  for (const namespace of namespaces) {
    const collected = await collectNamespace(namespace, { includeSystem });
    if (!collected.project) {
      console.error(`namespace ${namespace} не має cnrm.cloud.google.com/project-id`);
      continue;
    }
    if (jsonMode) {
      for (const r of collected.resources) resources.push({ namespace, project: collected.project, ...r });
      for (const d of collected.diagnostics) diagnostics.push({ namespace, project: collected.project, ...d });
    } else {
      printHuman(namespace, collected);
    }
  }

  if (jsonMode) console.log(JSON.stringify({ resources, diagnostics }, null, 2));
  return 0;
}
