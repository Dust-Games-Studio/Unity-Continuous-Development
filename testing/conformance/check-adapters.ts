/**
 * Adapter conformance checks.
 *
 * An adapter is allowed to install the binary, supply flags/environment/secrets,
 * call `unityci`, and wire the provider's cache, artifact and teardown features.
 * It is **not** allowed to decide the result: no retry loop, no interpretation
 * of a Unity exit code, no Unity output parsing (D4, Section 5.1).
 *
 * The checks are deliberately lexical. They read the adapter's `.yml`/`.yaml`
 * files, strip full-line comments so an annotated example cannot trip a rule,
 * and return one result per rule per file with a line number in `detail`. A
 * trailing `# …` on a `uses:` line is kept on purpose: `pinned-actions` needs to
 * see the version comment next to the SHA.
 *
 * The module lives outside `core/`, so it must not import core internals — the
 * adapter contract is executable from any provider's repository. Relative
 * adapter directories are resolved by walking up from the current directory, so
 * `checkAdapter('adapters/github')` works whether it is run from the repository
 * root or from `core/`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface ConformanceResult {
  /** Path shown to the reader; adapter-relative for a relative input, else absolute. */
  file: string;
  rule: string;
  ok: boolean;
  detail: string;
}

export const RULES = [
  'calls-unityci',
  'has-teardown',
  'teardown-does-not-fail-the-job',
  'no-retry-logic',
  'no-exit-code-logic',
  'publishes-on-zero-and-eight',
  'pinned-actions',
  'masks-credentials',
  'no-credential-on-command-line',
  'no-git-config-global-env',
] as const;

type Rule = (typeof RULES)[number];
type Check = { ok: boolean; detail: string };
type Checks = Record<Rule, Check>;

interface SourceLine {
  /** 1-based line number in the original file. */
  number: number;
  text: string;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolves a relative adapter directory against the working directory and then
 * each of its ancestors. The repository is a small tree, so the bounded walk is
 * cheap and it keeps the check usable from `core/` (`pnpm -C core test`) and
 * from the repository root without a path constant that could drift.
 */
function resolveAdapterDir(dir: string): string {
  if (isAbsolute(dir)) return dir;

  let current = resolve(process.cwd());
  for (let depth = 0; depth < 10; depth += 1) {
    const candidate = resolve(current, dir);
    if (isDirectory(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(
    `adapter directory not found: ${dir} (searched from ${process.cwd()} upwards)`,
  );
}

/** Every YAML file in the adapter directory, recursively, in a stable order. */
function yamlFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...yamlFiles(path));
    } else if (/\.ya?ml$/i.test(entry.name)) {
      files.push(path);
    }
  }
  return files.sort();
}

function readLines(file: string): SourceLine[] {
  return readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((text, index) => ({ number: index + 1, text }));
}

/**
 * Blanks full-line YAML comments while preserving line numbers. A trailing
 * comment is intentionally left in place (see the module comment).
 */
function stripCommentLines(lines: SourceLine[]): SourceLine[] {
  return lines.map((line) => ({
    number: line.number,
    text: /^\s*#/.test(line.text) ? '' : line.text,
  }));
}

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 120 ? trimmed : `${trimmed.slice(0, 117)}...`;
}

/** A line beginning a YAML step (`- name:`, `- uses:`, `- run:`, …). */
const STEP_START = /^\s*-\s+(?:name|uses|run|id|if):/;

/** Splits the document into step blocks. Text before the first step is ignored. */
function splitSteps(lines: SourceLine[]): SourceLine[][] {
  const steps: SourceLine[][] = [];
  let current: SourceLine[] | null = null;

  for (const line of lines) {
    if (STEP_START.test(line.text)) {
      if (current !== null) steps.push(current);
      current = [line];
    } else if (current !== null) {
      current.push(line);
    }
  }
  if (current !== null) steps.push(current);
  return steps;
}

const ALWAYS = /\bif:\s*(?:\$\{\{\s*)?always\s*\(\s*\)/;
const NON_GATING =
  /\bif:\s*(?:\$\{\{\s*)?(?:always\s*\(\s*\)|!\s*cancelled\s*\(\s*\)|success\s*\(\s*\)\s*\|\|\s*failure\s*\(\s*\))/;

const LICENSE_RETURN = /\bunityci\s+license\s+return\b/;

function checkCallsUnityci(lines: SourceLine[]): Check {
  const anyUnityci = lines.find((line) => /\bunityci\b/.test(line.text));
  if (anyUnityci === undefined) {
    return {
      ok: false,
      detail: 'no `unityci` invocation found; an adapter may only call the core binary',
    };
  }

  // Prefer an actual call (`unityci run …`, `unityci cache-info …`) over the
  // action's own `name:` line when reporting the evidence.
  const invocation =
    lines.find((line) =>
      /(?:^|[\s;&|(`"'])unityci\s+(?:(?:run|cache-info|doctor|setup|license|report)\b|["']?\$)/.test(
        line.text,
      ),
    ) ?? anyUnityci;

  // A bare lower-case `unity ` token is a direct Unity CLI call, which would
  // bypass the core's verdict, retries, licence handling and summary. The URL
  // `https://unity.com/install.sh` does not match: `unity` is followed by `.`.
  const bare = lines.find((line) =>
    /(?:^|[\s;&|(`"'=:/])unity(?=\s)/.test(line.text),
  );
  if (bare !== undefined) {
    return {
      ok: false,
      detail: `line ${bare.number}: bare \`unity\` invocation bypasses the core: ${excerpt(bare.text)}`,
    };
  }

  return {
    ok: true,
    detail: `line ${invocation.number}: calls \`unityci\` (${excerpt(invocation.text)}); no bare \`unity\` invocation`,
  };
}

function checkHasTeardown(lines: SourceLine[]): Check {
  const steps = splitSteps(lines);
  for (const step of steps) {
    if (!step.some((line) => ALWAYS.test(line.text))) continue;
    const returnLine = step.find((line) => LICENSE_RETURN.test(line.text));
    if (returnLine !== undefined) {
      return {
        ok: true,
        detail: `line ${returnLine.number}: \`unityci license return\` runs in an \`if: always()\` teardown`,
      };
    }
  }

  const anyReturn = lines.find((line) => LICENSE_RETURN.test(line.text));
  return {
    ok: false,
    detail:
      anyReturn === undefined
        ? 'no `unityci license return` step; a killed or cancelled job would leak the Unity seat'
        : `line ${anyReturn.number}: \`unityci license return\` is not in an \`if: always()\` step, so a cancelled or killed job would leak the seat`,
  };
}

function checkTeardownDoesNotFailTheJob(lines: SourceLine[]): Check {
  const steps = splitSteps(lines);
  const teardown = steps.find((step) =>
    step.some((line) => LICENSE_RETURN.test(line.text)),
  );
  if (teardown === undefined) {
    return {
      ok: false,
      detail: 'no `unityci license return` teardown found to check',
    };
  }

  const returnLine = teardown.find((line) => LICENSE_RETURN.test(line.text));
  if (returnLine === undefined) {
    return { ok: false, detail: 'no `unityci license return` line found' };
  }

  const tolerates =
    /\|\|/.test(returnLine.text) &&
    teardown.some((line) => /::warning::/.test(line.text));
  if (!tolerates) {
    return {
      ok: false,
      detail: `line ${returnLine.number}: the licence return does not tolerate a non-zero exit (expected \`|| echo "::warning::…"\`); exit 6 for an unreturned seat would turn a green run red`,
    };
  }

  return {
    ok: true,
    detail: `line ${returnLine.number}: a failed licence return is downgraded to a warning annotation, so the run step alone decides the job`,
  };
}

const RETRY_CONSTRUCT = /\b(?:retr(?:y|ies|ying)|max[-_]?attempts?|attempts?)\b/i;

function checkNoRetryLogic(lines: SourceLine[]): Check {
  const line = lines.find((entry) => RETRY_CONSTRUCT.test(entry.text));
  if (line !== undefined) {
    return {
      ok: false,
      detail: `line ${line.number}: retry construct found (${excerpt(line.text)}); retries belong to the core, not the adapter`,
    };
  }
  return { ok: true, detail: 'no retry/attempt construct found' };
}

/**
 * Exit-code interpretation happens in the core (D4). The patterns look for a
 * numeric comparison on `$?`, `code`, `exit_code` or `status`, not for the bare
 * `exit 64` a configuration guard legitimately uses.
 */
const EXIT_COMPARISONS: RegExp[] = [
  /\$\?[^\n]*?(?:===?|!==?|-eq|-ne|-lt|-gt|-le|-ge)\s*\d+/,
  /\b(?:exit(?:_?code)?|unity_?exit(?:_?code)?|status_?code)\b[^\n]*?(?:===?|!==?|-eq|-ne|-lt|-gt|-le|-ge)\s*\d+/i,
  /\d+\s*(?:===?|!==?|-eq|-ne|-lt|-gt|-le|-ge)[^\n]*?\b(?:exit(?:_?code)?|\bcode\b|status)\b/i,
  /\bcase\s+(?:"?\$?\??"?(?:exit_?code|code|status)\b|\$\?)/i,
];

function checkNoExitCodeLogic(lines: SourceLine[]): Check {
  for (const line of lines) {
    if (EXIT_COMPARISONS.some((pattern) => pattern.test(line.text))) {
      return {
        ok: false,
        detail: `line ${line.number}: compares a numeric exit code (${excerpt(line.text)}); the core owns the verdict`,
      };
    }
  }
  return {
    ok: true,
    detail: 'no comparison against a numeric Unity exit code',
  };
}

function checkPublishes(lines: SourceLine[]): Check {
  const uploads = splitSteps(lines).filter((step) =>
    step.some((line) => /\buses:\s*['"]?\S*upload-artifact/.test(line.text)),
  );
  if (uploads.length === 0) {
    return {
      ok: false,
      detail: 'no artifact/report upload step found; results from a failed run (exit 8) must still be published',
    };
  }

  for (const step of uploads) {
    if (step.some((line) => NON_GATING.test(line.text))) {
      const condition = step.find((line) => NON_GATING.test(line.text));
      return {
        ok: true,
        detail: `line ${condition?.number ?? step[0]?.number ?? 0}: the upload step runs regardless of the run result`,
      };
    }
  }

  const first = uploads[0]?.[0];
  return {
    ok: false,
    detail: `line ${first?.number ?? 0}: the artifact upload step gates on the run result; use \`if: always()\` so exit 8 still publishes its reports`,
  };
}

function checkPinnedActions(lines: SourceLine[]): Check {
  const uses: Array<{ line: SourceLine; ref: string }> = [];
  for (const line of lines) {
    const match = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line.text);
    if (match === null) continue;
    const ref = match[1]?.replace(/^['"]|['"]$/g, '') ?? '';
    uses.push({ line, ref });
  }

  if (uses.length === 0) {
    return { ok: true, detail: 'no third-party `uses:` lines to pin' };
  }

  const unpinned = uses.filter(
    ({ ref }) => !/^[^@]+@[0-9a-f]{40}$/.test(ref),
  );
  if (unpinned.length > 0) {
    const first = unpinned[0];
    return {
      ok: false,
      detail: `line ${first?.line.number ?? 0}: \`${first?.ref ?? ''}\` is not pinned to a 40-character commit SHA (${unpinned.length} unpinned of ${uses.length})`,
    };
  }

  return {
    ok: true,
    detail: `all ${uses.length} \`uses:\` line(s) are pinned to a 40-character commit SHA`,
  };
}

const CREDENTIAL_VAR_NAMES =
  /\$(?:\{)?(UNITYCI_GIT_TOKEN|GIT_TOKEN|GITHUB_TOKEN|GH_TOKEN|TOKEN|UNITY_LICENSE_SERIAL|UNITY_LICENSE_FILE_BASE64)\b/g;
const CREDENTIAL_EXPR_NAMES =
  /\$\{\{\s*(inputs\.git-token|secrets\.[A-Za-z0-9_]+)\s*\}\}/g;
/** An env mapping (`UNITYCI_GIT_TOKEN: …`) hands a value to the shell; it is not a log line. */
const ENV_MAPPING = /^\s*[A-Z][A-Z0-9_]*\s*:/;

/** Every distinct credential value referenced on one line. */
function credentialNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(CREDENTIAL_VAR_NAMES)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  for (const match of text.matchAll(CREDENTIAL_EXPR_NAMES)) {
    if (match[1] !== undefined) names.add(match[1]);
  }
  return [...names];
}

/** Whether one `::add-mask::` line masks this exact credential value. */
function maskCovers(mask: string, name: string): boolean {
  if (name.startsWith('inputs.') || name.startsWith('secrets.')) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\$\\{\\{\\s*${escaped}\\s*\\}\\}`).test(mask);
  }
  return new RegExp(`\\$(?:\\{)?${name}\\b`).test(mask);
}

/**
 * GC24 requires every credential value to be masked **before its own first
 * use**. One `::add-mask::` for one token does not cover a second credential
 * later in the same file, so this checks each name independently.
 */
function checkMasksCredentials(lines: SourceLine[]): Check {
  const masks = lines.filter((line) => /::add-mask::/.test(line.text));
  const uses: Array<{ line: SourceLine; names: string[] }> = [];

  for (const line of lines) {
    if (/::add-mask::/.test(line.text)) continue;
    if (ENV_MAPPING.test(line.text)) continue;
    const names = credentialNames(line.text);
    if (names.length > 0) uses.push({ line, names });
  }

  if (uses.length === 0) {
    return {
      ok: true,
      detail:
        'no credential value is expanded on an executable line (a declaration-only mention needs no mask)',
    };
  }

  const firstUse = new Map<string, SourceLine>();
  for (const use of uses) {
    for (const name of use.names) {
      if (!firstUse.has(name)) firstUse.set(name, use.line);
    }
  }

  const unmasked: Array<{ name: string; line: SourceLine }> = [];
  for (const [name, useLine] of firstUse) {
    const covered = masks.some(
      (mask) => mask.number < useLine.number && maskCovers(mask.text, name),
    );
    if (!covered) unmasked.push({ name, line: useLine });
  }

  if (unmasked.length > 0) {
    const first = unmasked[0];
    if (first === undefined) {
      return { ok: false, detail: 'credential use found without a mask' };
    }
    const more =
      unmasked.length > 1
        ? ` (and ${unmasked.length - 1} more unmasked credential(s))`
        : '';
    return {
      ok: false,
      detail: `line ${first.line.number}: \`${first.name}\` is used without an earlier \`::add-mask::\` for that value${more} (${excerpt(first.line.text)}); every credential must be masked before its first use (GC24)`,
    };
  }

  return {
    ok: true,
    detail: `::add-mask:: precedes every credential use (${firstUse.size} value(s))`,
  };
}

const GIT_CONFIG = /\bgit\s+config\b/;
const CREDENTIAL_HINT =
  /(?:token|secret|password|credential|x-access-token|\$\{?(?:[A-Z0-9_]*TOKEN|UNITY_LICENSE_SERIAL))/i;
const URL_WITH_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s"']+@/i;

function checkNoCredentialOnCommandLine(lines: SourceLine[]): Check {
  for (const line of lines) {
    if (!GIT_CONFIG.test(line.text)) continue;
    if (
      CREDENTIAL_HINT.test(line.text) ||
      URL_WITH_USERINFO.test(line.text)
    ) {
      return {
        ok: false,
        detail: `line ${line.number}: a credential reaches \`git config\`'s argv (${excerpt(line.text)}); write the rewrite with a shell builtin instead`,
      };
    }
  }
  return {
    ok: true,
    detail: 'no `git config` invocation carries a credential on its command line',
  };
}

function checkNoGitConfigGlobalEnv(lines: SourceLine[]): Check {
  const line = lines.find((entry) => /\bGIT_CONFIG_GLOBAL\b/.test(entry.text));
  if (line !== undefined) {
    return {
      ok: false,
      detail: `line ${line.number}: GIT_CONFIG_GLOBAL is set (${excerpt(line.text)}); Unity's Package Manager ignores it and fails at resolution`,
    };
  }
  return {
    ok: true,
    detail: 'GIT_CONFIG_GLOBAL is not used',
  };
}

function runChecks(lines: SourceLine[]): Checks {
  return {
    'calls-unityci': checkCallsUnityci(lines),
    'has-teardown': checkHasTeardown(lines),
    'teardown-does-not-fail-the-job': checkTeardownDoesNotFailTheJob(lines),
    'no-retry-logic': checkNoRetryLogic(lines),
    'no-exit-code-logic': checkNoExitCodeLogic(lines),
    'publishes-on-zero-and-eight': checkPublishes(lines),
    'pinned-actions': checkPinnedActions(lines),
    'masks-credentials': checkMasksCredentials(lines),
    'no-credential-on-command-line': checkNoCredentialOnCommandLine(lines),
    'no-git-config-global-env': checkNoGitConfigGlobalEnv(lines),
  };
}

function displayFile(input: string, adapterDir: string, file: string): string {
  if (isAbsolute(input)) return file;
  const base = input.replace(/\\/g, '/').replace(/\/+$/, '');
  const inside = relative(adapterDir, file).split(/[\\/]/).join('/');
  return `${base}/${inside}`;
}

/**
 * Checks every `.yml`/`.yaml` file under `dir` against every rule and returns
 * one `{ file, rule, ok, detail }` result per rule per file.
 */
export async function checkAdapter(dir: string): Promise<ConformanceResult[]> {
  const adapterDir = resolveAdapterDir(dir);
  const files = yamlFiles(adapterDir);

  if (files.length === 0) {
    return RULES.map((rule) => ({
      file: dir,
      rule,
      ok: false,
      detail: `no .yml/.yaml file found under ${adapterDir}; an adapter without a workflow cannot be checked`,
    }));
  }

  const results: ConformanceResult[] = [];
  for (const file of files) {
    const lines = stripCommentLines(readLines(file));
    const checks = runChecks(lines);
    for (const rule of RULES) {
      const check = checks[rule];
      results.push({
        file: displayFile(dir, adapterDir, file),
        rule,
        ok: check.ok,
        detail: check.detail,
      });
    }
  }
  return results;
}
