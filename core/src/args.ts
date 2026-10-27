import { parseArgs as parseArgsUtil } from 'node:util';

export interface ParseResult {
  command: string[];
  /**
   * Parsed flags, keyed by their long name.
   *
   * An option declared with `multiple: true` is always an **array** when it is
   * present — a single occurrence is `['value']`, never `'value'` — and its key
   * is **absent** (not `[]`) when the option was never supplied. Consumers must
   * check for the key's presence rather than assume an empty array.
   */
  flags: Record<string, string | boolean | string[]>;
  passthrough: string[];
}

export interface OptionSpec {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
}

/**
 * Flags every command understands. Command-specific flags are declared by the
 * caller through `extraOptions`; there is no open set, so a typo is always a
 * usage error.
 */
const GLOBAL_OPTIONS = {
  'project-path': { type: 'string', short: 'p' },
  config: { type: 'string' },
  'output-dir': { type: 'string' },
  annotations: { type: 'string' },
  ci: { type: 'boolean' },
  verbose: { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' },
} as const satisfies Readonly<Record<string, OptionSpec>>;

export function parseArgs(
  argv: string[],
  extraOptions: Record<string, OptionSpec> = {},
): ParseResult {
  // Everything after the first `--` belongs to the child process (editor
  // arguments and the like). It is never parsed as an option.
  const separator = argv.indexOf('--');
  const args = separator === -1 ? argv : argv.slice(0, separator);
  const passthrough = separator === -1 ? [] : argv.slice(separator + 1);

  const parsed = parseArgsUtil({
    args,
    options: { ...GLOBAL_OPTIONS, ...extraOptions },
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });

  return {
    command: [...parsed.positionals],
    flags: normaliseFlags(parsed.values),
    passthrough,
  };
}

function normaliseFlags(values: Record<string, unknown>): Record<string, string | boolean | string[]> {
  const flags: Record<string, string | boolean | string[]> = {};
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'boolean') {
      flags[name] = value;
    } else if (Array.isArray(value)) {
      flags[name] = value.map(String);
    }
  }
  return flags;
}
