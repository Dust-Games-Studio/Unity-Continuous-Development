import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import {
  SetupError,
  checkLicense,
  coreEnvironmentChecks,
  evaluateUnityDoctor,
  loadGitDependencies,
  refuseEmbeddedCredentials,
  resolveCliIdentity,
  unityBaseOptions,
  type PreflightCheck,
} from '../lifecycle/setup.js';
import { preflightGitDependencies } from '../packages/git.js';
import type { GitDependency } from '../packages/deps.js';
import {
  isUnsupportedCommand,
  unityDoctorCi,
  unityProjectsVerify,
} from '../unity/cli.js';
import type { UnityResult } from '../unity/exec.js';

type DoctorCheck = PreflightCheck;

interface GitDependencyReport {
  name: string;
  url: string;
  host: string;
  reachable: boolean;
  detail: string;
}

interface VerifyEvaluation {
  ok: boolean;
  code: string;
  detail: string;
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
 */
function evaluateVerify(result: UnityResult): VerifyEvaluation {
  const topLevel = Array.isArray(result.json?.errors) ? result.json.errors : [];
  const nested = asObject(result.json?.data)?.errors;
  const errors = [...topLevel, ...(Array.isArray(nested) ? nested : [])] as {
    code?: unknown;
    message?: unknown;
  }[];
  const messages = errors
    .map((error) => {
      const code = typeof error.code === 'string' ? error.code : '';
      const message = typeof error.message === 'string' ? error.message : '';
      return code === '' ? message : `${code}: ${message}`;
    })
    .filter((message) => message !== '');

  const ok =
    result.code === 0 && result.json?.success !== false && messages.length === 0;

  if (ok) {
    return { ok: true, code: 'OK', detail: 'no project integrity problems' };
  }

  const fallback = resultDetail(result);
  return {
    ok: false,
    code: messages.length > 0 ? 'PROJECT_VERIFY_FAILED' : `VERIFY_EXIT_${result.code}`,
    detail:
      messages.length > 0
        ? messages.join('; ')
        : fallback === ''
          ? `unity projects verify exited ${result.code}`
          : fallback,
  };
}

function writeReport(ctx: CoreContext, report: unknown): string {
  const outputDir = resolve(ctx.projectPath, ctx.config.output.dir);
  const path = resolve(outputDir, 'logs', 'doctor.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * `unityci doctor`: the preflight gate (R11).
 *
 * It consumes Unity's own report, adds the core's checks (CLI capability matrix,
 * glibc and disk space on the host, `projects verify`, the mode-aware licence
 * check and private-git reachability), writes `<output.dir>/logs/doctor.json`
 * and prints one line per check. It is pure: it activates and returns no
 * licence.
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
          ok: false,
          code: 'UNSUPPORTED_COMMAND',
          detail: 'this Unity CLI does not support `projects verify --strict`',
        }
      : evaluateVerify(verifyResult);
    checks.push({
      id: 'projects-verify',
      status: verify.ok ? 'pass' : 'fail',
      code: verify.code,
      blocking: true,
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

    const gitDependencies: GitDependencyReport[] = [];
    if (ctx.config.packages.preflight) {
      // A malformed manifest is `unity projects verify`'s finding too, but the
      // doctor report must still be written: record it and skip the network
      // probe instead of aborting the whole command.
      let dependencies: GitDependency[] | null = null;
      try {
        dependencies = loadGitDependencies(ctx);
      } catch (error) {
        checks.push({
          id: 'git-dependencies',
          status: 'fail',
          code: 'GIT_DEPENDENCIES_UNREADABLE',
          blocking: true,
          message: (error as Error).message,
          source: 'core',
        });
      }

      if (dependencies !== null) {
        // A credential-bearing URL is refused before a report is written: the
        // report itself must never carry the secret.
        refuseEmbeddedCredentials(dependencies);
        const results = await preflightGitDependencies(dependencies, {
          cwd: ctx.projectPath,
          env: ctx.env,
          logger: ctx.logger,
          redactor: ctx.redactor,
        });
        for (const result of results) {
          gitDependencies.push({
            name: result.dependency.name,
            url: result.dependency.url,
            host: result.dependency.host,
            reachable: result.reachable,
            detail: result.detail,
          });
          checks.push({
            id: `git-dependency:${result.dependency.name}`,
            status: result.reachable ? 'pass' : 'fail',
            code: result.reachable ? 'OK' : 'GIT_DEPENDENCY_UNREACHABLE',
            blocking: true,
            message: result.reachable
              ? `${result.dependency.name} (${result.dependency.url}) is fetchable`
              : `${result.dependency.name} (${result.dependency.url}) is not fetchable: ${result.detail}. Fix the credential with a git URL rewrite or correct the package URL.`,
            source: 'core',
          });
        }
      }
    } else {
      checks.push({
        id: 'git-dependencies',
        status: 'info',
        code: 'PREFLIGHT_DISABLED',
        blocking: false,
        message: 'private git package preflight is disabled (packages.preflight: false)',
        source: 'core',
      });
    }

    const failed = checks.some(isBlockingFailure);
    const verdict = failed ? 'fail' : 'pass';

    const reportPath = writeReport(ctx, {
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
      projectsVerify: { ok: verify.ok, detail: verify.detail },
      license: {
        active: license.active,
        mode: ctx.config.license.mode,
        detail: license.detail,
        licenses: license.licenses,
        floatingServer: license.floatingServer,
      },
      gitDependencies,
    });

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

export type { DoctorCheck, GitDependencyReport };
