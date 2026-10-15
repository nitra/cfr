// Read-only live GCP inventory. No Kubernetes connection or controller discovery.
import { getJson, paginate } from './gcp-rest.mjs';

import { collectAdditionalProjectAssets, PROJECT_ASSET_KINDS, enabledServiceIds } from './project-assets.mjs';
import { GKE_SECURITY_BULLETIN_NAME, containerAnalysisTopicReason, pvcDiskReason } from './ignore-rules.mjs';
import { restoreDiskOrigins } from './restore-disk-ownership.mjs';

export const KIND_ORDER = [
  'IAMServiceAccount',
  'IAMServiceAccountKey',
  'IAMWorkloadIdentityPool',
  'IAMWorkloadIdentityPoolProvider',
  'ArtifactRegistryRepository',
  'CloudBuildTrigger',
  'ContainerCluster',
  'ContainerNodePool',
  'GKEBackupPlan',
  'StorageBucket',
  'ComputeAddress',
  'ComputeDisk',
  'ComputeRouter',
  'ComputeRouterNAT',
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
  ...PROJECT_ASSET_KINDS,
  'ComputeForwardingRule',
];

const ASSET_API = 'https://cloudasset.googleapis.com/v1';
const IAM_API = 'https://iam.googleapis.com/v1';
const COMPUTE_API = 'https://compute.googleapis.com/compute/v1';
const DNS_API = 'https://dns.googleapis.com/dns/v1';
const GKE_API = 'https://container.googleapis.com/v1';

export function searchAllResources(project) {
  return paginate(`${ASSET_API}/projects/${project}:searchAllResources`, { pageSize: 500 }, 'results');
}

function searchAllIamPolicies(project) {
  return paginate(`${ASSET_API}/projects/${project}:searchAllIamPolicies`, { pageSize: 500 }, 'results');
}

function listBucketIamPolicyAssets(project) {
  return paginate(
    `${ASSET_API}/projects/${project}/assets`,
    {
      contentType: 'IAM_POLICY',
      assetTypes: ['storage.googleapis.com/Bucket'],
      pageSize: 500,
    },
    'assets',
  );
}

// projects/-/serviceAccounts/{email} — валідний шлях в IAM API, project
// беремо з листа `-`: не треба окремо передавати project поруч з email.
async function listUserManagedKeyIds(email) {
  const data = await getJson(`${IAM_API}/projects/-/serviceAccounts/${email}/keys`, { keyTypes: 'USER_MANAGED' });
  return (data.keys || []).map((k) => k.name.split('/').pop());
}

async function listWorkloadIdentityPools(project) {
  return paginate(
    `${IAM_API}/projects/${project}/locations/global/workloadIdentityPools`,
    { pageSize: 1000 },
    'workloadIdentityPools',
  );
}

async function listWorkloadIdentityPoolProviders(poolName) {
  return paginate(`${IAM_API}/${poolName}/providers`, { pageSize: 1000 }, 'workloadIdentityPoolProviders');
}

function workloadIdentityPoolId(name) {
  const match = name && name.match(/\/locations\/([^/]+)\/workloadIdentityPools\/([^/]+)$/);
  return match && `${match[1]}/${match[2]}`;
}

function workloadIdentityPoolProviderId(name) {
  const match = name && name.match(/\/locations\/([^/]+)\/workloadIdentityPools\/([^/]+)\/providers\/([^/]+)$/);
  return match && `${match[1]}/${match[2]}/${match[3]}`;
}

export function isGkeWorkloadIdentityPool(pool) {
  return Boolean(pool.name && pool.name.endsWith('.svc.id.goog'));
}

// aggregatedList: один виклик на всі регіони одразу, а не по одному на
// регіон. items — мапа "regions/{region}" -> {addresses: [...]}, не
// плаский масив під nextPageToken, тому власна пагінація, не paginate().
async function listRegionalAddressIds(project, { autoNatIds } = {}) {
  const out = [];
  let pageToken;
  do {
    const data = await getJson(`${COMPUTE_API}/projects/${project}/aggregated/addresses`, { pageSize: 500, pageToken });
    for (const [scopeKey, val] of Object.entries(data.items || {})) {
      if (!val.addresses) continue;
      const region = scopeKey.replace(/^regions\//, '');
      for (const a of val.addresses) {
        const id = `${region}/${a.name}`;
        out.push(id);
        if (isAutomaticNatAddress(a)) autoNatIds?.add(id);
      }
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

export function gkeNodePoolScopedId(name) {
  const match = name.match(/\/(?:locations|zones|regions)\/([^/]+)\/clusters\/([^/]+)\/nodePools\/([^/]+)$/);
  return match && `${match[1]}/${match[2]}/${match[3]}`;
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
// GKE Gateway names derived resources gkegw<generation>-<namespace>-...;
// these remain controller-owned and must not be adopted by OpenTofu.
const GKE_GATEWAY_SYSTEM = /(^|\/)gkegw\d+-/;
// GKE Ingress uses these names for its L7 resources. They are derived from an
// Ingress / ManagedCertificate and must remain under the GKE controller.
const GKE_INGRESS_SYSTEM = /(^|\/)(?:k8s[12]-|mcrt-)/;

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

// Cloud Asset may use a full project path; state secret_id is a short name.
export function liveSecretId(asset) {
  return typeof asset?.displayName === 'string' ? asset.displayName.split('/').at(-1) : undefined;
}

function isSystem(patterns, value) {
  return patterns.some((p) => p.test(value));
}

export function isGkeGatewayManaged(id) {
  return GKE_GATEWAY_SYSTEM.test(id);
}

export function isGkeIngressManaged(id) {
  return GKE_INGRESS_SYSTEM.test(id);
}

export function isGkePrivateEndpointAddress(id) {
  return /(^|\/)gke-.+-pe$/.test(id);
}

export function isAutomaticNatAddress(address) {
  return address.purpose === 'NAT_AUTO';
}

export function gkePrivateEndpointSubnetworkIds(clusters, project) {
  return new Set(clusters.flatMap((cluster) => {
    const name = cluster.controlPlaneEndpointsConfig?.ipEndpointsConfig?.privateEndpointSubnetwork
      || cluster.privateClusterConfig?.privateEndpointSubnetwork;
    const match = name?.match(/projects\/([^/]+)\/regions\/([^/]+)\/subnetworks\/([^/]+)$/);
    return match && match[1] === project ? [`${match[2]}/${match[3]}`] : [];
  }));
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

// Cloud Asset reports every resource of the scanned project with
// `project: projects/<NUMBER>`. Secret-level IAM resource names use that number
// while OpenTofu state uses the project ID, so derive number -> ID from assets.
export function projectNumberFromAssets(assets) {
  const numbers = new Set(assets.map((a) => a.project?.match(/^projects\/(\d+)$/)?.[1]).filter(Boolean));
  return numbers.size === 1 ? [...numbers][0] : undefined;
}

function assetResId(entry, project, projectNumber) {
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
  const other = stripPrefix(res, '//');
  return 'other/' + (projectNumber ? other.replace(`/projects/${projectNumber}/`, `/projects/${project}/`) : other);
}

export function replaceBucketIamPolicies(searchEntries, bucketAssets) {
  return [
    ...searchEntries.filter((entry) => entry.assetType !== 'storage.googleapis.com/Bucket'),
    ...bucketAssets.map((asset) => ({
      assetType: asset.assetType,
      resource: asset.name,
      policy: asset.iamPolicy,
    })),
  ];
}

export function liveIamPolicyResources(iamPolicies, project, includeSystem = false, projectNumber) {
  const resources = [];
  for (const entry of iamPolicies) {
    const rid = assetResId(entry, project, projectNumber);
    for (const binding of (entry.policy && entry.policy.bindings) || []) {
      for (const member of binding.members || []) {
        if (includeSystem || !isSystem(IAM_SYSTEM, member)) {
          resources.push({
            id: `${rid}/${binding.role}/${member}`,
            ...(binding.condition ? { condition: binding.condition } : {}),
          });
        }
      }
    }
  }
  return resources;
}

export function liveIamPolicyIds(iamPolicies, project, includeSystem = false, projectNumber) {
  return liveIamPolicyResources(iamPolicies, project, includeSystem, projectNumber).map((resource) => resource.id);
}

export function canonicalPubSubId(id, project, collection) {
  if (!id || id.startsWith('projects/')) return id;
  return `projects/${project}/${collection}/${id}`;
}

export async function collectProject(project, { includeSystem = false } = {}) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('project must be a non-empty string');
  const resources = [];
  const diagnostics = [];
  const push = (kind, entries, source) => {
    for (const entry of entries) {
      if (typeof entry === 'string' && entry) resources.push({ kind, id: entry, source });
      else if (entry && entry.id) resources.push({ kind, ...entry, source });
    }
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

  // --- IAMServiceAccountKey (тільки user-managed) ---------------------------
  // Живі SA для циклу ключів беремо БЕЗ фільтра system — дешевше не
  // ускладнювати, ключ системного SA все одно рідкість. Один REST-виклик
  // на SA, усі паралельно — раніше це був послідовний цикл окремих
  // процесів gcloud, найповільніша частина всього скану.
  const liveKey = (await Promise.all(allLiveSa.map(listUserManagedKeyIds))).flat();
  push('IAMServiceAccountKey', liveKey, 'gcp');

  // --- IAMWorkloadIdentityPool + Provider ----------------------------------
  // Cloud Asset Inventory не гарантує повне покриття IAM federation
  // resources, тому читаємо їх напряму через IAM REST API.
  const allWorkloadIdentityPools = await listWorkloadIdentityPools(project);
  const gkeWorkloadIdentityPools = allWorkloadIdentityPools.filter(isGkeWorkloadIdentityPool);
  const workloadIdentityPools = includeSystem
    ? allWorkloadIdentityPools
    : allWorkloadIdentityPools.filter((pool) => !isGkeWorkloadIdentityPool(pool));
  if (!includeSystem && gkeWorkloadIdentityPools.length) {
    diagnostics.push({
      kind: 'IAMWorkloadIdentityPool',
      type: 'system-resource-skip',
      count: gkeWorkloadIdentityPools.length,
      reason: 'GKE-managed Workload Identity pool',
    });
  }
  push('IAMWorkloadIdentityPool', workloadIdentityPools.map((pool) => workloadIdentityPoolId(pool.name)), 'gcp');

  const workloadIdentityProviders = (await Promise.all(
    allWorkloadIdentityPools
      .filter((pool) => !isGkeWorkloadIdentityPool(pool))
      .map((pool) => listWorkloadIdentityPoolProviders(pool.name)),
  )).flat();
  push(
    'IAMWorkloadIdentityPoolProvider',
    workloadIdentityProviders.map((provider) => workloadIdentityPoolProviderId(provider.name)),
    'gcp',
  );

  // --- ArtifactRegistryRepository -------------------------------------------
  let liveAr = liveScopedIds(assets, 'artifactregistry.googleapis.com/Repository', 'repositories');
  if (!includeSystem) {
    const systemAr = liveAr.filter((r) => isSystem(AR_SYSTEM, r));
    if (systemAr.length) diagnostics.push({ kind: 'ArtifactRegistryRepository', type: 'system-resource-skip', count: systemAr.length, reason: 'GCP-managed Artifact Registry repository' });
    liveAr = liveAr.filter((r) => !isSystem(AR_SYSTEM, r));
  }
  push('ArtifactRegistryRepository', liveAr, 'gcp');

  // --- ContainerCluster + ContainerNodePool ---------------------------------
  push('ContainerCluster', liveScopedIds(assets, 'container.googleapis.com/Cluster', 'clusters'), 'gcp');

  const poolAssets = [];
  const gkeClusterParents = new Set();
  for (const a of byType('container.googleapis.com/NodePool')) {
    const m = (a.name || '').match(/\/clusters\/([^/]+)\/nodePools\/([^/]+)$/);
    if (!m) continue;
    const [, cluster, pool] = m;
    const parent = gkeClusterParent(a.name || '');
    if (parent) gkeClusterParents.add(parent);
    poolAssets.push({ id: gkeNodePoolScopedId(a.name || '') || `${cluster}/${pool}`, identity: `${cluster}/${pool}`, pool });
  }
  const gkeNodePoolIds = await listGkeNodePoolIds(gkeClusterParents);
  const stalePoolCount = poolAssets.filter(({ identity }) => !gkeNodePoolIds.has(identity)).length;
  if (stalePoolCount) diagnostics.push({ kind: 'ContainerNodePool', type: 'stale-cache', count: stalePoolCount });
  const livePool = poolAssets
    .filter(({ identity }) => gkeNodePoolIds.has(identity))
    .filter(({ pool }) => includeSystem || !NODEPOOL_SYSTEM.test(pool))
    .map(({ id }) => id);
  push('ContainerNodePool', livePool, 'gcp');

  // --- StorageBucket ---------------------------------------------------------
  let liveBucket = byType('storage.googleapis.com/Bucket').map((a) => a.displayName);
  if (!includeSystem) liveBucket = liveBucket.filter((b) => !isSystemBucket(b, project));
  push('StorageBucket', liveBucket, 'gcp');

  // --- ComputeAddress (регіональні й глобальні) -------------------------------
  // Asset Inventory інколи повертає вже видалені адреси (перевірено
  // емпірично на azovmemo: search-all-resources показав адресу без
  // читабельного імені, якої `gcloud compute addresses describe` вже не
  // знаходить — той самий клас застарілого кешу, що й ResourceRecordSet).
  // Два дешевих прямих виклики (regional + global), не по одному на
  // ресурс, — фільтруємо ними ці привиди CAI.
  const autoNatIds = new Set();
  const [regionalAddrIds, globalAddrIds] = await Promise.all([
    listRegionalAddressIds(project, { autoNatIds }),
    listGlobalAddressIds(project),
  ]);
  const liveAddrIds = new Set([...regionalAddrIds, ...globalAddrIds]);
  const staleAddrCount0 = byType('compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress').length;
  let liveAddr = byType('compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress')
    .map((a) => `${a.location === 'global' ? 'global' : a.location}/${a.displayName}`)
    .filter((id) => liveAddrIds.has(id));
  const staleAddrCount = staleAddrCount0 - liveAddr.length;
  if (!includeSystem) {
    const privateEndpoints = liveAddr.filter(isGkePrivateEndpointAddress);
    if (privateEndpoints.length) diagnostics.push({ kind: 'ComputeAddress', type: 'gke-private-endpoint-skip', count: privateEndpoints.length });
    liveAddr = liveAddr.filter((id) => !isGkePrivateEndpointAddress(id));
    const autoNat = liveAddr.filter((id) => autoNatIds.has(id));
    if (autoNat.length) diagnostics.push({ kind: 'ComputeAddress', type: 'asset-scope-skip',
      assetType: 'compute.googleapis.com/Address', count: autoNat.length, reason: 'Cloud NAT automatic IP allocation (purpose NAT_AUTO)' });
    liveAddr = liveAddr.filter((id) => !autoNatIds.has(id));
  }
  if (staleAddrCount) diagnostics.push({ kind: 'ComputeAddress', type: 'stale-cache', count: staleAddrCount });
  push('ComputeAddress', liveAddr, 'gcp');

  // --- DNSManagedZone + DNSRecordSet -------------------------------------------
  // Зони, які GKE заводить і веде сам (label goog-gke-node) — не в diff

  const zones = byType('dns.googleapis.com/ManagedZone');
  const gkeZoneNames = new Set(
    zones.filter((z) => z.labels && z.labels['goog-gke-node'] !== undefined).map((z) => z.displayName),
  );
  const liveZone = zones.map((z) => z.displayName).filter((n) => !gkeZoneNames.has(n));
  if (gkeZoneNames.size) {
    diagnostics.push({ kind: 'DNSManagedZone', type: 'gke-managed-skip', zones: [...gkeZoneNames].sort() });
  }
  push('DNSManagedZone', liveZone, 'gcp');

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

  // --- Cloud Run та його тригери/залежності ---------------------------------
  push('RunService', liveScopedIds(assets, 'run.googleapis.com/Service', 'services'), 'gcp');

  push('RunJob', liveScopedIds(assets, 'run.googleapis.com/Job', 'jobs'), 'gcp');

  push('CloudSchedulerJob', liveScopedIds(assets, 'cloudscheduler.googleapis.com/Job', 'jobs'), 'gcp');

  push('EventarcTrigger', liveScopedIds(assets, 'eventarc.googleapis.com/Trigger', 'triggers'), 'gcp');

  // Container Analysis topics are tagged, not dropped (see ignore-rules.mjs).
  push('PubSubTopic', byType('pubsub.googleapis.com/Topic').map((a) => {
    const ignoreReason = includeSystem ? null : containerAnalysisTopicReason(a.displayName);
    return ignoreReason ? { id: a.displayName, ignoreReason } : a.displayName;
  }), 'gcp');

  push('PubSubSubscription', byType('pubsub.googleapis.com/Subscription').map((a) => a.displayName), 'gcp');

  push('SecretManagerSecret', byType('secretmanager.googleapis.com/Secret').map(liveSecretId).filter(Boolean), 'gcp');

  push('VPCAccessConnector', liveScopedIds(assets, 'vpcaccess.googleapis.com/Connector', 'connectors'), 'gcp');

  let liveNetwork = liveGlobalOrScopedIds(assets, 'compute.googleapis.com/Network', 'networks');
  if (!includeSystem) {
    const defaultNetwork = liveNetwork.filter(isDefaultNetwork);
    if (defaultNetwork.length) diagnostics.push({ kind: 'ComputeNetwork', type: 'system-resource-skip', count: defaultNetwork.length, reason: 'GCP default network' });
    liveNetwork = liveNetwork.filter((id) => !isDefaultNetwork(id));
  }
  push('ComputeNetwork', liveNetwork, 'gcp');

  let liveSubnetwork = liveScopedIds(assets, 'compute.googleapis.com/Subnetwork', 'subnetworks');
  if (!includeSystem && byType('container.googleapis.com/Cluster').length) {
    const { clusters = [] } = await getJson(`${GKE_API}/projects/${project}/locations/-/clusters`);
    const endpointIds = gkePrivateEndpointSubnetworkIds(clusters, project);
    const managed = liveSubnetwork.filter((id) => endpointIds.has(id));
    if (managed.length) diagnostics.push({ kind: 'ComputeSubnetwork', type: 'asset-scope-skip',
      assetType: 'compute.googleapis.com/Subnetwork', count: managed.length, reason: 'GKE control-plane private endpoint subnetwork (direct cluster reference)' });
    liveSubnetwork = liveSubnetwork.filter((id) => !endpointIds.has(id));
  }
  if (!includeSystem) {
    const defaultSubnetworkIds = new Set(await listDefaultSubnetworkIds(project));
    const defaultSubnetworks = liveSubnetwork.filter((id) => defaultSubnetworkIds.has(id));
    if (defaultSubnetworks.length) diagnostics.push({ kind: 'ComputeSubnetwork', type: 'system-resource-skip', count: defaultSubnetworks.length, reason: 'GCP default-network subnetwork' });
    liveSubnetwork = liveSubnetwork.filter((id) => !defaultSubnetworkIds.has(id));
  }
  push('ComputeSubnetwork', liveSubnetwork, 'gcp');

  // KMS key ідентифікується не лише ім'ям: keyRing теж є частиною URI.
  const cryptoKeyId = (a) => {
    const m = (a.name || '').match(/\/locations\/([^/]+)\/keyRings\/([^/]+)\/cryptoKeys\/([^/]+)$/);
    return m && `${m[1]}/${m[2]}/${m[3]}`;
  };
  push('KMSCryptoKey', byType('cloudkms.googleapis.com/CryptoKey').map(cryptoKeyId).filter(Boolean), 'gcp');

  {
    const services = await paginate(`https://serviceusage.googleapis.com/v1/projects/${project}/services`,
      { filter: 'state:ENABLED', pageSize: 200 }, 'services');
    push('ServiceUsageService', enabledServiceIds(services), 'gcp');
    const routes = byType('compute.googleapis.com/Route').length
      ? await paginate(`${COMPUTE_API}/projects/${project}/global/routes`, { maxResults: 500 }, 'items')
      : [];
    const computeProject = byType('compute.googleapis.com/Project').length
      ? await getJson(`${COMPUTE_API}/projects/${project}`) : undefined;
    const instanceSettings = new Map();
    for (const asset of includeSystem ? [] : byType('compute.googleapis.com/InstanceSettings')) {
      const zone = asset.name?.match(/\/zones\/([^/]+)/)?.[1];
      if (zone) instanceSettings.set(zone, await getJson(`${COMPUTE_API}/projects/${project}/zones/${zone}/instanceSettings`));
    }
    // Metadata-only reads that let the ignore rules / mappings be exact.
    const alertPolicies = new Map();
    for (const asset of includeSystem ? [] : byType('monitoring.googleapis.com/AlertPolicy')) {
      // Only the one well-known default title is inspected (1 call), not every policy.
      if (asset.displayName === GKE_SECURITY_BULLETIN_NAME) {
        const id = (asset.name || '').split('/').at(-1);
        alertPolicies.set(id, await getJson(`https://monitoring.googleapis.com/v3/projects/${project}/alertPolicies/${id}`));
      }
    }
    let activeRoleIds;
    if (byType('iam.googleapis.com/Role').length) {
      const roles = await paginate(`${IAM_API}/projects/${project}/roles`, { pageSize: 300 }, 'roles');
      activeRoleIds = new Set(roles.filter((role) => !role.deleted).map((role) => role.name.split('/').at(-1)));
    }
    const additional = collectAdditionalProjectAssets(assets, { includeSystem, routes, computeProject, instanceSettings, alertPolicies, activeRoleIds });
    resources.push(...additional.resources);
    diagnostics.push(...additional.diagnostics);
    const gkeNodeDisks = byType('compute.googleapis.com/Disk')
      .filter((asset) => asset.labels && Object.hasOwn(asset.labels, 'goog-gke-node'));
    const gkeNodeDiskIds = new Set(gkeNodeDisks.map((asset) => assetScopedId(asset, 'disks')).filter(Boolean));
    if (!includeSystem && gkeNodeDiskIds.size) {
      diagnostics.push({ kind: 'ComputeDisk', type: 'gke-managed-skip', zones: [...gkeNodeDiskIds].sort() });
    }
    const liveDisk = liveScopedIds(assets, 'compute.googleapis.com/Disk', 'disks')
      .filter((id) => includeSystem || !gkeNodeDiskIds.has(id));
    const diskOrigins = new Map();
    for (const asset of byType('gkebackup.googleapis.com/RestorePlan')) {
      const planId = assetScopedId(asset, 'restorePlans');
      if (!planId) throw new Error(`Invalid RestorePlan identity: ${asset.name}`);
      const [location, name] = planId.split('/');
      const parent = `projects/${project}/locations/${location}/restorePlans/${name}`;
      const restores = await paginate(`https://gkebackup.googleapis.com/v1/${parent}/restores`, { pageSize: 100 }, 'restores');
      for (const restore of restores) {
        const volumes = await paginate(`https://gkebackup.googleapis.com/v1/${restore.name}/volumeRestores`, { pageSize: 100 }, 'volumeRestores');
        for (const [id, origin] of restoreDiskOrigins(project, planId, volumes)) {
          if (diskOrigins.has(id) && diskOrigins.get(id).id !== origin.id) {
            throw new Error(`Conflicting RestorePlan disk origin: ${project}/${id}`);
          }
          diskOrigins.set(id, origin);
        }
      }
    }
    // PVC disks are tagged, not dropped; restore-derived disks keep their own
    // RestorePlan ownership classification and are never tagged.
    const pvcDiskReasons = new Map(includeSystem ? [] : byType('compute.googleapis.com/Disk')
      .map((asset) => [assetScopedId(asset, 'disks'), pvcDiskReason(asset)]).filter(([, reason]) => reason));
    resources.push(...liveDisk.map((id) => ({ kind: 'ComputeDisk', id, source: 'gcp',
      ...(diskOrigins.has(id) ? { derivedFrom: diskOrigins.get(id) }
        : pvcDiskReasons.has(id) ? { ignoreReason: pvcDiskReasons.get(id) } : {}) })));

    push('ComputeRouter', liveScopedIds(assets, 'compute.googleapis.com/Router', 'routers'), 'gcp');
    const routerNats = [];
    let pageToken;
    do {
      const data = await getJson(`${COMPUTE_API}/projects/${project}/aggregated/routers`, { pageSize: 500, pageToken });
      for (const [scope, value] of Object.entries(data.items || {})) {
        const region = scope.replace(/^regions\//, '');
        for (const router of value.routers || []) {
          for (const nat of router.nats || []) routerNats.push(`${region}/${router.name}/${nat.name}`);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    push('ComputeRouterNAT', routerNats, 'gcp');

    push('GKEBackupPlan', liveScopedIds(assets, 'gkebackup.googleapis.com/BackupPlan', 'backupPlans'), 'gcp');
    push('CloudBuildTrigger', liveScopedIds(assets, 'cloudbuild.googleapis.com/BuildTrigger', 'triggers'), 'gcp');
  }

  // --- HTTP(S) LB, що часто стоїть перед Cloud Run ---------------------------
  const liveLoadBalancer = (kind, assetType, collection) => {
    const ids = liveGlobalOrScopedIds(assets, assetType, collection);
    if (includeSystem) return ids;
    const gatewayManaged = ids.filter(isGkeGatewayManaged);
    const ingressManaged = ids.filter(isGkeIngressManaged);
    if (gatewayManaged.length) {
      diagnostics.push({ kind, type: 'gke-gateway-managed-skip', count: gatewayManaged.length });
    }
    if (ingressManaged.length) {
      diagnostics.push({ kind, type: 'gke-ingress-managed-skip', count: ingressManaged.length });
    }
    return ids.filter((id) => !isGkeGatewayManaged(id) && !isGkeIngressManaged(id));
  };
  push('ComputeBackendService', liveLoadBalancer('ComputeBackendService', 'compute.googleapis.com/BackendService', 'backendServices'), 'gcp');

  const isServerlessNeg = (a) => (a.additionalAttributes && a.additionalAttributes.networkEndpointType) === 'SERVERLESS'
    || (a.resource && a.resource.data && a.resource.data.networkEndpointType) === 'SERVERLESS';
  push('ComputeNetworkEndpointGroup', byType('compute.googleapis.com/NetworkEndpointGroup')
    .filter(isServerlessNeg).map((a) => assetGlobalOrScopedId(a, 'networkEndpointGroups')).filter(Boolean), 'gcp');

  push('ComputeURLMap', liveLoadBalancer('ComputeURLMap', 'compute.googleapis.com/UrlMap', 'urlMaps'), 'gcp');

  push('ComputeTargetHTTPSProxy', liveLoadBalancer('ComputeTargetHTTPSProxy', 'compute.googleapis.com/TargetHttpsProxy', 'targetHttpsProxies'), 'gcp');

  let globalForwardingRules = byType('compute.googleapis.com/ForwardingRule')
    .map((a) => assetGlobalOrScopedId(a, 'forwardingRules')).filter((id) => id && id.startsWith('global/'));
  if (!includeSystem) {
    const ingressManaged = globalForwardingRules.filter(isGkeIngressManaged);
    if (ingressManaged.length) diagnostics.push({ kind: 'ComputeGlobalForwardingRule', type: 'gke-ingress-managed-skip', count: ingressManaged.length });
    globalForwardingRules = globalForwardingRules.filter((id) => !isGkeIngressManaged(id));
  }
  push('ComputeGlobalForwardingRule', globalForwardingRules, 'gcp');

  let sslCertificates = liveGlobalOrScopedIds(assets, 'compute.googleapis.com/SslCertificate', 'sslCertificates');
  if (!includeSystem) {
    const ingressManaged = sslCertificates.filter(isGkeIngressManaged);
    if (ingressManaged.length) diagnostics.push({ kind: 'ComputeSSLCertificate', type: 'gke-ingress-managed-skip', count: ingressManaged.length });
    sslCertificates = sslCertificates.filter((id) => !isGkeIngressManaged(id));
  }
  push('ComputeSSLCertificate', sslCertificates, 'gcp');

  // --- IAMPolicyMember ---------------------------------------------------------
  // search-all-iam-policies — усі біндинги проєкту одразу, на будь-якому
  // типі ресурсу, не тільки на трьох раніше підтримуваних (Project/SA/AR).
  // searchAllIamPolicies uses a separate eventually-consistent search index
  // which can omit bucket policies that assets.list already exposes. Keep the
  // broad search for other resource types, but replace its bucket slice with
  // the complete IAM_POLICY asset snapshot.
  const [searchedIamPolicies, bucketIamPolicyAssets] = await Promise.all([
    searchAllIamPolicies(project),
    listBucketIamPolicyAssets(project),
  ]);
  const iamPolicies = replaceBucketIamPolicies(searchedIamPolicies, bucketIamPolicyAssets);
  push('IAMPolicyMember', liveIamPolicyResources(iamPolicies, project, includeSystem, projectNumberFromAssets(assets)), 'gcp');

  return { project, resources, diagnostics };
}
