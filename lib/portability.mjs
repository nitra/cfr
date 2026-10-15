// cfr portability — read-only pre-flight report: what will block moving the
// project into another Google Cloud project. OpenTofu coverage is NOT
// portability. Only metadata and counters are read; never secret payloads or
// bucket / registry contents.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getJson, paginate } from './gcp-rest.mjs';
import { projectNumberFromAssets, searchAllResources, isGkeWorkloadIdentityPool } from './get-resources.mjs';
import { pvcDiskReason } from './ignore-rules.mjs';
import { collectAndClassify } from './tofu-inventory.mjs';
import { parseOptions } from './args.mjs';

export const HELP = `cfr portability — read-only project-move pre-flight

Usage:
  npx @nitra/cfr portability --project PROJECT [--dir DIR ...] [--tofu DIR ...] [--json] [--strict]

Shows ahead of time what will hinder moving the workload to another Google
Cloud project: hardcoded project ID/number, globally unique names, data that
OpenTofu does not move, coverage gaps, steps outside Git, external trust and
static IPs. Reads only metadata and counters (never secret payloads/objects).

Options:
  --project PROJECT  GCP project ID (required). The project number comes from Cloud Asset.
  --dir DIR          Directory with *.tf and Kubernetes/Flux manifests (repeatable, default ".").
                     Skipped: *.md for literal checks, docs/, .terraform/, node_modules/, .git/.
  --tofu DIR         OpenTofu state root (repeatable); enables the coverage section.
  --json             Emit {findings, summary}.
  --strict           Exit 1 if there is any error finding.
`;

const SKIP_DIRS = new Set(['docs', '.terraform', 'node_modules', '.git']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function walkFiles(dir) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(join(current, entry.name));
      } else if (entry.isFile()) {
        const path = join(current, entry.name);
        if (statSync(path).size <= MAX_FILE_BYTES) out.push(path);
      }
    }
  };
  visit(dir);
  return out;
}

const finding = (severity, check, location, message, hint, extra = {}) => ({ severity, check, location, message, hint, ...extra });
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function projectIdCategory(token, project) {
  if (/\.pkg\.dev\/|gcr\.io\//.test(token)) return 'Artifact Registry / GCR path';
  if (token.includes(`@${project}.iam.gserviceaccount.com`)) return 'service account email';
  if (token.includes(`${project}.svc.id.goog`)) return 'GKE Workload Identity pool';
  if (token.includes(`projects/${project}`)) return 'projects/… resource path';
  if (token === project) return 'bare project ID';
  return 'name embedding the project ID (bucket / resource / repo name)';
}

const ID_HINT = 'Move it to a project_id variable (OpenTofu) or kustomize replacements / Flux postBuild substitution (manifests).';

// Never echoes the source line, only the matched token class and position.
export function scanLiterals(text, location, project, projectNumber) {
  const findings = [];
  const idRe = new RegExp(`(?<![A-Za-z0-9])${escapeRe(project)}(?![A-Za-z0-9])`, 'g');
  const numRe = projectNumber ? new RegExp(`(?<![0-9])${escapeRe(projectNumber)}(?![0-9])`) : null;
  text.split('\n').forEach((line, index) => {
    const seen = new Set();
    for (const match of line.matchAll(idRe)) {
      let start = match.index;
      let end = match.index + project.length;
      while (start > 0 && /[A-Za-z0-9._/@:-]/.test(line[start - 1])) start -= 1;
      while (end < line.length && /[A-Za-z0-9._/@:-]/.test(line[end])) end += 1;
      const category = projectIdCategory(line.slice(start, end), project);
      if (seen.has(category)) continue;
      seen.add(category);
      findings.push(finding('error', 'hardcoded-project-id', `${location}:${index + 1}`,
        `Literal project ID in ${category}`, ID_HINT, { category }));
    }
    if (numRe?.test(line)) {
      findings.push(finding('error', 'hardcoded-project-number', `${location}:${index + 1}`,
        'Literal project number', 'Read it from data.google_project / a variable; it changes with the project.'));
    }
  });
  return findings;
}

function blockRange(lines, startIndex) {
  let depth = 0;
  for (let i = startIndex; i < lines.length; i += 1) {
    const stripped = lines[i].replace(/\$\{/g, '');
    for (const ch of stripped) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
    }
    if (depth <= 0 && i >= startIndex) return i;
  }
  return lines.length - 1;
}

export function scanTerraform(text, location) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    const at = `${location}:${index + 1}`;
    if (/^\s*resource\s+"google_storage_bucket"\s+"[^"]+"\s*\{/.test(line)) {
      const end = blockRange(lines, index);
      let depth = 0;
      for (let i = index; i <= end; i += 1) {
        if (depth === 1) {
          const name = lines[i].match(/^\s*name\s*=\s*"([^"]*)"/);
          if (name && !name[1].includes('${')) {
            findings.push(finding('warn', 'globally-unique-names', `${location}:${i + 1}`,
              `Bucket name "${name[1]}" is globally unique and has no variable part`,
              'Derive the name from a variable (e.g. "${var.project_id}-suffix"); the old name will not be free to reuse during a move.'));
          }
        }
        for (const ch of lines[i].replace(/\$\{/g, '')) {
          if (ch === '{') depth += 1;
          if (ch === '}') depth -= 1;
        }
      }
    }
    const dns = line.match(/^\s*dns_name\s*=\s*"([^"$]+)"/);
    if (dns) {
      findings.push(finding('warn', 'globally-unique-names', at, `Domain-like literal "${dns[1]}"`,
        'Domain ownership/verification and delegation must be redone for the new project.'));
    }
    const issuer = line.match(/^\s*issuer_uri\s*=\s*"([^"$]+)"/);
    if (issuer) {
      findings.push(finding('info', 'external-trust', at, `Static OIDC issuer ${issuer[1]}`,
        'Recreate the WIF provider for this issuer in the new project and update attribute conditions.'));
    }
  });
  return findings;
}

const STEP_RULES = [
  { re: /kubectl\s+create\s+secret/, exts: null, what: 'kubectl create secret' },
  { re: /kubectl\s+apply\s+-k/, exts: null, what: 'kubectl apply -k' },
  { re: /helm\s+install/, exts: null, what: 'helm install' },
  { re: /\bgcloud\s/, exts: ['.sh', '.yaml', '.yml'], what: 'gcloud call' },
  { re: /вручну|manually|напряму|bootstrap/i, exts: 'comments', what: 'manual / bootstrap step' },
];

export function scanOutOfGitSteps(text, location, ext) {
  const findings = [];
  text.split('\n').forEach((line, index) => {
    const isComment = /^\s*(#|\/\/|<!--)/.test(line) || ['.md', '.sh'].includes(ext);
    for (const rule of STEP_RULES) {
      const applicable = rule.exts === null || (rule.exts === 'comments' ? isComment : rule.exts.includes(ext));
      if (applicable && rule.re.test(line)) {
        findings.push(finding('warn', 'out-of-git-steps', `${location}:${index + 1}`,
          `Step outside Git (${rule.what})`, 'Make it declarative (OpenTofu / Flux) or document it in the migration runbook.'));
        break;
      }
    }
  });
  return findings;
}

export function scanDirectories(dirs, { project, projectNumber }) {
  const findings = [];
  const literalExts = new Set(['.tf', '.tfvars', '.yaml', '.yml', '.json']);
  const stepExts = new Set(['.tf', '.yaml', '.yml', '.sh', '.md']);
  for (const dir of dirs) {
    for (const path of walkFiles(dir)) {
      const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
      if (!literalExts.has(ext) && !stepExts.has(ext)) continue;
      const location = relative(process.cwd(), path) || path;
      const text = readFileSync(path, 'utf8');
      if (literalExts.has(ext)) findings.push(...scanLiterals(text, location, project, projectNumber));
      if (ext === '.tf') findings.push(...scanTerraform(text, location));
      if (stepExts.has(ext)) findings.push(...scanOutOfGitSteps(text, location, ext));
    }
  }
  return findings;
}

const leaf = (name) => (typeof name === 'string' ? name.split('/').filter(Boolean).at(-1) : undefined);
const SA_SYSTEM = /(^[0-9]+-compute@developer|@appspot|@cloudservices|^firebase-adminsdk-|@system\.gserviceaccount|@gcp-sa-)/;

const OTHER_DATA_ASSETS = [
  ['sqladmin.googleapis.com/Instance', 'Cloud SQL instances', 'Export/import or Database Migration Service; an instance cannot be moved between projects.'],
  ['bigquery.googleapis.com/Dataset', 'BigQuery datasets', 'Copy datasets with the BigQuery Data Transfer Service / dataset copy.'],
  ['pubsub.googleapis.com/Subscription', 'Pub/Sub subscriptions', 'Recreate from IaC; drain or replay unacknowledged messages first.'],
  ['firestore.googleapis.com/Database', 'Firestore databases', 'Managed export/import to a bucket in the new project.'],
  ['spanner.googleapis.com/Instance', 'Spanner instances', 'Backup and restore into the new project.'],
  ['redis.googleapis.com/Instance', 'Memorystore Redis instances', 'Export RDB to a bucket and import in the new project.'],
];

// Metadata-only live collection. `io` is injectable for tests.
export async function collectLive(project, io = {}) {
  const searchAll = io.searchAll || searchAllResources;
  const get = io.getJson || getJson;
  const page = io.paginate || paginate;
  const assets = await searchAll(project);
  const byType = (type) => assets.filter((a) => a.assetType === type);
  const count = (items, key) => {
    const map = new Map();
    for (const item of items) map.set(key(item), (map.get(key(item)) || 0) + 1);
    return [...map].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  };

  const projectNumber = projectNumberFromAssets(assets);
  const secretVersions = byType('secretmanager.googleapis.com/SecretVersion')
    .filter((a) => !a.state || a.state !== 'DESTROYED');
  const secretVersionCounts = count(secretVersions, (a) => a.name?.match(/\/secrets\/([^/]+)\/versions\//)?.[1] || '?');
  const buckets = byType('storage.googleapis.com/Bucket').map((a) => a.displayName || leaf(a.name)).sort();
  const repos = byType('artifactregistry.googleapis.com/Repository').map((a) => a.name?.match(/\/locations\/([^/]+)\/repositories\/([^/]+)$/)?.slice(1).join('/')).filter(Boolean);
  const imageCounts = count(byType('artifactregistry.googleapis.com/DockerImage'),
    (a) => a.name?.match(/\/locations\/([^/]+)\/repositories\/([^/]+)\//)?.slice(1).join('/') || '?');
  const disks = byType('compute.googleapis.com/Disk');
  const pvcDisks = disks.filter((d) => pvcDiskReason(d)).length;
  const snapshots = byType('compute.googleapis.com/Snapshot').length;
  const others = OTHER_DATA_ASSETS.map(([type, label, how]) => ({ label, how, count: byType(type).length })).filter((o) => o.count);

  // user-managed SA keys: key ids only, no key material
  const serviceAccounts = byType('iam.googleapis.com/ServiceAccount')
    .map((a) => a.additionalAttributes?.email).filter((email) => email && !SA_SYSTEM.test(email));
  let userKeys = 0;
  const keyOwners = [];
  for (const email of serviceAccounts) {
    const data = await get(`https://iam.googleapis.com/v1/projects/-/serviceAccounts/${email}/keys`, { keyTypes: 'USER_MANAGED' });
    const n = (data.keys || []).length;
    userKeys += n;
    if (n) keyOwners.push([email, n]);
  }

  const pools = await page(`https://iam.googleapis.com/v1/projects/${project}/locations/global/workloadIdentityPools`,
    { pageSize: 1000 }, 'workloadIdentityPools');
  const providers = [];
  for (const pool of pools.filter((p) => !isGkeWorkloadIdentityPool(p))) {
    for (const provider of await page(`https://iam.googleapis.com/v1/${pool.name}/providers`, { pageSize: 1000 }, 'workloadIdentityPoolProviders')) {
      providers.push({
        pool: leaf(pool.name), provider: leaf(provider.name),
        issuer: provider.oidc?.issuerUri || (provider.aws ? `aws:${provider.aws.accountId}` : provider.saml ? 'saml' : undefined),
        audiences: provider.oidc?.allowedAudiences || [],
      });
    }
  }

  const addresses = [];
  let pageToken;
  do {
    const data = await get(`https://compute.googleapis.com/compute/v1/projects/${project}/aggregated/addresses`, { maxResults: 500, pageToken });
    for (const [scope, value] of Object.entries(data.items || {})) {
      for (const a of value.addresses || []) {
        if ((a.addressType || 'EXTERNAL') === 'EXTERNAL' && a.purpose !== 'NAT_AUTO') {
          addresses.push({ name: a.name, scope: scope.replace(/^(regions|global)\/?/, '') || 'global', address: a.address, status: a.status });
        }
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return { projectNumber, secretVersionCounts, secretVersionTotal: secretVersions.length, buckets, repos, imageCounts,
    pvcDisks, otherDisks: disks.length - pvcDisks, snapshots, others, userKeys, keyOwners, providers, addresses };
}

const sum = (pairs) => pairs.reduce((total, [, n]) => total + n, 0);
const top = (pairs, n = 5) => pairs.slice(0, n).map(([k, v]) => `${k}=${v}`).join(', ') + (pairs.length > n ? ', …' : '');

export function liveFindings(live, project) {
  const findings = [];
  const data = (label, count, how, detail) => findings.push(finding('info', 'data-not-in-iac', `live:${label}`,
    `${label}: ${count}${detail ? ` (${detail})` : ''}`, how, { dataClass: label, count }));
  if (live.secretVersionTotal) {
    data('SecretVersion', live.secretVersionTotal, 'Re-create values in the new project through your secret source of truth (never copy payloads through chat/CI logs).',
      `${live.secretVersionCounts.length} secrets: ${top(live.secretVersionCounts)}`);
  }
  if (live.buckets.length) {
    data('Storage buckets', live.buckets.length, 'Create new buckets and copy objects with Storage Transfer Service / gcloud storage cp; object counts are not read here.', live.buckets.join(', '));
  }
  if (live.repos.length || live.imageCounts.length) {
    data('Artifact Registry DOCKER images', sum(live.imageCounts), 'Re-push from CI or copy with crane/skopeo/gcrane to the new registry host path.',
      `${live.repos.length} repos: ${top(live.imageCounts)}`);
  }
  if (live.pvcDisks) data('PVC disks', live.pvcDisks, 'Use GKE Backup for GKE (backup/restore plan) or snapshot + create disks in the new project.');
  if (live.snapshots) data('Compute snapshots', live.snapshots, 'Snapshots are project-bound: copy via machine image/disk export or recreate from backups.');
  if (live.userKeys) data('SA user-managed keys', live.userKeys, 'Do not move keys; issue new keys or (better) replace with Workload Identity Federation.',
    live.keyOwners.map(([email, n]) => `${email}=${n}`).join(', '));
  for (const other of live.others) data(other.label, other.count, other.how);
  for (const p of live.providers) {
    findings.push(finding('info', 'external-trust', `live:wif/${p.pool}/${p.provider}`,
      `WIF provider ${p.pool}/${p.provider} trusts ${p.issuer || 'unknown issuer'}${p.audiences.length ? ` (audiences: ${p.audiences.join(', ')})` : ''}`,
      'Recreate the pool/provider in the new project and update service account bindings and attribute conditions.', { issuer: p.issuer }));
  }
  for (const a of live.addresses) {
    findings.push(finding('info', 'static-ips-and-dns', `live:address/${a.scope}/${a.name}`,
      `Static external address ${a.name} ${a.address || ''} (${a.status || 'n/a'}) will change`,
      'Reserve a new address and update DNS records / firewall allow-lists of external parties.', { address: a.address }));
  }
  return findings;
}

export function coverageFindings(coverage) {
  if (!coverage) {
    return [finding('info', 'uncovered-or-unsupported', 'coverage', 'Coverage section skipped (no --tofu)', 'Pass --tofu DIR to include OpenTofu state coverage.')];
  }
  const groups = new Map();
  const add = (key, severityKind, id) => {
    const g = groups.get(key) || { ids: [] };
    g.ids.push(id);
    groups.set(key, g);
    return severityKind;
  };
  for (const r of coverage.results) {
    if (r.status === 'uncovered' || r.status.startsWith('orphan_')) add(`${r.status} ${r.kind}`, r.status, r.id);
  }
  for (const d of coverage.gcpDiagnostics) {
    if (d.type === 'unsupported-live-resource') add(`unsupported_live_resource ${d.assetType}`, d.type, d.id);
  }
  for (const d of coverage.tofuDiagnostics) add(`unsupported_controller_resource ${d.resourceType}`, d.type, d.address);
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, g]) => finding('warn', 'uncovered-or-unsupported', `coverage:${key}`,
    `${key}: ${g.ids.length}`, 'Bring under OpenTofu (import) or confirm it is intentionally recreated by hand; see tofu-inventory.',
    { count: g.ids.length, sample: g.ids.slice(0, 3) }));
}

export function summarize(findings) {
  const data = findings.filter((f) => f.check === 'data-not-in-iac')
    .map((f) => `${f.dataClass} ${f.count}`);
  return {
    blockers: findings.filter((f) => f.severity === 'error').length,
    warnings: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
    dataToMigrate: data,
  };
}

const SECTIONS = [
  ['hardcoded-project-id', '1. Hardcoded project ID'],
  ['hardcoded-project-number', '2. Hardcoded project number'],
  ['globally-unique-names', '3. Globally unique names'],
  ['data-not-in-iac', '4. Data outside IaC'],
  ['uncovered-or-unsupported', '5. Uncovered / unsupported'],
  ['out-of-git-steps', '6. Steps outside Git'],
  ['external-trust', '7. External trust'],
  ['static-ips-and-dns', '8. Static IPs and DNS'],
];

export function renderReport(findings, summary, project, limit = 8) {
  const lines = [`### Portability: ${project} ###`, ''];
  for (const [check, title] of SECTIONS) {
    const items = findings.filter((f) => f.check === check);
    lines.push(`== ${title}: ${items.length} ==`);
    if (check === 'hardcoded-project-id') {
      const files = new Set(items.map((f) => f.location.replace(/:\d+$/, '')));
      const cats = new Map();
      for (const f of items) cats.set(f.category, (cats.get(f.category) || 0) + 1);
      if (items.length) lines.push(`  ${items.length} lines in ${files.size} files`, ...[...cats].map(([c, n]) => `  - ${c}: ${n}`));
    } else if (check === 'hardcoded-project-number') {
      const files = new Set(items.map((f) => f.location.replace(/:\d+$/, '')));
      if (items.length) lines.push(`  ${items.length} lines in ${files.size} files`);
    }
    for (const f of items.slice(0, limit)) lines.push(`  [${f.severity}] ${f.location} — ${f.message}`);
    if (items.length > limit) lines.push(`  … +${items.length - limit} more (use --json)`);
    if (items[0]) lines.push(`  hint: ${items[0].hint}`);
    lines.push('');
  }
  lines.push(`blockers (error): ${summary.blockers}; warnings: ${summary.warnings}; data to migrate: ${summary.dataToMigrate.join(', ') || 'none'}`);
  return lines.join('\n');
}

export async function analyze(project, { dirs, tofuPaths = [] }, deps = {}) {
  const live = await (deps.collectLive || collectLive)(project);
  const coverage = tofuPaths.length ? await (deps.collectCoverage || collectAndClassify)(project, tofuPaths) : undefined;
  const findings = [
    ...scanDirectories(dirs, { project, projectNumber: live.projectNumber }),
    ...liveFindings(live, project),
    ...coverageFindings(coverage),
  ];
  return { findings, summary: summarize(findings), projectNumber: live.projectNumber };
}

export async function run(argv, deps = {}) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }
  let options;
  try {
    options = parseOptions(argv, { flags: ['--json', '--strict'], values: ['--project', '--dir', '--tofu'] });
    if (options.get('--project')?.length !== 1) throw new Error('--project PROJECT is required exactly once');
  } catch (err) {
    console.error(`usage: cfr portability --project PROJECT [--dir DIR ...] [--tofu DIR ...] [--json] [--strict]: ${err.message}`);
    return 2;
  }
  const project = options.get('--project')[0];
  const { findings, summary } = await analyze(project, {
    dirs: options.get('--dir') || ['.'], tofuPaths: options.get('--tofu') || [],
  }, deps);
  if (options.get('--json')) console.log(JSON.stringify({ findings, summary }, null, 2));
  else console.log(renderReport(findings, summary, project));
  return options.get('--strict') && summary.blockers > 0 ? 1 : 0;
}
