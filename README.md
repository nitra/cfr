# @nitra/cfr

A handful of small k8s/GitOps CLI utilities, one `npx`/`bunx` away — no
install, no dependencies. Two commands so far:

- **`check`** (default) — verify a Kustomize directory's `resources:` list
  matches what's actually on disk
- **`kcc-inventory`** — diff a GCP Config Connector namespace against the
  live project to find drift

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
the GCP project against what's declared under KCC, for
`IAMServiceAccount`, `IAMServiceAccountKey`, `ArtifactRegistryRepository`,
`ContainerCluster`, `ContainerNodePool`, `StorageBucket`, `ComputeAddress`,
`DNSManagedZone`, `DNSRecordSet`, and `IAMPolicyMember`.

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

Requires `kubectl` on `PATH`, pointed at the target cluster. Set
`KUBE_CONTEXT` to target a specific kubeconfig context explicitly instead
of relying on the current one. The GCP side talks to Cloud Asset
Inventory, IAM, and Compute Engine directly over REST — no `gcloud` CLI
needed, just [Application Default
Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)
(`gcloud auth application-default login` locally, a service account key
via `GOOGLE_APPLICATION_CREDENTIALS`, or the ambient credentials on
GCE/GKE/Cloud Build).

By default, GCP-managed system noise is filtered out — Google-owned
service accounts, `gcr.io` shims, GKE-managed node pools and DNS zones,
legacy bucket ACL entries. Pass `--include-system` to see it anyway.

### Two directions

- **DRIFT** — live in GCP, not declared under KCC. Either adopt it (give
  it a matching CR with the right `resourceID`) or delete it by hand.
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

## License

MIT
