import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cacheInfo,
  cacheInfoCommand,
  type CacheInfo,
} from '../src/commands/cache-info.js';
import { DEFAULT_CONFIG, type Config } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

/**
 * Every `unity` call goes through `runUnity`; mocking at that seam keeps the
 * CLI wrappers (and therefore the `--format json` placement) under test.
 */
const mocks = vi.hoisted(() => ({ runUnity: vi.fn() }));

vi.mock('../src/unity/exec.js', () => ({ runUnity: mocks.runUnity }));

const DOWNLOAD_PATH = 'C:\\Users\\example\\AppData\\Roaming\\UnityHub\\downloads';
const EDITOR_VERSION = '6000.3.7f1';
const TARGET = 'StandaloneWindows64';
const CACHE_KEY = 'observed-library-cache-key';

interface CallResult {
  data?: unknown;
  code?: number;
  success?: boolean;
  /** Replaces the whole envelope, for an unparsable or missing document. */
  json?: unknown;
  stderr?: string;
}

interface Scenario {
  info?: CallResult;
  key?: CallResult;
}

const tempDirs: string[] = [];
const lines: string[] = [];
const calls: string[][] = [];
let scenario: Scenario = {};

function envelope(
  data: unknown,
  code = 0,
  success = true,
  stderr = '',
): { code: number; stdout: string; stderr: string; json: unknown } {
  return { code, stdout: '', stderr, json: { success, data } };
}

function responder(args: string[]) {
  if (args[0] === 'cache' && args[1] === 'info') {
    const result = scenario.info;
    if (result?.json !== undefined) {
      return { code: result.code ?? 0, stdout: '', stderr: result.stderr ?? '', json: result.json };
    }
    return envelope(
      result?.data ?? { path: DOWNLOAD_PATH },
      result?.code ?? 0,
      result?.success ?? true,
      result?.stderr ?? '',
    );
  }
  if (args[0] === 'cache' && args[1] === 'key') {
    const result = scenario.key;
    if (result?.json !== undefined) {
      return { code: result.code ?? 0, stdout: '', stderr: result.stderr ?? '', json: result.json };
    }
    return envelope(
      result?.data ?? { key: CACHE_KEY },
      result?.code ?? 0,
      result?.success ?? true,
      result?.stderr ?? '',
    );
  }
  return envelope({});
}

function makeProject(editorVersion: string | null = EDITOR_VERSION): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-cache-'));
  tempDirs.push(dir);
  if (editorVersion !== null) {
    mkdirSync(join(dir, 'ProjectSettings'), { recursive: true });
    writeFileSync(
      join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
      `m_EditorVersion: ${editorVersion}\n`,
      'utf8',
    );
  }
  return dir;
}

function makeContext(projectPath: string, edit?: (config: Config) => void): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  config.build.target = TARGET;
  edit?.(config);
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
    cwd: projectPath,
    projectPath,
    env: {},
    logger,
    redactor,
    binary: 'unity',
    startedAt: Date.now(),
    cliVersion: null,
    cliChannel: null,
    cliCommit: null,
  };
}

beforeEach(() => {
  scenario = {};
  lines.length = 0;
  calls.length = 0;
  mocks.runUnity.mockReset();
  mocks.runUnity.mockImplementation(async (options: { args: string[] }) => {
    calls.push(options.args);
    return responder(options.args);
  });
});

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe('cacheInfo', () => {
  it('reports the download cache path from unity cache info', async () => {
    const project = makeProject();

    const info = await cacheInfo(makeContext(project));

    expect(info.editor.paths).toContain(DOWNLOAD_PATH);
    expect(info.editor.key).toBe(`unity-downloads-${EDITOR_VERSION}`);
    // The wrapper owns `--format json`; the command must not append its own.
    expect(calls[0]).toEqual(['cache', 'info', '--format', 'json']);
  });

  it('reports the library cache key from unity cache key', async () => {
    const project = makeProject();
    scenario.key = { data: { key: CACHE_KEY } };

    const info = await cacheInfo(makeContext(project));

    expect(info.library.key).toBe(CACHE_KEY);
    expect(calls[1]).toEqual([
      'cache',
      'key',
      project,
      '--target',
      TARGET,
      '--format',
      'json',
    ]);
  });

  it('reports a static library key made of the editor version and target', async () => {
    const project = makeProject();

    const info = await cacheInfo(makeContext(project));

    expect(info.library.staticKey).toBe(`unity-library-${EDITOR_VERSION}-${TARGET}`);
  });

  it('reports the library path inside the project', async () => {
    const project = makeProject();

    const info = await cacheInfo(makeContext(project));

    expect(info.library.paths).toEqual([join(project, 'Library')]);
  });

  it('uses the configured editor version without reading ProjectVersion.txt', async () => {
    const project = makeProject(null);
    const ctx = makeContext(project, (config) => {
      config.unity.editor.version = '2022.3.1f1';
    });

    const info = await cacheInfo(ctx);

    expect(info.editor.key).toBe('unity-downloads-2022.3.1f1');
    expect(info.library.staticKey).toBe(`unity-library-2022.3.1f1-${TARGET}`);
  });

  it('uses an unknown marker instead of an empty editor segment', async () => {
    const project = makeProject(null);

    const info = await cacheInfo(makeContext(project));

    expect(info.editor.key).toBe('unity-downloads-unknown');
    expect(info.library.staticKey).toBe(`unity-library-unknown-${TARGET}`);
    expect(lines.join('')).toContain('could not resolve the Unity Editor version');
  });
});

describe('cacheInfoCommand', () => {
  it('prints valid JSON when --json is passed', async () => {
    const project = makeProject();
    scenario.key = { data: { key: CACHE_KEY } };
    const ctx = makeContext(project);

    const code = await cacheInfoCommand(ctx, { json: true });

    expect(code).toBe(0);
    const output = lines.join('');
    // Two-space indentation and a trailing newline: a provider can pipe it.
    expect(output).toContain('\n  "editor"');
    expect(output.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(output) as CacheInfo;
    expect(parsed).toEqual({
      editor: {
        paths: [DOWNLOAD_PATH],
        key: `unity-downloads-${EDITOR_VERSION}`,
      },
      library: {
        paths: [join(project, 'Library')],
        key: CACHE_KEY,
        staticKey: `unity-library-${EDITOR_VERSION}-${TARGET}`,
      },
    });
  });

  it('prints a labelled human summary without --json', async () => {
    const project = makeProject();

    const code = await cacheInfoCommand(makeContext(project));

    expect(code).toBe(0);
    const output = lines.join('');
    expect(output).toContain('editor');
    expect(output).toContain(DOWNLOAD_PATH);
    expect(output).toContain('library');
    expect(output).toContain(join(project, 'Library'));
    expect(() => JSON.parse(output)).toThrow();
  });

  it('falls back to the static key when unity cache key reports NOT_A_PROJECT', async () => {
    const project = makeProject();
    scenario.key = {
      code: 11,
      success: false,
      json: {
        success: false,
        errors: [
          {
            code: 'NOT_A_PROJECT',
            message: `No Unity project at ${project}. Expected to find ProjectSettings\\ProjectVersion.txt.`,
          },
        ],
      },
    };
    const ctx = makeContext(project);

    const info = await cacheInfo(ctx);
    const code = await cacheInfoCommand(ctx);

    expect(code).toBe(0);
    expect(info.library.key).toBe(info.library.staticKey);
    expect(lines.join('')).toContain('NOT_A_PROJECT');
    expect(lines.join('')).toContain(info.library.staticKey);
  });

  it('accepts a cache key payload that is a bare string', async () => {
    const project = makeProject();
    scenario.key = { data: 'bare-string-key' };

    const info = await cacheInfo(makeContext(project));

    expect(info.library.key).toBe('bare-string-key');
  });

  it('accepts a cache key payload that carries the three components', async () => {
    const project = makeProject();
    scenario.key = { data: { editor: 'editor-part', packages: 'packages-part', target: 'target-part' } };

    const info = await cacheInfo(makeContext(project));

    expect(info.library.key).toBe('editor-part-packages-part-target-part');
  });

  it('never fails the command when the cache calls fail', async () => {
    const project = makeProject();
    scenario.info = {
      code: 6,
      success: false,
      stderr: 'could not read the download cache',
      json: {
        success: false,
        errors: [{ code: 'CACHE_INFO_FAILED', message: 'could not read the download cache' }],
      },
    };
    scenario.key = { code: 6, json: null };
    const ctx = makeContext(project);

    const info = await cacheInfo(ctx);
    const code = await cacheInfoCommand(ctx);

    expect(code).toBe(0);
    // Both hints degrade rather than invent a value: no known path, and the
    // static key instead of an unknown CLI key.
    expect(info.editor.paths).toEqual([]);
    expect(info.library.key).toBe(info.library.staticKey);
    expect(info.library.key).toBe(`unity-library-${EDITOR_VERSION}-${TARGET}`);
    expect(lines.join('')).toContain('could not read the Unity download cache path');
    expect(lines.join('')).toContain('could not compute the Library cache key');
  });

  it('falls back when the cache key document is unparsable', async () => {
    const project = makeProject();
    scenario.key = { code: 0, json: null };

    const info = await cacheInfo(makeContext(project));

    expect(info.library.key).toBe(info.library.staticKey);
    expect(lines.join('')).toContain('could not compute the Library cache key');
  });
});
