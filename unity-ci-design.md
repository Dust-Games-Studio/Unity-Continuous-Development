# Unity CI Kit: Design Document (v0.1)

> Working name: `unity-ci-kit` (placeholder; check for name collisions and Unity trademark guidance before publishing).
> Audience: the implementer. Status: ready to build after **Spike 0** (Section 9).

---

## 1. Summary

An open-source toolkit that installs, licenses, tests and builds Unity projects in CI using **Unity's own CLI** (`unity`), with no Docker layer and no dependency on any single CI provider.

It replaces the role that `game-ci/cli` plus the `unity-activate`, `unity-test-runner` and `unity-builder` GitHub Actions play today, for **Unity only**.

### Goals

- Same commands run identically on a developer machine and in CI.
- GitHub Actions is a supported *adapter*, not a requirement. Adding another provider (GitLab, Jenkins, Buildkite, etc.) means adding one directory and changing no core code.
- Correct, explicit handling of exit codes, license lifecycle (activate, then always return), retries, and test-result reporting.
- Secure by default: secrets never in argv or logs, no shell-string construction, validated inputs.
- Testable without a Unity license (via a fake `unity` binary).

### Non-goals (v1)

- Other engines (Godot, Unreal, Bevy).
- Docker or container orchestration, cloud runners, or an orchestrator.
- Deploy targets (Steam, itch, etc.).
- A runtime plugin system. `game-ci/cli`'s comments show plugin loading causing compiled-binary pitfalls (dynamic `import()` not traceable by Bun's `--compile`). Avoid it until there is a real need.
- Using the optional `com.unity.pipeline` package (it controls a *running* Editor; `unity build` and `unity test` run in batch mode and shouldn't need it. **[VERIFY]**).

---

## 2. Key decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Three layers: **Unity CLI → Core → Adapters**, with dependencies pointing one way only. | Keeps provider logic out of the logic that matters. |
| D2 | The core never reads `GITHUB_*`, `GITLAB_*`, `JENKINS_*` etc. Adapters pass what the core needs via flags or env. | Makes "no provider coupling" enforceable (lint rule plus test). |
| D3 | The core/adapter contract is **flags + env + files + exit codes**, never a library import. | Any CI system that can run a command can integrate. |
| D4 | The core decides pass/fail. Adapters only *display* results. | In game-ci the verdict was split between the CLI exit code and `ResultsCheck`. One source of truth is simpler. |
| D5 | Core is TypeScript, compiled with Bun to single binaries (Linux x64/arm64, macOS x64/arm64, Windows x64). Also published to npm. | Matches Unity CLI's single-binary ethos and avoids a Node requirement on bare agents. **The contract in D3 is what matters; the language is swappable.** |
| D6 | The GitHub adapter is a **composite action**, not a JS action. | No bundled `dist/` to commit and no Node-runtime upgrade treadmill. It just installs the binary and calls it. |
| D7 | Caching is **described** by the core (`cache-info`) and **performed** by adapters. | Cache APIs are provider-specific. Cache *keys and paths* are not. |
| D8 | Reports are emitted as NUnit XML (from Unity) **and** JUnit XML (converted by the core). | GitLab and Jenkins consume JUnit natively. Unity emits NUnit. |
| D9 | `latest` is not allowed for the Unity CLI version unless explicitly opted into. | The CLI is pre-1.0 and its flags may change. Reproducibility matters more than freshness. |
| D10 | Editor version defaults to the project's own `ProjectVersion.txt` (`--allow-install`). | The project, not the runner, is the source of truth. |

---

## 3. Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Adapters (provider-specific, thin)                         │
│  adapters/github   adapters/gitlab   adapters/jenkins      │
│  adapters/generic (docs only)                              │
│  Do: install core, set env/flags, wire cache, upload       │
│      artifacts, publish reports, always-run teardown       │
│  Don't: retry, map exit codes, parse Unity output          │
└───────────────┬────────────────────────────────────────────┘
                │  flags + env + files + exit codes
┌───────────────▼────────────────────────────────────────────┐
│ Core: `unityci` (provider-neutral)                         │
│  config → setup → license → run → report → summary.json    │
└───────────────┬────────────────────────────────────────────┘
                │  spawn argv arrays (never a shell string)
┌───────────────▼────────────────────────────────────────────┐
│ Unity CLI: `unity`  (install, license, test, build, doctor)│
└────────────────────────────────────────────────────────────┘
```

---

## 4. Core (`unityci`)

### 4.1 Commands

| Command | Purpose |
|---|---|
| `unityci doctor` | Runs `unity doctor --format json` plus the core's own checks (CLI version in tested range, glibc on Linux, disk space). Safe to run as the first CI step and to upload as a diagnostic artifact. |
| `unityci setup` | Ensures the Unity CLI is at the pinned version, then installs the Editor and modules (`unity install <ver> -m <mods> --cm --accept-eula --yes`, or relies on `--allow-install`). Idempotent. |
| `unityci license activate` / `return` | Thin, explicit wrappers over `unity license`. Exposed so adapters can add a backup `always()` teardown. |
| `unityci run test` | Lifecycle: setup → license activate → `unity test` → report → **finally** license return. |
| `unityci run build` | Same lifecycle around `unity build`. |
| `unityci report` | Converts NUnit XML to JUnit XML and writes or refreshes `summary.json`. |
| `unityci cache-info --json` | Prints cache descriptors (Section 4.6). Never touches a cache service. |

### 4.2 Configuration

Precedence (high to low): **CLI flags > `UNITYCI_*` env vars > `unity-ci.yml` > defaults.**

```yaml
# unity-ci.yml
unity:
  cli:
    version: 1.0.0-beta.5        # pinned; "latest" requires cli.allowLatest: true
  editor:
    version: from-project        # or an explicit version, e.g. 6000.3.7f1
    changeset: null              # needed only for versions not in Unity's release list
    modules: [android]
    childModules: true
license:
  mode: floating                 # floating | offline | ...   [VERIFY: see Spike 0]
test:
  modes: [EditMode, PlayMode]
  outputDir: ci-output/tests
build:
  target: Android
  executeMethod: Builder.PerformBuild
  outputPath: ci-output/build/app.aab
retry:
  onExitCodes: [7]               # see 4.4
  maxAttempts: 2
output:
  dir: ci-output
  annotations: none              # none | github   (set by the adapter, never auto-detected)
```

Rules:

- **Secrets are env-only.** Unity service-account credentials (`UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET`) and any license material are never accepted as flags or config keys. Reject them if found in `unity-ci.yml`.
- Own env vars use the `UNITYCI_` prefix (`UNITYCI_TEST_MODES=EditMode`). **Unknown `UNITYCI_*` vars produce a warning, not a failure.** (game-ci's strict-mode behavior turned typos into hard failures. That's defensible, but unfriendly for a tool consumed from many CI systems.)
- Validate every value that reaches a path, URL or argv. Reuse the idea from game-ci's `validateCliVersion`: an allow-list regex such as `^[A-Za-z0-9][A-Za-z0-9._+-]*$`, plus path-traversal checks on `outputDir`.

### 4.3 Process execution

- Always spawn with an **argv array** (`spawn(file, args)`), never a concatenated string, never `shell: true`. (game-ci's CodeQL false-positive comments describe the same safe pattern.)
- Stream stdout and stderr through a redactor that masks every known secret value.
- Prefer `--format json` / `ndjson` for Unity CLI calls whose output the core parses. Never parse human-formatted output or progress bars.
- Set `UNITY_NON_INTERACTIVE=1`, `UNITY_NO_UPDATE_CHECK=1`, `UNITY_NO_BANNER=1` for all child processes in CI. Consider `UNITY_NO_CRASH_REPORT` and `UNITY_NO_CONSENT_PROMPT` behind config.

### 4.4 Exit codes and retries

The core **passes Unity's exit codes through** so behavior is learnable from Unity's own docs, and adds its own codes only in a reserved range.

| Code | Meaning | Source |
|---|---|---|
| 0 | Success | Unity |
| 1 | General error | Unity |
| 2 | Usage error | Unity |
| 3 | Auth failure | Unity |
| 4 | Configuration required | Unity |
| 6 | Primary operation failed. For `test`, the run didn't finish and produced no results. | Unity |
| 7 | Unity service unreachable (retryable) | Unity |
| 8 | `test` only: tests ran, some failed. **Never retry.** | Unity |
| 130 / 143 | SIGINT / SIGTERM | Unity |
| 64 | Core configuration or validation error | Core |
| 65 | Core internal error (e.g. unparsable Unity output) | Core |

Retry policy:

- Default: retry **only 7**, up to `maxAttempts`, with backoff.
- **Never retry 8.**
- **[VERIFY]** Unity's docs disagree slightly on 6. The exit-code table calls 6 terminal, while a note under `unity test` says a retry on 6 or 7 can still produce results. Make 6 opt-in (`retry.onExitCodes: [6, 7]`) and default it off until Spike 0 settles it.

Adapter semantics for results: on **0 or 8**, results exist, so publish them. On anything else, publish only logs and diagnostics. The job status always comes from the core's exit code.

### 4.5 The `run` lifecycle (guarantees)

```
setup → license activate → unity <test|build> (with retries) → report
                                  │
                                  └── finally: license return   (always)
                                      also on SIGINT/SIGTERM, with a bounded timeout
```

- `license return` failures are logged loudly but never mask the primary exit code.
- If the core process is killed hard (SIGKILL, runner teardown), only an adapter-level `always()` step can recover. Every adapter **must** include one (`unityci license return`, a safe no-op if nothing is held).

### 4.6 Outputs contract (what adapters consume)

Everything is written under `output.dir` (default `ci-output/`).

```
ci-output/
  summary.json            # machine-readable result (schema below)
  tests/*.xml             # NUnit, as emitted by `unity test`
  tests/*.junit.xml       # JUnit, converted
  build/...               # build outputs
  logs/editor.log
  logs/cli-log.json       # copy of the CLI's own log, if available
  logs/doctor.json
```

`summary.json` (versioned: bump `schema` on breaking changes):

```json
{
  "schema": 1,
  "command": "test",
  "status": "passed | tests_failed | infra_failed | config_error",
  "exitCode": 0,
  "unityExitCode": 0,
  "attempts": 1,
  "cliVersion": "1.0.0-beta.5",
  "editorVersion": "6000.3.7f1",
  "durationMs": 123456,
  "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 },
  "reports": { "nunit": ["tests/editmode.xml"], "junit": ["tests/editmode.junit.xml"] },
  "artifacts": ["build/app.aab"],
  "logs": { "editor": "logs/editor.log", "cli": "logs/cli-log.json" }
}
```

`cache-info --json`:

```json
{
  "editor":  { "paths": ["<install-path>/<version>"], "key": "unity-editor-<os>-<arch>-<version>-<modules-hash>" },
  "library": { "paths": ["<project>/Library"],        "key": "<output of `unity cache key`>" }
}
```

The Editor install location is controllable via `unity install-path`, so it can be pointed somewhere cacheable. **[VERIFY]** that a restored install is recognized by `unity install` / `--allow-install` rather than reinstalled.

---

## 5. Adapters

### 5.1 The adapter contract (hard rules)

An adapter may **only**:

1. Install or locate the `unityci` binary at a pinned version.
2. Set env vars and flags (including `--annotations <provider>`).
3. Call `unityci` commands.
4. Read `summary.json` and the files under `ci-output/`.
5. Wire provider-native features: cache, artifact upload, test-report display, job summary, secrets injection, and an `always()` license-return step.

An adapter must **not** implement retries, exit-code interpretation, Unity output parsing, or version resolution.

**Adding a provider = adding `adapters/<name>/` plus docs. Zero changes to `core/`.** A conformance check (Section 8) enforces this.

### 5.2 GitHub (`adapters/github`), first-class

- Composite `action.yml`: install the binary, then call `unityci run …`.
- Inputs map 1:1 onto core flags and env. No logic in YAML beyond that.
- Caching via `actions/cache`, with keys from `cache-info`. Artifacts via `actions/upload-artifact`.
- Job summary from `summary.json` into `$GITHUB_STEP_SUMMARY`. Annotations via `--annotations github` (Unity's `--format github` covers CLI failures).
- Optional **GitHub Check with per-test detail**, replacing game-ci's `ResultsCheck`. It lives **only** in this adapter, is **off by default**, and requires `checks: write`. It consumes the JUnit/NUnit files and does not decide pass/fail (D4).
- Pin any third-party action by commit SHA.
- Teardown: `if: always()` step running `unityci license return`.

### 5.3 GitLab (`adapters/gitlab`)

- `unity.gitlab-ci.yml` template with hidden jobs (`.unityci-test`, `.unityci-build`) consumers `extends:`.
- `artifacts:reports:junit` pointing at `ci-output/tests/*.junit.xml` (this is why D8 exists).
- `cache:` using keys from `cache-info`. `after_script` for license return.

### 5.4 Jenkins (`adapters/jenkins`)

- `Jenkinsfile` example (a shared-library step is optional). Uses the `junit` step on the converted reports, `archiveArtifacts`, and `post { always { … } }` for license return.

### 5.5 Generic and local (`docs/generic-ci.md`)

The documented minimum for any CI system:

```bash
unityci doctor
unityci run test --output-dir ci-output
unityci license return   # in the provider's always-run teardown
```

---

## 6. Cross-cutting concerns

### Security

- Secrets: env only, redacted everywhere (register values at startup, also from config files, before any logging of option bags. game-ci had to fix ordering bugs here).
- Install path for the Unity CLI: Unity's recommended `curl -fsSL https://unity.com/install.sh | bash` is acceptable for convenience, but the docs also offer Homebrew, winget and apt/dnf packages. For hardened or pinned environments, document the package-manager route, and always verify the result with `unity version --format json` against the pinned version.
- `unity self-update --target <version>` pins the CLI after a script install (the script itself always installs latest).
- Never pass secrets on argv (process listings and command logging leak them).

### Platform support

Mirrors Unity CLI: Linux (glibc 2.34+, e.g. Ubuntu 22.04+, RHEL 9), macOS 14+, Windows 10 21H1+. Support Linux first, then macOS and Windows.

**[VERIFY]** which system libraries or virtual display the Linux Editor needs on bare runners. `unity doctor` may report this. Document what's required, since Docker no longer hides it.

### Reproducibility

- The Unity CLI version is pinned in config. The Editor version comes from the project. Record both in `summary.json`.
- A weekly scheduled CI job runs against Unity CLI `latest` to catch upstream breakage early and open an issue (see Section 10).

---

## 7. Repository layout

```
/
├─ core/                      # provider-neutral; no provider imports
│  ├─ src/
│  │  ├─ cli.ts               # argument parsing, config precedence
│  │  ├─ config/              # schema, validation, env mapping
│  │  ├─ unity/               # the ONLY module that spawns `unity`
│  │  ├─ lifecycle/           # setup, license, run, retry, signals
│  │  ├─ report/              # NUnit → JUnit, summary.json
│  │  ├─ redact.ts
│  │  └─ exit-codes.ts
│  └─ test/                   # unit tests using the fake `unity`
├─ adapters/
│  ├─ github/                 # action.yml + docs
│  ├─ gitlab/
│  ├─ jenkins/
│  └─ generic/
├─ testing/
│  ├─ fake-unity/             # stub `unity` binary driven by fixtures
│  ├─ conformance/            # adapter conformance checks
│  └─ fixtures/               # sample NUnit XML, doctor JSON, etc.
├─ examples/
│  └─ minimal-project/        # tiny Unity project with 1 EditMode test, 1 build method
├─ docs/
├─ .github/workflows/         # this repo's OWN CI (uses the GitHub adapter = dogfooding)
├─ LICENSE
├─ CONTRIBUTING.md
└─ README.md
```

Rules enforced by lint or CI:

- Only `core/src/unity/` may spawn `unity`.
- `core/` must not match `GITHUB_|GITLAB_|JENKINS_|CI_JOB` (grep-style check).
- `adapters/*` may not import from `core/src` internals. They only invoke the binary.

---

## 8. Testing strategy

1. **Unit tests (no Unity, no license).** The `fake-unity` stub is a script that emits configured exit codes, JSON and NUnit fixtures. It covers: retry on 7, no retry on 8, license return on failure and on SIGTERM, secret redaction, config precedence, version validation, NUnit→JUnit conversion, and `summary.json` correctness.
2. **Adapter conformance checks.** A provider-agnostic test script asserts each adapter: calls `unityci` (not `unity`), includes a license-return teardown, publishes results on exit codes 0 and 8, and doesn't implement retries.
3. **Integration tests.** `examples/minimal-project` runs through the GitHub adapter in this repo's own CI, using a real license provided as a repo secret. These run on protected branches and tags, not on fork PRs. Never expose secrets to untrusted PRs.
4. **Upstream drift test.** The weekly job from Section 6.

---

## 9. Spike 0: resolve before building (about 1 to 2 days)

Each item gets a short written answer committed to `docs/decisions/`.

| # | Question | Why it matters |
|---|---|---|
| S1 | Which license types work headlessly: floating, offline/`.ulf`, Personal, serial key? What does `unity license activate --help` accept? | Decides whether this works for the target users at all. Biggest risk. |
| S2 | Full flag sets of `unity test` and `unity build`: test filters, categories, coverage, play-mode platform, build profiles, `--timeout`, signing options. Does `--output` accept a directory for multi-mode runs? | Defines the core's pass-through surface. |
| S3 | Does `--format github` combine with `--output`? Is NUnit output version 2 or 3? | Reporting and conversion design. |
| S4 | Retry semantics for exit code 6 (docs conflict). | Section 4.4 default. |
| S5 | What does the Linux Editor need on a bare runner (libraries, virtual display)? | Docs and `doctor` checks. |
| S6 | Can a restored, cached Editor install be reused without reinstall? Does `unity install-path` plus caching work as expected? | Whether CI is fast enough to be practical. |
| S7 | Does `unity build` / `unity test` require `com.unity.pipeline`? | Non-goal assumption in Section 1. |
| S8 | Is `--allow-install` EULA-safe in CI, or does it need `--accept-eula`? | Unattended installs. |
| S9 | What is the Unity CLI's stability and versioning policy (the docs describe a beta channel)? | Compatibility range and pinning policy. |

---

## 10. Milestones and acceptance criteria

| Milestone | Scope | Done when |
|---|---|---|
| **M0** | Spike 0 | All S1–S9 answered in writing. If S1 shows no viable headless license path for common users, stop and revisit scope. |
| **M1** | Core MVP: config, `doctor`, `setup`, `license`, `run test`, `summary.json`, redaction, `fake-unity` | Unit tests pass without Unity. A local run against `examples/minimal-project` produces a correct `summary.json`. |
| **M2** | `run build`, retries, `cache-info`, NUnit→JUnit, signal handling | Retry and teardown tests pass. License is returned on failure and on SIGTERM. |
| **M3** | GitHub adapter, repo self-CI, example project, docs | Dogfood workflow green. Job summary and artifacts work. Optional Check output works. |
| **M4** | GitLab and Jenkins adapters, generic docs, conformance checks | The **same example project** passes through GitLab or Jenkins with **no core changes** (this validates D1 to D3). |
| **M5** | macOS and Windows support, hardening, v0.1 release | Cross-OS matrix green. The README states the pre-1.0 and Unity-CLI-beta status plainly. |

---

## 11. What carries over from game-ci (and what doesn't)

**Carry over**

- Spawn via argv arrays. Secrets via env only.
- Version-string validation before it reaches paths or URLs.
- Exit-code-driven flow and "publish results on 0 or 8" semantics (game-ci: 0 or 2).
- Token threading and rate-limit awareness where GitHub API calls are needed (e.g. fetching releases). Pass tokens explicitly, since `GITHUB_TOKEN` is not auto-injected into a JS action's env. This only applies to the GitHub adapter.
- "Never cache `latest`" reasoning (assets can be replaced in place under the same tag).
- Redaction-before-logging ordering.

**Left behind**

- Docker image selection, volume mounts, and container-OS detection.
- Multi-engine plugin architecture, orchestrator and deploy plugins.
- The JS-action runtime and `dist/` commit workflow.
- Split pass/fail authority between CLI and results check (D4).

---

## 12. Open-source hygiene

- License: MIT or Apache-2.0 (Apache-2.0 adds an explicit patent grant). Decide before first commit.
- State clearly in the README: unaffiliated with Unity Technologies; "Unity" is their trademark.
- Semantic versioning, with a `docs/compatibility.md` matrix of tested Unity CLI and Editor versions.
- `CONTRIBUTING.md` documents the adapter contract (Section 5.1) and the "no core changes for a new provider" rule, with a how-to for writing a new adapter.
- Security policy (`SECURITY.md`): how to report vulnerabilities, with a note about secrets handling.
- Never run secret-bearing integration jobs on fork PRs.

---

## 13. Sources

- Unity docs: Use the Unity CLI; Unity CLI reference (commands, exit codes, env vars, output formats).
- Unity blog: "CICD Made Easier with Unity CLI" (`--allow-install`, `unity license activate --floating` / `return`, example `test` and `build` commands).
- XGameDev: "Unity CLI Explained" (third-party field report. Notes the CLI is labeled experimental and the `com.unity.pipeline` package is optional).
- `game-ci/unity-activate`, `unity-test-runner` and `game-ci/cli` source as supplied by the requester (patterns carried over or deliberately dropped, per Section 11).

Items tagged **[VERIFY]** are assumptions not confirmed by the sources above and must be settled in Spike 0.
