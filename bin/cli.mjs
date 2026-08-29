#!/usr/bin/env node
import { run as runCheck } from '../lib/check.mjs';
import { run as runKccInventory } from '../lib/kcc-inventory.mjs';
import { run as runGetResources } from '../lib/get-resources.mjs';

const TOP_HELP = `cfr (@nitra/cfr) — a handful of small k8s/GitOps CLI utilities

Usage:
  npx @nitra/cfr [dir-or-kustomization.yaml ...]
  npx @nitra/cfr <command> [args...]

Commands:
  check           Verify kustomization.yaml resources: match the directory
                  (default when the first argument isn't a known command)
  kcc-inventory   GCP Config Connector (KCC) drift inventory
  get-resources   Raw KCC/GCP resource list behind kcc-inventory, no diff

Run "npx @nitra/cfr <command> --help" for command-specific help.
`;

const COMMANDS = {
  check: runCheck,
  'kcc-inventory': runKccInventory,
  'get-resources': runGetResources,
};

// check is synchronous (local filesystem only); the other two are async
// (talk to GCP/Kubernetes over the network) — awaiting a plain number is
// a no-op, so this works for either.
async function main(argv) {
  if (argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(TOP_HELP);
    return 0;
  }

  const [first, ...rest] = argv;
  const command = COMMANDS[first];
  // No recognized subcommand name in front — treat the whole argv as
  // arguments to the default command (`check`), same as before subcommands
  // existed: `npx @nitra/cfr flux/clusters/prod` still just works.
  if (!command) return runCheck(argv);
  return command(rest);
}

main(process.argv.slice(2)).then(
  // Не викликаємо process.exit(): він примусово обриває pending stdout
  // writes. Для великого `kcc-inventory --json | jq ...` це давало
  // неповний JSON, хоча scan уже завершився. exitCode зберігає статус,
  // але дає Node дописати pipe перед природним завершенням процесу.
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`✗ ${err.message || err}`);
    process.exitCode = 1;
  },
);
