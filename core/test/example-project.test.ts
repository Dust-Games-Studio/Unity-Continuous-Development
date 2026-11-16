import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../src/config/load.js';

/**
 * The repository's own acceptance fixture: a real Unity project the toolkit is
 * validated against end to end. These checks are static — they prove the
 * project is complete enough to run, without launching an Editor in the unit
 * suite (that is the manual Step 5 run).
 *
 * The project is pinned to an Editor version installed on the reference
 * machine, so `unity test` never downloads gigabytes mid-run.
 */
const projectRoot = fileURLToPath(new URL('../../examples/minimal-project', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const PINNED_EDITOR_VERSION = '6000.6.6f1';

/** Reads a repository-relative text file. */
function readRepo(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/** Parses a repository YAML file (workflow, action) into a plain object. */
function parseRepoYaml(relativePath: string): Record<string, unknown> {
  return parse(readRepo(relativePath)) as Record<string, unknown>;
}

/**
 * The `on:` triggers of a workflow. YAML 1.1 parsers turn the bare key `on`
 * into a boolean, so both spellings are accepted even though `yaml`'s default
 * schema keeps it as a string.
 */
function workflowTriggers(document: Record<string, unknown>): unknown {
  return document.on ?? document['true'];
}

function hasTrigger(triggers: unknown, name: string): boolean {
  if (triggers === null || triggers === undefined) return false;
  if (typeof triggers === 'string') return triggers === name;
  if (Array.isArray(triggers)) return triggers.includes(name);
  if (typeof triggers === 'object') return (triggers as Record<string, unknown>)[name] !== undefined;
  return false;
}

interface ActionStep {
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

function actionSteps(): ActionStep[] {
  const document = parseRepoYaml('adapters/github/action.yml');
  const runs = document.runs as { steps?: ActionStep[] } | undefined;
  return runs?.steps ?? [];
}

/**
 * Asserts that every `export UNITYCI_<config>` in a shell script is inside a
 * non-empty (`[ -n … ]`) guard. The core applies environment variables after the
 * config file, so an unconditional export of an empty default silently replaces
 * the project's `unity-ci.yml` value.
 */
function expectGuardedExports(script: string, label: string): void {
  const guards: boolean[] = [];

  for (const line of script.split(/\r?\n/)) {
    const exported = /\bexport\s+(UNITYCI_[A-Z0-9_]+)=/.exec(line);
    if (exported !== null) {
      const inlineGuard =
        /^\s*if\s+\[\s+-n\s+/.test(line) && /\bfi\s*$/.test(line);
      const guarded = inlineGuard || (guards.length > 0 && guards[guards.length - 1] === true);
      expect(
        guarded,
        `${label}: unconditional export of ${exported[1]}: ${line.trim()}`,
      ).toBe(true);
      continue;
    }

    if (/^\s*if\b/.test(line)) {
      // A one-line `if …; then …; fi` opens and closes in place.
      if (/\bfi\b/.test(line)) continue;
      // Only `[ -n … ]` proves a value is present; `-z`, `[[ … ]]`, etc. do not.
      guards.push(/\[\s+-n\s+/.test(line));
    } else if (/^\s*fi\b/.test(line)) {
      guards.pop();
    }
  }
}

function readText(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string): T {
  return JSON.parse(readText(relativePath)) as T;
}

interface PackageManifest {
  dependencies?: Record<string, string>;
}

interface AssemblyDefinition {
  name?: string;
  references?: string[];
  includePlatforms?: string[];
  testAssemblies?: boolean;
}

describe('the example Unity project', () => {
  it('the example project exists and names its Editor version', () => {
    const versionFile = join(projectRoot, 'ProjectSettings', 'ProjectVersion.txt');
    expect(existsSync(versionFile), `missing ${versionFile}`).toBe(true);

    const text = readText('ProjectSettings/ProjectVersion.txt');
    const match = /^m_EditorVersion:\s*(\S+)\s*$/m.exec(text);
    expect(match, 'ProjectVersion.txt must contain m_EditorVersion').not.toBeNull();
    expect(match?.[1]).toBe(PINNED_EDITOR_VERSION);

    // The newline-terminated ProjectSettings entry is what Unity writes; a
    // project whose stamp is absent or guessed is not reproducible.
    expect(existsSync(join(projectRoot, 'ProjectSettings', 'ProjectSettings.asset'))).toBe(true);
  });

  it('the example project does not depend on com.unity.pipeline', () => {
    const manifest = readJson<PackageManifest>('Packages/manifest.json');
    const dependencies = manifest.dependencies ?? {};
    expect(typeof dependencies).toBe('object');

    const pipeline = Object.keys(dependencies).filter(
      (name) => name === 'com.unity.pipeline' || name.startsWith('com.unity.pipeline.'),
    );
    expect(pipeline, 'the example must prove S7: no com.unity.pipeline dependency').toEqual([]);
  });

  it('the example project has an EditMode test assembly with at least one test', () => {
    const asmdefPath = join(
      projectRoot,
      'Assets',
      'Tests',
      'EditMode',
      'DustGames.Minimal.Tests.asmdef',
    );
    expect(existsSync(asmdefPath), `missing ${asmdefPath}`).toBe(true);

    const asmdef = readJson<AssemblyDefinition>(
      'Assets/Tests/EditMode/DustGames.Minimal.Tests.asmdef',
    );
    expect(asmdef.name).toBe('DustGames.Minimal.Tests');
    expect(asmdef.testAssemblies).toBe(true);
    expect(asmdef.includePlatforms).toEqual(['Editor']);
    expect(asmdef.references).toEqual(
      expect.arrayContaining(['UnityEngine.TestRunner', 'UnityEditor.TestRunner']),
    );

    // At least one file in the assembly directory carries an NUnit test. The
    // Test Framework only collects a test that lives in a `[TestFixture]` (or
    // an implicit one); a stray `[Test]` in a non-test assembly is inert.
    const testDir = join(projectRoot, 'Assets', 'Tests', 'EditMode');
    const sources = readdirSync(testDir).filter((name) => name.endsWith('.cs'));
    const tests = sources.filter((name) => /\[Test\]/.test(readFileSync(join(testDir, name), 'utf8')));
    expect(tests.length, 'expected at least one source file with [Test]').toBeGreaterThan(0);
  });

  it('the example project has a static build method', () => {
    const builderPath = join(projectRoot, 'Assets', 'Editor', 'Builder.cs');
    expect(existsSync(builderPath), `missing ${builderPath}`).toBe(true);

    const source = readText('Assets/Editor/Builder.cs');
    expect(source).toMatch(/public\s+static\s+void\s+PerformBuild\s*\(\s*\)/);
    expect(source).toContain('BuildPipeline.BuildPlayer');
    // `unity build --output` forwards its value as `-buildOutput`; a
    // builder that ignored it would write somewhere the toolkit never reads.
    expect(source).toContain('-buildOutput');
    // A build method that returns quietly on failure is a false green.
    expect(source).toMatch(/throw\s+new\s+/);
  });

  it('the example config sets the output dir and the test modes', () => {
    const configPath = join(projectRoot, 'unity-ci.yml');
    expect(existsSync(configPath), `missing ${configPath}`).toBe(true);

    const document = parse(readText('unity-ci.yml')) as {
      test?: { modes?: unknown };
      build?: { target?: unknown };
      output?: { dir?: unknown };
    };
    expect(document.test?.modes).toEqual(['EditMode']);
    expect(document.build?.target).toBe('StandaloneWindows64');
    expect(document.output?.dir).toBe('ci-output');

    // The file must survive the same merge and validation a real run performs.
    const loaded = loadConfig({ projectPath: projectRoot, cwd: projectRoot, argv: {}, env: {} });
    expect(loaded.issues).toEqual([]);
    expect(loaded.config.test.modes).toEqual(['EditMode']);
    expect(loaded.config.build.target).toBe('StandaloneWindows64');
    expect(loaded.config.output.dir).toBe('ci-output');
  });
});

describe('the repository self-CI', () => {
  it('the root package.json exposes test, build, typecheck and the three lint scripts', () => {
    const manifest = JSON.parse(readRepo('package.json')) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = manifest.scripts ?? {};

    for (const name of [
      'test',
      'build',
      'typecheck',
      'lint:provider-neutrality',
      'lint:spawn',
      'check:adapters',
    ]) {
      expect(typeof scripts[name], `missing root script "${name}"`).toBe('string');
      expect(scripts[name]).not.toBe('');
    }
  });

  it('the self-CI workflow runs the unit suite and the lint gates without Unity', () => {
    const document = parseRepoYaml('.github/workflows/ci.yml');
    expect(hasTrigger(workflowTriggers(document), 'push')).toBe(true);
    expect(hasTrigger(workflowTriggers(document), 'pull_request')).toBe(true);

    const text = readRepo('.github/workflows/ci.yml');
    for (const command of [
      'pnpm install --frozen-lockfile',
      'pnpm run typecheck',
      'pnpm run test',
      'pnpm run lint:provider-neutrality',
      'pnpm run lint:spawn',
      'pnpm run check:adapters',
    ]) {
      expect(text).toContain(command);
    }
  });

  it('the self-CI workflow never runs Unity on a fork pull request', () => {
    const document = parseRepoYaml('.github/workflows/example.yml');
    const triggers = workflowTriggers(document);

    expect(hasTrigger(triggers, 'push')).toBe(true);
    // A secret-bearing integration job must never be reachable from a fork PR.
    expect(hasTrigger(triggers, 'pull_request')).toBe(false);
    expect(hasTrigger(triggers, 'pull_request_target')).toBe(false);

    const text = readRepo('.github/workflows/example.yml');
    expect(text).toContain('examples/minimal-project');
    expect(text).toContain('adapters/github');
    expect(text).toContain('UNITY_LICENSE_SERIAL');
  });

  it('a nightly workflow exists that installs the latest Unity CLI', () => {
    const document = parseRepoYaml('.github/workflows/nightly.yml');
    const triggers = workflowTriggers(document);

    expect(hasTrigger(triggers, 'schedule')).toBe(true);
    const schedule = (triggers as { schedule?: Array<{ cron?: unknown }> }).schedule ?? [];
    expect(schedule.length).toBeGreaterThan(0);
    expect(typeof schedule[0]?.cron).toBe('string');

    const text = readRepo('.github/workflows/nightly.yml');
    // The installer always fetches the current beta; a pinned version would
    // defeat the point of an upstream drift test.
    expect(text).toContain('unity.com/install.sh');
    expect(text).toContain('unity version --format json');
  });

  it('the nightly workflow is not secret-bearing on fork pull requests', () => {
    const document = parseRepoYaml('.github/workflows/nightly.yml');
    expect(hasTrigger(workflowTriggers(document), 'pull_request')).toBe(false);
    expect(hasTrigger(workflowTriggers(document), 'pull_request_target')).toBe(false);
  });

  it('every third-party action in the workflows is pinned to a full commit SHA', () => {
    for (const file of ['ci.yml', 'example.yml', 'nightly.yml']) {
      const text = readRepo(`.github/workflows/${file}`);
      const uses = [...text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map(
        (match) => match[1] ?? '',
      );
      expect(uses.length, `${file} should use at least one action`).toBeGreaterThan(0);

      for (const ref of uses) {
        // A local composite action is part of this repository; it needs no SHA.
        if (ref.startsWith('./')) continue;
        expect(
          /^[^@]+@[0-9a-f]{40}$/.test(ref),
          `${file}: ${ref} is not pinned to a 40-character commit SHA`,
        ).toBe(true);
      }
    }
  });

  it('the GitHub action never exports a config override unconditionally', () => {
    const scripts = actionSteps()
      .map((step) => step.run)
      .filter((script): script is string => typeof script === 'string');

    expect(scripts.length).toBeGreaterThan(0);
    let exports = 0;
    for (const script of scripts) {
      exports += [...script.matchAll(/\bexport\s+UNITYCI_/g)].length;
      expectGuardedExports(script, 'action.yml');
    }

    // The five override inputs are the whole surface this test protects.
    expect(exports).toBeGreaterThanOrEqual(5);
  });

  it('the GitHub action gates its git teardown on a touched marker', () => {
    const steps = actionSteps();
    const credentials = steps.find((step) => step.id === 'git-credentials');
    expect(credentials?.run, 'the git-credentials step must exist').toBeDefined();
    const script = credentials?.run ?? '';

    // The marker starts false and flips only after the rewrite is appended, so
    // a guard failure exits before the teardown can remove a file it never wrote.
    const falseAt = script.indexOf('touched=false');
    const writeAt = script.indexOf('>> "$HOME/.gitconfig"');
    const trueAt = script.indexOf('touched=true');
    expect(falseAt).toBeGreaterThanOrEqual(0);
    expect(writeAt).toBeGreaterThan(falseAt);
    expect(trueAt).toBeGreaterThan(writeAt);

    const teardown = steps.find((step) =>
      typeof step.run === 'string' && /rm -f "\$HOME\/\.gitconfig"/.test(step.run),
    );
    expect(teardown, 'a step that removes ~/.gitconfig must exist').toBeDefined();
    expect(teardown?.if).toContain("steps.git-credentials.outputs.touched == 'true'");
  });

  it('the published bin is executed and sets process.exitCode', async () => {
    const originalArgv = process.argv;
    const originalExitCode = process.exitCode;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      // An unknown command is a usage error (2) and reaches no Unity process.
      process.argv = [process.execPath, 'unityci', 'no-such-command'];
      process.exitCode = undefined;

      // A query defeats Vitest's module cache, so this actually executes
      // bin.ts's top-level `process.exitCode = await main(...)`. TypeScript
      // cannot resolve the query suffix; Vite can.
      vi.resetModules();
      // @ts-expect-error -- the cache-busting query is Vite-specific.
      await import('../src/bin.js?bin-exec');
      expect(process.exitCode).toBe(2);
    } finally {
      process.argv = originalArgv;
      process.exitCode = originalExitCode;
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
