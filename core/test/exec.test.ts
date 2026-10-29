import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../src/exit-codes.js';
import { killAllChildren, spawnProcess } from '../src/exec.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';

/**
 * The registry of live children exists so a signal handler can kill an
 * in-flight Unity tree before returning the licence seat. These tests cover the
 * two halves that matter: a live tree really dies, and a child that already
 * exited is never signalled again (on Windows a dead pid can be recycled).
 */

const CWD = process.cwd();
const tempDirs: string[] = [];

function harness(): {
  logger: ReturnType<typeof createLogger>;
  redactor: ReturnType<typeof createRedactor>;
} {
  const redactor = createRedactor();
  const logger = createLogger({
    redactor,
    level: 'debug',
    sink: () => {
      // Silence: the assertions here are about processes, not log lines.
    },
  });
  return { logger, redactor };
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-exec-registry-'));
  tempDirs.push(dir);
  return dir;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isAlive(pid);
}

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readFileSync(path, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${path}`);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('killAllChildren', () => {
  it('kills a live child and its whole tree', async () => {
    const pidFile = join(tempDir(), 'pids.json');
    const script = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      fs.writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({
        child: process.pid,
        grandchild: grandchild.pid,
      }));
      setInterval(() => {}, 1000);
    `;

    const { logger, redactor } = harness();
    const pending = spawnProcess({
      file: process.execPath,
      args: ['-e', script],
      cwd: CWD,
      env: {},
      logger,
      redactor,
    });

    let childPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const pids = JSON.parse(await waitForFile(pidFile, 15000)) as {
        child: number;
        grandchild: number;
      };
      childPid = pids.child;
      grandchildPid = pids.grandchild;
      expect(Number.isInteger(childPid)).toBe(true);
      expect(Number.isInteger(grandchildPid)).toBe(true);

      killAllChildren();
      // Re-entrant and safe: a second signal must not signal an already-killed
      // pid a second time.
      killAllChildren();

      const result = await pending;
      // Killed by a signal (or taskkill): not the timeout code, because no
      // timeout was configured.
      expect(result.code).toBe(EXIT.ERROR);

      await expect(waitForDeath(childPid, 10000)).resolves.toBe(true);
      await expect(waitForDeath(grandchildPid, 10000)).resolves.toBe(true);
    } finally {
      for (const pid of [grandchildPid, childPid]) {
        if (pid === undefined) continue;
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already dead, which is the expected outcome.
        }
      }
    }
  });

  it('is a no-op with nothing in flight', () => {
    expect(() => {
      killAllChildren();
      killAllChildren();
    }).not.toThrow();
  });

  describe('with a mocked spawn', () => {
    interface FakeChild extends EventEmitter {
      stdout: PassThrough;
      stderr: PassThrough;
      pid: number;
      exitCode: number | null;
      killed: boolean;
      kill: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    }

    function fakeChild(): FakeChild {
      const child = new EventEmitter() as FakeChild;
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.pid = 4242;
      child.exitCode = null;
      child.killed = false;
      child.kill = vi.fn();
      child.unref = vi.fn();
      return child;
    }

    async function withMockedSpawn(
      child: FakeChild,
      body: (tools: {
        spawnMock: ReturnType<typeof vi.fn>;
        spawnProcess: typeof spawnProcess;
        killAllChildren: typeof killAllChildren;
      }) => Promise<void>,
    ): Promise<void> {
      const spawnMock = vi.fn(
        (_file: string, _args: string[], _options: Record<string, unknown>) => child,
      );

      vi.resetModules();
      vi.doMock('node:child_process', () => ({ spawn: spawnMock }));
      try {
        const exec = await import('../src/exec.js');
        await body({
          spawnMock,
          spawnProcess: exec.spawnProcess,
          killAllChildren: exec.killAllChildren,
        });
      } finally {
        vi.doUnmock('node:child_process');
        vi.resetModules();
      }
    }

    it('does not signal a child that has already exited', async () => {
      const child = fakeChild();
      const killSpy = vi.spyOn(process, 'kill');

      await withMockedSpawn(child, async (exec) => {
        const { logger, redactor } = harness();
        const pending = exec.spawnProcess({
          file: 'unity',
          args: ['test'],
          cwd: CWD,
          env: {},
          logger,
          redactor,
        });

        // A normal exit: `close` fires, the promise settles, and the child must
        // leave the registry.
        child.emit('close', 0, null);
        await expect(pending).resolves.toMatchObject({ code: 0 });

        killSpy.mockClear();
        exec.killAllChildren();

        // No second spawn (Windows `taskkill`) and no group signal (POSIX).
        expect(exec.spawnMock).toHaveBeenCalledTimes(1);
        expect(killSpy).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();
      });
    });

    it('does not signal a child that is already marked killed', async () => {
      const child = fakeChild();
      child.killed = true;
      const killSpy = vi.spyOn(process, 'kill');

      await withMockedSpawn(child, async (exec) => {
        const { logger, redactor } = harness();
        const pending = exec.spawnProcess({
          file: 'unity',
          args: ['test'],
          cwd: CWD,
          env: {},
          logger,
          redactor,
        });

        exec.killAllChildren();

        expect(exec.spawnMock).toHaveBeenCalledTimes(1);
        expect(killSpy).not.toHaveBeenCalled();
        expect(child.kill).not.toHaveBeenCalled();

        // Let the pending call settle so the test leaves nothing behind.
        child.emit('close', 0, null);
        await pending;
      });
    });
  });
});
