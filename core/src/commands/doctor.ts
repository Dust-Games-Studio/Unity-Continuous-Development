import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import {
  SetupError,
  checkLicense,
  coreEnvironmentChecks,
  evaluateUnityDoctor,
  resolveCliIdentity,
  unityBaseOptions,
  type PreflightCheck,
} from '../lifecycle/setup.js';
import {
  isUnsupportedCommand,
  unityDoctorCi,
  unityProjectsVerify,
} from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';

type DoctorCheck = PreflightCheck;

interface VerifyEvaluation {
  status: 'pass' | 'info' | 'fail';
  code: string;
  detail: string;
  blocking: boolean;
}

function firstLine(value: string): string {
  const line = value.split(/\r?\n/, 1)[0] ?? '';
  return line.trim();
}

function resultDetail(result: UnityResult): string {
  const detail = firstLine(result.stderr) || firstLine(result.stdout);
  return detail === '' ? '' : detail;
}

function isBlockingFailure(check: { status: string; blocking: boolean }): boolean {
  return check.blocking && check.status !== 'pass' && check.status !== 'info';
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `unity projects verify --strict` is a blocking preflight: it catches missing
 * or orphaned `.meta` files, duplicate GUIDs, conflict markers and an invalid
 * package manifest without launching the Editor.
 *
 * A clean report is `pass`. Missing/unparsable output is `info`, not a pass:
 * R18 forbids a false green, but `doctor` already treats its own missing report
 * as blocking, and verify is a secondary check with no verdict to consume
 * (M3). A non-zero exit or an error list is always `fail`.
 *
 * The CLI puts the useful detail in `data.findings` (code, path, message) and
 * only a count in the envelope's top-level `errors`. A preflight that says
 * "Errors: 6" and nothing else cannot be acted on, so each finding is listed
 * on its own line; the list is capped so a huge report cannot bury the exit
 * code, with the remainder counted in one "and N more" line.
 */
const MAX_VERIFY_FINDINGS = 5;

interface VerifyFinding {
  code: string;
  path: string;
  message: string;
}

/**
 * Reads one finding without assuming a shape: the CLI has used objects, and a
 * future/older shape may use a bare string. A missing path, code or message is
 * tolerated; an entry with none of them is dropped as empty.
 */
function readFinding(entry: unknown): VerifyFinding | null {
  if (typeof entry === 'string') {
    const message = entry.trim();
    return message === '' ? null : { code: '', path: '', message };
  }
  const object = asObject(entry);
  if (object === null) return null;
  const code = typeof object.code === 'string' ? object.code.trim() : '';
  const path = typeof object.path === 'string' ? object.path.trim() : '';
  const message = typeof object.message === 'string' ? object.message.trim() : '';
  if (code === '' && path === '' && message === '') return null;
  return { code, path, message };
}

/** `data.findings` (what the CLI really sends), or a top-level `findings`. */
function readFindings(json: Record<string, unknown> | null): VerifyFinding[] {
  const candidate = asObject(json?.data)?.findings ?? json?.findings;
  if (!Array.isArray(candidate)) return [];
  return candidate
    .map((entry) => readFinding(entry))
    .filter((finding): finding is VerifyFinding => finding !== null);
}

/**
 * The error count in the shapes the CLI has used: `data.errorCount`,
 * `data.summary.errors` (the current payload), or a top-level `errorCount`.
 * Returns null when no usable count is present.
 */
function readErrorCount(json: Record<string, unknown> | null): number | null {
  const data = asObject(json?.data);
  const summary = asObject(data?.summary);
  for (const candidate of [data?.errorCount, summary?.errors, json?.errorCount]) {
    if (
      typeof candidate === 'number' &&
      Number.isSafeInteger(candidate) &&
      candidate >= 0
    ) {
      return candidate;
    }
  }
  return null;
}

/** `- CODE path: message`, dropping any part the report omitted. */
function formatFinding(finding: VerifyFinding): string {
  const location = [finding.code, finding.path].filter((part) => part !== '').join(' ');
  if (location === '') return `- ${finding.message}`;
  return finding.message === '' ? `- ${location}` : `- ${location}: ${finding.message}`;
}

/** Messages from an envelope `errors` array, tolerating strings and bad entries. */
function errorMessages(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const messages: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const message = entry.trim();
      if (message !== '') messages.push(message);
      continue;
    }
    const object = asObject(entry);
    if (object === null) continue;
    const code = typeof object.code === 'string' ? object.code : '';
    const message = typeof object.message === 'string' ? object.message : '';
    const composed = code === '' ? message : `${code}: ${message}`;
    if (composed.trim() !== '') messages.push(composed);
  }
  return messages;
}

function evaluateVerify(result: UnityResult): VerifyEvaluation {
  const json = asObject(result.json);
  const messages = [
    ...errorMessages(json?.errors),
    ...errorMessages(asObject(json?.data)?.errors),
  ];
  const findings = readFindings(json);
  const errorCount = readErrorCount(json);

  const failed =
    result.code !== 0 ||
    json?.success === false ||
    messages.length > 0 ||
    findings.length > 0 ||
    (errorCount !== null && errorCount > 0);

  if (failed) {
    const fallback = resultDetail(result);
    const count = errorCount ?? findings.length;
    const detail: string[] = [];

    if (messages.length > 0) {
      // The CLI's own summary line, e.g. "PROJECTS_VERIFY_FAILED: Project
      // verification failed. Errors: 6" — kept verbatim as the count line.
      detail.push(messages.join('; '));
    } else if (count > 0) {
      detail.push(`unity projects verify found ${count} error${count === 1 ? '' : 's'}`);
    }

    detail.push(...findings.slice(0, MAX_VERIFY_FINDINGS).map(formatFinding));
    const hidden = findings.length - MAX_VERIFY_FINDINGS;
    if (hidden > 0) detail.push(`and ${hidden} more`);

    if (detail.length === 0) {
      detail.push(fallback === '' ? `unity projects verify exited ${result.code}` : fallback);
    }

    return {
      status: 'fail',
      blocking: true,
      code:
        messages.length > 0 || findings.length > 0 || count > 0
          ? 'PROJECT_VERIFY_FAILED'
          : `VERIFY_EXIT_${result.code}`,
      detail: detail.join('\n'),
    };
  }

  if (result.json === null) {
    return {
      status: 'info',
      blocking: false,
      code: 'PROJECT_VERIFY_NO_REPORT',
      detail:
        '`unity projects verify --format json` produced no machine-readable report (exit 0); not treated as a pass',
    };
  }

  return {
    status: 'pass',
    blocking: true,
    code: 'OK',
    detail: 'no project integrity problems',
  };
}

/** Masks every string in the report before it is serialised, keeping the JSON valid. */
function redactDeep(value: unknown, redactor: CoreContext['redactor']): unknown {
  if (typeof value === 'string') return redactor.redact(value);
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry, redactor));
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = redactDeep(entry, redactor);
    }
    return output;
  }
  return value;
}

/**
 * Writes the report through the context's redactor: the values come from
 * Unity's raw envelope, which may echo a secret (I2). Every string is masked
 * before serialisation so the artifact stays valid JSON.
 */
function writeReport(ctx: CoreContext, report: unknown): string {
  const outputDir = resolve(ctx.projectPath, ctx.config.output.dir);
  const path = resolve(outputDir, 'logs', 'doctor.json');
  const serialized = JSON.stringify(redactDeep(report, ctx.redactor), null, 2);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${serialized}\n`, 'utf8');
  return path;
}

/**
 * `unityci doctor`: the preflight gate (R11).
 *
 * It consumes Unity's own report, adds the core's checks (CLI capability matrix,
 * glibc and disk space on the host, `projects verify`, the mode-aware licence
 * check), writes `<output.dir>/logs/doctor.json` and prints one line per check.
 * It is pure: it activates and returns no licence. The private-git preflight
 * belongs to `setup`, so `doctor` never repeats it.
 */
export async function doctorCommand(ctx: CoreContext): Promise<number> {
  try {
    // `doctor` records a below-floor CLI as a blocking check in its report
    // instead of aborting before the report exists.
    await resolveCliIdentity(ctx, { throwBelowFloor: false });
    const base = unityBaseOptions(ctx);
    const checks: DoctorCheck[] = [...coreEnvironmentChecks(ctx)];
    let unityVerdict: 'pass' | 'fail' | 'unknown' = 'unknown';

    const doctorResult = await unityDoctorCi(base);
    if (isUnsupportedCommand(doctorResult)) {
      checks.push({
        id: 'unity-doctor',
        status: 'fail',
        code: 'UNSUPPORTED_COMMAND',
        blocking: true,
        message: 'this Unity CLI does not support `doctor --ci`',
        source: 'core',
      });
    } else {
      const doctor = evaluateUnityDoctor(doctorResult);
      unityVerdict = doctor.verdict;
      if (!doctor.reportOk) {
        const detail = resultDetail(doctorResult);
        checks.push({
          id: 'doctor-report',
          status: 'fail',
          code: 'CORE_DOCTOR_REPORT_MISSING',
          blocking: true,
          message:
            '`unity doctor --ci --format json` did not return a machine-readable report' +
            (detail === '' ? ` (exit ${doctorResult.code})` : ` (exit ${doctorResult.code}): ${detail}`),
          source: 'core',
        });
      } else {
        for (const check of doctor.checks) {
          checks.push({ ...check, source: 'unity' });
        }
      }
    }

    const verifyResult = await unityProjectsVerify(base, ctx.projectPath);
    const verify: VerifyEvaluation = isUnsupportedCommand(verifyResult)
      ? {
          status: 'fail',
          blocking: true,
          code: 'UNSUPPORTED_COMMAND',
          detail: 'this Unity CLI does not support `projects verify --strict`',
        }
      : evaluateVerify(verifyResult);
    checks.push({
      id: 'projects-verify',
      status: verify.status,
      code: verify.code,
      blocking: verify.blocking,
      message: verify.detail,
      source: 'core',
    });

    const license = await checkLicense(ctx);
    const licenseFails =
      !license.active && !license.unsupported && ctx.config.license.mode === 'none';
    checks.push({
      id: 'license',
      status: license.unsupported
        ? 'fail'
        : license.active
          ? 'pass'
          : licenseFails
            ? 'fail'
            : 'info',
      code: license.unsupported
        ? 'UNSUPPORTED_COMMAND'
        : license.active
          ? 'OK'
          : licenseFails
            ? 'LICENSE_NOT_ACTIVE'
            : 'LICENSE_INACTIVE_REPORTED',
      blocking: license.unsupported || licenseFails,
      message: license.unsupported
        ? 'this Unity CLI does not support `license status`'
        : license.active
          ? `active: ${license.detail}`
          : licenseFails
            ? `no active Unity license (${license.detail}); a run with license.mode: none requires one`
            : `no active Unity license yet (${license.detail}); license.mode "${ctx.config.license.mode}" activates it in the lifecycle`,
      source: 'core',
    });

    const failed = checks.some(isBlockingFailure);
    const verdict = failed ? 'fail' : 'pass';

    let reportPath: string;
    try {
      reportPath = writeReport(ctx, {
        schema: 1,
        generatedAt: new Date().toISOString(),
        cli: {
          version: ctx.cliVersion,
          channel: ctx.cliChannel,
          commit: ctx.cliCommit,
        },
        verdict,
        unityVerdict,
        checks,
        projectsVerify: {
          status: verify.status,
          blocking: verify.blocking,
          detail: verify.detail,
        },
        license: {
          active: license.active,
          mode: ctx.config.license.mode,
          detail: license.detail,
          licenses: license.licenses,
          floatingServer: license.floatingServer,
        },
      });
    } catch (error) {
      ctx.logger.error(
        `could not write the doctor report under ${ctx.projectPath}: ${(error as Error).message}`,
      );
      return EXIT.COMMAND_FAILED;
    }

    for (const check of checks) {
      const code = check.code === '' ? '' : ` (${check.code})`;
      ctx.logger.info(
        `${check.status.toUpperCase()} ${check.id}${code}: ${check.message}`,
      );
    }
    ctx.logger.info(`doctor report: ${reportPath}`);

    return failed ? EXIT.CONFIG_ERROR : EXIT.SUCCESS;
  } catch (error) {
    if (error instanceof SetupError) {
      ctx.logger.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}

export type { DoctorCheck };
