# @nitra/check-flux-resources

Kustomize's `resources:` field is an **explicit list**, not a glob. Add a
YAML manifest to a directory managed by a [Flux](https://fluxcd.io)
`Kustomization` without listing it in `resources:`, and
`kustomize-controller` silently skips it — no error, no warning, the
object just never reaches the cluster.

This CLI catches that drift before it ships: it compares every
`*.yaml`/`*.yml` file physically present in a directory against the
`resources:` list in its `kustomization.yaml`, in both directions.

## Usage

```sh
npx @nitra/check-flux-resources [dir-or-kustomization.yaml ...]
```

No arguments checks `.`. Point it at one or more directories (or direct
paths to a `kustomization.yaml`/`kustomization.yml`):

```sh
npx @nitra/check-flux-resources flux/clusters/production
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
# .github/workflows/check-flux-resources.yml
on:
  push:
    paths: ['flux/clusters/production/**']
  pull_request:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - run: npx @nitra/check-flux-resources flux/clusters/production
```

## What it checks

For each target directory:

- every `*.yaml`/`*.yml` file in the directory (except the
  `kustomization.yaml` itself) must appear in `resources:`
- every `resources:` entry that is a plain local filename (no `/`, no URL
  scheme) must exist on disk

Entries containing `/` (subdirectories, components) or a URL scheme
(remote bases) are out of scope and skipped — this tool only guards
against the specific footgun of a loose file sitting next to
`kustomization.yaml` that nobody remembered to list.

## Why this exists

A real incident: a PR added two manifests to a Flux cluster directory but
missed adding them to `resources:`. The PR merged clean, CI was green,
`git log` showed the files — and Flux applied nothing. No error surfaced
anywhere; the only symptom was the feature silently not existing in the
cluster. This tool turns that into a CI failure at PR time instead.

## License

MIT
