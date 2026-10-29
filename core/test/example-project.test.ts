import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
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
const PINNED_EDITOR_VERSION = '6000.6.6f1';

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
    // `unity build --output-path` forwards its value as `-buildOutput`; a
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
