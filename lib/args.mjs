// Strict argument parsing shared by project inventory commands.
export function parseOptions(argv, { flags = [], values = [] } = {}) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (flags.includes(arg)) {
      result.set(arg, true);
    } else if (values.includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value`);
      const entries = result.get(arg) || [];
      entries.push(value);
      result.set(arg, entries);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return result;
}
