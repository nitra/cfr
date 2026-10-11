#!/usr/bin/env node
import { run as runCheck } from '../lib/check.mjs';
import { run as runGetResources } from '../lib/gcp-inventory-cli.mjs';
import { run as runTofuInventory } from '../lib/tofu-inventory.mjs';
import { run as runContract } from '../lib/contract.mjs';
import { readFileSync } from 'node:fs';

const TOP_HELP = `cfr (@nitra/cfr) — OpenTofu + Flux contract utilities

Usage:
  npx @nitra/cfr [dir-or-kustomization.yaml ...]
  npx @nitra/cfr <command> [args...]

Commands:
  check           Verify kustomization.yaml resources: match the directory
                  (default when the first argument isn't a known command)
  get-resources   Read-only live GCP inventory (--project PROJECT)
  tofu-inventory  Compare live GCP with actual OpenTofu state
  contract        Validate rendered Kubernetes/Flux manifests (no cloud owner CRs)

Run "npx @nitra/cfr <command> --help" for command-specific help.
`;

const COMMANDS = {
  check: runCheck,
  'get-resources': runGetResources,
  'tofu-inventory': runTofuInventory,
  contract: runContract,
};

// check is synchronous (local filesystem only); inventory commands are async
// (talk to GCP over the network) — awaiting a plain number is
// a no-op, so this works for either.
async function main(argv) {
  if (argv[0] === '--version' || argv[0] === '-v') {
    console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);
    return 0;
  }
  if (argv[0] === 'kcc-inventory') {
    console.error('kcc-inventory was removed in v1. Use tofu-inventory --project PROJECT --tofu DIR.');
    return 2;
  }
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
  // writes. Для великого inventory JSON через pipe це давало
  // неповний JSON, хоча scan уже завершився. exitCode зберігає статус,
  // але дає Node дописати pipe перед природним завершенням процесу.
  (code) => { process.exitCode = code; },
  (err) => {
    console.error(`✗ ${err.message || err}`);
    process.exitCode = 1;
  },
);
