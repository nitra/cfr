// Extra OpenTofu-only resource families. Identity comes from the API resource
// name, not displayName (which is not unique for alert policies, for example).
const leaf = (name) => typeof name === 'string' ? name.split('/').at(-1) : undefined;
const scope = (name) => typeof name === 'string'
  ? name.match(/\/(?:locations|regions|zones)\/([^/]+)\//)?.[1]
  : undefined;
const scoped = (name) => leaf(name) ? `${scope(name) || 'global'}/${leaf(name)}` : undefined;
const directoryId = (name) => typeof name === 'string'
  ? name.match(/\/locations\/(.+)$/)?.[1]
  : undefined;
const join = (...parts) => parts.every((part) => typeof part === 'string' && part)
  ? parts.join('/') : undefined;

export const PROJECT_ASSET_FAMILIES = [
  ['gkebackup.googleapis.com/RestorePlan', 'GKEBackupRestorePlan', scoped, 'google_gke_backup_restore_plan', (v) => join(v.location, leaf(v.name))],
  ['cloudbilling.googleapis.com/ProjectBillingInfo', 'ProjectBillingInfo', () => 'billingInfo', 'google_billing_project_info', () => 'billingInfo'],
  ['cloudresourcemanager.googleapis.com/Project', 'Project', () => 'project', 'google_project', () => 'project'],
  ['compute.googleapis.com/InstanceSettings', 'ComputeInstanceSettings', scope, 'google_compute_instance_settings', (v) => leaf(v.zone)],
  ['firestore.googleapis.com/Database', 'FirestoreDatabase', leaf, 'google_firestore_database', (v) => leaf(v.name || v.id)],
  ['monitoring.googleapis.com/AlertPolicy', 'MonitoringAlertPolicy', leaf, 'google_monitoring_alert_policy', (v) => leaf(v.name || v.id)],
  ['logging.googleapis.com/LogBucket', 'LoggingLogBucket', scoped, 'google_logging_project_bucket_config', (v) => join(v.location, v.bucket_id)],
  ['logging.googleapis.com/LogSink', 'LoggingLogSink', leaf, 'google_logging_project_sink', (v) => leaf(v.name || v.id)],
  ['compute.googleapis.com/Snapshot', 'ComputeSnapshot', scoped, 'google_compute_snapshot', (v) => join('global', leaf(v.name))],
  ['compute.googleapis.com/Firewall', 'ComputeFirewall', scoped, 'google_compute_firewall', (v) => join('global', leaf(v.name))],
  ['compute.googleapis.com/Instance', 'ComputeInstance', scoped, 'google_compute_instance', (v) => join(leaf(v.zone), leaf(v.name))],
  ['compute.googleapis.com/InstanceGroup', 'ComputeInstanceGroup', scoped, 'google_compute_instance_group', (v) => join(leaf(v.zone), leaf(v.name))],
  ['compute.googleapis.com/InstanceGroupManager', 'ComputeInstanceGroupManager', scoped, 'google_compute_instance_group_manager', (v) => join(leaf(v.zone), leaf(v.name))],
  ['compute.googleapis.com/InstanceTemplate', 'ComputeInstanceTemplate', scoped, 'google_compute_instance_template', (v) => join('global', leaf(v.name))],
  ['compute.googleapis.com/HealthCheck', 'ComputeHealthCheck', scoped, 'google_compute_health_check', (v) => join('global', leaf(v.name))],
  ['compute.googleapis.com/TargetHttpProxy', 'ComputeTargetHTTPProxy', scoped, 'google_compute_target_http_proxy', (v) => join('global', leaf(v.name))],
  ['compute.googleapis.com/Route', 'ComputeRoute', scoped, 'google_compute_route', (v) => join('global', leaf(v.name))],
  ['servicedirectory.googleapis.com/Namespace', 'ServiceDirectoryNamespace', directoryId, 'google_service_directory_namespace', (v) => directoryId(v.id || v.name)],
  ['servicedirectory.googleapis.com/Service', 'ServiceDirectoryService', directoryId, 'google_service_directory_service', (v) => directoryId(v.id || v.name)],
  ['servicedirectory.googleapis.com/Endpoint', 'ServiceDirectoryEndpoint', directoryId, 'google_service_directory_endpoint', (v) => directoryId(v.id || v.name)],
];

export const PROJECT_ASSET_KINDS = [...PROJECT_ASSET_FAMILIES.map(([, kind]) => kind),
  'ComputeProjectMetadataEntry', 'ComputeProjectDefaultNetworkTier', 'ComputeProjectCloudArmorTier', 'ServiceUsageService'];
export const PROJECT_TOFU_TYPES = Object.fromEntries(PROJECT_ASSET_FAMILIES.map(([, kind, , type, identity]) => [
  type, (values) => ({ project: values.project, kind, id: identity(values) }),
]));
// A project resource identifies itself with project_id, independently of the
// provider's project/defaultProject used by its child resources.
PROJECT_TOFU_TYPES.google_project = (v) => ({ project: v.project_id, kind: 'Project', id: 'project' });
PROJECT_TOFU_TYPES.google_project_service = (v) => ({ project: v.project, kind: 'ServiceUsageService', id: v.service });
PROJECT_TOFU_TYPES.google_compute_project_metadata_item = (v) => ({ project: v.project, kind: 'ComputeProjectMetadataEntry', id: v.key });
PROJECT_TOFU_TYPES.google_compute_project_metadata = (v) => v.metadata && typeof v.metadata === 'object'
  ? Object.keys(v.metadata).map((id) => ({ project: v.project, kind: 'ComputeProjectMetadataEntry', id }))
  : { unsupported: 'Project metadata map is missing from state' };
PROJECT_TOFU_TYPES.google_compute_project_default_network_tier = (v) => ({ project: v.project, kind: 'ComputeProjectDefaultNetworkTier', id: 'defaultNetworkTier' });
PROJECT_TOFU_TYPES.google_compute_project_cloud_armor_tier = (v) => ({ project: v.project, kind: 'ComputeProjectCloudArmorTier', id: 'cloudArmorTier' });
for (const [type, kind] of [
  ['google_compute_region_instance_group_manager', 'ComputeInstanceGroupManager'],
  ['google_compute_region_instance_template', 'ComputeInstanceTemplate'],
  ['google_compute_region_health_check', 'ComputeHealthCheck'],
  ['google_compute_region_target_http_proxy', 'ComputeTargetHTTPProxy'],
]) {
  PROJECT_TOFU_TYPES[type] = (v) => ({ project: v.project, kind, id: join(leaf(v.region), leaf(v.name)) });
}

// The existing collector handles these families, including direct API checks
// and the intentional system-resource filters defined there.
const EXISTING_ASSET_TYPES = new Set([
  'iam.googleapis.com/ServiceAccount', 'iam.googleapis.com/ServiceAccountKey',
  'iam.googleapis.com/WorkloadIdentityPool', 'iam.googleapis.com/WorkloadIdentityPoolProvider',
  'artifactregistry.googleapis.com/Repository', 'cloudbuild.googleapis.com/BuildTrigger',
  'container.googleapis.com/Cluster', 'container.googleapis.com/NodePool',
  'gkebackup.googleapis.com/BackupPlan', 'storage.googleapis.com/Bucket',
  'compute.googleapis.com/Address', 'compute.googleapis.com/GlobalAddress',
  'compute.googleapis.com/Disk', 'compute.googleapis.com/Router',
  'dns.googleapis.com/ManagedZone', 'dns.googleapis.com/ResourceRecordSet',
  'run.googleapis.com/Service', 'run.googleapis.com/Job',
  'cloudscheduler.googleapis.com/Job', 'eventarc.googleapis.com/Trigger',
  'pubsub.googleapis.com/Topic', 'pubsub.googleapis.com/Subscription',
  'secretmanager.googleapis.com/Secret', 'vpcaccess.googleapis.com/Connector',
  'compute.googleapis.com/Network', 'compute.googleapis.com/Subnetwork',
  'cloudkms.googleapis.com/CryptoKey', 'compute.googleapis.com/BackendService',
  'compute.googleapis.com/UrlMap', 'compute.googleapis.com/TargetHttpsProxy',
  'compute.googleapis.com/SslCertificate',
]);

// These assets are runtime contents/status, not persistent infrastructure
// declarations in this command. Unknown infrastructure types are never put
// on this list implicitly, so adding a new asset type fails strict scans.
const CONTENT_ASSETS = new Map([
  // Unified Maintenance exposes get/list/summarize operation records, not
  // declarations of the affected resource or its maintenance policy.
  ['maintenance.googleapis.com/ResourceMaintenance', 'maintenance operation status; does not establish affected resource or maintenance policy coverage'],
  ['gkebackup.googleapis.com/Backup', 'backup instances created under a BackupPlan'],
  ['gkebackup.googleapis.com/VolumeBackup', 'volume contents created under a BackupPlan'],
  ['gkebackup.googleapis.com/Restore', 'restore execution created under a RestorePlan'],
  ['gkebackup.googleapis.com/VolumeRestore', 'volume restoration created under a RestorePlan'],
  ['containerregistry.googleapis.com/Image', 'container image contents'],
  ['serviceusage.googleapis.com/Service', 'Asset activation metadata; enablement is checked directly through Service Usage'],
]);

const UNSUPPORTED_REASONS = new Map([
  ['compute.googleapis.com/Project', 'Compute project aggregates metadata, quotas and settings; individual setting resources do not cover the entire asset'],
  ['retail.googleapis.com/Catalog', 'No Retail Catalog resource in the verified hashicorp/google 8.2.0 provider schema'],
  ['cloudbuild.googleapis.com/GlobalTriggerSettings', 'No GlobalTriggerSettings resource in the verified hashicorp/google 8.2.0 provider schema'],
]);

export function enabledServiceIds(services) {
  return services.filter((service) => service.state === 'ENABLED').map((service) => {
    const id = leaf(service.name);
    if (!id || !service.name.includes('/services/')) throw new Error('Invalid enabled Service Usage resource name');
    return id;
  });
}

export function collectComputeProjectSettings(data, { includeSystem = false } = {}) {
  const resources = [];
  const diagnostics = [];
  const outputFields = ['kind', 'id', 'creationTimestamp', 'name', 'quotas', 'selfLink',
    'defaultServiceAccount', 'vmDnsSetting'];
  const knownFields = new Set([...outputFields, 'commonInstanceMetadata', 'defaultNetworkTier',
    'cloudArmorTier', 'xpnProjectStatus', 'usageExportLocation']);
  const unsupported = (field, reason) => diagnostics.push({ type: 'unsupported-live-resource',
    assetType: 'compute.googleapis.com/Project', id: `computeProject:${field}`, reason });
  for (const field of Object.keys(data)) {
    if (!knownFields.has(field)) unsupported(field, 'Unmapped Compute project field');
  }
  if (data.usageExportLocation && Object.keys(data.usageExportLocation).length) {
    unsupported('usageExportLocation', 'Compute usage export settings are not mapped');
  }
  if (data.xpnProjectStatus && !['UNSPECIFIED', 'UNSPECIFIED_XPN_PROJECT_STATUS'].includes(data.xpnProjectStatus)) {
    unsupported('xpnProjectStatus', 'Shared VPC project ownership is not mapped');
  }
  if (!data.commonInstanceMetadata || typeof data.commonInstanceMetadata !== 'object') {
    unsupported('commonInstanceMetadata', 'Project metadata is missing from the API response');
  }
  for (const item of data.commonInstanceMetadata?.items || []) {
    if (!item.key || typeof item.value !== 'string') throw new Error('Invalid Compute project metadata entry');
    if (!includeSystem && /^gke-.+-secondary-ranges$/.test(item.key)) {
      diagnostics.push({ type: 'asset-scope-skip', assetType: 'compute.googleapis.com/Project',
        kind: 'ComputeProjectMetadataEntry', reason: 'GKE secondary ranges metadata', count: 1 });
    } else {
      resources.push({ kind: 'ComputeProjectMetadataEntry', id: item.key, source: 'gcp' });
    }
  }
  for (const [field, kind] of [['defaultNetworkTier', 'ComputeProjectDefaultNetworkTier'],
    ['cloudArmorTier', 'ComputeProjectCloudArmorTier']]) {
    if (typeof data[field] !== 'string' || !data[field]) {
      unsupported(field, 'Compute project setting is missing from the API response');
    } else resources.push({ kind, id: field, source: 'gcp' });
  }
  diagnostics.push({ type: 'asset-scope-skip', assetType: 'compute.googleapis.com/Project',
    kind: 'ComputeProjectDescriptor', reason: `Computed descriptor fields: ${outputFields.join(', ')}; mutable settings are inventoried separately`, count: 1 });
  return { resources, diagnostics };
}

function managedReason(asset, kind) {
  const name = asset.name || '';
  const base = leaf(name) || '';
  if (asset.labels && Object.hasOwn(asset.labels, 'goog-gke-node')) return 'GKE node controller';
  if (/^(?:k8s[12]-|mcrt-|gkegw\d+-)/.test(base) || /^k8s-fw-/.test(base)) return 'GKE Ingress/Gateway controller';
  if (['ComputeInstanceGroup', 'ComputeInstanceGroupManager'].includes(kind)
      && /^gke-.+-[0-9a-f]{8}-grp$/.test(base)) return 'GKE node pool instance group';
  if (['LoggingLogBucket', 'LoggingLogSink'].includes(kind) && ['_Default', '_Required'].includes(base)) return 'Google default logging resource';
  if (kind === 'ComputeFirewall' && /^gke-.+-[0-9a-f]{8}-(?:all|vms|inkubelet|exkubelet|master)$/.test(base)) return 'GKE cluster firewall';
  if (kind === 'ComputeFirewall' && /^default-allow-(?:icmp|internal|rdp|ssh)$/.test(base)) return 'Google default firewall';
  if (kind.startsWith('ServiceDirectory') && /\/namespaces\/goog-psc-default(?:\/|$)/.test(name)) return 'Google Private Service Connect directory';
  return null;
}

export function collectAdditionalProjectAssets(assets, { includeSystem = false, routes = [], computeProject } = {}) {
  const resources = [];
  const diagnostics = [];
  const families = new Map(PROJECT_ASSET_FAMILIES.map(([type, kind, identity]) => [type, { kind, identity }]));
  const routeByName = new Map(routes.map((route) => [route.name, route]));
  const diagnosticCounts = new Map();
  const diag = (assetType, reason, kind) => {
    const key = JSON.stringify([assetType, reason, kind]);
    diagnosticCounts.set(key, (diagnosticCounts.get(key) || 0) + 1);
  };
  for (const asset of assets) {
    const assetType = asset.assetType || '<missing assetType>';
    if (assetType === 'compute.googleapis.com/Project' && computeProject) {
      const settings = collectComputeProjectSettings(computeProject, { includeSystem });
      resources.push(...settings.resources);
      diagnostics.push(...settings.diagnostics);
      continue;
    }
    if (EXISTING_ASSET_TYPES.has(assetType)) continue;
    if (assetType.startsWith('k8s.io/') || assetType.includes('.k8s.io/')) {
      diag(assetType, 'Kubernetes object; outside GCP infrastructure state', 'Kubernetes');
      continue;
    }
    if (CONTENT_ASSETS.has(assetType)) {
      diag(assetType, CONTENT_ASSETS.get(assetType), 'RuntimeContent');
      continue;
    }
    let family = families.get(assetType);
    if (assetType === 'compute.googleapis.com/ForwardingRule') {
      if (/\/global\//.test(asset.name || '')) continue;
      if (!includeSystem && /^gke-.+-pe$/.test(leaf(asset.name) || '')) {
        diag(assetType, 'GKE private endpoint forwarding rule', 'ComputeForwardingRule');
        continue;
      }
      family = { kind: 'ComputeForwardingRule', identity: scoped };
    }
    if (assetType === 'compute.googleapis.com/NetworkEndpointGroup') {
      const type = asset.additionalAttributes?.networkEndpointType || asset.resource?.data?.networkEndpointType;
      if (type === 'SERVERLESS') continue;
      family = { kind: 'ComputeNetworkEndpointGroup', identity: scoped };
    }
    if (!family) {
      diagnostics.push({ type: 'unsupported-live-resource', assetType, id: asset.name, reason: UNSUPPORTED_REASONS.get(assetType) || 'No live/state mapping for this asset type' });
      continue;
    }
    let reason = managedReason(asset, family.kind);
    if (family.kind === 'ComputeRoute') {
      const route = routeByName.get(leaf(asset.name));
      // Subnet-generated routes expose nextHopNetwork; custom routes do not.
      if (route?.nextHopNetwork) reason = 'subnetwork-generated route';
    }
    if (reason && !includeSystem) {
      diag(assetType, reason, family.kind);
      continue;
    }
    const id = family.identity(asset.name);
    if (!id) throw new Error(`cannot normalize live ${assetType}: ${asset.name}`);
    resources.push({ kind: family.kind, id, source: 'gcp' });
  }
  for (const [key, count] of diagnosticCounts) {
    const [assetType, reason, kind] = JSON.parse(key);
    diagnostics.push({ type: 'asset-scope-skip', assetType, kind, reason, count });
  }
  return { resources, diagnostics };
}

PROJECT_TOFU_TYPES.google_compute_forwarding_rule = (v) => ({ project: v.project, kind: 'ComputeForwardingRule', id: join(leaf(v.region), leaf(v.name)) });
PROJECT_TOFU_TYPES.google_compute_network_endpoint_group = (v) => ({ project: v.project, kind: 'ComputeNetworkEndpointGroup', id: join(leaf(v.zone), leaf(v.name)) });
