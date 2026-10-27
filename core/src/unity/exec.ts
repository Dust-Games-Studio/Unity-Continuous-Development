import { spawnProcess } from '../exec.js';
import type { Logger } from '../logger.js';
import type { Redactor } from '../redact.js';

export interface UnityResult {
  code: number;
  stdout: string;
  stderr: string;
  /** `JSON.parse(stdout)`, or null when stdout is not valid JSON. */
  json: unknown | null;
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

/**
 * Runs one `unity` invocation with the Unity-specific child environment and
 * parses its stdout as JSON. Unparsable stdout is not an error here — callers
 * decide what a missing JSON document means — so `json` is null instead.
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

  let json: unknown | null = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }

  return { ...result, json };
}
