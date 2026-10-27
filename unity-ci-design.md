# Unity CI Kit: Design Document (v0.1)

> Working name: `unity-ci-kit` (placeholder; check for name collisions and Unity trademark guidance before publishing).
> Audience: the implementer. Status: build-ready. **Spike 0 is complete** — the questions are in Section 9 and the resolved answers, with the requirements they produced, are in the **Spike 0 outcomes** section that follows it.

---

## 1. Summary

An open-source toolkit that installs, licenses, tests and builds Unity projects in CI using **Unity's own CLI** (`unity`), with no Docker layer and no dependency on any single CI provider.

It replaces the role that `game-ci/cli` plus the `unity-activate`, `unity-test-runner` and `unity-builder` GitHub Actions play today, for **Unity only**.

### Goals

- Same commands run identically on a developer machine and in CI.
- GitHub Actions is a supported *adapter*, not a requirement. Adding another provider (GitLab, Jenkins, Buildkite, etc.) means adding one directory and changing no core code.
- Correct, explicit handling of exit codes, the license **precondition** (checked before anything runs, never assumed) and teardown (return the seat whenever a returnable license is held), retries, and test-result reporting. An offline `--file` license cannot be returned, so that route leaks a seat that must be reclaimed by hand.
- Secure by default: secrets never in argv or logs, no shell-string construction, validated inputs.
- Testable without a Unity license (via a fake `unity` binary).

### Non-goals (v1)

- Other engines (Godot, Unreal, Bevy).
- Docker or container orchestration, cloud runners, or an orchestrator.
- Deploy targets (Steam, itch, etc.).
- A runtime plugin system. `game-ci/cli`'s comments show plugin loading causing compiled-binary pitfalls (dynamic `import()` not traceable by Bun's `--compile`). Avoid it until there is a real need.
- Using the optional `com.unity.pipeline` package. Unity's reference states that `unity test` runs the tests "directly via the editor command line — no pipeline package or server is involved"; `unity build` is inferred to be the same, because the package requirement is stated on every command that drives a *running* Editor (`command`, `status`, `run --command`, `recompile`, `mcp`, `logs --console`) and is absent from `build` and `test` (S7). The toolkit never adds a package to a user's project to run CI.

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
| D8 | The core asks `unity test` for **both** formats (`--report-format nunit,junit` with `--output` and `--junit-output`) and converts NUnit→JUnit itself **only as a fallback**, when no JUnit file was produced. | Unity's converter already sits in the CLI path, and re-converting can only lose `test-case` ids. Unity emits **NUnit 3** (root `<test-run>`), so any fallback converter targets that schema, not NUnit 2. GitLab and Jenkins still consume JUnit (Section 5.3). |
| D9 | The Unity CLI version is **recorded, not enforced**: the configured version is the *tested* version and is written into every artifact. The tested range is **1.0.0-beta.9 through 1.0.0-beta.14**, held as `TESTED_CLI_MIN` / `TESTED_CLI_MAX` constants in `core/src/unity/cli.ts`: a CLI below the floor fails with exit 64, a CLI above the ceiling warns and continues. `latest` still requires an explicit opt-in. | The CLI self-updates through the Hub and through winget/MSIX and cannot be reliably pinned (S9). A hard version gate would rot within weeks; recording the exact build is what makes a failure reproducible (R13, R16). |
| D10 | Editor version defaults to the project's own `ProjectVersion.txt`. The core resolves it by reading `ProjectSettings/ProjectVersion.txt` and installs explicitly when needed; it **never** uses `--allow-install`, whose implicit install carries no EULA flag (S8). | The project, not the runner, is the source of truth. A missing Editor is an explicit `unity install` gated by `acceptEula`, or a fail-fast error naming the command. |

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
| `unityci doctor` | The preflight gate (R11). Runs `unity doctor --ci --format json`, consumes its report (`data.verdict`, `data.checks[]` with `id`/`status`/`code`/`blocking`/`message`), and adds the core's own checks: capability matrix (R13), glibc on Linux, disk space, licence state (R17), and git-dependency reachability (R19). Safe to run as the first CI step and to upload as a diagnostic artifact. |
| `unityci setup` | Resolves the Editor version (from `ProjectSettings/ProjectVersion.txt` when `unity.editor.version` is `from-project`) and reads `unity editors --installed --format json`. Three branches: **present** with the modules the **invoked command** needs → verify only, install nothing (a test run needs the test modules, a build needs the target's modules, and a command with no module requirement checks only the Editor version; a present Editor missing a required module is exit 64 naming the module, never a silent reinstall); **missing** and `unity.editor.acceptEula: true` → `unity install <ver> -m <mods…> [--cm] --yes --accept-eula`; **missing** and `acceptEula: false` → exit 64 with the exact command to run. The core never accepts the EULA silently on the user's behalf, because `--accept-eula` accepts Unity's and every module's license agreements, and it never sends `--allow-install` (S8). When `unity.editor.terms` is true it then runs `unity terms accept <ver> --yes` (R10). Idempotent. |
| `unityci license status` / `activate` / `return` | Thin, explicit wrappers over `unity license`. `status` reports the license state and, in an activation mode, whether the current license matches what that mode expects; a not-yet-active license is reported there, not treated as an error, because the lifecycle activates it and re-checks afterwards. Under `license.mode: none` the same check is the precondition and exits 64 when nothing is active (R17). `activate` performs the route selected by `license.mode` (S1); `return` is the one the teardown calls, because a teardown returns a seat rather than acquiring one. |
| `unityci run test` | Lifecycle: preflight → setup → packages preflight → license step → `unity test` → verify artifacts → report → **finally** license return. |
| `unityci run build` | Same lifecycle around `unity build`. |
| `unityci report` | Asserts every expected artifact exists and is non-empty (R18), converts NUnit XML to JUnit XML **only when Unity produced no JUnit file** (D8), and writes or refreshes `summary.json`. |
| `unityci cache-info --json` | Prints cache descriptors (Section 4.6): paths from `unity cache info`, the `Library/` key from `unity cache key`. Never touches a cache service. |

### 4.2 Configuration

Precedence (high to low): **CLI flags > `UNITYCI_*` env vars > `unity-ci.yml` > defaults.**

```yaml
# unity-ci.yml
unity:
  cli:
    version: 1.0.0-beta.14       # the *tested* version; recorded, not enforced (D9)
    allowLatest: false           # "latest" requires true
  editor:
    version: from-project        # or an explicit version, e.g. 6000.3.7f1
    changeset: null              # needed only for versions not in Unity's release list
    modules: [android]
    childModules: true
    terms: true                  # run `unity terms accept <ver> --yes` after install (R10)
    acceptEula: false            # declared input: accepts Unity's and every module's license agreements (S8)
license:
  mode: none                     # none | serial | floating | offline-file | personal
  serialEnv: UNITY_LICENSE_SERIAL
  fileEnv: UNITY_LICENSE_FILE_BASE64
packages:
  preflight: true                # git-dependency detection + `git ls-remote` (R19)
test:
  modes: [EditMode, PlayMode]
  outputDir: ci-output/tests
  nographics: true               # default; forced off for PlayMode (R14)
build:
  target: Android
  executeMethod: Builder.PerformBuild
  outputPath: ci-output/build/app.aab
retry:
  onExitCodes: [7, 9, 12, 14]    # see 4.4
  maxAttempts: 2
output:
  dir: ci-output
  annotations: none              # none | github   (set by the adapter, never auto-detected)
```

Rules:

- **Secrets are environment-only or git-configuration-only.** Unity service-account credentials (`UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET`), license material (the serial named by `license.serialEnv`, the base64 `.ulf` named by `license.fileEnv`) and the credentials for private git packages are never accepted as flags or config keys: they travel through the environment or through git configuration, never through a flag, a config file or a command line (R19). Reject them if found in `unity-ci.yml`. (Service accounts authenticate Unity *services*; they cannot activate an Editor license — S1.)
- **Android signing is out of scope for v0.1.** `unity build` takes keystore material only on argv (`--android-keystore-base64`, `--android-keystore-password`, `--android-key-alias`, `--android-key-alias-password`), and Unity's own help warns that those arguments "may appear in shell history and CI logs". There is no environment or file route in this CLI build, so the core exposes no keystore flags and passes none; a signed Android artifact must be produced outside the toolkit. `--android-export-type`, `--android-version-code` and `--android-target-sdk-version` stay in scope because they are not secrets.
- Own env vars use the `UNITYCI_` prefix (`UNITYCI_TEST_MODES=EditMode`). **Unknown `UNITYCI_*` vars produce a warning, not a failure.** (game-ci's strict-mode behavior turned typos into hard failures. That's defensible, but unfriendly for a tool consumed from many CI systems.)
- Validate every value that reaches a path, URL or argv. Reuse the idea from game-ci's `validateCliVersion`: an allow-list regex such as `^[A-Za-z0-9][A-Za-z0-9._+-]*$`, plus path-traversal checks on `outputDir`.

`license.mode` selects what the toolkit does about licensing, not whether a license is required:

- `none` (the default) — the toolkit **does not activate anything**. An active license is a precondition: `unity license status --format json` must report `data.active: true`, or the run fails fast with exit 64 (R17).
- `serial`, `floating` and `offline-file` — the three unattended activation routes. `serial` reads the serial from `license.serialEnv`, so it never reaches `argv`; `floating` needs a server already configured on the machine (check it with `unity license server status` first); `offline-file` base64-decodes `license.fileEnv` into a temporary `.ulf`, passes it with `--file`, and deletes it afterward.
- `personal` — requires a signed-in user and is rejected outright for a service-account session, so it is **local-only**; it is never valid in CI.

The mode selects the route used by the lifecycle's license step and by the explicit `unityci license activate` wrapper. In `none` mode the lifecycle only reads `status` and fails fast when no license is active; in the activation modes it activates first and then re-reads `status`. `return` runs in `finally` regardless of mode.

### 4.3 Process execution

- Always spawn with an **argv array** (`spawn(file, args)`), never a concatenated string, never `shell: true`. (game-ci's CodeQL false-positive comments describe the same safe pattern.)
- Stream stdout and stderr through a redactor that masks every known secret value.
- Prefer `--format json` / `ndjson` for Unity CLI calls whose output the core parses. Never parse human-formatted output or progress bars.
- Set `UNITY_NON_INTERACTIVE=1`, `UNITY_NO_UPDATE_CHECK=1`, `UNITY_NO_BANNER=1` for all child processes in CI. Consider `UNITY_NO_CRASH_REPORT` and `UNITY_NO_CONSENT_PROMPT` behind config.
- Capture `unity version --format json` (version, channel, commit) **before any other Unity call** and carry it into `summary.json` (R16). A failure must be traceable to an exact CLI build.
- Forward `-nographics` to the Editor for EditMode runs and batch builds (R14), using each command's own mechanism: `unity test` forwards editor arguments after a literal `--` (so the core appends `-- -nographics`), and `unity build` takes them through `--args` (it already passes `-nographics` in its batch defaults). Unity documents both; neither has been exercised on this build, so the task that wires it **probes the mechanism first** instead of assuming it. Forced **off** for PlayMode, where simulated input needs a graphics device.
- Treat `--output` as a **file** path, never a directory: a directory is accepted silently, the tests still run, and no report is written at all (S2).
- Never pass `--mode` more than once per `unity test`. A repeated `--mode` is not a usage error — the last one silently wins — so the core owns mode selection and spawns one Editor per mode (S2).
- `--args` on `unity build` is shell-split by Unity itself, so it is passed as **one** argv element and never built by string concatenation. Prefer the typed flags wherever they exist.

### 4.4 Exit codes and retries

The core **passes Unity's exit codes through** so behavior is learnable from Unity's own docs, and adds its own codes only in a reserved range.

| Code | Meaning | Source |
|---|---|---|
| 0 | Success | Unity |
| 1 | General error | Unity |
| 2 | Usage error. Pre-flight; no Editor is spawned. | Unity |
| 3 | Auth failure | Unity |
| 4 | Configuration required (e.g. no floating server is configured) | Unity |
| 6 | Primary operation failed. For `test`, the run produced **no verdict** — compile error, crash, expired licence, unknown platform. **Terminal by default**; opt-in once (see below). | Unity |
| 7 | Unity service unreachable (retryable) | Unity |
| 8 | `test` only: tests ran, some failed. **Never retry.** | Unity |
| 9 | Install locked (retryable) | Unity |
| 10 | Ready timeout. Retryable, but it only applies to `unity open --until-ready`, which this toolkit does not run. | Unity |
| 11 | Not a Unity project, or the release/module does not exist. **Terminal.** | Unity |
| 12 | Editor unreachable (retryable) | Unity |
| 13 | Terminal (not retryable) | Unity |
| 14 | Timeout. **Infrastructure**, retryable; a timed-out suite is reported as an infrastructure failure, never as red tests. | Unity |
| 130 / 143 | SIGINT / SIGTERM. A signalled CI job must fail, not loop. | Unity |
| 64 | Core configuration or validation error (also: no active licence, R17) | Core |
| 65 | Core internal error (e.g. unparsable Unity output) | Core |

The list above is the CLI's own machine-readable table (`unity commands --json` → `data.exitCodes[].retry`), which is authoritative. Unity's prose documentation contradicts it in one place: it claims a `--timeout` on `unity test` exits 6. Measured, `unity test --timeout 1` exits **14** with `TEST_TIMED_OUT`; that sentence is stale, and the core must not encode it.

Retry policy:

- Default: retry **`[7, 9, 12, 14]`**, up to `maxAttempts`, with backoff.
- **This default differs deliberately from `docs/decisions/spike0-cli.md`, whose Implications section recommends `{7, 9, 10, 12, 14, 130, 143}`.** `10` (`READY_TIMEOUT`) applies only to `unity open --until-ready`, and `130`/`143` are interrupts — a signalled CI job must fail, never loop — so both are excluded even though Unity's own table marks them retryable. Exit 8 is never retried; exit 6 is opt-in and capped at one extra attempt. The resolved S4 answer supersedes the earlier recommendation.
- **Never retry 8** (tests ran and failed), nor `2`, `3`, `4`, `11`, `13`.
- Exclude `10` (only reachable through `unity open --until-ready`) and `130`/`143` (a signalled job must fail, not loop).
- **6 is terminal by default.** It is opt-in per pipeline (`retry.onExitCodes: [6, 7, 9, 12, 14]`) and then capped at **one** extra attempt, because re-running an identical broken configuration reproduces the failure.
- Classify **14** as infrastructure and retry it; a `TEST_TIMED_OUT` run produced no verdict and must not be summarised as failing tests.
- Branch on the **exit code** first and `errors[0].code` second: a usage error shipped `COMMAND_FAILED` on exit 2, so the error code is not a stable classifier on its own (S3).

Adapter semantics for results: on **0 or 8**, results exist, so publish them — after the core has asserted each expected artifact exists and is non-empty (R18). On anything else, publish only logs and diagnostics. The job status always comes from the core's exit code.

### 4.5 The `run` lifecycle (guarantees)

```
doctor (preflight) → setup: verify or install (EULA-gated) + terms accept → packages preflight (git ls-remote)
   → license step (mode-dependent check or activate) → unity <test|build> (with retries) → verify artifacts → report
                                        │
                                        └── finally: license return   (always)
                                            also on SIGINT/SIGTERM, with a bounded timeout
```

- `unity version --format json` is captured **first**, before any other Unity call, and recorded in `summary.json` (R16).
- `unity terms accept <editorVersion> --yes` runs after the install and before the first batch-mode launch. Without it the Editor stops on the "Unity Editor Software Terms" dialog and the job fails or hangs instead of running tests (R10). This is the default (`unity.editor.terms: true`); `terms: false` is the explicit opt-out for a machine where the terms were already accepted outside the toolkit.
- **The license is checked before any test or build runs (R17).** The core reads `unity license status --format json` → `data.active`. With the default `license.mode: none` it activates nothing: no active license means exit 64 naming the three unattended routes (`--serial` from a secret, `--floating` after `unity license server status`, `--file` from a base64 secret). With `serial`, `floating` or `offline-file` it activates through that route first (Section 4.2), re-checks, and treats a failure as a configuration error (64), never a retryable one. `personal` never runs unattended (S1).
- **A report that was not written is not a pass, and an exit code without an artifact is not a verdict.** Every expected artifact is asserted to exist and be non-empty before anything is reported on it; "ran but produced nothing" is an infrastructure failure (exit 6), never a green or a red test run (R18).
- `license return` failures are logged loudly but never mask the primary exit code.
- If the core process is killed hard (SIGKILL, runner teardown), only an adapter-level `always()` step can recover. Every adapter **must** include one (`unityci license return`, a safe no-op if nothing is held).
- An offline `--file` licence **cannot be returned** — `license return` leaves it in place. Those runners leak seats and must be counted by hand; the docs say so (R17).

### 4.6 Outputs contract (what adapters consume)

Everything is written under `output.dir` (default `ci-output/`).

```
ci-output/
  summary.json            # machine-readable result (schema below)
  tests/*.xml             # NUnit 3, one file per mode; `--output` is a file, not a directory
  tests/*.junit.xml       # JUnit, written by Unity's converter (fallback: NUnit 3 converted by the core)
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
  "cliVersion": "1.0.0-beta.14",
  "cliChannel": "beta",
  "cliCommit": "…",
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
  "editor":  { "paths": ["<download-cache-path>"], "key": "unity-downloads-<editorVersion>" },
  "library": { "paths": ["<project>/Library"],     "key": "<unity cache key>",
               "staticKey": "unity-library-<editorVersion>-<target>" }
}
```

The Editor install directory is **never** a cache path: it is global, shared with the Hub and other projects, and restoring over it can corrupt every install on the machine (see below). `library.staticKey` exists for providers such as GitLab, which must compute a cache key **before** the job's script runs and therefore cannot shell out; it is derived only from the Editor version and the target.

`cliVersion`, `cliChannel` and `cliCommit` come from `unity version --format json`, captured at the start of the run. `unity build`'s provenance manifest already records the CLI build; it is merged in when present (R16).

The Editor install location is queryable with `unity install-path`, but it is **global** and shared with the Hub and other projects, so it is not a per-project cache. Instead:

- An already-installed Editor is **reused with no install step at all** — every Spike 0 probe ran against a pre-installed `6000.6.6f1` resolved from `ProjectVersion.txt`. The whole prerequisite check is `unity editors --installed --format json` plus `unity install-path`; install only when that list lacks the project's version (S6).
- **Modules must be verified too.** A row with `"modules": ""` is a valid installed Editor that has lost its platform modules, so a version-only check passes and the build fails much later.
- Cache the **download cache** (`unity cache info` → the path), never the install directory: `$XDG_CONFIG_HOME/unityhub/downloads` (Linux), `%APPDATA%\UnityHub\downloads` (Windows), `~/Library/Application Support/UnityHub/downloads` (macOS).
- `unity cache key [project] --target <target>` is the CI cache key for `Library/`: editor version + resolved package set + target. It **excludes script content by design**, so a script-only change must not be treated as a cache miss by the toolkit's own logic.
- `unity install` already treats "already installed" as "leave it alone" (its `--force` flag exists to override that), and `unity test`/`unity build` accept `--editor-path` for Editors that are not registered with the Hub.

---

## 5. Adapters

### 5.1 The adapter contract (hard rules)

An adapter may **only**:

1. Install or locate the `unityci` binary at a pinned version.
2. Set env vars and flags (including `--annotations <provider>`).
3. Call `unityci` commands.
4. Read `summary.json` and the files under `ci-output/`.
5. Wire provider-native features: cache, artifact upload, test-report display, job summary, secrets injection, and an `always()` license-return step.
6. Supply the credentials the core must not hold: the licence through the environment, and — for a project with private git package dependencies — a **git URL rewrite** in git configuration, so the manifest keeps a credential-free URL (R19).

An adapter must **not** implement retries, exit-code interpretation, Unity output parsing, or version resolution.

**Adding a provider = adding `adapters/<name>/` plus docs. Zero changes to `core/`.** A conformance check (Section 8) enforces this.

### 5.2 GitHub (`adapters/github`), first-class

- Composite `action.yml`: install the binary, then call `unityci run …`.
- Reuse Unity's own proven sequence rather than reinventing it: the stock `unity ci init --provider github` workflow already installs the CLI, restores the editor download cache and `Library/`, installs the Editor version from `ProjectVersion.txt`, activates a licence, runs `unity doctor --ci`, tests, builds and returns the seat in an unconditional teardown. `unity-ci-kit` does **not** reimplement that; it adds what the stock workflow lacks — provider-neutrality beyond GitHub/GitLab, local execution identical to CI, the `summary.json` contract, retries, and guaranteed license teardown under signals (R12).
- Inputs map 1:1 onto core flags and env. No logic in YAML beyond that.
- Caching via `actions/cache`, with keys from `cache-info`. Artifacts via `actions/upload-artifact`.
- Job summary from `summary.json` into `$GITHUB_STEP_SUMMARY`. Annotations via `--annotations github` (Unity's `--format github` covers CLI failures).
- Optional **GitHub Check with per-test detail**, replacing game-ci's `ResultsCheck`. It lives **only** in this adapter, is **off by default**, and requires `checks: write`. It consumes the JUnit/NUnit files and does not decide pass/fail (D4).
- Pin any third-party action by commit SHA.
- Teardown: `if: always()` step running `unityci license return`.

### 5.3 GitLab (`adapters/gitlab`)

- `unity.gitlab-ci.yml` template with hidden jobs (`.unityci-test`, `.unityci-build`) consumers `extends:`.
- `artifacts:reports:junit` pointing at `ci-output/tests/*.junit.xml` (D8: the core asks Unity for JUnit directly and converts NUnit only as a fallback).
- `cache:` using keys from `cache-info`. `after_script` for license return.

### 5.4 Jenkins (`adapters/jenkins`)

- `Jenkinsfile` example (a shared-library step is optional). Uses the `junit` step on the JUnit reports (Unity's own, with the core's conversion as fallback), `archiveArtifacts`, and `post { always { … } }` for license return.

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

- Secrets: environment or git configuration only, redacted everywhere (register values at startup, also from config files, before any logging of option bags. game-ci had to fix ordering bugs here). Never through a flag, a config file or a command line — see R19 for the git-configuration route.
- Install path for the Unity CLI: Unity's recommended `curl -fsSL https://unity.com/install.sh | bash` is acceptable for convenience, but the docs also offer Homebrew, winget and apt/dnf packages. Always verify the result with `unity version --format json` against the **tested** version and record what was found (D9).
- **Pinning is an install-method policy, not a version string.** "The Unity Hub updates the Unity CLI automatically. You can't disable these updates in the Hub", and an MSIX/winget install "keeps the CLI current in the background" with no rollback. `unity self-update --target <version>` pins a script install, but the reliable route is apt/dnf/brew with an explicit version, or a standalone binary kept outside the Hub's path. `unity config update-check off` silences only the CLI's own notice; it does not stop the Hub (S9).
- Never pass secrets on argv (process listings and command logging leak them). This is also why Android signing is out of scope for v0.1 (Section 4.2): this CLI build offers keystore input only on argv.

### Platform support

Platform floors follow the Unity CLI: Linux (glibc 2.34+, e.g. Ubuntu 22.04+, RHEL 9), macOS 14+, Windows 10 21H1+. Support Linux first, then macOS and Windows. The Editor's own requirements are narrower, and the difference matters:

**Unity's support statement covers a narrower set of machines than the toolkit runs on.** Unity supports the Editor "on workstations or laptop form factors running without emulation, container or compatibility layer"; the supported Linux target is Ubuntu 22.04/24.04 on x64 with a Gnome desktop on X11/Wayland and an OpenGL 3.2+/Vulkan GPU. A bare CI runner **works**, but it is outside that statement, and the README and `docs/local-development.md` must say so plainly (R15). RHEL 9 is **CLI-only**: the CLI supports it (glibc ≥ 2.34), the Editor does not.

- No virtual display is needed for EditMode tests or batch builds: `-nographics` exists precisely to "run automated workflows on machines that don't have a GPU", and Unity's release notes record that `unity test` "now runs on a Linux machine without a display server". `xvfb` is not installed by default, and PlayMode without a display is **UNRESOLVED** — do not claim support for it.
- The shared-library set is **inferred, not Unity-published** (Unity's last published dependency list dates from Unity 5.x in 2015). The set `unity ci init` installs for Ubuntu 24.04 (noble) is: `libgl1 libglu1-mesa libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libdrm2 libxtst6 libxrandr2 libxcursor1 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxrender1 libxext6 libsm6 libice6 libxkbcommon0 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 libnotify4 libsecret-1-0` — drop the `t64` suffix on pre-24.04 images. Keep the list data-driven so it can be corrected per Ubuntu release without a code change.
- Raise the open-file limit (`ulimit -n 4096`); the Editor reports `Pipe error !` otherwise.
- `unity doctor --ci` may report some of this. Its report is the machine-readable surface the core consumes (R11); the rest becomes the core's own documented checks.

### Private git packages

A project may depend on a package in a private git repository. Three things must hold (R19):

- **Detection.** The core reads the project's git dependencies from `Packages/manifest.json`, reports their hosts, and **refuses to run** when a URL embeds credentials (`https://user:token@host/org/repo.git`), because Unity copies that URL verbatim into the committed `packages-lock.json` — the token would land in the repository.
- **Preflight.** The core proves each dependency is fetchable with `git ls-remote --exit-code <url>`, using the same git configuration the Package Manager will use, so a missing credential fails in seconds instead of ten minutes into an Editor launch.
- **Credential supply.** The adapter's job, never the core's, because the credential is a provider secret. The supported mechanism is a **git URL rewrite**: the manifest keeps a credential-free URL, and git applies the credential at fetch time. Measured in `docs/decisions/upm-git-auth-probe.md`, Unity's Package Manager honours a rewrite in `~/.gitconfig`, in `$XDG_CONFIG_HOME/git/config`, and through the per-invocation `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` variables — and **ignores `GIT_CONFIG_GLOBAL`**, which is the most convenient mechanism and therefore the trap. The rewritten, credential-bearing URL appears nowhere in `packages-lock.json`.

Credentials travel through the environment or through git configuration, never through a flag, a config file or a command line. SSH (`git@host:owner/repo.git` via `ssh-agent`) and `git credential.helper` under UPM are **unmeasured**; the URL-rewrite route depends on neither.

### Reproducibility

- The configured Unity CLI version is the **tested** version. It is recorded in every artifact (`unity version --format json` → version, channel, commit; R16) rather than enforced as a pin: the tested range is **1.0.0-beta.9 through 1.0.0-beta.14** (constants in `core/src/unity/cli.ts`), so a CLI below beta.9 fails and one above beta.14 warns (D9, R13). The Editor version comes from the project. Record both in `summary.json`.
- A weekly scheduled CI job runs against Unity CLI `latest` to catch upstream breakage early and open an issue (see Section 8).

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

1. **Unit tests (no Unity, no license).** The `fake-unity` stub is a script that emits configured exit codes, JSON and NUnit fixtures. It covers: retry on `7`/`9`/`12`/`14`, no retry on `8`, the single opt-in retry on `6`, license return on failure and on SIGTERM, secret redaction, config precedence, version validation, capability-matrix degradation when a command or flag is missing (R13), the licence precondition and exit 64 (R17), git-dependency detection and the refusal to run on a credential-bearing URL (R19), artifact-existence assertions (R18), NUnit 3→JUnit fallback conversion, and `summary.json` correctness.
2. **Adapter conformance checks.** A provider-agnostic test script asserts each adapter: calls `unityci` (not `unity`), includes a license-return teardown, publishes results on exit codes 0 and 8, and doesn't implement retries.
3. **Integration tests.** `examples/minimal-project` runs through the GitHub adapter in this repo's own CI, using a real license provided as a repo secret. These run on protected branches and tags, not on fork PRs. Never expose secrets to untrusted PRs.
4. **Upstream drift test.** The weekly job from Section 6.

---

## 9. Spike 0: questions and resolved answers

Each item gets a short written answer committed to `docs/decisions/`. **All nine are answered** — the conclusions are recorded in the Spike 0 outcomes section below, and the evidence is in the decision records.

| # | Question | Why it matters |
|---|---|---|
| S1 | Which license types work headlessly: floating, offline/`.ulf`, Personal, serial key? What does `unity license activate --help` accept? | Decides whether this works for the target users at all. Biggest risk. |
| S2 | Full flag sets of `unity test` and `unity build`: test filters, categories, coverage, play-mode platform, build profiles, `--timeout`, signing options. Does `--output` accept a directory for multi-mode runs? | Defines the core's pass-through surface. |
| S3 | Does `--format github` combine with `--output`? Is NUnit output version 2 or 3? | Reporting and conversion design. |
| S4 | Retry semantics for exit code 6 (docs conflict). | Section 4.4 default. |
| S5 | What does the Linux Editor need on a bare runner (libraries, virtual display)? | Docs and `doctor` checks. |
| S6 | Can a restored, cached Editor install be reused without reinstall? Does `unity install-path` plus caching work as expected? | Whether CI is fast enough to be practical. |
| S7 | Does `unity build` / `unity test` require `com.unity.pipeline`? | Non-goal assumption in Section 1. |
| S8 | Is the CLI's install-if-needed shortcut EULA-safe in CI, or does it need `--accept-eula`? | Unattended installs. |
| S9 | What is the Unity CLI's stability and versioning policy (the docs describe a beta channel)? | Compatibility range and pinning policy. |

---

## Spike 0 outcomes

Every question in Section 9 was answered against a live `unity` install (a 1.0.0-beta.13 binary whose data files already said beta.14) driving Editor 6000.6.6f1, and against Unity's own documentation. The evidence — transcripts, verbatim help output, quoted official sources — lives in `docs/decisions/spike0-cli.md`, `docs/decisions/spike0-research.md` and `docs/decisions/upm-git-auth-probe.md`. This section records only the conclusions, because every later task is built on them.

### S1 — Which licence types work headlessly

`unity license activate` accepts `--serial`, `--personal`, `--floating`, `--file` (.ulf/.xml), `--generate-request` (.alf). In CI: **only `--serial`, `--floating` and `--file` work** — Unity's licensing backend rejects service-account tokens, so `--personal` is unavailable in CI. The serial is read from the `UNITY_LICENSE_SERIAL` environment variable when no `--serial` and no other activation option is passed, so it never appears in `argv`. `--generate-request` is **not** an unattended route (it writes an `.alf` that must be exchanged elsewhere and imported with `--file`). There is **no `UNITY_LICENSING_SERVER` environment variable** — the floating endpoint comes from the machine's `licensingServiceBaseUrl` setting, readable with `unity license server list --format json` (`data.servers[]`). A licence's state is readable with `unity license status --format json` → `data.active`, `data.authMode`, `data.licenses[]`, `data.floatingServer`; an offline `--file` licence **cannot be returned** (`license return` leaves it in place), so those runners leak seats and must be counted by hand.

### S2 — The flag surface of `unity test` and `unity build`

`unity test` flags to expose: `--mode` (exactly **one** per invocation — a repeated `--mode` is *not* a usage error; the CLI silently lets the **last one win**, so the core must own mode selection), `--filter`, `--output`, `--report-format nunit,junit`, `--junit-output`, `--shard N/M`, `--shard-inventory`, `--retries`, `--rerun-failed`, `--affected`, `--affected-compare`, `--since`, `--coverage`, `--coverage-output`, `--coverage-options`, `--editor-version`, `--allow-install`, `--timeout`. **`--output` is a FILE path**: a directory is accepted silently, the tests still run, and **no report is written at all** — no error, no warning. `unity build` flags to expose: `--target`, `--profile`, `--create-profile`, `--execute-method`, `--output-path`, `--log-file`, `--args`, `--versioning-strategy`, `--build-version`, `--android-export-type`, `--android-version-code`, `--android-target-sdk-version`, `--android-symbol-type`, `--allow-dirty-build`, `--provenance-path`, `--timeout`. `unity build` works with **no** `--execute-method`: on Unity 6 it auto-discovers a Build Profile, and with a desktop `--target` it drives the legacy player flags. `unity build --list-targets --format json` is machine-readable and its rows carry a `zeroCode` boolean (`StandaloneWindows64`/`StandaloneLinux64`/`StandaloneOSX` are zero-code; `Android`, `WebGL`, `iOS` and the rest are not).

Note: `--allow-install` is in that list because the CLI accepts it, not because the core uses it — the core **never sends it** (S8).

### S3 — `--format github` with `--output`, and the NUnit version

`--format github` and `--output` are independent and compose — one invocation produced `::error::` annotations on stdout **and** two report files on disk. Unity's Test Framework emits **NUnit 3** (`<test-run … testcasecount=… total=… passed=… failed=…>` with `<test-suite>`/`<test-case>` children), not NUnit 2. `--report-format nunit,junit` + `--junit-output` is a **valid, verified** combination; `--report-format junit` **with** `--junit-output` is a pre-flight usage error (exit 2, no Editor spawned) because with `junit` alone the JUnit report *is* `--output`. The core therefore always requests `nunit,junit` and passes both paths, and writes its own NUnit→JUnit converter against the **NUnit 3** schema as a fallback only.

### S4 — Exit codes and retry semantics

Unity's own machine-readable table (`unity commands --json` → `data.exitCodes[].retry`) is authoritative: `7` (service unreachable), `9` (install locked), `10` (ready timeout), `12` (Editor unreachable), `14` (timeout), `130` (interrupted) and `143` (terminated) are **retryable**; `6`, `8`, `11` and `13` are **terminal**. Exit **8** = tests ran and some failed → never retry. Exit **6** = the run produced **no** verdict (compile error, crash, expired licence, unknown platform) → terminal by default, opt-in per pipeline and then capped at **one** extra attempt, because re-running an identical broken configuration reproduces the failure. Exit **14** = timeout → retryable, and **infrastructure**: `unity test --timeout 1` was measured to exit **14** with `TEST_TIMED_OUT` (the reference doc's claim that a `--timeout` exits 6 is **wrong** for this build), and a timed-out suite must not be reported as red tests. Exit **11** = the path is not a Unity project or the release/module does not exist. The core's default retry set is `[7, 9, 12, 14]` — it excludes `10` (only applies to `unity open --until-ready`) and `130`/`143` (a signalled CI job must fail, not loop).

### S5 — What the Linux Editor needs on a bare runner

Unity's **official support statement excludes the environment we are building for**: "the Unity Editor is supported on workstations or laptop form factors running without emulation, container or compatibility layer", and the supported Linux Editor target is Ubuntu 22.04 / 24.04 on x64 with a Gnome desktop on X11/Wayland and an OpenGL 3.2+/Vulkan GPU. A bare CI runner therefore **works** (Unity's own release notes record that `unity test` "now runs on a Linux machine without a display server") but is **outside Unity's support statement** — the toolkit must say so rather than imply support. RHEL 9 is a **CLI-only** platform: the CLI supports it (glibc ≥ 2.34) but the Editor does not. No virtual display is needed: use `-nographics`, which exists precisely to "run automated workflows on machines that don't have a GPU"; `xvfb` is not installed by default and PlayMode-without-a-display is **UNRESOLVED**. The shared-library set is **inferred, not Unity-published** (Unity's last published dependency list is from Unity 5.x in 2015). The set Unity's own `unity ci init` scaffold installs for Ubuntu 24.04 (noble) is: `libgl1 libglu1-mesa libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libdrm2 libxtst6 libxrandr2 libxcursor1 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxrender1 libxext6 libsm6 libice6 libxkbcommon0 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 libnotify4 libsecret-1-0` — drop the `t64` suffix on pre-24.04 images. Also raise the open-file limit (`ulimit -n 4096`). The Editor download cache lives at `$XDG_CONFIG_HOME/unityhub/downloads` (Linux) / `%APPDATA%\UnityHub\downloads` (Windows) / `~/Library/Application Support/UnityHub/downloads` (macOS).

### S6 — Reusing a restored or cached Editor install

Yes — an already-installed Editor is reused with **no** install step at all: every probe ran against the pre-installed `6000.6.6f1`, resolved from `ProjectVersion.txt`. The whole prerequisite check is `unity editors --installed --format json` plus `unity install-path`; only when the list lacks the project's version does an install become necessary, which makes a restored/cached Editor a first-class fast path. **Modules must be verified too**: a row with `"modules": ""` is a valid installed Editor that lost its platform modules, so a version-only check passes and the build fails much later. `unity install` has **no** `--allow-install` flag (that flag lives on `build`/`test`/`run`); its only reuse-related flags are `-f, --force` ("Force reinstall of an already-installed editor", so the default is "already installed → leave it alone") and `--resume`. `unity install-path` is a global getter/setter with no subcommands — cache the **download cache** (`unity cache info` → the path), never the install directory, because installs are shared with the Hub and other projects. `unity cache key [project] --target <target>` is the CI cache key for `Library/` (Editor version + resolved package set + target) and **excludes script content by design**, so a script-only change must not be treated as a cache miss by the toolkit's own logic. `unity install --download-directory <dir>` (new in beta.14) installs a self-contained Editor into a named folder without registering it with the Hub, but then `unity test`/`unity build` would need `--editor-path`; it is deferred for the MVP. `unity install` refuses an Editor the licence does not cover (`EDITOR_NOT_ENTITLED`).

### S7 — Does `build`/`test` need `com.unity.pipeline`?

**CONFIRMED** for `unity test`, which Unity's own CLI reference describes as running the tests "directly via the editor command line — no pipeline package or server is involved". `unity build` is **INFERRED** to be the same: the package requirement is stated on every command that drives a *running* Editor (`command`, `status`, `run --command`, `recompile`, `mcp`, `logs --console`) and is absent from `build` and `test`; Unity's own generated CI workflow installs the package never and still runs `unity doctor --ci`, `unity test` and `unity build`. `unity projects create` now adds the package to every new project; `--bare` leaves it out. The toolkit must **never** add a package to a user's project to run CI.

### S8 — Is the install-if-needed shortcut EULA-safe?

`--allow-install` itself has **no EULA surface and no EULA flag** — it is a three-word convenience on `build`/`test`/`run` meaning "install the project's editor version if it is not already installed", and it cannot carry `--accept-eula`. The separate `unity install` command has `--accept-eula` ("Accept all module license agreements automatically") and `-y, --yes`, and Unity's own generated CI workflow uses both together: `unity install 6000.0.47f1 --yes --accept-eula`. The safe pattern is therefore an **explicit** install step with `--yes --accept-eula`, with `--allow-install` used only as a recovery path — and since whether the install `--allow-install` triggers accepts the EULA cannot be verified, the core **never** sends it and instead fails fast with the exact install command. EULA acceptance is a **declared** config input (`unity.editor.acceptEula`), not a silent default, because it means accepting Unity's and every module's licence agreements on the user's behalf. A separate step is still required for the Editor Software Terms: `unity terms accept <version> --yes`, and the first Editor launch otherwise stops on the "Unity Editor Software Terms" dialog.

### S9 — Stability, versioning and pinning

Unity's docs state plainly: "The Unity command-line interface (CLI) is experimental. The features and documentation might change in an upcoming release." Versions are `1.0.0-beta.N`, shipping roughly fortnightly (beta.1 on 2026-06-30 → beta.14 on 2026-10-21). There is **no stable channel yet** — the installer "gets the latest beta on its own" "until a stable release ships", and `unity self-update --check --channel stable` is documented as the check you run "when moving off a beta once GA ships". **GA is undated.** Breaking changes ship per-beta under "Breaking changes" headings (beta.7 reached the beta channel and was withdrawn the same day it shipped), so a hard minimum-version gate would rot within weeks. **Pinning is not trustable**: "The Unity Hub updates the Unity CLI automatically. You can't disable these updates in the Hub", and "If you installed the CLI as an MSIX package, including through winget, Windows keeps the CLI current in the background. Rollback isn't available for MSIX installs." Therefore pinning is an **install-method policy** (apt/dnf/brew with an explicit version, or a standalone binary outside the Hub's path), not a version string, and the toolkit ships a **capability matrix** rather than a minimum-version constant. A CLI newer than the tested range is a loud warning rather than a failure, and the core probes for the capabilities it needs instead of gating on a version number.

### What the outcomes change in this document

- **D8 is revised:** the core asks `unity test` for `nunit,junit` and converts NUnit→JUnit only as a fallback when no JUnit file was produced (Section 2, Section 4.1, Section 5.3).
- **D9 is revised:** the CLI version is recorded, not enforced — the configured version is the tested version, written into every artefact; older than the floor fails, newer warns (Section 2, Section 6 "Reproducibility").
- **Section 1** (non-goal on `com.unity.pipeline`) now records S7 rather than an assumption.
- **Section 4.3–4.6** carry the operational consequences: one `--mode` per invocation, `--output` as a file, the corrected exit-code table and retry set, the artifact assertions, and the recorded CLI identity.
- **Section 6** now carries the support caveat, the Linux package list, the install-method pinning policy, and private git package handling.

### Requirements established by Spike 0

These are binding on every later task. R10–R19 are stated here once; the sections above explain how they land in the design.

- **R10 — Accept the Editor Software Terms.** The lifecycle must run `unity terms accept <editorVersion> --yes` after installing the Editor and before the first batch-mode run, otherwise the Editor stops on the Software Terms dialog. This is the default (`unity.editor.terms: true`); `terms: false` is the explicit opt-out for a machine where the terms were already accepted outside the toolkit.
- **R11 — Doctor is the preflight gate.** `unity doctor --ci` is the preflight gate; its JSON report (`data.verdict`, `data.checks[]` with `id`/`status`/`code`/`blocking`/`message`) is what `unityci doctor` consumes.
- **R12 — Do not reimplement `unity ci init`.** Unity ships `unity ci init --provider github|gitlab`, which generates a complete stock workflow (install, caches, runtime libraries, license, preflight, test, build, license return). `unity-ci-kit` does **not** reimplement that; it adds what the stock workflow lacks — provider-neutrality beyond GitHub/GitLab, local execution identical to CI, a `summary.json` contract, retries, and guaranteed license teardown under signals. The GitHub adapter reuses Unity's proven install/cache/library sequence and adds the missing guarantees.
- **R13 — Capability matrix, not a version gate.** The core probes `unity version --format json` and the presence of the commands and flags it needs, and degrades with a clear message when one is missing. It must never fail a run solely because the CLI is newer than tested.
- **R14 — `-nographics` by default.** EditMode test runs and batch builds pass `-nographics` so a machine without a GPU works. The mechanism is per command: `unity test` forwards editor arguments after a literal `--` (so the core passes `-- -nographics`), while `unity build` takes extra editor arguments through its own `--args` flag (and already passes `-nographics` in its batch defaults). The forwarding is documented but unprobed on this build, so a later task must **probe the mechanism** before relying on it rather than assuming it. It is a config knob (`test.nographics`) and is **off** for PlayMode, where simulated input needs a graphics device.
- **R15 — State the support caveat.** The README and `docs/local-development.md` must say plainly that Unity's own support statement covers "workstations or laptop form factors running without emulation, container or compatibility layer", that a bare CI runner works but sits outside that statement, and that RHEL 9 supports the CLI but not the Editor.
- **R16 — Record the CLI identity.** `unity version --format json` (version, channel, commit) is captured at the start of every run and stored in `summary.json`, so a failure can be traced to an exact CLI build. `unity build`'s provenance manifest already records it and is merged in.
- **R17 — The licence is a precondition, not a step the toolkit owns.** `unity license status --format json` reports `data.active`; the core checks it and fails fast with exit 64 when no licence is active, instead of attempting an activation it cannot perform unattended. The three documented unattended routes are `--serial` (from a secret), `--floating` (with `unity license server status` checked first) and `--file` (a base64 secret decoded to a `.ulf`). The docs must state that an offline `--file` licence **cannot be returned** — those runners leak seats.
- **R18 — Never trust a result you did not verify.** A report that was not written is not a pass, and an exit code without an artifact is not a verdict. The core asserts every artifact exists and is non-empty before it reports on it, and treats "ran but produced nothing" as an infrastructure failure (exit 6) rather than a green or a red test run.
- **R19 — Private git packages are a first-class concern.** A project may depend on a package in a private git repository. The design must cover three things: (a) **detection** — the core reads the project's git dependencies, reports their hosts, and refuses to run if a URL embeds credentials, because Unity copies that URL verbatim into the committed `packages-lock.json`; (b) **preflight** — the core proves each dependency is fetchable with `git ls-remote`, using the same git configuration the Package Manager will use, so a missing credential fails in seconds instead of ten minutes into an Editor launch; (c) **credential supply** — the adapter's job, never the core's, because the credential is a provider secret. The supported mechanism is a **git URL rewrite** (the manifest keeps a credential-free URL; git applies the credential at fetch time), measured in `docs/decisions/upm-git-auth-probe.md`: Unity's Package Manager honours a rewrite in `~/.gitconfig`, in `$XDG_CONFIG_HOME/git/config`, and through the per-invocation `GIT_CONFIG_*` variables, and **ignores `GIT_CONFIG_GLOBAL`**.

Two scoping notes on the list above. **R17** describes the default `license.mode: none`: the lifecycle reads `unity license status` and fails fast with exit 64 when nothing is active. When the mode selects an activation route (`serial`, `floating` or `offline-file`), the lifecycle activates through that route first and then applies the same status check; `personal` stays local-only (Section 4.2). **R10** is the default behaviour: `unity.editor.terms: true` runs `unity terms accept`, and `terms: false` exists only for a machine where the terms were already accepted outside the toolkit.

---

## 10. Milestones and acceptance criteria

| Milestone | Scope | Done when |
|---|---|---|
| **M0** | Spike 0 | All S1–S9 answered in writing (**done** — see Spike 0 outcomes). S1 showed a viable headless path for the target users (serial, floating, offline file), so scope stands. |
| **M1** | Core MVP: config, `doctor`, `setup`, `license`, `run test`, `summary.json`, redaction, `fake-unity` | Unit tests pass without Unity. A local run against `examples/minimal-project` produces a correct `summary.json`. |
| **M2** | `run build`, retries, `cache-info`, NUnit→JUnit fallback, signal handling | Retry and teardown tests pass. License is returned on failure and on SIGTERM. |
| **M3** | GitHub adapter, repo self-CI, example project, docs | Dogfood workflow green. Job summary and artifacts work. Optional Check output works. |
| **M4** | GitLab and Jenkins adapters, generic docs, conformance checks | The **same example project** passes through GitLab or Jenkins with **no core changes** (this validates D1 to D3). |
| **M5** | macOS and Windows support, hardening, v0.1 release | Cross-OS matrix green. The README states the pre-1.0 and Unity-CLI-beta status plainly. |

---

## 11. What carries over from game-ci (and what doesn't)

**Carry over**

- Spawn via argv arrays. Secrets via the environment or git configuration only.
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
- Semantic versioning, with a `docs/compatibility.md` matrix of tested Unity CLI and Editor versions. The runtime capability matrix from R13 is the machine-readable form of the same knowledge.
- `CONTRIBUTING.md` documents the adapter contract (Section 5.1) and the "no core changes for a new provider" rule, with a how-to for writing a new adapter.
- Security policy (`SECURITY.md`): how to report vulnerabilities, with a note about secrets handling.
- Never run secret-bearing integration jobs on fork PRs.

---

## 13. Sources

- Unity docs: Use the Unity CLI; Unity CLI reference (commands, exit codes, env vars, output formats).
- Unity blog: "CICD Made Easier with Unity CLI" (the install-if-needed shortcut the toolkit deliberately does not use — see S8 — plus `unity license activate --floating` / `return` and example `test` and `build` commands).
- XGameDev: "Unity CLI Explained" (third-party field report. Notes the CLI is labeled experimental and the `com.unity.pipeline` package is optional).
- `game-ci/unity-activate`, `unity-test-runner` and `game-ci/cli` source as supplied by the requester (patterns carried over or deliberately dropped, per Section 11).
- Spike 0 evidence: `docs/decisions/spike0-cli.md` (empirical CLI probes), `docs/decisions/spike0-research.md` (documentation review, with quotations and confidence labels) and `docs/decisions/upm-git-auth-probe.md` (how the Package Manager authenticates to a private git repository).

Spike 0 is complete: every assumption that this document previously marked as unverified is resolved in the Spike 0 outcomes section, and each resolution cites either the CLI's own output or an official Unity source.
