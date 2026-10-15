# @nitra/cfr

Read-only tools for the OpenTofu + Flux GitOps standard. Node.js >=18.
Cloud infrastructure belongs to OpenTofu; Kubernetes desired state belongs
to Flux. Version 1 has no Config Connector inventory, Kubernetes transport,
namespace discovery or kubeconfig dependency.

## Commands

```sh
npx @nitra/cfr@1.0.0 --version
npx @nitra/cfr@1.0.0 check ./k8s/main
kustomize build ./k8s/main | npx @nitra/cfr@1.0.0 contract --json -
npx @nitra/cfr@1.0.0 get-resources --project azovmemo --json
npx @nitra/cfr@1.0.0 tofu-inventory --project azovmemo \
  --tofu ./tofu/gke-foundation --strict --json
```

For reproducible CI, use an exact dependency and commit `package-lock.json`,
then `npm ci` and `npx --no-install cfr ...`. The lockfile binds transitive
versions and npm integrity hashes; version-only `npx` examples are interactive.
The tool never imports resources, applies plans, changes clusters or publishes
Flux artifacts. Consumers must explicitly upgrade to this major version.

## `check`

Check a Kustomize directory's `resources:` against its sibling YAML files.
The directory-only shorthand remains supported. YAML is parsed, not guessed
with line patterns. This checks local inclusion, not rendering or Flux policy.

```sh
npx @nitra/cfr@1.0.0 check ./k8s/main
```

## `contract`

Validate the complete supplied set of concrete rendered Kubernetes manifests.
Render templates/ResourceSets first and include referenced sources and Flux
dependencies. Multiple files and Kubernetes `List` objects are supported.

```sh
npx @nitra/cfr@1.0.0 contract --json root.yaml controllers.yaml apps.yaml
```

Static checks include:

- No cloud-owner CRs, Config Connector controller manifests, RBAC or known
  chart/OLM installation paths; no plaintext `Secret.data`/`stringData`.
- No duplicate resource identities or unresolved ResourceSet templates.
- OCI sources for roots/workloads; workload `ref.digest` uses SHA-256.
  A `flux-system` root may use a separate SemVer channel. An OCI source used
  as `HelmRelease.chartRef` may use an exact chart tag, not `latest`.
- Root Kustomization: `prune:false`, `wait:false`, no child health checks.
  Children select `wait:true` or targeted health checks, not both; explicit
  interval, timeout, path, prune and wait fields.
- Container images and Kustomization image overrides use immutable SHA-256
  digests. Helm release/target/storage identities and chart versions are explicit.
- Referenced sources/dependencies exist in the supplied bundle; no Flux
  dependency cycles.

JSON: `{contractVersion, ok, checked, findings}`. Findings contain resource
identities and rule codes, never manifest/Secret payloads. Exit 0 = pass,
1 = violations/read/parse error, 2 = invalid command usage.

This is a static subset of the shared contract, not full compliance certification.
It does not resolve remote artifacts, Helm values/image templates, arbitrary
custom installers or OpenTofu configuration. Add CRD/schema validation,
secret scanning, provenance/retention checks, exact-plan gates, and direct
application/data acceptance separately. A valid subset cannot prove that a
missing cluster object or source has been included. `contractVersion:1` names
the validator profile, not a pin to a particular external contract Git revision.

Flux documents that `wait:true` ignores `healthChecks`; see the
[Kustomization reference](https://fluxcd.io/flux/components/kustomize/kustomizations/#wait).

## `get-resources`

Scan one explicit GCP project using Application Default Credentials (ADC).
No `gcloud`/`kubectl` executable is required. Output contains resource identities
and diagnostic reasons, not application secret values or Secret Manager payloads.

```sh
npx @nitra/cfr@1.0.0 get-resources --project azovmemo --json
npx @nitra/cfr@1.0.0 get-resources --project azovmemo --include-system
```

JSON: `{project, resources, diagnostics}`. Human output groups resource identities.
GCP-managed defaults/controller resources are filtered with explicit diagnostics;
`--include-system` includes system resources. This is inventory, not an adoption
instruction. Dynamic GKE disks, LB/NEG and similar resources must retain their
controller owner, not be blindly imported into OpenTofu.

## `tofu-inventory`

Compare live GCP identities against actual state from every supplied OpenTofu
root, using `tofu -chdir=DIR show -json` (not HCL text matching). Initialize
the correct backend first; do not supply a plan or state file from another
project/backend. Cloud reads use ADC, and OpenTofu must be on PATH.

```sh
npx @nitra/cfr@1.0.0 tofu-inventory --project azovmemo \
  --tofu ./tofu/gke-foundation --tofu ./tofu/other-root \
  --show-covered --strict --json
```

JSON remains an array of classifications/diagnostics. Important statuses:

| Status | Meaning |
|---|---|
| `covered_opentofu` | Live identity matches a supported managed resource in actual state |
| `uncovered` | Live resource has no matching OpenTofu owner |
| `orphan_opentofu` | State resource has no matching live identity |
| `controller_managed` | Exact successful RestorePlan/VolumeRestore evidence proves derived disk ownership |
| `ignored` | Explicit system/runtime/controller scope diagnostic |
| `unsupported_live_resource` | Unmapped live infrastructure type; blocks strict mode |
| `unsupported_controller_resource` | Unmapped/invalid OpenTofu state identity; blocks strict mode |

`--strict` fails on uncovered/orphan resources and unsupported live/state types.
Overlapping owners across state roots are errors, never resolved by precedence.
API/auth failures fail the command; no successful empty inventory fallback.
Read-only API coverage spans IAM/WIF and policy bindings, GKE, registry, storage,
DNS/network/Compute, Cloud Run/Scheduler/Eventarc/PubSub, secrets/KMS,
backup/restore and additional supported cloud assets. IAM conditions are part
of identity. Asset Inventory lag is reconciled against direct APIs for selected
known cases; a green report is not a provider plan or exhaustive runtime proof.

### Ignored (system-managed / data) resources

`--strict` should not demand OpenTofu ownership for things GCP, GKE or a
controller create and maintain, or that are data. These are reported as
`ignored` with a `reason` (individual entries for tagged resources, `asset_scope`
counts for assets; both visible with `--json`, entries also with `--show-covered`).
A resource that IS in OpenTofu state stays `covered_opentofu`. `--include-system`
turns all built-in rules off. Rules and rationale live in `lib/ignore-rules.mjs`.

| Ignored | Why |
|---|---|
| `secretmanager.googleapis.com/SecretVersion` | payload = data; the Secret itself is still checked (`SecretManagerSecret`) |
| Disks with a `kubernetes.io/created-for/pvc/*` label/description | lifecycle owned by the PersistentVolume (restore-derived disks keep their RestorePlan logic) |
| `ComputeInstanceSettings` with empty metadata | per-zone default object |
| Pub/Sub `container-analysis-{notes,occurrences}-v1[beta1]` | created by Container Analysis |
| Firewalls `gke-<cluster>-<8hex>-[ipv6-]{all,vms,inkubelet,exkubelet,master}` | created by GKE |
| DNS response policies/rules named `gke-*` (policy: name or all rules `gke-*`) | created by GKE Cloud DNS |
| Dataplex entry groups `@<service>` | Google system groups |
| Predefined `iam.googleapis.com/Role` (`//iam.googleapis.com/roles/*`) | Google-managed; **custom roles stay unsupported/visible** |

Never ignored: service accounts and keys, IAM members/policies, buckets, secrets,
WIF pools/providers, custom roles, enabled APIs, addresses, Artifact Registry,
snapshots, alert policies, Certificate Manager, Cloud Armor, notification channels,
user networking. For project-specific exceptions use the explicit, repeatable
`--ignore KIND_OR_ASSET_TYPE:ID_REGEX` (only uncovered / unsupported-live
findings; the reason shows `user --ignore ...`).

Secret-level IAM (`google_secret_manager_secret_{iam_member,iam_binding,iam_policy}`)
is mapped; Cloud Asset reports it by project number, cfr normalises that to the
project ID taken from the scanned assets. A persistent `orphan_opentofu` IAM
binding that exists in GCP usually means the Cloud Asset IAM search index lags
behind the real policy (it is eventually consistent), not an ID mismatch:
compare `gcloud asset search-all-iam-policies` with `get-iam-policy` and re-run.

`covered_opentofu` does not establish absence of a second external reconciler.
During migration, separately prove KCC abandon/recreate-path removal before
enabling OpenTofu writes. No automatic ownership transfer is implemented here.

## portability

OpenTofu coverage is not readiness to move the workload to another Google Cloud
project. `cfr portability` shows ahead of time what will hinder a move. It is
read-only and reads only metadata and counters (never secret payloads, objects
or image contents).

```sh
npx @nitra/cfr portability --project PROJECT --dir tofu --dir flux [--tofu tofu/root] [--json] [--strict]
```

`--dir` is repeatable (default `.`); `*.md` (for literal checks), `docs/`,
`.terraform/`, `node_modules/` and `.git/` are skipped. The project number comes
from Cloud Asset. Findings carry `severity` (error|warn|info), `check`,
`location` (file:line or `live:...`), `message`, `hint`. `--json` emits
`{findings, summary}`; exit is 0, or 1 with `--strict` when any error exists.

| Check | Severity | What |
|---|---|---|
| `hardcoded-project-id` | error | literal project ID, grouped by context (bucket/resource name, `pkg.dev/PROJECT/`, SA email, `PROJECT.svc.id.goog`, `projects/PROJECT`, bare ID) |
| `hardcoded-project-number` | error | literal project number |
| `globally-unique-names` | warn | bucket names without a variable part; literal `dns_name` (the Artifact Registry host is project-scoped by path, so it is reported by the ID check) |
| `data-not-in-iac` | info | live counters + migration advice: SecretVersion per secret, buckets, Artifact Registry DOCKER images, PVC disks, snapshots, user-managed SA keys, Cloud SQL / BigQuery / Pub/Sub subscriptions / Firestore / Spanner / Redis when present |
| `uncovered-or-unsupported` | warn | needs `--tofu`: uncovered, orphan and unsupported resources (not `ignored`) grouped by type |
| `out-of-git-steps` | warn | heuristic: `kubectl create secret`, `kubectl apply -k`, `helm install`, `gcloud` (.sh/.yaml), manual/bootstrap wording in comments, scripts and README |
| `external-trust` | info | live WIF providers' issuer/audiences and static `issuer_uri` in `.tf` |
| `static-ips-and-dns` | info | external static addresses (IPs change, DNS needs updating) |

The human report ends with `blockers (error): N; warnings: N; data to migrate: ...`.
Heuristics can have false positives; messages never echo source lines.

## Upgrade from 0.x

- Remove `kcc-inventory` jobs. The removed command returns exit 2 with guidance.
- Replace `get-resources <namespace>` / `--all` with one explicit
  `get-resources --project PROJECT` invocation per project.
- Update raw inventory JSON consumers to the new envelope.
- Pass every authoritative state root to `tofu-inventory`; no KCC or ownership
  catalog flags can satisfy coverage.
- Fix unknown/missing arguments: version 1 rejects them with exit 2.
- Add the rendered `contract` check as a separate gate; it does not replace
  `check`, schema validation, inventory or runtime acceptance.

Do not enable final strict migration gates by silently excluding old cloud CRs
from reports. Record temporary failures/exceptions while transferring ownership,
then remove KCC resources/controllers/addons in the actual migration workflow.

## Development and release

```sh
npm ci
npm test
npm pack --dry-run
```

GitHub CI tests Node 18/20/22. Tag `v1.0.0` must match `package.json`.
The existing GitHub-hosted publish workflow uses npm trusted OIDC publishing,
with pinned actions and npm 11.6.2; no long-lived npm publish token.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

MIT license. Historical behavior is recorded in [CHANGELOG.md](CHANGELOG.md).
