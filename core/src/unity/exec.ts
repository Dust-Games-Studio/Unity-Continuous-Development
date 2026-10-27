import { spawnProcess } from '../exec.js';
import type { Logger } from '../logger.js';
import type { Redactor } from '../redact.js';

/**
 * The envelope every `unity … --format json` command emits (see the samples in
 * `docs/decisions/spike0-cli.md`). Later tasks read `data` and branch on the
 * exit code, not on `errors[0].code`.
 */
export interface UnityEnvelope {
  success?: boolean;
  data?: unknown;
  errors?: { code?: string; message?: string }[];
  warnings?: string[];
}

export interface UnityResult {
  code: number;
  stdout: string;
  stderr: string;
  /**
   * The parsed stdout envelope, or null when stdout is not a JSON object.
   *
   * It is parsed from the child's raw output, so a value Unity echoes back
   * (for example a licence serial) is present here even though `stdout` is
   * redacted; do not persist this field without redacting it first.
   */
  json: UnityEnvelope | null;
}

export interface RunUnityOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logger: Logger;
  redactor: Redactor;
  timeoutMs?: number;
}

/**
 * Unity's own CLI strips these from every process it starts. Doing the same
 * before the child exists keeps a service-account or forge token away from the
 * Editor's Package Manager and its git (GC23).
 */
const STRIPPED_VARIABLES = [
  'UNITY_SERVICE_ACCOUNT_ID',
  'UNITY_SERVICE_ACCOUNT_SECRET',
  'UNITY_GITHUB_TOKEN',
  'UNITY_GITLAB_TOKEN',
] as const;

/**
 * Unattended, quiet and telemetry-free for every Unity child process (GC13).
 * `UNITY_NO_CRASH_REPORT` and `UNITY_NO_CONSENT_PROMPT` are deliberately not
 * here: they are policy, decided by the caller through `opts.env`.
 */
const ALWAYS_ON: Readonly<Record<string, string>> = {
  UNITY_NON_INTERACTIVE: '1',
  UNITY_NO_UPDATE_CHECK: '1',
  UNITY_NO_BANNER: '1',
  UNITY_NO_AGENT_HINTS: '1',
  UNITY_NO_CLI_INVOKED_TELEMETRY: '1',
};

/**
 * `opts.env` wins over the ambient environment for everything except the four
 * stripped token names and the five forced variables. `UNITY_LICENSE_SERIAL`
 * passes through: the CLI reads it from the environment by design and never
 * puts it on argv.
 */
function unityChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
  for (const name of STRIPPED_VARIABLES) delete childEnv[name];
  Object.assign(childEnv, ALWAYS_ON);
  return childEnv;
}

/** A top-level JSON object is a Unity envelope; anything else is "no data". */
function parseEnvelope(raw: string): UnityEnvelope | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as UnityEnvelope;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Runs one `unity` invocation with the Unity-specific child environment and
 * parses its stdout as a JSON envelope.
 *
 * Parsing reads the child's **raw** stdout: redaction can mask a substring that
 * straddles JSON syntax, and a valid document must never turn into
 * `json: null` because a secret was registered. Only the exposed `stdout` and
 * `stderr` strings are redacted. Unparsable stdout is not an error here —
 * callers decide what a missing envelope means — so `json` is null instead.
 */
export async function runUnity(opts: RunUnityOptions): Promise<UnityResult> {
  const result = await spawnProcess({
    file: opts.binary,
    args: opts.args,
    cwd: opts.cwd,
    env: unityChildEnv(opts.env),
    logger: opts.logger,
    redactor: opts.redactor,
    timeoutMs: opts.timeoutMs,
  });

  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    json: parseEnvelope(result.rawStdout),
  };
}
