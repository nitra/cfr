# @nitra/cfr

A handful of small k8s/GitOps CLI utilities, one `npx`/`bunx` away — no
install. Three commands so far:

- **`check`** (default) — verify a Kustomize directory's `resources:` list
  matches what's actually on disk
- **`kcc-inventory`** — diff a GCP Config Connector namespace against the
  live project to find drift
- **`get-resources`** — the raw resource list `kcc-inventory` diffs,
  without the diff

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
the GCP project against what's declared under KCC. Besides IAM, GKE,
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
```

```
### namespace nitraai -> проєкт nitraai ###
== StorageBucket (проєкт nitraai) ==
  DRIFT — є в GCP, немає в KCC:
    old-backups-bucket
  чисто (11 live, 11 kcc)
```

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

### Two directions

- **DRIFT** — live in GCP, not declared under a known controller. Either
  adopt it (give it a matching CR with the right `resourceID`), declare its
  confirmed external controller in CFR's ownership catalog, or delete it by hand.
- **COVERED_OPENTOFU** — live in GCP and explicitly controlled by OpenTofu;
  it is visible in the report, but not treated as unowned KCC drift.
- **ORPHAN** — declared under KCC, no longer live in GCP. The CR is
  pointing at nothing; safe to remove from git.

### A known Cloud Asset Inventory quirk

`kcc-inventory` calls `searchAllResources`/`searchAllIamPolicies` on the
Cloud Asset API — one or two paginated calls per project instead of a
list call per resource kind. That index can lag: it has been observed
returning `DNSRecordSet` and `ComputeAddress` entries for resources
already deleted in GCP. Both are cross-checked against a direct Compute
Engine call before being reported, and any stale entry found this way is
counted and noted separately — never silently folded into DRIFT.

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
