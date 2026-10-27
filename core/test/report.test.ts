import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportCommand } from '../src/commands/report.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import type { CoreContext } from '../src/context.js';
import { createLogger } from '../src/logger.js';
import { createRedactor } from '../src/redact.js';
import { emitAnnotations } from '../src/report/annotations.js';
import { nunitToJUnit } from '../src/report/junit.js';
import { ReportParseError, parseNFailures, parseNUnit } from '../src/report/nunit.js';
import { buildSummary, deriveStatus, writeSummary } from '../src/report/summary.js';

const PASS_FIXTURE = readFileSync(
  new URL('./fixtures/editmode-pass.xml', import.meta.url),
  'utf8',
);
const FAIL_FIXTURE = readFileSync(
  new URL('./fixtures/editmode-fail.xml', import.meta.url),
  'utf8',
);

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'unityci-report-'));
  tempDirs.push(dir);
  return dir;
}

function makeContext(env: NodeJS.ProcessEnv = {}, projectPath = process.cwd()): CoreContext {
  const config = structuredClone(DEFAULT_CONFIG);
  const redactor = createRedactor();
  const logger = createLogger({ redactor, level: 'debug', sink: () => undefined });
  return {
    config,
    cwd: projectPath,
    projectPath,
    env,
    logger,
    redactor,
    binary: 'unity',
    startedAt: Date.now(),
    cliVersion: '1.0.0-beta.14',
    cliChannel: 'beta',
    cliCommit: 'abc1234',
  };
}

/**
 * A project laid out the way `run test` leaves it: an NUnit file at
 * `<test.outputDir>/<mode>.xml` and `summary.json` under `<output.dir>`.
 */
function reportProject(
  fixture: string = FAIL_FIXTURE,
): { ctx: CoreContext; root: string; testDir: string } {
  const root = tempDir();
  const ctx = makeContext({}, root);
  ctx.config.output.dir = 'ci-output';
  ctx.config.test.outputDir = 'ci-output/tests';
  const testDir = join(root, 'ci-output', 'tests');
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'EditMode.xml'), fixture);
  return { ctx, root, testDir };
}

function captureStdout(): { text: () => string; spy: ReturnType<typeof vi.spyOn> } {
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  return {
    spy,
    text: () => spy.mock.calls.map((call) => String(call[0])).join(''),
  };
}

beforeEach(() => {
  delete process.env.GITHUB_STEP_SUMMARY;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('NUnit parsing', () => {
  it('counts total, passed, failed and skipped from NUnit XML', () => {
    expect(parseNUnit(PASS_FIXTURE)).toEqual({ total: 3, passed: 2, failed: 0, skipped: 1 });
    expect(parseNUnit(FAIL_FIXTURE)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });

    // Attributes in any order, single- and double-quoted values, self-closing
    // elements, nested suites and entities in an attribute value.
    const shapes = `<?xml version='1.0' encoding="utf-8"?>
      <test-run passed='2' failed="1" total='3' inconclusive="0" skipped='0' testcasecount="3">
        <test-suite name='Outer'>
          <test-suite name="Inner &amp; Fixture">
            <test-case name="a" result="Passed" duration="0.001" />
            <test-case result='Passed' name='b' />
            <test-case name='c &lt;odd&gt;' result='Failed'>
              <failure><message>x &amp; y</message><stack-trace>at T () in C:\\src\\T.cs:7</stack-trace></failure>
            </test-case>
          </test-suite>
        </test-suite>
      </test-run>`;
    expect(parseNUnit(shapes)).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0 });

    // No root counts: walk <test-case> elements. Inconclusive counts as skipped.
    const walked = `<test-run><test-suite>
      <test-case result="Passed" />
      <test-case result="Failed" />
      <test-case result="Skipped" />
      <test-case result="Inconclusive" />
    </test-suite></test-run>`;
    expect(parseNUnit(walked)).toEqual({ total: 4, passed: 1, failed: 1, skipped: 2 });

    // The older NUnit 2 root is tolerated.
    const nunit2 = `<test-results total="2" failures="1">
      <test-suite>
        <test-case result="Passed" />
        <test-case result="Failed" />
      </test-suite>
    </test-results>`;
    expect(parseNUnit(nunit2)).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
  });

  it('extracts failure names, messages and stacks', () => {
    expect(parseNFailures(FAIL_FIXTURE)).toEqual([
      {
        name: 'Fails<badly>',
        message: 'Expected 2 but was 3\r\nAmpersand & and <angle>\nlast',
        stack:
          'at Game.Tests.BrokenTests.Fails () [0x00000] in /repo/Assets/Tests/BrokenTests.cs:42',
      },
    ]);
    expect(parseNFailures(PASS_FIXTURE)).toEqual([]);

    // Every standard entity and both numeric forms is decoded on input.
    const entities = `<test-run><test-suite><test-case name="e" result="Failed">
      <failure>
        <message>&lt;x&gt; &amp; &quot;q&quot; &apos;a&apos; &#13;&#10;&#xA;end</message>
        <stack-trace>s</stack-trace>
      </failure>
    </test-case></test-suite></test-run>`;
    expect(parseNFailures(entities)).toEqual([
      { name: 'e', message: '<x> & "q" \'a\' \r\n\nend', stack: 's' },
    ]);
  });
});

describe('JUnit conversion', () => {
  it('converts NUnit XML into JUnit XML with one testcase per test', () => {
    const junit = nunitToJUnit(FAIL_FIXTURE);
    expect(junit.startsWith('<?xml')).toBe(true);
    expect(junit).toContain('<testsuites');
    expect(junit.split('<testcase ').length - 1).toBe(2);
    expect(junit).toContain('<testcase classname="Game.Tests.BrokenTests" name="Passes"');
    expect(junit).toContain('time="0.002"');
    expect(junit).toContain('<failure');
    // Failure text is escaped on output, so the document stays parseable.
    expect(junit).toContain('Ampersand &amp; and &lt;angle&gt;');
    expect(junit).not.toContain('<angle>');

    const passing = nunitToJUnit(PASS_FIXTURE);
    expect(passing.split('<testcase ').length - 1).toBe(3);
    expect(passing).toContain('<skipped');
    expect(passing).toContain('classname="Game.Tests.MathTests"');

    // Quotes are escaped too: an attribute value must not terminate the
    // attribute, and the document must stay parseable.
    const quoted = nunitToJUnit(`<test-run><test-suite name="S"><test-case name="q" result="Failed">
      <failure><message>say &quot;hi&quot; &amp; &lt;bye&gt;</message><stack-trace>a &quot;b&quot;</stack-trace></failure>
    </test-case></test-suite></test-run>`);
    expect(quoted).toContain('say &quot;hi&quot; &amp; &lt;bye&gt;');
    expect(quoted).toContain('a &quot;b&quot;');
  });

  it('keeps the original NUnit file untouched when converting', async () => {
    const { ctx, testDir } = reportProject();
    const nunitPath = join(testDir, 'EditMode.xml');
    const original = readFileSync(nunitPath);

    const code = await reportCommand(ctx);

    expect(code).toBe(0);
    expect(readFileSync(nunitPath).equals(original)).toBe(true);
    const junitPath = join(testDir, 'EditMode.junit.xml');
    expect(existsSync(junitPath)).toBe(true);
    expect(readFileSync(junitPath, 'utf8')).toContain('<testsuites');
  });

  it('only converts when the JUnit sibling is missing and never overwrites it', async () => {
    const { ctx, testDir } = reportProject();
    const nunitPath = join(testDir, 'EditMode.xml');
    const junitPath = join(testDir, 'EditMode.junit.xml');
    const originalNunit = readFileSync(nunitPath);
    // What Unity's own converter wrote is authoritative (D8).
    const unityJunit = Buffer.from(
      '<?xml version="1.0"?><testsuites><!-- written by Unity --></testsuites>\n',
    );
    writeFileSync(junitPath, unityJunit);

    expect(await reportCommand(ctx)).toBe(0);
    expect(readFileSync(junitPath).equals(unityJunit)).toBe(true);
    expect(readFileSync(nunitPath).equals(originalNunit)).toBe(true);

    // With no JUnit sibling present, the core's fallback writes one.
    rmSync(junitPath);
    expect(await reportCommand(ctx)).toBe(0);
    expect(existsSync(junitPath)).toBe(true);
    expect(readFileSync(junitPath, 'utf8')).toContain('<testsuites');
  });
});

describe('summary.json', () => {
  it('writes summary.json with schema 1 and the documented keys', () => {
    const dir = tempDir();
    const summary = buildSummary({
      command: 'test',
      status: 'passed',
      exitCode: 0,
      tests: { total: 2, passed: 1, failed: 1, skipped: 0 },
      reports: { nunit: ['tests/EditMode.xml'], junit: ['tests/EditMode.junit.xml'] },
    });
    writeSummary(dir, summary);

    const text = readFileSync(join(dir, 'summary.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "schema": 1,');

    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      [
        'artifacts',
        'attempts',
        'cliChannel',
        'cliCommit',
        'cliVersion',
        'command',
        'durationMs',
        'editorVersion',
        'exitCode',
        'license',
        'logs',
        'reports',
        'schema',
        'status',
        'tests',
        'unityExitCode',
      ].sort(),
    );
    expect(parsed.schema).toBe(1);
    expect(parsed.tests).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 });
    expect(Object.keys(parsed.reports as object).sort()).toEqual(['junit', 'nunit']);
    expect(Object.keys(parsed.license as object).sort()).toEqual([
      'activated',
      'mode',
      'returned',
      'seatLeaked',
    ]);
    expect(Object.keys(parsed.logs as object).sort()).toEqual(['cli', 'editor']);
  });

  it('derives status from the exit code', () => {
    expect(deriveStatus(0)).toBe('passed');
    expect(deriveStatus(8)).toBe('tests_failed');
    expect(deriveStatus(64)).toBe('config_error');
    expect(deriveStatus(6)).toBe('infra_failed');
    expect(deriveStatus(65)).toBe('infra_failed');
  });

  it('records the CLI version, channel and commit', async () => {
    const { ctx, root } = reportProject(PASS_FIXTURE);
    ctx.cliVersion = '1.0.0-beta.14';
    ctx.cliChannel = 'beta';
    ctx.cliCommit = 'deadbee';

    expect(await reportCommand(ctx)).toBe(0);

    const summary = JSON.parse(
      readFileSync(join(root, 'ci-output', 'summary.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(summary.cliVersion).toBe('1.0.0-beta.14');
    expect(summary.cliChannel).toBe('beta');
    expect(summary.cliCommit).toBe('deadbee');
    expect(summary.command).toBe('test');
    expect(summary.status).toBe('passed');
    expect(summary.tests).toEqual({ total: 3, passed: 2, failed: 0, skipped: 1 });
  });
});

describe('annotations', () => {
  it('emits a GitHub annotation per failed test when annotations is github', () => {
    const ctx = makeContext();
    ctx.config.output.annotations = 'github';
    const failures = parseNFailures(FAIL_FIXTURE);
    const stdout = captureStdout();

    emitAnnotations(ctx, failures);

    expect(stdout.text()).toContain(
      '::error file=/repo/Assets/Tests/BrokenTests.cs,line=42::Fails<badly> — ' +
        'Expected 2 but was 3 Ampersand & and <angle> last',
    );
    expect(stdout.text().split('::error ').length - 1).toBe(1);
  });

  it('emits nothing when annotations is none', () => {
    const ctx = makeContext();
    ctx.config.output.annotations = 'none';
    const stdout = captureStdout();

    emitAnnotations(ctx, parseNFailures(FAIL_FIXTURE));

    expect(stdout.spy).not.toHaveBeenCalled();
  });

  it('writes to $GITHUB_STEP_SUMMARY when it is set', () => {
    const dir = tempDir();
    const summaryPath = join(dir, 'step-summary.md');
    const ctx = makeContext({ GITHUB_STEP_SUMMARY: summaryPath });
    ctx.config.output.annotations = 'github';
    captureStdout();

    emitAnnotations(ctx, parseNFailures(FAIL_FIXTURE));

    const text = readFileSync(summaryPath, 'utf8');
    expect(text).toContain('### Unity test failures');
    expect(text).toContain('Fails&lt;badly&gt;');
    expect(text).toContain('Expected 2 but was 3');
  });

  it('redacts a secret that appears in a failure message', () => {
    const dir = tempDir();
    const summaryPath = join(dir, 'step-summary.md');
    const ctx = makeContext({ GITHUB_STEP_SUMMARY: summaryPath });
    ctx.config.output.annotations = 'github';
    ctx.redactor.register('s3cr3t-token');
    const stdout = captureStdout();

    emitAnnotations(ctx, [
      {
        name: 'LeaksASecret',
        message: 'the token s3cr3t-token must never be printed',
        stack: 'at Game.Tests.SecretTests.LeaksASecret () in /repo/Assets/Tests/SecretTests.cs:9',
      },
    ]);

    expect(stdout.text()).toContain('***');
    expect(stdout.text()).not.toContain('s3cr3t-token');
    expect(readFileSync(summaryPath, 'utf8')).not.toContain('s3cr3t-token');
  });
});

describe('report command', () => {
  it('redacts a secret in the JUnit file it writes', async () => {
    const secret = 's3cr3t-token';
    const xml = `<test-run total="1" passed="0" failed="1" skipped="0" inconclusive="0">
      <test-suite name="SecretTests">
        <test-case name="Leaks" fullname="Game.Tests.SecretTests.Leaks" classname="Game.Tests.SecretTests" result="Failed" duration="0.001">
          <failure>
            <message>the token ${secret} must never reach the artifact</message>
            <stack-trace>at Game.Tests.SecretTests.Leaks () in /repo/Assets/Tests/SecretTests.cs:9</stack-trace>
          </failure>
        </test-case>
      </test-suite>
    </test-run>`;
    const { ctx, testDir } = reportProject(xml);
    ctx.redactor.register(secret);

    expect(await reportCommand(ctx)).toBe(0);

    // nunitToJUnit stays pure; reportCommand redacts at the write boundary.
    const junit = readFileSync(join(testDir, 'EditMode.junit.xml'), 'utf8');
    expect(junit).toContain('***');
    expect(junit).not.toContain(secret);
  });

  it('throws a typed error when the NUnit XML cannot be parsed', async () => {
    const malformed = '<test-run total="1"';

    expect(() => parseNUnit(malformed)).toThrow(ReportParseError);
    expect(() => parseNFailures(malformed)).toThrow(ReportParseError);
    expect(() => nunitToJUnit(malformed)).toThrow(ReportParseError);

    // The caller maps the typed error to exit 65 (GC7), never a zero-count pass.
    const { ctx, testDir } = reportProject(malformed);
    expect(await reportCommand(ctx)).toBe(65);
    expect(existsSync(join(testDir, 'EditMode.junit.xml'))).toBe(false);
  });
});
