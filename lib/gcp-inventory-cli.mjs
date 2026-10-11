import { collectProject } from './get-resources.mjs';
import { parseOptions } from './args.mjs';

export const HELP = `cfr get-resources — read-only live GCP inventory

Usage:
  npx @nitra/cfr@1.0.0 get-resources --project PROJECT [--json] [--include-system]

Project is explicit; no Kubernetes, namespaces or kubeconfig are used.
Authentication: Application Default Credentials, including WIF.
--json emits {project, resources, diagnostics}. System/controller resources
have diagnostic skip reasons; --include-system includes them where supported.
This reports facts, not OpenTofu coverage. Use tofu-inventory for coverage.
Exit 0: completed scan; 1: collection failure; 2: invalid usage.
`;

export async function run(argv, { collect = collectProject } = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let options;
  try {
    options = parseOptions(argv, { flags: ['--json', '--include-system'], values: ['--project'] });
    if (options.get('--project')?.length !== 1) throw new Error('--project PROJECT is required exactly once');
  } catch (err) {
    console.error(`usage: cfr get-resources --project PROJECT [--json] [--include-system]: ${err.message}`);
    return 2;
  }
  const project = options.get('--project')[0];
  const result = await collect(project, { includeSystem: Boolean(options.get('--include-system')) });
  if (options.get('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`### GCP project ${project} ###`);
    for (const resource of result.resources) console.log(`${resource.kind}: ${resource.id}`);
    for (const diagnostic of result.diagnostics) console.log(`diagnostic: ${diagnostic.type} (${diagnostic.kind || diagnostic.assetType})`);
  }
  return 0;
}
