// Kustomize's `resources:` field is an explicit list, not a glob. Add a
// YAML file to a Kustomize directory without listing it there and
// kustomize-controller silently skips it — no error, no warning, the
// resource just never reaches the cluster. This command catches that
// drift before it ships.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const HELP = `cfr check — verify kustomization.yaml resources: match the directory

Usage:
  npx @nitra/cfr [dir-or-kustomization.yaml ...]
  npx @nitra/cfr check [dir-or-kustomization.yaml ...]

Each argument is either a directory containing a kustomization.yaml (or
kustomization.yml), or a direct path to one. Defaults to "." when no
argument is given.

For each target, compares:
  - every *.yaml/*.yml file physically present in the directory
  - every plain-filename entry under the top-level "resources:" list

and reports both directions: files on disk missing from resources: (Flux
will never apply them), and resources: entries with no matching file
(dead reference). Entries containing "/" or a URL scheme (subdirectories,
components, remote bases) are out of scope and skipped.

Exits 0 when every target is consistent, 1 otherwise.

Options:
  -h, --help    Show this help and exit.
`;

function findKustomization(target) {
  const abs = resolve(target);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return { error: `${target}: no such file or directory` };
  }
  if (stat.isFile()) {
    return { dir: dirname(abs), file: abs };
  }
  for (const name of ['kustomization.yaml', 'kustomization.yml']) {
    const candidate = join(abs, name);
    try {
      if (statSync(candidate).isFile()) return { dir: abs, file: candidate };
    } catch {
      // try next
    }
  }
  return { error: `${target}: no kustomization.yaml (or .yml) found` };
}

function extractResources(text) {
  const lines = text.split('\n');
  const entries = [];
  let inBlock = false;
  for (const line of lines) {
    if (!inBlock) {
      if (/^resources:\s*(#.*)?$/.test(line)) inBlock = true;
      continue;
    }
    if (line.trim() === '') continue;
    const item = line.match(/^\s+-\s*(.+?)\s*(#.*)?$/);
    if (!item) break; // dedented past the list — block is over
    let value = item[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    entries.push(value);
  }
  return entries;
}

function isLocalYamlFilename(entry) {
  return /^[^/]+\.ya?ml$/i.test(entry) && !/^[a-z]+:\/\//i.test(entry);
}

function checkTarget(target) {
  const found = findKustomization(target);
  if (found.error) return { target, ok: false, error: found.error };

  const { dir, file } = found;
  const onDisk = new Set(
    readdirSync(dir).filter((name) => /\.ya?ml$/i.test(name) && join(dir, name) !== file),
  );

  const listedAll = extractResources(readFileSync(file, 'utf8'));
  const listedLocal = new Set(listedAll.filter(isLocalYamlFilename));

  const missing = [...onDisk].filter((name) => !listedLocal.has(name)).sort();
  const dangling = [...listedLocal].filter((name) => !onDisk.has(name)).sort();

  return { target, ok: missing.length === 0 && dangling.length === 0, file, missing, dangling };
}

export function run(argv) {
  if (argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(HELP);
    return 0;
  }

  const targets = argv.length > 0 ? argv : ['.'];
  let exitCode = 0;

  for (const target of targets) {
    const result = checkTarget(target);
    if (result.error) {
      console.error(`✗ ${result.target}: ${result.error}`);
      exitCode = 1;
      continue;
    }
    if (result.ok) {
      console.log(`✓ ${result.file}`);
      continue;
    }
    exitCode = 1;
    console.error(`✗ ${result.file}`);
    if (result.missing.length > 0) {
      console.error('  on disk but missing from resources: (Flux will not apply them):');
      for (const name of result.missing) console.error(`    - ${name}`);
    }
    if (result.dangling.length > 0) {
      console.error('  listed in resources: but missing on disk:');
      for (const name of result.dangling) console.error(`    - ${name}`);
    }
  }

  return exitCode;
}
