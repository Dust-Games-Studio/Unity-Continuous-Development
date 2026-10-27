import { parseArgs as parseArgsUtil } from 'node:util';

export interface ParseResult {
  command: string[];
  flags: Record<string, string | boolean | string[]>;
}

type OptionConfig = {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
};

/**
 * Flags every command understands. Command-specific flags are not listed here:
 * they are discovered per invocation (see `discoverCommandOptions`) so
 * subcommands can add their own without editing the global schema.
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
} as const satisfies Readonly<Record<string, OptionConfig>>;

export function parseArgs(argv: string[]): ParseResult {
  // The open set: learn the command-specific flags from argv, then let the
  // strict `parseArgs` pass below validate them alongside the global flags.
  // A command flag is recognised by carrying a value (`--mode EditMode`,
  // `--mode=EditMode`); a bare unknown flag is indistinguishable from a typo
  // (`--nope`) and is therefore a usage error.
  const options: Record<string, OptionConfig> = { ...GLOBAL_OPTIONS };
  for (const [name, shape] of discoverCommandOptions(argv)) {
    if (!shape.hasValue) throw new Error(`Unknown option '--${name}'`);
    options[name] = { type: 'string', multiple: shape.repeated };
  }

  const parsed = parseArgsUtil({
    args: argv,
    options,
    allowPositionals: true,
    allowNegative: true,
    strict: true,
  });

  return {
    command: [...parsed.positionals],
    flags: normaliseFlags(parsed.values),
  };
}

interface CommandOptionShape {
  hasValue: boolean;
  repeated: boolean;
}

function discoverCommandOptions(argv: string[]): Map<string, CommandOptionShape> {
  const discovered = new Map<string, CommandOptionShape>();

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    // Everything after `--` is positional (editor arguments and the like).
    if (token === '--') break;
    if (!token.startsWith('--') || token === '--') continue;

    const body = token.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);

    if (name in GLOBAL_OPTIONS) continue;
    if (name.startsWith('no-') && name.slice(3) in GLOBAL_OPTIONS) continue;

    const next = argv[index + 1];
    const hasValue = equals !== -1 || (next !== undefined && !next.startsWith('-'));

    const previous = discovered.get(name);
    discovered.set(name, {
      hasValue: hasValue || previous?.hasValue === true,
      repeated: previous !== undefined,
    });
  }

  return discovered;
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
