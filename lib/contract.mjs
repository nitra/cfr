// Static checks of concrete, rendered OpenTofu + Flux Kubernetes bundles.
// Reports identities/rule codes only: never echo manifest or secret values.
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';

export const HELP = `cfr contract — validate rendered OpenTofu + Flux manifests

Usage:
  kustomize build PATH > bundle.yaml
  npx @nitra/cfr@1.0.0 contract [--json] bundle.yaml [bundle.yaml ...]
  kustomize build PATH | npx @nitra/cfr@1.0.0 contract --json -

Checks the complete supplied bundle: no cloud-owner CRs/installations,
duplicate identities, unresolved templates, missing/circular dependencies,
Flux root/source/health rules, immutable workload images, Helm identities,
and plaintext Secret payloads. Supply all referenced Flux sources/dependencies.
Input must be rendered manifests, not a Kustomize configuration directory.
This is static validation, not CRD schema validation, cloud coverage,
saved-plan approval or application/data acceptance.
Exit 0: valid; 1: violations/read/parse error; 2: invalid usage.
`;

const group = (object) => typeof object.apiVersion === 'string' ? object.apiVersion.split('/')[0] : '';
const ns = (object) => object.metadata?.namespace || 'default';
const key = (object) => `${group(object)}/${object.kind}/${ns(object)}/${object.metadata?.name}`;
const fluxKey = (kind, namespace, name) => `${kind}/${namespace}/${name}`;
const digest = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const cloudOwner = (value) => typeof value === 'string'
  && /cnrm\.cloud\.google\.com|(?:^|[/.\s-])config[-_]?connector(?:$|[/.\s-])|(?:^|[/.\s-])(?:cnrm|kcc)(?:$|[/.\s-])/i.test(value);

export function validateBundles(inputs) {
  const findings = [];
  const entries = [];
  const add = (rule, source, object, message) => findings.push({
    rule, source, ...(object ? { resource: key(object) } : {}), message,
  });
  const expanded = new WeakSet();
  const expand = (object, source) => {
    if (object && typeof object === 'object') {
      if (expanded.has(object)) { add('manifest', source, null, 'Repeated or cyclic YAML object alias'); return; }
      expanded.add(object);
    }
    if (object?.kind === 'List' && Array.isArray(object.items)) {
      for (const item of object.items) expand(item, source);
    } else if (object && typeof object === 'object') entries.push({ object, source });
    else if (object !== null) add('manifest', source, null, 'Expected a Kubernetes object');
  };
  for (const { source, text } of inputs) {
    let documents;
    try { documents = parseAllDocuments(text); } catch {
      add('yaml', source, null, 'Invalid YAML');
      continue;
    }
    for (const document of documents) {
      if (document.errors.length) { add('yaml', source, null, 'Invalid YAML'); continue; }
      try { expand(document.toJS({ maxAliasCount: 100 }), source); } catch {
        add('yaml', source, null, 'Invalid YAML aliases');
      }
    }
    if (text.includes('<< inputs.') || text.includes('<< resources.')) {
      add('unresolved-template', source, null, 'Expand ResourceSet templates before validation');
    }
  }
  if (!entries.length && !findings.length) add('empty-bundle', '<bundle>', null, 'No rendered Kubernetes resources');
  const seen = new Set();
  const flux = new Map();
  for (const { object, source } of entries) {
    if (!object.apiVersion || !object.kind || !object.metadata?.name) {
      add('manifest', source, object, 'apiVersion, kind and metadata.name are required');
    }
    if (seen.has(key(object))) add('duplicate-owner', source, object, 'Duplicate resource identity');
    seen.add(key(object));
    if (group(object).endsWith('.toolkit.fluxcd.io')) {
      flux.set(fluxKey(object.kind, ns(object), object.metadata?.name), object);
    }
    if (group(object) === 'kustomize.config.k8s.io') {
      add('render-required', source, object, 'Supply rendered manifests, not Kustomize configuration');
    }
    if (['ConfigConnector', 'ConfigConnectorContext'].includes(object.kind)
      || cloudOwner(object.apiVersion) || cloudOwner(object.metadata?.name)
      || Object.keys(object.metadata?.annotations || {}).some(cloudOwner)
      || cloudOwner(object.spec?.group)) {
      add('cloud-owner', source, object, 'Cloud resources must be owned by OpenTofu');
    }
    if (object.kind === 'Secret' && (Object.keys(object.data || {}).length || Object.keys(object.stringData || {}).length)) {
      add('secret-payload', source, object, 'Use runtime secret references/sync instead of Secret payloads');
    }
    const walked = new WeakSet();
    const walk = (value, field = '') => {
      if (!value || typeof value !== 'object') return;
      if (walked.has(value)) return;
      walked.add(value);
      if (['containers', 'initContainers', 'ephemeralContainers'].includes(field) && Array.isArray(value)) {
        for (const container of value) {
          if (cloudOwner(container?.image)) add('cloud-owner', source, object, 'Cloud controller installation is forbidden');
          if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(container?.image || '')) {
            add('image-pin', source, object, 'Container images require an immutable sha256 digest');
          }
        }
      }
      if (field === 'apiGroups' && Array.isArray(value) && value.some(cloudOwner)) {
        add('cloud-owner', source, object, 'Remove cloud-controller RBAC references');
      }
      if (field === 'chart' && typeof value.name === 'string' && cloudOwner(value.name)) {
        add('cloud-owner', source, object, 'Cloud controller chart installation is forbidden');
      }
      for (const [name, child] of Object.entries(value)) walk(child, name);
    };
    walk(object);
    const chart = object.spec?.chart?.spec?.chart || object.spec?.packageName || object.spec?.source?.catalog?.packageName;
    if (cloudOwner(chart)) add('cloud-owner', source, object, 'Cloud controller chart/OLM installation is forbidden');
  }
  const roots = new Set();
  const chartSources = new Set();
  for (const { object } of entries) {
    if (group(object) === 'kustomize.toolkit.fluxcd.io' && object.kind === 'Kustomization'
      && object.metadata?.name === 'flux-system' && object.spec?.sourceRef?.kind === 'OCIRepository') {
      roots.add(fluxKey('OCIRepository', object.spec.sourceRef.namespace || ns(object), object.spec.sourceRef.name));
    }
    if (object.kind === 'HelmRelease' && object.spec?.chartRef?.kind === 'OCIRepository') {
      chartSources.add(fluxKey('OCIRepository', object.spec.chartRef.namespace || ns(object), object.spec.chartRef.name));
    }
  }
  const graph = new Map();
  for (const { object, source } of entries) {
    const spec = object.spec || {};
    if (cloudOwner(spec.path)) add('cloud-owner', source, object, 'Cloud-controller reconciliation path is forbidden');
    if (group(object) === 'source.toolkit.fluxcd.io' && object.kind === 'GitRepository') {
      add('source-transport', source, object, 'Final cluster roots/workloads use OCI sources');
    }
    if (group(object) === 'source.toolkit.fluxcd.io' && object.kind === 'OCIRepository') {
      const identity = fluxKey(object.kind, ns(object), object.metadata?.name);
      if (cloudOwner(spec.url)) add('cloud-owner', source, object, 'Cloud controller source is forbidden');
      const exactChartTag = chartSources.has(identity) && typeof spec.ref?.tag === 'string'
        && spec.ref.tag !== 'latest' && !/[\s*<>=~^]/.test(spec.ref.tag);
      const rootChannel = roots.has(identity) && typeof spec.ref?.semver === 'string' && spec.ref.semver.trim();
      if (!digest(spec.ref?.digest) && !exactChartTag && !rootChannel) {
        add('source-pin', source, object, 'Workload OCI sources require ref.digest; root channel or exact chart tag are separate profiles');
      }
      if (spec.ref?.digest && !digest(spec.ref.digest)) add('source-pin', source, object, 'Malformed OCI digest');
      if (!spec.interval || typeof spec.url !== 'string' || !spec.url.startsWith('oci://')) add('source-fields', source, object, 'OCI url and interval are required');
    }
    if (group(object) === 'kustomize.toolkit.fluxcd.io' && object.kind === 'Kustomization') {
      const root = object.metadata?.name === 'flux-system';
      if (root && (spec.prune !== false || spec.wait !== false || spec.healthChecks?.length)) {
        add('root-policy', source, object, 'Root requires prune:false, wait:false and no child health checks');
      }
      if (!spec.interval || !spec.path || !spec.timeout || typeof spec.prune !== 'boolean' || typeof spec.wait !== 'boolean') {
        add('kustomization-fields', source, object, 'Explicit interval/path/timeout/prune/wait are required');
      }
      if (spec.wait === true && spec.healthChecks?.length) {
        add('health-policy', source, object, 'wait:true ignores healthChecks; choose one health mode');
      }
      if (!root && spec.wait !== true && !spec.healthChecks?.length) {
        add('health-policy', source, object, 'Child requires wait:true or explicit healthChecks');
      }
      const ref = spec.sourceRef;
      if (ref?.kind !== 'OCIRepository') add('source-transport', source, object, 'Kustomization requires OCIRepository source');
      else if (!flux.has(fluxKey(ref.kind, ref.namespace || ns(object), ref.name))) {
        add('missing-source', source, object, 'Referenced source is absent from supplied bundle');
      }
      if (spec.images && !Array.isArray(spec.images)) add('manifest', source, object, 'images must be a list');
      for (const image of Array.isArray(spec.images) ? spec.images : []) {
        if (!digest(image?.digest)) add('image-pin', source, object, 'Image overrides require sha256 digest');
      }
    }
    if (group(object) === 'helm.toolkit.fluxcd.io' && object.kind === 'HelmRelease') {
      if (!spec.releaseName || !spec.targetNamespace || !spec.storageNamespace || !spec.interval) {
        add('helm-identity', source, object, 'Explicit Helm releaseName/targetNamespace/storageNamespace/interval required');
      }
      const ref = spec.chartRef || spec.chart?.spec?.sourceRef;
      if (!ref || !flux.has(fluxKey(ref.kind, ref.namespace || ns(object), ref.name))) {
        add('missing-source', source, object, 'Referenced chart source is absent from supplied bundle');
      }
      if (!spec.chartRef && (!spec.chart?.spec?.version || spec.chart.spec.version === 'latest' || /[\s*<>=~^]/.test(spec.chart.spec.version))) {
        add('chart-pin', source, object, 'Helm chart version must be exact');
      }
    }
    if (['kustomize.toolkit.fluxcd.io', 'helm.toolkit.fluxcd.io'].includes(group(object))
      && ['Kustomization', 'HelmRelease'].includes(object.kind)) {
      const identity = fluxKey(object.kind, ns(object), object.metadata?.name);
      if (spec.dependsOn && !Array.isArray(spec.dependsOn)) add('manifest', source, object, 'dependsOn must be a list');
      const dependencies = (Array.isArray(spec.dependsOn) ? spec.dependsOn : []).map((ref) => fluxKey(object.kind, ref?.namespace || ns(object), ref?.name));
      graph.set(identity, dependencies);
      for (const dep of dependencies) if (!flux.has(dep)) {
        add('missing-dependency', source, object, 'Referenced dependency is absent from supplied bundle');
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (identity) => {
    if (visiting.has(identity)) { add('dependency-cycle', '<bundle>', flux.get(identity), 'Circular Flux dependency'); return; }
    if (visited.has(identity)) return;
    visiting.add(identity);
    for (const dep of graph.get(identity) || []) visit(dep);
    visiting.delete(identity);
    visited.add(identity);
  };
  for (const identity of graph.keys()) visit(identity);
  return { contractVersion: 1, ok: findings.length === 0, checked: entries.length, findings };
}

export function run(argv) {
  if (argv.includes('-h') || argv.includes('--help')) { process.stdout.write(HELP); return 0; }
  const paths = argv.filter((arg) => arg !== '--json');
  if (!paths.length || paths.some((arg) => arg.startsWith('-') && arg !== '-') || paths.filter((p) => p === '-').length > 1) {
    console.error('usage: cfr contract [--json] FILE [FILE ...] (or - for stdin)');
    return 2;
  }
  const inputs = [];
  for (const source of paths) {
    try { inputs.push({ source, text: readFileSync(source === '-' ? 0 : source, 'utf8') }); } catch {
      const report = { contractVersion: 1, ok: false, checked: 0, findings: [{ rule: 'read-error', source, message: 'Cannot read bundle' }] };
      if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
      else console.error(`Cannot read bundle: ${source}`);
      return 1;
    }
  }
  const report = validateBundles(inputs);
  if (argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else if (report.ok) console.log(`✓ OpenTofu + Flux contract: ${report.checked} resources`);
  else for (const finding of report.findings) console.error(`${finding.source}: ${finding.rule}: ${finding.resource || '<bundle>'}: ${finding.message}`);
  return report.ok ? 0 : 1;
}
