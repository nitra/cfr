# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.5] - 2026-08-30

### Added

- Mark `nitraai/us-central1/forgejo-remote` as explicitly controlled by
  OpenTofu. It is reported as `covered_opentofu`, not KCC drift, while other
  Artifact Registry repositories remain subject to the normal KCC diff.

## [0.6.4] - 2026-08-30

### Fixed

- Verify Cloud Asset Inventory NodePool entries against the GKE API, so
  deleted node pools are reported as stale cache rather than KCC drift.

## [0.6.3] - 2026-08-30

### Fixed

- Exclude GCP-managed Artifact Registry shims, the default network and its
  subnetworks, and managed-zone apex `NS`/`SOA` records from default KCC
  inventory output; `--include-system` retains them for inspection.

## [0.6.2] - 2026-08-30

### Fixed

- Exclude Compute backend services, URL maps, and HTTPS proxies created by
  the GKE Gateway controller from the default KCC drift report; pass
  `--include-system` to inspect them.

## [0.6.1] - 2026-08-29

### Fixed

- `kcc-inventory --json` now drains its complete stdout payload before the
  process exits, so piping a full inventory into `jq` cannot receive a
  truncated JSON document.

## [0.6.0] - 2026-08-29

### Added

- `kcc-inventory` and `get-resources` now cover Cloud Run services and jobs,
  Scheduler, Eventarc, Pub/Sub, Secret Manager, VPC Access, KMS, and the
  serverless HTTP(S) load-balancer chain.

### Changed

- Location-scoped inventory IDs use `location/name`; IAM bindings for a
  `RunService` use the same canonical identity.

## [0.5.0] - 2026-08-28

### Changed

- `kcc-inventory` and `get-resources` no longer need `kubectl` on `PATH`.
  The cluster side now talks directly to the Kubernetes API server over
  REST (`lib/k8s-rest.mjs`), authenticated with the same Application
  Default Credentials access token already used for the GCP calls — GKE
  accepts a GCP IAM OAuth2 token as a bearer token natively, which is
  what `gke-gcloud-auth-plugin` does under `kubectl` anyway. Server
  address and CA certificate still come from the kubeconfig
  (`KUBECONFIG`/`~/.kube/config`, `KUBE_CONTEXT`).
- Roughly 2x faster on top of the 0.3.0 speedup: no `kubectl` subprocess
  spawned per call either.

### Added

- `yaml` dependency (kubeconfig parsing).

### Known limitation

- Only works against **GKE** clusters. A kubeconfig using client
  certificates, a static token, or a non-GCP `exec` plugin (EKS, AKS,
  ...) won't authenticate — this isn't a general Kubernetes REST client.

## [0.4.0] - 2026-08-28

### Added

- `get-resources` subcommand: the raw `{kind, id, source}` resource list
  `kcc-inventory` diffs, exposed on its own with no drift/orphan
  comparison. `npx @nitra/cfr get-resources <namespace|--all> [--json]
  [--include-system]`.

### Changed

- `lib/kcc-resources.mjs` renamed to `lib/get-resources.mjs` — it now
  doubles as both the internal module `kcc-inventory.mjs` consumes and
  its own CLI entrypoint.

## [0.3.0] - 2026-08-28

### Changed

- `kcc-inventory` no longer needs `gcloud` on `PATH`. The GCP side now
  talks directly to the Cloud Asset, IAM, and Compute Engine REST APIs
  (`lib/gcp-rest.mjs`), authenticated with Application Default
  Credentials instead of shelling out to the `gcloud` CLI.
- `searchAllResources`/`searchAllIamPolicies` now paginate properly via
  `nextPageToken` instead of buffering one giant JSON blob from a single
  `gcloud` invocation.
- Service-account-key listing moved from one sequential `gcloud`
  subprocess per service account to one REST call per account, fired in
  parallel.
- `compute.addresses.list` moved to `aggregatedList` (one call for every
  region) plus a separate global-addresses call.
- Authentication failures now throw instead of being silently swallowed
  as an empty result.
- Roughly 40x faster on the project this was measured against: ~22s
  instead of ~14+ minutes, almost entirely `gcloud`'s own Python startup
  and buffering overhead.
- Internal: `kcc-resources.mjs` (the GCP/KCC fact-gathering mechanism)
  split out from `kcc-inventory.mjs` (the diff and report on top of it).

### Added

- `google-auth-library` dependency (Application Default Credentials).

### Fixed

- CI never ran `npm install`/`npm ci` before this release added the
  package's first dependency — every test was failing on module
  resolution. Both workflows now install dependencies first.

## [0.2.0] - 2026-08-28

### Added

- `kcc-inventory` command: diffs a GCP Config Connector (KCC) namespace
  against the live GCP project to find drift, for `IAMServiceAccount`,
  `IAMServiceAccountKey`, `ArtifactRegistryRepository`,
  `ContainerCluster`, `ContainerNodePool`, `StorageBucket`,
  `ComputeAddress`, `DNSManagedZone`, `DNSRecordSet`, and
  `IAMPolicyMember`. `npx @nitra/cfr kcc-inventory <namespace|--all>
  [--json] [--include-system]`.
- Subcommand routing in `bin/cli.mjs`: `check` stays the default when the
  first argument isn't a recognized command name, so existing `npx
  @nitra/cfr <dir>` invocations are unaffected.

## [0.1.2] - 2026-08-28

### Fixed

- CI: upgrade to `actions/setup-node@v6` for npm Trusted Publishing —
  `v4`/`v5` write an empty auth token into `.npmrc` that short-circuits
  the OIDC exchange.

## [0.1.0] - 2026-08-27

### Added

- Initial release: `check` verifies every YAML file in a Kustomize
  directory is listed in `kustomization.yaml`'s explicit `resources:`
  (and vice versa) — catches files Flux silently ignores.

[0.6.1]: https://github.com/nitra/cfr/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/nitra/cfr/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nitra/cfr/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nitra/cfr/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nitra/cfr/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/nitra/cfr/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/nitra/cfr/compare/20e9f03...v0.1.2
[0.1.0]: https://github.com/nitra/cfr/commit/20e9f03
