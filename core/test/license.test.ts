import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { licenseActivateCommand, licenseReturnCommand } from '../src/commands/license.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import {
  LicenseError,
  activateLicense,
  returnLicense,
} from '../src/lifecycle/license.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

const mocks = vi.hoisted(() => ({
  runUnity: vi.fn(),
}));

vi.mock('../src/unity/exec.js', () => ({
  runUnity: mocks.runUnity,
}));

interface UnityCall {
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface FakeResult {
  code: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

const SERIAL = 'abc123-serial-secret';
const calls: UnityCall[] = [];
const lines: string[] = [];

function ok(data: unknown = {}): FakeResult {
  return { code: 0, stdout: '', stderr: '', json: { success: true, data } };
}

function failed(code: number, stderr: string, message = stderr): FakeResult {
  return {
    code,
    stdout: '',
    stderr,
    json: { success: false, errors: [{ code: 'LICENSE_FAILED', message }] },
  };
}

function record(options: UnityCall): void {
  calls.push({ args: options.args, env: options.env, timeoutMs: options.timeoutMs });
}

function makeContext(
  mode: Config['license']['mode'],
  env: NodeJS.ProcessEnv = {},
): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  config.license.mode = mode;
  const redactor = createRedactor();
  const logger = createLogger({
    redactor,
    level: 'debug',
    sink: (line) => {
      lines.push(line);
    },
  });
  return {
    config,
    cwd: process.cwd(),
    projectPath: process.cwd(),
    env,
    logger,
    redactor,
    binary: 'unity',
    startedAt: Date.now(),
    cliVersion: null,
    cliChannel: null,
    cliCommit: null,
  };
}

const originalSerial = process.env.UNITY_LICENSE_SERIAL;
const originalFile = process.env.UNITY_LICENSE_FILE_BASE64;

beforeEach(() => {
  calls.length = 0;
  lines.length = 0;
  // The anatomy of a leak: a value left in the real environment must never
  // make an "env var is empty" test pass or fail by accident.
  delete process.env.UNITY_LICENSE_SERIAL;
  delete process.env.UNITY_LICENSE_FILE_BASE64;
  mocks.runUnity.mockReset();
  mocks.runUnity.mockImplementation(async (options: UnityCall) => {
    record(options);
    return ok({ activated: true });
  });
});

afterEach(() => {
  if (originalSerial === undefined) delete process.env.UNITY_LICENSE_SERIAL;
  else process.env.UNITY_LICENSE_SERIAL = originalSerial;
  if (originalFile === undefined) delete process.env.UNITY_LICENSE_FILE_BASE64;
  else process.env.UNITY_LICENSE_FILE_BASE64 = originalFile;
});

describe('activateLicense', () => {
  it('activates with mode none without calling the CLI', async () => {
    const result = await activateLicense(makeContext('none'));

    expect(result).toEqual({ activated: false, mode: 'none' });
    expect(mocks.runUnity).not.toHaveBeenCalled();
  });

  it('activates a serial without putting the serial in argv', async () => {
    const result = await activateLicense(
      makeContext('serial', { UNITY_LICENSE_SERIAL: SERIAL }),
    );

    expect(result).toEqual({ activated: true, mode: 'serial' });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.args).toEqual(['license', 'activate', '--format', 'json']);
    // The CLI reads UNITY_LICENSE_SERIAL itself, so neither the value nor the
    // option that would carry it may appear on the child's command line.
    expect(call.args).not.toContain(SERIAL);
    expect(call.args.join(' ')).not.toContain(SERIAL);
    expect(call.args).not.toContain('--serial');
    // The value must still reach the child, under the configured name.
    expect(call.env.UNITY_LICENSE_SERIAL).toBe(SERIAL);
  });

  it('passes the serial under the configured env var name', async () => {
    const ctx = makeContext('serial', { MY_UNITY_SERIAL: SERIAL });
    ctx.config.license.serialEnv = 'MY_UNITY_SERIAL';

    await activateLicense(ctx);

    expect(calls[0]!.args).not.toContain('--serial');
    expect(calls[0]!.env.MY_UNITY_SERIAL).toBe(SERIAL);
  });

  it('activates floating with --floating', async () => {
    const result = await activateLicense(makeContext('floating'));

    expect(result).toEqual({ activated: true, mode: 'floating' });
    expect(calls[0]!.args).toContain('--floating');
    expect(calls[0]!.args).not.toContain('--serial');
  });

  it('explains a missing floating server when the CLI exits 4', async () => {
    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      return failed(4, 'no licensing server is configured');
    });

    const code = await licenseActivateCommand(makeContext('floating'));

    expect(code).toBe(64);
    const output = lines.join('');
    expect(output).toMatch(/no floating license server is configured/i);
    expect(output).toContain('licensingServiceBaseUrl');
    expect(output).toContain('no licensing server is configured');
  });

  it('decodes an offline license file to a temp path and passes --file', async () => {
    const content = '<?xml version="1.0"?><root>offline licence</root>\n';
    const encoded = Buffer.from(content, 'utf8').toString('base64');
    let tempPath = '';
    let contentDuringCall = '';
    let modeDuringCall = 0;

    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      const index = options.args.indexOf('--file');
      tempPath = options.args[index + 1] ?? '';
      contentDuringCall = readFileSync(tempPath, 'utf8');
      modeDuringCall = statSync(tempPath).mode & 0o777;
      return ok({ activated: true });
    });

    const result = await activateLicense(
      makeContext('offline-file', { UNITY_LICENSE_FILE_BASE64: encoded }),
    );

    expect(result).toEqual({ activated: true, mode: 'offline-file' });
    expect(tempPath).toMatch(/\.ulf$/);
    expect(contentDuringCall).toBe(content);
    if (process.platform !== 'win32') {
      expect(modeDuringCall).toBe(0o600);
    }
    // The decoded licence must not outlive the activation.
    expect(existsSync(tempPath)).toBe(false);
    expect(existsSync(dirname(tempPath))).toBe(false);
  });

  it('deletes the offline temp file even when activation fails', async () => {
    const encoded = Buffer.from('ulf-bytes', 'utf8').toString('base64');
    let tempPath = '';
    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      tempPath = options.args[options.args.indexOf('--file') + 1] ?? '';
      return failed(3, 'activation refused');
    });

    const error = await activateLicense(
      makeContext('offline-file', { UNITY_LICENSE_FILE_BASE64: encoded }),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LicenseError);
    expect(tempPath).not.toBe('');
    expect(existsSync(tempPath)).toBe(false);
  });

  it('activates personal with --personal --accept-eula', async () => {
    const result = await activateLicense(makeContext('personal'));

    expect(result).toEqual({ activated: true, mode: 'personal' });
    expect(calls[0]!.args).toContain('--personal');
    expect(calls[0]!.args).toContain('--accept-eula');
  });

  it('fails with exit 64 when the serial env var is empty', async () => {
    const ctx = makeContext('serial', { UNITY_LICENSE_SERIAL: '' });

    const error = await activateLicense(ctx).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(LicenseError);
    expect(error).toMatchObject({ exitCode: 64 });
    expect((error as Error).message).toContain('UNITY_LICENSE_SERIAL');
    expect(mocks.runUnity).not.toHaveBeenCalled();
  });

  it('fails with exit 64 when the offline licence env var is missing', async () => {
    const error = await activateLicense(makeContext('offline-file')).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(LicenseError);
    expect(error).toMatchObject({ exitCode: 64 });
    expect((error as Error).message).toContain('UNITY_LICENSE_FILE_BASE64');
    expect(mocks.runUnity).not.toHaveBeenCalled();
  });

  it('turns an activation failure into exit 64', async () => {
    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      return failed(7, 'cannot reach the licensing service');
    });

    const code = await licenseActivateCommand(
      makeContext('serial', { UNITY_LICENSE_SERIAL: SERIAL }),
    );

    expect(code).toBe(64);
    expect(lines.join('')).toContain('cannot reach the licensing service');
  });

  it('never writes the serial into the log', async () => {
    mocks.runUnity.mockImplementation(async (options: UnityCall): Promise<FakeResult> => {
      record(options);
      // Unity may echo the value back; the core must mask it everywhere.
      return {
        code: 3,
        stdout: `serial ${SERIAL} rejected\n`,
        stderr: `activation refused for ${SERIAL}\n`,
        json: {
          success: false,
          errors: [{ code: 'LICENSE_INVALID', message: `serial ${SERIAL} rejected` }],
        },
      };
    });

    const code = await licenseActivateCommand(
      makeContext('serial', { UNITY_LICENSE_SERIAL: SERIAL }),
    );

    expect(code).toBe(64);
    const output = lines.join('');
    expect(output).not.toContain(SERIAL);
    expect(output).toContain('***');
  });
});

describe('returnLicense', () => {
  it('returns the license with --yes', async () => {
    const result = await returnLicense(makeContext('none'));

    expect(result).toEqual({ returned: true, code: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual(['license', 'return', '--yes', '--format', 'json']);
    // GC9: the teardown is bounded.
    expect(calls[0]!.timeoutMs).toBe(60_000);
  });

  it('swallows a return failure without changing the caller exit code', async () => {
    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      return failed(7, 'the licensing service is unreachable');
    });
    const ctx = makeContext('serial');

    // It reports the failure instead of throwing, so the run lifecycle can log
    // it and keep its own primary exit code (GC9).
    await expect(returnLicense(ctx)).resolves.toMatchObject({ returned: false, code: 7 });
    expect(lines.join('')).toMatch(/could not return the Unity license/i);
  });

  it('swallows a thrown return failure too', async () => {
    mocks.runUnity.mockRejectedValue(new Error('spawn exploded'));

    const result = await returnLicense(makeContext('none'));

    expect(result).toMatchObject({ returned: false, code: 6 });
    expect(lines.join('')).toContain('spawn exploded');
  });

  it('warns that an offline --file licence cannot be returned', async () => {
    const result = await returnLicense(makeContext('offline-file'));

    expect(result).toEqual({ returned: true, code: 0 });
    const output = lines.join('');
    expect(output).toMatch(/cannot be returned|leaks a seat/i);
    expect(output).toContain('reclaim');
  });

  it('exits 6 when the return call failed: the standalone command must be honest', async () => {
    mocks.runUnity.mockRejectedValue(new Error('boom'));

    const code = await licenseReturnCommand(makeContext('none'));

    expect(code).toBe(6);
    expect(lines.join('')).toMatch(/could not return the Unity license/i);
  });

  it('exits 6 when unity exits non-zero, and 0 when it succeeds', async () => {
    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      return failed(7, 'the licensing service is unreachable');
    });
    expect(await licenseReturnCommand(makeContext('none'))).toBe(6);

    mocks.runUnity.mockImplementation(async (options: UnityCall) => {
      record(options);
      return ok({});
    });
    expect(await licenseReturnCommand(makeContext('none'))).toBe(0);
  });
});

describe('licenseActivateCommand', () => {
  it('exits 0 and reports what it did', async () => {
    const code = await licenseActivateCommand(
      makeContext('serial', { UNITY_LICENSE_SERIAL: SERIAL }),
    );

    expect(code).toBe(0);
    expect(lines.join('')).toMatch(/activated/i);
  });

  it('exits 0 under mode none without calling the CLI', async () => {
    const code = await licenseActivateCommand(makeContext('none'));

    expect(code).toBe(0);
    expect(mocks.runUnity).not.toHaveBeenCalled();
    expect(lines.join('')).toMatch(/no activation/i);
  });
});
