import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The checker lives outside `core/` because it is provider-neutral (and because
 * an adapter repository would carry it verbatim). It is loaded through a
 * computed path so `tsc -p tsconfig.test.json` does not try to pull a file
 * outside `rootDir` into the core program.
 */
interface ConformanceResult {
  file: string;
  rule: string;
  ok: boolean;
  detail: string;
}

type CheckAdapter = (dir: string) => Promise<ConformanceResult[]>;

const checkerPath = fileURLToPath(
  new URL('../../testing/conformance/check-adapters.ts', import.meta.url),
);
const { checkAdapter } = (await import(checkerPath)) as {
  checkAdapter: CheckAdapter;
};

const tempDirs: string[] = [];

/** Writes a minimal adapter directory and returns its absolute path. */
function adapter(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-conformance-'));
  tempDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

function resultFor(
  results: ConformanceResult[],
  rule: string,
): ConformanceResult {
  const found = results.find((result) => result.rule === rule);
  expect(found, `expected a result for rule ${rule}`).toBeDefined();
  return found as ConformanceResult;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('adapter conformance', () => {
  it('the GitHub adapter satisfies every conformance rule', async () => {
    const results = await checkAdapter('adapters/github');
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.length).toBeGreaterThanOrEqual(10);
  });

  it('detects a retry loop added to an adapter', async () => {
    const dir = adapter({
      'workflow.yml': `name: ci-run
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run the tests
        run: |
          for attempt in 1 2 3; do unityci run test; done
`,
    });

    const results = await checkAdapter(dir);
    const result = resultFor(results, 'no-retry-logic');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('line 9');
  });

  it('detects a missing license-return teardown', async () => {
    const dir = adapter({
      'workflow.yml': `name: no-teardown
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Run the tests
        run: unityci run test --annotations github
`,
    });

    const results = await checkAdapter(dir);
    expect(resultFor(results, 'has-teardown').ok).toBe(false);
  });

  it('detects a license-return step that is not always()', async () => {
    const dir = adapter({
      'workflow.yml': `name: success-only-teardown
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Return the licence only on success
        if: success()
        run: unityci license return
`,
    });

    const results = await checkAdapter(dir);
    expect(resultFor(results, 'has-teardown').ok).toBe(false);
  });

  it('detects an upload step gated on the run result', async () => {
    const dir = adapter({
      'workflow.yml': `name: gated-upload
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Upload the output only when the run passed
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          path: ci-output
`,
    });

    const results = await checkAdapter(dir);
    expect(resultFor(results, 'publishes-on-zero-and-eight').ok).toBe(false);
  });

  it('detects a teardown that would fail the job', async () => {
    const dir = adapter({
      'workflow.yml': `name: failing-teardown
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Return the licence
        if: always()
        run: unityci license return
`,
    });

    const results = await checkAdapter(dir);
    expect(resultFor(results, 'has-teardown').ok).toBe(true);
    expect(resultFor(results, 'teardown-does-not-fail-the-job').ok).toBe(false);
  });

  it('detects an unpinned action', async () => {
    const dir = adapter({
      'workflow.yml': `name: unpinned
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@v4
        with:
          path: Library
          key: example
`,
    });

    const results = await checkAdapter(dir);
    const result = resultFor(results, 'pinned-actions');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('actions/cache@v4');
  });

  it('keeps the version comment next to a pinned SHA readable', async () => {
    const dir = adapter({
      'workflow.yml': `name: pinned
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0
        with:
          path: Library
          key: example
`,
    });

    const results = await checkAdapter(dir);
    expect(resultFor(results, 'pinned-actions').ok).toBe(true);
  });

  it('detects a credential passed to git config on a command line', async () => {
    const dir = adapter({
      'workflow.yml': `name: credential-on-argv
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Rewrite the URL
        run: git config --global url."https://x-access-token:\${{ inputs.git-token }}@github.com/".insteadOf https://github.com/
`,
    });

    const results = await checkAdapter(dir);
    const result = resultFor(results, 'no-credential-on-command-line');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('line 8');
  });

  it('detects GIT_CONFIG_GLOBAL', async () => {
    const dir = adapter({
      'workflow.yml': `name: global-config
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Point git at a throwaway file
        run: echo "GIT_CONFIG_GLOBAL=\$RUNNER_TEMP/gitconfig" >> "\$GITHUB_ENV"
`,
    });

    const results = await checkAdapter(dir);
    const result = resultFor(results, 'no-git-config-global-env');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('line 8');
  });

  it('detects a token used without being masked', async () => {
    const dir = adapter({
      'workflow.yml': `name: unmasked
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Fetch a package
        run: curl -H "Authorization: token \$UNITYCI_GIT_TOKEN" https://example.test
`,
    });

    const results = await checkAdapter(dir);
    const result = resultFor(results, 'masks-credentials');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('::add-mask::');
  });

  it('requires a mask for every credential, not just the first', async () => {
    const dir = adapter({
      'workflow.yml': `name: second-unmasked
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - name: Mask the package token
        run: echo "::add-mask::\$UNITYCI_GIT_TOKEN"
      - name: Use both credentials
        run: |
          curl -H "Authorization: token \$UNITYCI_GIT_TOKEN" https://example.test
          curl -H "X-License: \$UNITY_LICENSE_SERIAL" https://example.test
`,
    });

    const results = await checkAdapter(dir);
    const result = resultFor(results, 'masks-credentials');
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('UNITY_LICENSE_SERIAL');
  });

  it('ignores a bare unity mention inside a comment', async () => {
    const dir = adapter({
      'workflow.yml': `name: commented
on: workflow_dispatch
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      # Do not call unity directly; unity version would bypass the core.
      - name: Run the tests
        run: unityci run test --annotations github
`,
    });

    const results = await checkAdapter(dir);
    expect(resultFor(results, 'calls-unityci').ok).toBe(true);
  });
});
