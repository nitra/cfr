# @nitra/cfr

A handful of small Kubernetes, GitOps, and GCP CLI utilities, one `npx`/`bunx` away — no
install. Four commands so far:

- **`check`** (default) — verify a Kustomize directory's `resources:` list
  matches what's actually on disk
- **`kcc-inventory`** — diff a GCP Config Connector namespace against the
  live project to find drift
- **`get-resources`** — the raw resource list `kcc-inventory` diffs,
  without the diff
- **`tofu-inventory`** — diff an explicitly named GCP project against
  OpenTofu state, without Kubernetes or Config Connector

## `check`

Kustomize's `resources:` field is an **explicit list**, not a glob. Add a
YAML manifest to a directory managed by a [Flux](https://fluxcd.io)
`Kustomization` without listing it in `resources:`, and
`kustomize-controller` silently skips it — no error, no warning, the
object just never reaches the cluster.

This command catches that drift before it ships: it compares every
`*.yaml`/`*.yml` file physically present in a directory against the
`resources:` list in its `kustomization.yaml`, in both directions.

### Usage

```sh
npx @nitra/cfr [dir-or-kustomization.yaml ...]
npx @nitra/cfr check [dir-or-kustomization.yaml ...]   # same, explicit
```

No arguments checks `.`. Point it at one or more directories (or direct
paths to a `kustomization.yaml`/`kustomization.yml`):

```sh
npx @nitra/cfr flux/clusters/production
```

```
✗ flux/clusters/production/kustomization.yaml
  on disk but missing from resources: (Flux will not apply them):
    - new-app.yaml
```

Exits `0` when every target is consistent, `1` otherwise — wire it into CI
on any path that touches a Kustomize directory with an explicit
`resources:` list:

```yaml
# .github/workflows/cfr.yml
on:
  push:
    paths: ['flux/clusters/production/**']
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: npx @nitra/cfr flux/clusters/production
```

### What it checks

For each target directory:

- every `*.yaml`/`*.yml` file in the directory (except the
  `kustomization.yaml` itself) must appear in `resources:`
- every `resources:` entry that is a plain local filename (no `/`, no URL
  scheme) must exist on disk

Entries containing `/` (subdirectories, components) or a URL scheme
(remote bases) are out of scope and skipped — this tool only guards
against the specific footgun of a loose file sitting next to
`kustomization.yaml` that nobody remembered to list.

### Why this exists

A real incident: a PR added two manifests to a Flux cluster directory but
missed adding them to `resources:`. The PR merged clean, CI was green,
`git log` showed the files — and Flux applied nothing. No error surfaced
anywhere; the only symptom was the feature silently not existing in the
cluster. This command turns that into a CI failure at PR time instead.

## `kcc-inventory`

[Config Connector](https://cloud.google.com/config-connector/docs/overview)
(KCC) lets a Kubernetes namespace declare a GCP project's resources as
CRs, with a controller reconciling git against reality. It won't tell you
about the reverse direction: a resource created straight in GCP — by hand,
by another tool, by a Terraform run nobody ported — that KCC has never
heard of, and never will until someone points it out.

`kcc-inventory` is that someone. Per namespace (any namespace carrying the
annotation `cnrm.cloud.google.com/project-id`), it compares what's live in
the GCP project against the union of KCC declarations, OpenTofu state, and
explicit ownership catalogs. Besides IAM (including Workload Identity pools
and providers), GKE,
Artifact Registry, buckets, addresses and Cloud DNS, it includes Cloud Run
(`RunService`, `RunJob`), `CloudSchedulerJob`, `EventarcTrigger`, Pub/Sub,
Secret Manager, VPC Access, KMS, and the Cloud Run HTTP(S) load-balancer
chain (network, subnetwork, backend service, serverless NEG, URL map,
target HTTPS proxy, global forwarding rule, and SSL certificates).

Location-scoped resources use the canonical `location/name` ID, preventing
resources with the same name in different regions from being merged. IAM
bindings on a `RunService` are normalized to the same identity.

Read-only — it reports, it doesn't touch anything.

### Usage

```sh
npx @nitra/cfr kcc-inventory <namespace>
npx @nitra/cfr kcc-inventory --all                              # every KCC namespace
npx @nitra/cfr kcc-inventory <namespace|--all> --json
npx @nitra/cfr kcc-inventory <namespace|--all> --include-system  # don't filter GCP-managed noise
npx @nitra/cfr kcc-inventory nitraai \
  --ownership platform/kcc/inventory-ownership.json \
  --tofu platform/workload-identity/tofu
npx @nitra/cfr kcc-inventory nitraai --show-covered
```

```
### namespace nitraai -> проєкт nitraai ###
== StorageBucket (проєкт nitraai) ==
  UNCOVERED — old-backups-bucket
```

`--ownership PATH` and `--tofu DIR` are repeatable. Ownership paths use the
version-1 `{resources: [...]}` catalog. OpenTofu roots are read from actual
state via `tofu -chdir=DIR show -json`; parsing `.tf` configuration alone
would incorrectly mark resources that were never imported or applied as
covered. GKE clusters and node pools in OpenTofu state use the same canonical
`location/cluster` and `location/cluster/pool` IDs as live GCP and KCC
resources. Consequently, `tofu` must be available on `PATH` only when
`--tofu` is used.

Overlapping declarations are an error: a canonical
`(project, kind, id)` resource cannot simultaneously belong to KCC,
OpenTofu, or an ownership exception.

No `gcloud` or `kubectl` CLI needed on `PATH` — the GCP side (Cloud Asset
Inventory, IAM, Compute Engine) and the cluster side both talk REST
directly, authenticated with [Application Default
Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
(`gcloud auth application-default login` locally, a service account key
via `GOOGLE_APPLICATION_CREDENTIALS`, or the ambient credentials on
GCE/GKE/Cloud Build).

Cluster connection details still come from your kubeconfig (`KUBECONFIG`,
default `~/.kube/config`) — that part isn't going anywhere, it's the only
place the cluster's API server address and CA certificate live. Set
`KUBE_CONTEXT` to target a specific context explicitly instead of relying
on `current-context`. The GCP access token is used directly as the
cluster bearer token (the same trick `gke-gcloud-auth-plugin` performs
under `kubectl`), so this only works against **GKE** clusters — a
kubeconfig using client certs, a static token, or a non-GCP exec plugin
(EKS, AKS, ...) won't authenticate.

By default, GCP-managed system noise is filtered out — Google-owned
service accounts, Artifact Registry shims, the GCP default network and its
subnets, Cloud DNS zone-apex `NS`/`SOA` records, resources whose
`gkegw<generation>-` name shows they are created by the GKE Gateway
controller, GKE-managed node pools and DNS zones, and legacy bucket ACL
entries. Pass `--include-system` to see it anyway. Gateway-generated backend
services, URL maps, and HTTPS proxies are derived from Gateway API objects;
do not adopt them with KCC.

### Coverage and orphans

- **UNCOVERED** — live in GCP but absent from KCC, OpenTofu state, and
  ownership catalogs.
- **ORPHAN_KCC**, **ORPHAN_OPENTOFU**, **ORPHAN_OWNERSHIP** — a controller
  declaration exists, but its live GCP resource does not.
- **COVERED_KCC**, **COVERED_OPENTOFU**, **COVERED_OWNERSHIP** — shown in
  JSON and, for human output, only when `--show-covered` is passed.

### A known Cloud Asset Inventory quirk

`kcc-inventory` calls `searchAllResources`/`searchAllIamPolicies` on the
Cloud Asset API — one or two paginated calls per project instead of a
list call per resource kind. That index can lag: it has been observed
returning `DNSRecordSet` and `ComputeAddress` entries for resources
already deleted in GCP. Both are cross-checked against a direct Compute
Engine call before being reported, and any stale entry found this way is
counted and noted separately — never silently folded into DRIFT.

## `tofu-inventory`

`tofu-inventory` is the KCC-free variant of the GCP coverage scan. It reads
live resources from an explicit GCP project and declarations from one or more
real OpenTofu state roots. There is no Kubernetes API request, KCC namespace,
KCC CRD, or kubeconfig requirement.

```sh
npx @nitra/cfr tofu-inventory \
  --project nitraai \
  --tofu infrastructure/core \
  --tofu infrastructure/gke

# Gate CI on uncovered/orphan resources and unknown google_* state types.
npx @nitra/cfr tofu-inventory \
  --project nitraai \
  --tofu infrastructure/core \
  --strict
```

It reports `UNCOVERED` live GCP resources and `ORPHAN_OPENTOFU` declarations
whose cloud resource is absent. `--show-covered` includes the normal
`COVERED_OPENTOFU` entries, and `--json` provides the machine-readable form.
As with `kcc-inventory`, state is read with `tofu -chdir=DIR show -json`, never
from `.tf` source alone.

OpenTofu state is normalized for every resource family currently covered by
the live inventory: service accounts and keys, Workload Identity pools,
Artifact Registry, GKE, buckets, addresses, DNS, Cloud Run, Scheduler,
Eventarc, Pub/Sub, Secret Manager, VPC Access, network/subnetwork, KMS,
the global/regional serverless HTTP(S) load-balancer chain, selected legacy
GKE resources (persistent disks, Cloud Router/NAT, Backup for GKE plans, and
Cloud Build triggers), and IAM bindings
for projects, buckets, service accounts, Artifact Registry, and Cloud Run.
One authoritative IAM binding or policy becomes one canonical entry per
member and condition.

The OpenTofu-only project scan also covers Firestore databases, Monitoring
alert policies, project Logging buckets/sinks, Compute snapshots, firewall
rules, instances/groups/templates, health checks, HTTP proxies, regional
forwarding rules, routes, zonal NEGs, and Service Directory namespaces,
services, and endpoints. Identities preserve location and hierarchy; alert
policies use their API ID rather than their display name.
Enabled APIs are read directly from the paginated Service Usage API and
matched to `google_project_service` state by service name. Every enabled API
is inventoried, including defaults; APIs absent from all supplied states are
uncovered. An API disabled outside OpenTofu becomes an orphan declaration.
Cloud Asset service metadata does not establish enablement coverage.
Backup for GKE RestorePlans match `google_gke_backup_restore_plan`; Restore
and VolumeRestore executions have explicit runtime-content diagnostics.
Restored disks receive the separate `controller_managed` status only when
an exact successful VolumeRestore disk handle references the same project
and its live RestorePlan is covered by a supplied OpenTofu state. Reports
include the target PVC, VolumeRestore and parent state; these entries remain
visible in human output without `--show-covered`. Missing parent state,
failed restores and PVC-like disk names cannot establish coverage. Explicit
disk declarations retain their `covered_opentofu` status.

This is an origin/parent-state check through GCP APIs, not a live Kubernetes
PVC binding or reclaim-policy check. Removing a RestorePlan does not establish
that its restored disks will be deleted. Validate PVC/PV lifecycle separately
before teardown or moving a disk into static OpenTofu ownership. The inventory
requires no Kubernetes access for this classification.
Cloud NAT addresses are filtered only when the Compute API reports purpose
`NAT_AUTO`. GKE private endpoint subnetworks are filtered only through an exact
subnetwork reference in the cluster API, including the current control-plane
endpoint configuration. `--include-system` keeps both resource kinds visible.
Resource Manager projects, project billing associations and zonal Compute
InstanceSettings are also matched. Project identities use `project_id` from
state, independent of the provider's default project.

Every Cloud Asset type returned by the project search is accounted for.
Unknown infrastructure types produce `unsupported_live_resource` entries
and fail `--strict`. Kubernetes objects, image/backup contents and cached service
metadata have explicit `ignored` diagnostics with reasons. Default
Logging resources, GKE node/controller resources and subnet-generated routes
are filtered by default; `--include-system` includes them. Internet routes
and manual snapshots remain visible. A successful scan only describes the
Asset Inventory search snapshot: it does not guarantee that an API's child
resources, configuration drift or types not exposed by that API are covered.

Compute Project is read directly and split into individual metadata entries,
default network tier and Cloud Armor tier. GKE secondary-range metadata is
filtered by default. Output-only descriptor fields (including quota usage)
are explicitly accounted for separately. Unknown project fields, usage export
settings and Shared VPC host status still fail strict mode. Metadata values
are not emitted in reports; this inventory checks identities, not value drift.
Retail Catalog and Cloud Build GlobalTriggerSettings retain unsupported reasons
based on the verified Google 8.2.0 schema.

Managed `google_*` types outside that inventory are reported as
`unsupported_controller_resource`. Regional NEGs support `SERVERLESS`;
zonal NEGs have separate location-scoped identities. Use `--strict` in CI so unsupported types cannot become a
silent coverage gap.

The command requires `tofu` on `PATH` and GCP Application Default Credentials.
It does not require the `gcloud` or `kubectl` executables.

## `get-resources`

`kcc-inventory` is a diff on top of a fact-finding step: for each KCC
namespace, list what's live in GCP and what's declared under KCC. That
step is `get-resources` — same scan, same filtering, no drift/orphan
comparison. Useful on its own for piping into `jq`, feeding a different
tool, or just seeing everything a namespace touches without wading
through a diff.

### Usage

```sh
npx @nitra/cfr get-resources <namespace>
npx @nitra/cfr get-resources --all
npx @nitra/cfr get-resources <namespace|--all> --json
npx @nitra/cfr get-resources <namespace|--all> --include-system
```

```
### namespace nitraai -> проєкт nitraai ###
== StorageBucket ==
  gcp: 7n-forgejo-lfs
  gcp: old-backups-bucket
  kcc: 7n-forgejo-lfs
```

`--json` emits `{resources: [{namespace, project, kind, id, source}, ...],
diagnostics: [...]}` — `source` is `"gcp"` or `"kcc"`, `diagnostics`
carries the same stale-cache/GKE-managed notes described above.

Same requirements as `kcc-inventory` — no `gcloud`/`kubectl` needed, GKE
only, `--include-system` to see GCP-managed noise.

## Changelog

See [CHANGELOG.md](https://github.com/nitra/cfr/blob/main/CHANGELOG.md).

## License

MIT
