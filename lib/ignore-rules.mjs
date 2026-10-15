// Explicit, conservative rules for live resources that are created and kept by
// GCP / GKE / a controller, or that are data rather than infrastructure.
// Every rule states WHY it is safe to hide. When in doubt a resource is NOT
// matched here, so it stays visible as uncovered / unsupported.
//
// Rules are skipped with --include-system. A matched resource that IS declared
// in OpenTofu state is still reported as covered_opentofu; only otherwise
// uncovered resources become `ignored` (with a `reason`).

const leaf = (name) => (typeof name === 'string' ? name.split('/').filter(Boolean).at(-1) : undefined);

// GCE PD CSI driver / in-tree provisioner record the claim in the disk
// description (JSON with "kubernetes.io/created-for/pvc/name") and/or in labels
// (kubernetes_io_created-for_pvc_name). Their life cycle belongs to the PV
// reclaim policy, not to OpenTofu. The pvc-<uuid> NAME alone is not evidence.
export function pvcDiskReason(asset) {
  const labels = Object.keys(asset?.labels || {}).map((key) => key.replaceAll('_', '/').replaceAll('.', '/'));
  const byLabel = labels.some((key) => /(^|\/)created-for\/pvc\/name$/.test(key));
  const byDescription = typeof asset?.description === 'string'
    && asset.description.includes('kubernetes.io/created-for/pvc/');
  return byLabel || byDescription ? 'Kubernetes PVC disk (created-for/pvc marker); lifecycle owned by the PersistentVolume' : null;
}

// Container Analysis creates exactly these four topics when the API is enabled.
export function containerAnalysisTopicReason(id) {
  return /^(?:projects\/[^/]+\/topics\/)?container-analysis-(?:notes|occurrences)-v1(?:beta1)?$/.test(id || '')
    ? 'Pub/Sub topic created by Container Analysis' : null;
}

// compute InstanceSettings exists per zone. It is only system noise while it
// carries no metadata; a non-empty one is a user setting and stays visible.
export function emptyInstanceSettingsReason(settings) {
  if (!settings || typeof settings !== 'object') return null;
  const items = settings.metadata?.items;
  return !items || (Array.isArray(items) && items.length === 0)
    ? 'default per-zone Compute InstanceSettings without metadata' : null;
}

// Predefined roles live at //iam.googleapis.com/roles/NAME; custom roles live
// under projects/ or organizations/ and are deliberately NOT matched.
export function predefinedRoleReason(assetName) {
  return /^\/\/iam\.googleapis\.com\/roles\/[^/]+$/.test(assetName || '') ? 'predefined (Google-managed) IAM role' : null;
}

// Dataplex system entry groups are named @<service> (@bigquery, @pubsub, ...).
export function dataplexSystemEntryGroupReason(assetName) {
  return /\/entryGroups\/@[^/]+$/.test(assetName || '') ? 'Google-managed Dataplex system entry group' : null;
}

// GKE Cloud DNS adds rules named gke-<...>. Rules and policies are matched only
// by that prefix; a policy additionally qualifies when it has rules and ALL of
// them are gke- rules (policy ids are numeric, so the name is often unavailable).
const policyOf = (name) => (typeof name === 'string' ? name.match(/^(.*\/responsePolicies\/[^/]+)\/rules\//)?.[1] : undefined);
export function gkeDnsReasons(assets) {
  const rulesByPolicy = new Map();
  for (const asset of assets) {
    if (asset.assetType !== 'dns.googleapis.com/ResponsePolicyRule') continue;
    const policy = policyOf(asset.name);
    if (!policy) continue;
    const list = rulesByPolicy.get(policy) || [];
    list.push(leaf(asset.name));
    rulesByPolicy.set(policy, list);
  }
  return (asset) => {
    if (asset.assetType === 'dns.googleapis.com/ResponsePolicyRule') {
      return leaf(asset.name)?.startsWith('gke-') ? 'DNS response policy rule created by GKE Cloud DNS' : null;
    }
    if (asset.assetType === 'dns.googleapis.com/ResponsePolicy') {
      const rules = rulesByPolicy.get(asset.name) || [];
      const named = (asset.displayName || leaf(asset.name) || '').startsWith('gke-');
      return named || (rules.length > 0 && rules.every((rule) => rule?.startsWith('gke-')))
        ? 'DNS response policy created by GKE Cloud DNS' : null;
    }
    return null;
  };
}

// User supplied rules: "KIND_OR_ASSET_TYPE:ID_REGEX". Explicit opt-in per run.
export function parseUserIgnoreRules(values = []) {
  return values.map((value) => {
    const index = value.indexOf(':');
    if (index <= 0 || index === value.length - 1) throw new Error(`--ignore expects KIND_OR_ASSET_TYPE:ID_REGEX, got ${value}`);
    return { selector: value.slice(0, index), pattern: new RegExp(value.slice(index + 1)), text: value };
  });
}

export function applyUserIgnores(results, gcpDiagnostics, rules) {
  if (!rules.length) return { results, gcpDiagnostics };
  const match = (rule, selector, id) => rule.selector === selector && rule.pattern.test(id);
  return {
    results: results.map((result) => {
      const rule = result.status === 'uncovered' && rules.find((candidate) => match(candidate, result.kind, result.id));
      return rule ? { ...result, status: 'ignored', reason: `user --ignore ${rule.text}` } : result;
    }),
    gcpDiagnostics: gcpDiagnostics.map((diag) => {
      const rule = diag.type === 'unsupported-live-resource' && rules.find((candidate) => match(candidate, diag.assetType, diag.id));
      return rule ? { ...diag, type: 'user-ignored', reason: `user --ignore ${rule.text}` } : diag;
    }),
  };
}
