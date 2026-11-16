/** Process exit codes the core emits or passes through from the Unity CLI. */
export const EXIT = {
  SUCCESS: 0,
  ERROR: 1,
  BAD_ARGS: 2,
  AUTH_ERROR: 3,
  NEEDS_CONFIG: 4,
  COMMAND_FAILED: 6,
  NETWORK_UNREACHABLE: 7,
  TESTS_FAILED: 8,
  NOT_FOUND: 11,
  EDITOR_UNREACHABLE: 12,
  REMOTE_COMMAND_FAILED: 13,
  TIMEOUT: 14,
  RUN_FAILED: 15,
  JOB_SUSPENDED: 16,
  UNAVAILABLE: 17,
  AWAITING_INPUT: 18,
  CONFIG_ERROR: 64,
  INTERNAL_ERROR: 65,
  INTERRUPTED: 130,
  OUTPUT_CLOSED: 141,
  TERMINATED: 143,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/**
 * Human-readable meaning of an exit code. Codes 9 and 10 are Unity's own but
 * are not emitted by the core, so they are described rather than named in EXIT.
 */
const DESCRIPTIONS: Readonly<Record<number, string>> = {
  [EXIT.SUCCESS]: 'success',
  [EXIT.ERROR]: 'general error',
  [EXIT.BAD_ARGS]: 'usage error',
  [EXIT.AUTH_ERROR]: 'authentication failure',
  [EXIT.NEEDS_CONFIG]: 'configuration required',
  9: 'install locked',
  10: 'ready timeout',
  [EXIT.COMMAND_FAILED]: 'command failed',
  [EXIT.NETWORK_UNREACHABLE]: 'Unity service unreachable',
  [EXIT.TESTS_FAILED]: 'tests failed',
  [EXIT.NOT_FOUND]: 'project or release not found',
  [EXIT.EDITOR_UNREACHABLE]: 'editor unreachable',
  [EXIT.REMOTE_COMMAND_FAILED]: 'remote command failed',
  [EXIT.TIMEOUT]: 'timed out',
  [EXIT.RUN_FAILED]: 'run failed',
  [EXIT.JOB_SUSPENDED]: 'job suspended',
  [EXIT.UNAVAILABLE]: 'editor unavailable (loading, compiling, reloading or in Safe Mode)',
  [EXIT.AWAITING_INPUT]: 'editor awaiting input (a modal dialog is blocking it)',
  [EXIT.CONFIG_ERROR]: 'configuration error',
  [EXIT.INTERNAL_ERROR]: 'internal error',
  [EXIT.INTERRUPTED]: 'interrupted (SIGINT)',
  [EXIT.OUTPUT_CLOSED]: 'output closed (the reader of stdout closed the pipe)',
  [EXIT.TERMINATED]: 'terminated (SIGTERM)',
};

export function describeExit(code: number): string {
  return DESCRIPTIONS[code] ?? `unknown exit code ${code}`;
}
