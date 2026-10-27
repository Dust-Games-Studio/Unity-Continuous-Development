/**
 * The complete, merged configuration. Every later task reads its settings from
 * here; nothing else defines a default.
 *
 * The shape is the design's configuration surface (section 4.2) plus the
 * fields Spike 0 forces: `unity.cli.*` (the tested CLI version), the licensing
 * environment variable names, the retry policy and the output/annotation switch.
 */
export interface Config {
  unity: {
    cli: { version: string; allowLatest: boolean; binary: string };
    editor: {
      version: string;
      changeset: string | null;
      modules: string[];
      childModules: boolean;
      terms: boolean;
      acceptEula: boolean;
    };
  };
  license: {
    mode: 'none' | 'serial' | 'floating' | 'offline-file' | 'personal';
    serialEnv: string;
    fileEnv: string;
  };
  packages: { preflight: boolean };
  test: {
    modes: string[];
    outputDir: string;
    filter: string | null;
    coverage: boolean;
    shards: string | null;
    retries: number;
    nographics: boolean;
  };
  build: {
    target: string;
    profile: string | null;
    executeMethod: string | null;
    outputPath: string;
    versioningStrategy: 'none' | 'semantic' | 'tag' | 'custom';
    buildVersion: string | null;
    androidVersionCode: number | null;
    allowDirtyBuild: boolean;
  };
  retry: { onExitCodes: number[]; maxAttempts: number; backoffMs: number };
  output: { dir: string; annotations: 'none' | 'github'; ci: boolean };
}

/** A single configuration problem. The caller turns a non-empty list into exit 64. */
export type ConfigIssue = { path: string; message: string };

/**
 * Built-in defaults. The lowest precedence layer: every other layer is merged
 * over a deep copy of this object, which is never mutated.
 */
export const DEFAULT_CONFIG: Config = {
  unity: {
    cli: { version: '1.0.0-beta.14', allowLatest: false, binary: 'unity' },
    editor: {
      version: 'from-project',
      changeset: null,
      modules: [],
      childModules: true,
      terms: true,
      acceptEula: false,
    },
  },
  license: {
    mode: 'none',
    serialEnv: 'UNITY_LICENSE_SERIAL',
    fileEnv: 'UNITY_LICENSE_FILE_BASE64',
  },
  packages: { preflight: true },
  test: {
    modes: ['EditMode'],
    outputDir: 'ci-output/tests',
    filter: null,
    coverage: false,
    shards: null,
    retries: 0,
    nographics: true,
  },
  build: {
    target: 'StandaloneWindows64',
    profile: null,
    executeMethod: null,
    outputPath: 'ci-output/build',
    versioningStrategy: 'none',
    buildVersion: null,
    androidVersionCode: null,
    allowDirtyBuild: false,
  },
  retry: { onExitCodes: [7, 9, 12, 14], maxAttempts: 2, backoffMs: 5000 },
  output: { dir: 'ci-output', annotations: 'none', ci: true },
};
