/** Preserve the CLI's exact option syntax and errors across live and folder commands. */
export function parseArguments(argv: string[], flags: readonly string[], values: readonly string[]) {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (flags.includes(value)) options.set(value, "");
    else if (values.includes(value)) {
      const next = argv[++index];
      if (!next || next.startsWith("--")) throw new Error(`${value} needs a value`);
      options.set(value, next);
    } else if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    else positional.push(value);
  }
  return { positional, options };
}
