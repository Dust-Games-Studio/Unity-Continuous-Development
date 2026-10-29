# Unity CI Kit — M1–M3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `unity-ci-kit` — a provider-neutral runner around Unity's own `unity` CLI that installs, licenses, tests and builds a Unity project identically on a developer machine and in CI, emitting a machine-readable `summary.json` contract.

**Architecture:** Three layers, dependencies pointing one way: **Core** (`@unityci/core`, TypeScript → npm bin `unityci`) spawns `unity` via argv arrays only and owns the pass/fail verdict; **Adapters** (GitHub composite action, generic docs) are thin provider-specific YAML that call `unityci` and display results; **Unity CLI** is the only thing that touches the Editor. Core never reads `GITHUB_*`/`GITLAB_*`/`JENKINS_*`.

**Tech Stack:** TypeScript 5.9.3 (ESM, `module: nodenext`), Node runtime with **two floors** — **22.4** for the published package (`util.parseArgs`'s `allowNegative`) and **22.12** for the development toolchain (`vitest@5` declares `^22.12.0 || ^24.0.0 || >=26.0.0`, `vite@8` declares `^20.19.0 || >=22.12.0`), pnpm workspace, vitest 5, `yaml` 2.9 for `unity-ci.yml`. No runtime dependencies beyond `yaml`.

**Spec:** `unity-ci-design.md` (repo root). The plan argues from it; conflicts resolve against it, except where the plan's Global Constraints record a ruling that supersedes it.

---

## Global Constraints

These bind every task. Copy them verbatim into every dispatch.

- **GC1 — Runtime.** TypeScript 5.9.3 (NOT 7.x), ESM only (`"type": "module"`), `module`/`moduleResolution` = `nodenext`, `target` = `es2023`, `strict: true`. Build with `tsc`. Package name `@unityci/core`, bin name `unityci`. **Two Node floors, deliberately different:** the **published runtime** floor is **22.4** (`util.parseArgs`'s `allowNegative` landed in 22.4) → `core/package.json` declares `"engines": { "node": ">=22.4" }`; the **development toolchain** floor is **22.12** (`vitest@5` declares `^22.12.0 || ^24.0.0 || >=26.0.0` and `vite@8` declares `^20.19.0 || >=22.12.0`) → the root `package.json` declares `"engines": { "node": ">=22.12" }`, and `pnpm-workspace.yaml` sets **`engineStrict: true`** so an old runner fails the **install** with a clear message instead of failing obscurely at test time. pnpm 12 reads `engineStrict` from `pnpm-workspace.yaml`, **not** from `.npmrc` — an `.npmrc` `engine-strict=true` is inert (measured: the install still succeeds), so do not use one.
- **GC2 — Package manager.** pnpm workspaces. Root `package.json` is `private: true`. Only workspace package is `core`. `pnpm install` at the root installs everything.
- **GC3 — One spawn point.** `core/src/exec.ts` is the **only** module that may spawn any child process, and it always uses `spawn(file, argsArray, { shell: false })` — never a concatenated command string, never `shell: true`. `core/src/unity/exec.ts` is the only module that may spawn **`unity`**, and `core/src/packages/git.ts` the only one that may spawn **`git`**. Lint: `grep -rnE "\b(spawn|spawnSync|exec|execFile|execSync)\(" core/src --include=*.ts` must match only `core/src/exec.ts`; and the same grep for the literal `unity` must additionally match only `core/src/unity/exec.ts`.
- **GC4 — Provider neutrality.** `core/src/**` must not match `\b(GITHUB_|GITLAB_|JENKINS_|CIRCLECI_|BUILDKITE_|AZURE_)` except inside `core/src/report/annotations.ts`, which may reference `GITHUB_STEP_SUMMARY` and `GITHUB_OUTPUT` only. A conformance check enforces this. The **word boundary matters**: `UNITY_GITHUB_TOKEN` and `UNITY_GITLAB_TOKEN` are *Unity* environment variables — the names of the credentials Unity's own CLI strips from its child processes — and they must still appear in `core/src/exec.ts`'s strip list, so the lint must not match them. The lint's real intent is that the core must not read CI-provider *state*. Lint: `grep -rnE "\b(GITHUB_|GITLAB_|JENKINS_|CIRCLECI_|BUILDKITE_|AZURE_)" core/src --include=*.ts` must match only `core/src/report/annotations.ts`.
- **GC5 — Secrets are env-only.** `UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET`, `UNITY_LICENSE_SERIAL`, `UNITY_LICENSE_FILE_BASE64` and anything under `UNITYCI_SECRET_*` are read from the environment only. Never accepted as CLI flags, never written to `unity-ci.yml` (the loader must **reject** such keys with exit 64), never placed in `argv` of a child process. Redact registered secret values from every byte the core logs or writes. A **git** credential (for a private UPM package) is a separate channel and is not a `UNITYCI_*` value: it travels through git configuration only — never through a flag, a config file, or a command line (GC21, GC23, GC24).
- **GC6 — Redaction before logging.** Register all secret values into the redactor **before** the first log line is emitted. A redactor replaces each registered non-empty secret with `***`.
- **GC7 — Exit codes.** The core passes Unity's exit codes through unchanged and adds only two in a reserved range: **64** = core configuration/validation error, **65** = core internal error (unparsable Unity output, unexpected exception). Unity's codes to handle explicitly: `0` success, `2` usage, `3` auth, `4` needs config, `6` command failed (the run produced **no** verdict), `7` service unreachable, `8` tests ran and some failed (**never retried**), `9` install locked, `11` not a Unity project / release missing, `12` Editor unreachable, `13` unknown Editor command, `14` timeout, `130` SIGINT, `143` SIGTERM. **Branch on the exit code first** — `errors[0].code` is *not* a reliable branch key (a `--junit-output` usage error shipped with `"code": "COMMAND_FAILED"` on exit 2).
- **GC8 — Retry policy.** Unity's own machine-readable table (`unity commands --json` → `data.exitCodes[].retry`) marks `7`, `9`, `10`, `12`, `14`, `130` and `143` retryable and `6`, `8`, `11`, `13` terminal. The core's default is **`retry.onExitCodes: [7, 9, 12, 14]`**, `maxAttempts: 2`, backoff 5000 ms. It differs from Unity's table in two deliberate ways: **`10`** (`READY_TIMEOUT`) applies only to `unity open --until-ready` and is excluded, and **`130`/`143`** are interrupts — a signalled CI job must fail, never loop — so they are excluded even though Unity marks them retryable. **Exit 8 is never retried**, and a config listing `8`, `130` or `143` is rejected at validation time with exit 64 — as is `0`, because it is **success** and retrying a green run doubles the work. **Exit 6 is opt-in**: the reference docs are explicit that re-running an identical broken configuration reproduces the failure, so `6` may be added per pipeline but is capped at **one** extra attempt.
  Additionally: `unity test --timeout` exits **14** with `TEST_TIMED_OUT` (the reference doc's claim that it exits 6 is wrong), and a timed-out suite is an **infrastructure** failure — `summary.json` must not report it as red tests.
- **GC9 — License teardown is unconditional.** `unity license return --yes` runs in a `finally` after every `run test` / `run build`, including on failure, on SIGINT and on SIGTERM, with a bounded 60 s timeout. A failure of the teardown is logged loudly and **never** changes the primary exit code.
- **GC10 — Output layout.** Everything is written under `output.dir` (default `ci-output/`):
  `summary.json`, `tests/*.xml` (NUnit), `tests/*.junit.xml` (JUnit), `build/**`, `logs/editor.log`, `logs/cli-log.json`, `logs/doctor.json`.
  `unity build` accepts `--log-file`, so a build run writes `logs/editor.log`. `unity test` has **no** `--log-file` flag, so a test run leaves `logs.editor` as `null` rather than pretending to have captured it. `logs/cli-log.json` is `null` when the CLI has not written one.
- **GC11 — `summary.json` schema.** Exactly this shape, `schema: 1`:
  ```json
  { "schema": 1, "command": "test", "status": "passed|tests_failed|infra_failed|config_error",
    "exitCode": 0, "unityExitCode": 0, "attempts": 1, "cliVersion": "1.0.0-beta.14",
    "cliChannel": "beta", "cliCommit": "abc1234",
    "editorVersion": "6000.3.7f1", "durationMs": 123456,
    "tests": { "total": 0, "passed": 0, "failed": 0, "skipped": 0 },
    "reports": { "nunit": ["tests/editmode.xml"], "junit": ["tests/editmode.junit.xml"] },
    "license": { "mode": "serial", "activated": true, "returned": true, "seatLeaked": false },
    "artifacts": [], "logs": { "editor": "logs/editor.log", "cli": "logs/cli-log.json" } }
  ```
  The `license` object is the **machine-readable** form of the licence lifecycle, and it is the only place a leaked seat can be seen: `mode` is the configured mode, `activated` and `returned` are what the lifecycle actually did, and `seatLeaked` is true when the licence was an offline `--file` licence that `unity license return` could not free. A log warning nobody greps for is not a signal a CI system can act on. **The serial itself never appears** — only the mode and the booleans.
  `status` is derived from the exit code: `0` → `passed`; `8` → `tests_failed`; `64` → `config_error`; any other non-zero → `infra_failed`.
  `cliChannel` and `cliCommit` are additive fields (the spec's existing keys are unchanged) that make a failure traceable to an exact CLI build — R16.
- **GC12 — Never parse human output.** Every `unity` invocation whose output the core reads uses `--format json`. Human output is only streamed to the log.
- **GC13 — Child environment.** Every child `unity` process gets `UNITY_NON_INTERACTIVE=1`, `UNITY_NO_UPDATE_CHECK=1`, `UNITY_NO_BANNER=1`, `UNITY_NO_AGENT_HINTS=1`, `UNITY_NO_CLI_INVOKED_TELEMETRY=1`. `UNITY_NO_CRASH_REPORT=1` and `UNITY_NO_CONSENT_PROMPT=1` are added when `output.ci: true` (default true).
- **GC14 — Config precedence.** CLI flags > `UNITYCI_*` env vars > `unity-ci.yml` > built-in defaults. Unknown `UNITYCI_*` env vars produce a **warning**, never a failure.
- **GC15 — Input validation.** Any value that reaches a path, URL or argv is validated: version strings must match `^[A-Za-z0-9][A-Za-z0-9._+-]*$`; `output.dir` and every path under it must resolve inside the project root (path-traversal check); target names must match `^[A-Za-z0-9][A-Za-z0-9._+-]*$`. A violation is exit **64**.
  **Report paths must be files, not directories.** `unity test --output` accepts a directory silently, runs the tests, and then writes **no report at all** — no error, no warning. The core therefore rejects a report path that is an existing directory, and after every run **asserts the report exists and is non-empty** before it believes the result.
- **GC16 — `latest` is opt-in.** `unity.cli.version: "latest"` requires `unity.cli.allowLatest: true`; otherwise exit 64.
- **GC17 — The CLI version is advisory, never fatal on the high side.** The Unity CLI is experimental and **self-updates**: the Hub updates it automatically and that cannot be disabled, and winget/MSIX installs self-update with no rollback. A pinned version therefore cannot be guaranteed, so a running CLI **older** than the tested floor is exit 64, while a running CLI **newer** than the tested ceiling produces a loud warning and the run continues. `unity version --format json` (version, channel, commit) is recorded in `summary.json`.
- **GC18 — Capability probing, not version gating.** Beta releases add, rename and remove commands between fortnightly drops, so the core probes for what it needs (`unity version --format json`, plus the presence of the commands and flags it uses) and reports a clear "this CLI does not support X" error instead of crashing. A run is never failed solely because the CLI is newer than tested.
- **GC19 — Adapters never decide pass/fail.** An adapter may only install the binary, set env/flags, call `unityci`, read `summary.json` and files under `ci-output/`, and wire provider-native features (cache, artifacts, report display, job summary, secrets, an always-run teardown). It must not implement retries, exit-code interpretation, Unity output parsing, or version resolution.
- **GC20 — Commit discipline.** One commit per task, conventional-commit message (`feat:`, `test:`, `docs:`, `chore:`, `fix:`). Every commit must leave `pnpm -C core test` green.
- **GC21 — Credential material never enters a committed file.** `Packages/manifest.json` and `Packages/packages-lock.json` are committed, and Unity records a git dependency's URL in the lock file **exactly as written in the manifest**. A token embedded in the URL therefore lands in the repository. The supported mechanism rewrites git's **URL resolution**, never the manifest, so both files keep the plain URL.
- **GC22 — The core never handles credentials; the adapter does.** The core must not read `GITHUB_TOKEN`, `GH_TOKEN`, `UNITY_GITHUB_TOKEN`, `UNITY_SERVICE_ACCOUNT_ID` or `UNITY_SERVICE_ACCOUNT_SECRET`, and must not write git config. Adapters own secrets injection (GC19). What the core *does* own is **detection**: it reads the project's git dependencies, reports the hosts, and preflights that they are fetchable — all provider-neutral, from the manifest and lock file alone.
- **GC23 — Credentials travel by git configuration, not by Unity's token variables.** Unity's CLI strips `UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET`, `UNITY_GITHUB_TOKEN` and `UNITY_GITLAB_TOKEN` from every process it starts, so those variables do **not** reach the Editor's Package Manager or its git. Credentials must reach git through **git configuration**. Measured, end-to-end through `unity build` (`docs/decisions/upm-git-auth-probe.md`): Unity's Package Manager honours a URL rewrite delivered by the real `~/.gitconfig`, by `$XDG_CONFIG_HOME/git/config`, or by the per-invocation `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` variables — and it **ignores `GIT_CONFIG_GLOBAL`**, which is the most convenient-looking option and the one that fails.
- **GC24 — Masked and scrubbed.** An adapter that injects a credential masks its value in the log (`::add-mask::`) **before** the first use, never puts it in a command line (write the config with a shell **builtin**, not `git config --global url.…`, whose argument would carry the token), and removes what it wrote in the always-run teardown. A credential must never appear in a command line, in a log line, in `summary.json`, in `Packages/manifest.json`, in `Packages/packages-lock.json`, or in an artefact.

---

## Review Focus

Inputs and failure modes the spec implies that no task's tests obviously cover. Each line is pinned by a test in the task that owns the code.

1. **A test run where the Editor produced no report file at all** (crashed before writing XML, or `--output` was pointed at a directory — Unity accepts that silently, runs the tests, and writes nothing). The core must not report `total: 0, failed: 0` as a pass — that is a false green — nor treat exit 8 as "tests failed" without an artifact. → pinned in Task 9.
2. **JUnit requested but the CLI produced only NUnit** (older CLI, or the CLI's junit writer failed). The core must convert NUnit→JUnit itself and still publish a JUnit file. → pinned in Task 10.
3. **SIGINT arriving while `unity test` is running.** The core must return the license, write `summary.json`, and exit 130 — not leave a seat activated. → pinned in Task 11.
4. **`unity license activate` with a serial present in the environment.** The serial must never appear in the child's `argv`, in the core's log, or in `summary.json`. → pinned in Task 6.
5. **A `unity-ci.yml` containing a secret-looking key** (`license.serial`, `license.fileBase64`, anything matching `UNITY_SERVICE_ACCOUNT_*`). The loader must reject the file with exit 64 rather than honour it. → pinned in Task 3.
6. **`unity doctor --ci` reporting a blocking failure** (e.g. `EDITOR_NOT_ENTITLED`). `unityci doctor` must exit non-zero and `unityci run test` must refuse to start. → pinned in Task 5.
7. **A retryable exit 14 on the second attempt succeeding.** `summary.json` must report `attempts: 2` and the overall status `passed`, with the failed attempt's log preserved — and a timed-out suite must never be reported as red tests. → pinned in Task 9.
8. **A config that puts `8`, `130` or `143` in `retry.onExitCodes`.** The loader must reject it with exit 64 rather than silently retrying a failing test suite or looping on a signalled job. → pinned in Task 3.
9. **A project whose `Packages/manifest.json` points at a private git package, with no credentials configured.** The run must fail in seconds with the repo URL and the remedy — not after a ten-minute Editor launch with a confusing resolution error. → pinned in Task 5.
10. **A git dependency whose URL carries embedded credentials.** The core must detect it and **refuse to run**, because Unity copies that URL verbatim into the committed `packages-lock.json`. → pinned in Task 5.

---

## File Structure

```
/
├─ package.json                    # pnpm workspace root, private
├─ pnpm-workspace.yaml
├─ .gitignore
├─ unity-ci-design.md              # THE SPEC (Task 1 revises it in place)
├─ core/
│  ├─ package.json                 # @unityci/core, bin: unityci
│  ├─ tsconfig.json
│  ├─ vitest.config.ts
│  ├─ src/
│  │  ├─ cli.ts                    # entrypoint + command dispatch
│  │  ├─ args.ts                   # argv parsing (node:util parseArgs), no deps
│  │  ├─ exit-codes.ts
│  │  ├─ logger.ts
│  │  ├─ redact.ts
│  │  ├─ exec.ts                    # the ONLY place a child process is spawned
│  │  ├─ context.ts                # CoreContext
│  │  ├─ config/{schema,validate,env,load}.ts
│  │  ├─ packages/{deps,git}.ts    # private git package detection + fetch preflight
│  │  ├─ unity/{exec,cli}.ts       # exec.ts is the ONLY spawn point
│  │  ├─ lifecycle/{setup,license,retry,signals,test,build}.ts
│  │  ├─ report/{nunit,junit,summary,annotations}.ts
│  │  └─ commands/{doctor,setup,license,run,report,cache-info}.ts
│  └─ test/                        # vitest, uses the fake-unity binary
│     ├─ fixtures/{editmode-pass.xml,editmode-fail.xml,doctor.json,license.json}
│     └─ *.test.ts
├─ testing/
│  ├─ fake-unity/                  # stub `unity` driven by a scenario file
│  └─ conformance/check-adapters.ts
├─ adapters/
│  ├─ github/{action.yml,README.md}
│  └─ generic/README.md
├─ examples/minimal-project/       # real Unity project: 1 EditMode test + 1 build method
├─ docs/{decisions,local-development.md,generic-ci.md,compatibility.md,private-packages.md}
├─ .github/workflows/{ci.yml,example.yml,nightly.yml}
└─ README.md
```

---

## Task 1: Spike 0 decision records and spec revision

**Files:**
- Create: `docs/decisions/spike0-cli.md`, `docs/decisions/spike0-research.md` (already written by the research subagents — commit them verbatim, do not rewrite)
- Modify: `unity-ci-design.md` (resolve every `[VERIFY]` tag; add a "Spike 0 outcomes" section)

**Interfaces:**
- Consumes: the two research files already present in `docs/decisions/`.
- Produces: `unity-ci-design.md` with all nine `[VERIFY]` tags replaced by a resolved answer, and a `## Spike 0 outcomes` section that states the corrected facts. Later tasks cite this file as the spec.

- [ ] **Step 1: Commit the two research files as-is**

```bash
git add docs/decisions/spike0-cli.md docs/decisions/spike0-research.md
git commit -m "docs: add Spike 0 research answers (S1-S9)"
```

- [ ] **Step 2: Revise `unity-ci-design.md`**

Replace each `[VERIFY]` marker with the empirically confirmed answer. The confirmed facts, which the revision MUST reflect:

| Tag | Resolved answer |
|---|---|
| S9 | Unity's docs state plainly: "The Unity command-line interface (CLI) is experimental. The features and documentation might change in an upcoming release." Versions are `1.0.0-beta.N`, shipping roughly fortnightly (beta.1 on 2026-06-30 → beta.14 on 2026-10-21). There is **no stable channel yet** — the installer "gets the latest beta on its own" "until a stable release ships", and `unity self-update --check --channel stable` is documented as the check you run "when moving off a beta once GA ships". **GA is undated.** Breaking changes ship per-beta under "Breaking changes" headings (beta.7 reached the beta channel and was withdrawn the same day it shipped), so a hard minimum-version gate would rot within weeks. **Pinning is not trustable**: "The Unity Hub updates the Unity CLI automatically. You can't disable these updates in the Hub", and "If you installed the CLI as an MSIX package, including through winget, Windows keeps the CLI current in the background. Rollback isn't available for MSIX installs." Therefore pinning is an **install-method policy** (apt/dnf/brew with an explicit version, or a standalone binary outside the Hub's path), not a version string, and the toolkit ships a **capability matrix** rather than a minimum-version constant. A CLI newer than tested is a loud warning, not a failure (GC17, GC18). |
| S1 | `unity license activate` accepts `--serial`, `--personal`, `--floating`, `--file` (.ulf/.xml), `--generate-request` (.alf). In CI: **only `--serial`, `--floating` and `--file` work** — Unity's licensing backend rejects service-account tokens, so `--personal` is unavailable in CI. The serial is read from the `UNITY_LICENSE_SERIAL` environment variable when no `--serial` and no other activation option is passed, so it never appears in `argv`. `--generate-request` is **not** an unattended route (it writes an `.alf` that must be exchanged elsewhere and imported with `--file`). There is **no `UNITY_LICENSING_SERVER` environment variable** — the floating endpoint comes from the machine's `licensingServiceBaseUrl` setting, readable with `unity license server list --format json` (`data.servers[]`). A licence's state is readable with `unity license status --format json` → `data.active`, `data.authMode`, `data.licenses[]`, `data.floatingServer`; an offline `--file` licence **cannot be returned** (`license return` leaves it in place), so those runners leak seats and must be counted by hand. |
| S2 | `unity test` flags to expose: `--mode` (exactly **one** per invocation — a repeated `--mode` is *not* a usage error; the CLI silently lets the **last one win**, so the core must own mode selection), `--filter`, `--output`, `--report-format nunit,junit`, `--junit-output`, `--shard N/M`, `--shard-inventory`, `--retries`, `--rerun-failed`, `--affected`, `--affected-compare`, `--since`, `--coverage`, `--coverage-output`, `--coverage-options`, `--editor-version`, `--allow-install`, `--timeout`. **`--output` is a FILE path**: a directory is accepted silently, the tests still run, and **no report is written at all** — no error, no warning. `unity build` flags to expose: `--target`, `--profile`, `--create-profile`, `--execute-method`, `--output-path`, `--log-file`, `--args`, `--versioning-strategy`, `--build-version`, `--android-export-type`, `--android-version-code`, `--android-target-sdk-version`, `--android-symbol-type`, `--allow-dirty-build`, `--provenance-path`, `--timeout`. `unity build` works with **no** `--execute-method`: on Unity 6 it auto-discovers a Build Profile, and with a desktop `--target` it drives the legacy player flags. `unity build --list-targets --format json` is machine-readable and its rows carry a `zeroCode` boolean (`StandaloneWindows64`/`StandaloneLinux64`/`StandaloneOSX` are zero-code; `Android`, `WebGL`, `iOS` and the rest are not). |
| S3 | `--format github` and `--output` are independent and compose — one invocation produced `::error::` annotations on stdout **and** two report files on disk. Unity's Test Framework emits **NUnit 3** (`<test-run … testcasecount=… total=… passed=… failed=…>` with `<test-suite>`/`<test-case>` children), not NUnit 2. `--report-format nunit,junit` + `--junit-output` is a **valid, verified** combination; `--report-format junit` **with** `--junit-output` is a pre-flight usage error (exit 2, no Editor spawned) because with `junit` alone the JUnit report *is* `--output`. The core therefore always requests `nunit,junit` and passes both paths, and writes its own NUnit→JUnit converter against the **NUnit 3** schema as a fallback only. |
| S4 | Unity's own machine-readable table (`unity commands --json` → `data.exitCodes[].retry`) is authoritative: `7` (service unreachable), `9` (install locked), `10` (ready timeout), `12` (Editor unreachable), `14` (timeout), `130` (interrupted) and `143` (terminated) are **retryable**; `6`, `8`, `11` and `13` are **terminal**. Exit **8** = tests ran and some failed → never retry. Exit **6** = the run produced **no** verdict (compile error, crash, expired licence, unknown platform) → terminal by default, opt-in per pipeline and then capped at **one** extra attempt, because re-running an identical broken configuration reproduces the failure. Exit **14** = timeout → retryable, and **infrastructure**: `unity test --timeout 1` was measured to exit **14** with `TEST_TIMED_OUT` (the reference doc's claim that a `--timeout` exits 6 is **wrong** for this build), and a timed-out suite must not be reported as red tests. Exit **11** = the path is not a Unity project or the release/module does not exist. The core's default retry set is `[7, 9, 12, 14]` — it excludes `10` (only applies to `unity open --until-ready`) and `130`/`143` (a signalled CI job must fail, not loop). |
| S5 | Unity's **official support statement excludes the environment we are building for**: "the Unity Editor is supported on workstations or laptop form factors running without emulation, container or compatibility layer", and the supported Linux Editor target is Ubuntu 22.04 / 24.04 on x64 with a Gnome desktop on X11/Wayland and an OpenGL 3.2+/Vulkan GPU. A bare CI runner therefore **works** (Unity's own release notes record that `unity test` "now runs on a Linux machine without a display server") but is **outside Unity's support statement** — the toolkit must say so rather than imply support. RHEL 9 is a **CLI-only** platform: the CLI supports it (glibc ≥ 2.34) but the Editor does not. No virtual display is needed: use `-nographics`, which exists precisely to "run automated workflows on machines that don't have a GPU"; `xvfb` is not installed by default and PlayMode-without-a-display is **UNRESOLVED**. The shared-library set is **inferred, not Unity-published** (Unity's last published dependency list is from Unity 5.x in 2015). The set Unity's own `unity ci init` scaffold installs for Ubuntu 24.04 (noble) is: `libgl1 libglu1-mesa libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libdrm2 libxtst6 libxrandr2 libxcursor1 libxcomposite1 libxdamage1 libxfixes3 libxi6 libxrender1 libxext6 libsm6 libice6 libxkbcommon0 libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 libnotify4 libsecret-1-0` — drop the `t64` suffix on pre-24.04 images. Also raise the open-file limit (`ulimit -n 4096`). The Editor download cache lives at `$XDG_CONFIG_HOME/unityhub/downloads` (Linux) / `%APPDATA%\UnityHub\downloads` (Windows) / `~/Library/Application Support/UnityHub/downloads` (macOS). |
| S6 | Yes — an already-installed Editor is reused with **no** install step at all: every probe ran against the pre-installed `6000.6.6f1`, resolved from `ProjectVersion.txt`. The whole prerequisite check is `unity editors --installed --format json` plus `unity install-path`; only when the list lacks the project's version does an install become necessary, which makes a restored/cached Editor a first-class fast path. **Modules must be verified too**: a row with `"modules": ""` is a valid installed Editor that lost its platform modules, so a version-only check passes and the build fails much later. `unity install` has **no** `--allow-install` flag (that flag lives on `build`/`test`/`run`); its only reuse-related flags are `-f, --force` ("Force reinstall of an already-installed editor", so the default is "already installed → leave it alone") and `--resume`. `unity install-path` is a global getter/setter with no subcommands — cache the **download cache** (`unity cache info` → the path), never the install directory, because installs are shared with the Hub and other projects. `unity cache key [project] --target <target>` is the CI cache key for `Library/` (Editor version + resolved package set + target) and **excludes script content by design**, so a script-only change must not be treated as a cache miss by the toolkit's own logic. `unity install --download-directory <dir>` (new in beta.14) installs a self-contained Editor into a named folder without registering it with the Hub, but then `unity test`/`unity build` would need `--editor-path`; it is deferred for the MVP. `unity install` refuses an Editor the licence does not cover (`EDITOR_NOT_ENTITLED`). |
| S7 | **CONFIRMED** for `unity test`, which Unity's own CLI reference describes as running the tests "directly via the editor command line — no pipeline package or server is involved". `unity build` is **INFERRED** to be the same: the package requirement is stated on every command that drives a *running* Editor (`command`, `status`, `run --command`, `recompile`, `mcp`, `logs --console`) and is absent from `build` and `test`; Unity's own generated CI workflow installs the package never and still runs `unity doctor --ci`, `unity test` and `unity build`. `unity projects create` now adds the package to every new project; `--bare` leaves it out. The toolkit must **never** add a package to a user's project to run CI. |
| S8 | `--allow-install` itself has **no EULA surface and no EULA flag** — it is a three-word convenience on `build`/`test`/`run` meaning "install the project's editor version if it is not already installed", and it cannot carry `--accept-eula`. The separate `unity install` command has `--accept-eula` ("Accept all module license agreements automatically") and `-y, --yes`, and Unity's own generated CI workflow uses both together: `unity install 6000.0.47f1 --yes --accept-eula`. The safe pattern is therefore an **explicit** install step with `--yes --accept-eula`, with `--allow-install` used only as a recovery path — and since whether the install `--allow-install` triggers accepts the EULA cannot be verified, the core **never** sends it and instead fails fast with the exact install command. EULA acceptance is a **declared** config input (`unity.editor.acceptEula`), not a silent default, because it means accepting Unity's and every module's licence agreements on the user's behalf. A separate step is still required for the Editor Software Terms: `unity terms accept <version> --yes`, and the first Editor launch otherwise stops on the "Unity Editor Software Terms" dialog. |

Add a `## Spike 0 outcomes` section to the spec recording the table above, and add these corrections to the spec body:

- **D8 revised:** the core asks `unity test` for `nunit,junit` and converts NUnit→JUnit only as a fallback when no JUnit file was produced.
- **New requirement R10:** the lifecycle must run `unity terms accept <editorVersion> --yes` after installing the Editor and before the first batch-mode run, otherwise the Editor stops on the Software Terms dialog.
- **New requirement R11:** `unity doctor --ci` is the preflight gate; its JSON report (`data.verdict`, `data.checks[]` with `id`/`status`/`code`/`blocking`/`message`) is what `unityci doctor` consumes.
- **New requirement R12:** Unity ships `unity ci init --provider github|gitlab`, which generates a complete stock workflow (install, caches, runtime libraries, license, preflight, test, build, license return). `unity-ci-kit` does **not** reimplement that; it adds what the stock workflow lacks — provider-neutrality beyond GitHub/GitLab, local execution identical to CI, a `summary.json` contract, retries, and guaranteed license teardown under signals. The GitHub adapter reuses Unity's proven install/cache/library sequence and adds the missing guarantees.
- **D9 revised — the CLI version is recorded, not enforced.** Replace "The Unity CLI version is pinned in config" with: the configured version is the **tested** version, recorded in every artefact; a running CLI older than the tested floor fails, a newer one warns. Rationale: the CLI self-updates and cannot be reliably pinned (S9).
- **New requirement R13 — capability matrix.** The core probes `unity version --format json` and the presence of the commands and flags it needs, and degrades with a clear message when one is missing. It must never fail a run solely because the CLI is newer than tested.
- **New requirement R14 — `-nographics` by default.** EditMode test runs and batch builds pass `-- -nographics` so a machine without a GPU works. It is a config knob and is **off** for PlayMode, where simulated input needs a graphics device.
- **New requirement R15 — state the support caveat.** The README and `docs/local-development.md` must say plainly that Unity's own support statement covers "workstations or laptop form factors running without emulation, container or compatibility layer", that a bare CI runner works but sits outside that statement, and that RHEL 9 supports the CLI but not the Editor.
- **New requirement R16 — record the CLI identity.** `unity version --format json` (version, channel, commit) is captured at the start of every run and stored in `summary.json`, so a failure can be traced to an exact CLI build. `unity build`'s provenance manifest already records it and is merged in.
- **New requirement R17 — the licence is a precondition, not a step the toolkit owns.** `unity license status --format json` reports `data.active`; the core checks it and fails fast with exit 64 when no licence is active, instead of attempting an activation it cannot perform unattended. The three documented unattended routes are `--serial` (from a secret), `--floating` (with `unity license server status` checked first) and `--file` (a base64 secret decoded to a `.ulf`). The docs must state that an offline `--file` licence **cannot be returned** — those runners leak seats.
- **New requirement R18 — never trust a result you did not verify.** A report that was not written is not a pass, and an exit code without an artifact is not a verdict. The core asserts every artifact exists and is non-empty before it reports on it, and treats "ran but produced nothing" as an infrastructure failure (exit 6) rather than a green or a red test run.
- **New requirement R19 — private git packages are a first-class concern.** A project may depend on a package in a private git repository. The design must cover three things: (a) **detection** — the core reads the project's git dependencies, reports their hosts, and refuses to run if a URL embeds credentials, because Unity copies that URL verbatim into the committed `packages-lock.json`; (b) **preflight** — the core proves each dependency is fetchable with `git ls-remote`, using the same git configuration the Package Manager will use, so a missing credential fails in seconds instead of ten minutes into an Editor launch; (c) **credential supply** — the adapter's job, never the core's, because the credential is a provider secret. The supported mechanism is a **git URL rewrite** (the manifest keeps a credential-free URL; git applies the credential at fetch time), measured in `docs/decisions/upm-git-auth-probe.md`: Unity's Package Manager honours a rewrite in `~/.gitconfig`, in `$XDG_CONFIG_HOME/git/config`, and through the per-invocation `GIT_CONFIG_*` variables, and **ignores `GIT_CONFIG_GLOBAL`**.

- [ ] **Step 3: Commit the spec revision**

```bash
git add unity-ci-design.md
git commit -m "docs: resolve Spike 0 verification tags in the design spec"
```

- [ ] **Step 4: Verify no unresolved tags remain**

Run: `grep -n "\[VERIFY\]" unity-ci-design.md`
Expected: no output (exit 1 from grep is the pass condition).

---

## Task 2: Workspace scaffolding and core skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `core/package.json`, `core/tsconfig.json`, `core/vitest.config.ts`
- Modify: `.gitignore`
- Create: `core/src/exit-codes.ts`, `core/src/logger.ts`, `core/src/redact.ts`, `core/src/args.ts`
- Test: `core/test/redact.test.ts`, `core/test/logger.test.ts`, `core/test/args.test.ts`

**Interfaces:**
- Consumes: nothing (first task in the code).
- Produces:
  - `core/src/exit-codes.ts` → `export const EXIT = { SUCCESS: 0, ERROR: 1, BAD_ARGS: 2, AUTH_ERROR: 3, NEEDS_CONFIG: 4, COMMAND_FAILED: 6, NETWORK_UNREACHABLE: 7, TESTS_FAILED: 8, NOT_FOUND: 11, EDITOR_UNREACHABLE: 12, REMOTE_COMMAND_FAILED: 13, TIMEOUT: 14, CONFIG_ERROR: 64, INTERNAL_ERROR: 65, INTERRUPTED: 130, TERMINATED: 143 } as const`, `export type ExitCode = (typeof EXIT)[keyof typeof EXIT]`, `export function describeExit(code: number): string`.
  - `core/src/redact.ts` → `export interface Redactor { register(value: string | undefined | null): void; redact(text: string): string; readonly secrets: string[] }`, `export function createRedactor(): Redactor`.
  - `core/src/logger.ts` → `export interface Logger { info(msg: string): void; warn(msg: string): void; error(msg: string): void; debug(msg: string): void }`, `export function createLogger(opts: { redactor: Redactor; level?: 'debug'|'info'|'warn'|'error'; sink?: (line: string) => void }): Logger`. Every line the logger writes passes through `redactor.redact()`.
  - `core/src/args.ts` → `export interface ParseResult { command: string[]; flags: Record<string, string | boolean | string[]>; passthrough: string[] }`, `export interface OptionSpec { type: 'string' | 'boolean'; short?: string; multiple?: boolean }`, `export function parseArgs(argv: string[], extraOptions?: Record<string, OptionSpec>): ParseResult` built on `node:util`'s `parseArgs` in a **single strict pass**. The declared schema is the global flags `--project-path/-p`, `--config`, `--output-dir`, `--annotations`, `--ci`/`--no-ci`, `--verbose`, `--quiet`, `--help/-h`, `--version/-v`, `--json`; `extraOptions` is the extension point later tasks use to declare command-specific flags (GC14's "flags beat env beat file"). **Unknown options are a usage error — there is no open set.** Tokens after a literal `--` are collected in `passthrough` and are never parsed as options.

- [ ] **Step 1: Write the failing tests**

`core/test/redact.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createRedactor } from '../src/redact.js';

describe('createRedactor', () => {
  it('replaces a registered secret with ***', () => {
    const r = createRedactor();
    r.register('s3cret');
    expect(r.redact('token=s3cret end')).toBe('token=*** end');
  });
  it('ignores empty, null and undefined registrations', () => {
    const r = createRedactor();
    r.register(''); r.register(null); r.register(undefined);
    expect(r.redact('nothing to hide')).toBe('nothing to hide');
  });
  it('never replaces an empty string, which would match everywhere', () => {
    const r = createRedactor();
    r.register('');
    expect(r.redact('abc')).toBe('abc');
  });
  it('registers a secret added after the first redact call', () => {
    const r = createRedactor();
    r.redact('x');
    r.register('late');
    expect(r.redact('late')).toBe('***');
  });
});
```

`core/test/logger.test.ts`:
```ts
it('writes one newline-terminated line per message', () => { /* sink capture */ });
it('redacts a registered secret before writing the line', () => { /* the sink never sees the secret */ });
it('redacts a secret registered after the logger was created', () => { /* GC6 ordering */ });
it('suppresses debug messages at the default level', () => { /* nothing written */ });
it('emits debug messages at the debug level', () => { /* written */ });
it('suppresses messages below the configured level', () => { /* nothing written */ });
```

`core/test/args.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('splits a command path from its flags', () => {
    const r = parseArgs(['run', 'test', '--project-path', 'C:/p', '--ci']);
    expect(r.command).toEqual(['run', 'test']);
    expect(r.flags['project-path']).toBe('C:/p');
    expect(r.flags.ci).toBe(true);
  });
  it('collects a repeated flag into an array', () => {
    const r = parseArgs(['run', 'test', '--mode', 'EditMode', '--mode', 'PlayMode'], { mode: { type: 'string', multiple: true } });
    expect(r.flags.mode).toEqual(['EditMode', 'PlayMode']);
  });
  it('supports --flag=value form', () => {
    expect(parseArgs(['run', '--output-dir=ci-out']).flags['output-dir']).toBe('ci-out');
  });
  it('treats an unknown flag as a usage error', () => {
    expect(() => parseArgs(['run', '--nope'])).toThrow(/nope/);
  });
  it('treats an unknown flag with a value as a usage error', () => {
    expect(() => parseArgs(['run', '--nope', 'value'])).toThrow(/nope/);
  });
  it('merges extraOptions with the global schema instead of replacing it', () => {
    const r = parseArgs(['--output-dir', 'ci-out', '--mode', 'EditMode'], { mode: { type: 'string' } });
    expect(r.flags['output-dir']).toBe('ci-out');
    expect(r.flags.mode).toBe('EditMode');
  });
  it('does not consume the next token for a declared boolean option', () => {
    const r = parseArgs(['run', '--verbose', 'test'], { verbose: { type: 'boolean' } });
    expect(r.flags.verbose).toBe(true);
    expect(r.command).toEqual(['run', 'test']);
  });
  it('omits a multiple option that was not supplied', () => {
    const r = parseArgs(['run'], { mode: { type: 'string', multiple: true } });
    expect('mode' in r.flags).toBe(false);
  });
  it('returns an array for a multiple option supplied once', () => {
    const r = parseArgs(['run', '--mode', 'EditMode'], { mode: { type: 'string', multiple: true } });
    expect(r.flags.mode).toEqual(['EditMode']);
  });
  it('collects tokens after -- as passthrough and does not parse them as options', () => {
    const r = parseArgs(['run', 'test', '--', '-nographics']);
    expect(r.command).toEqual(['run', 'test']);
    expect(r.passthrough).toEqual(['-nographics']);
  });
  it('returns an empty passthrough when there is no --', () => {
    expect(parseArgs(['run', 'test']).passthrough).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test`
Expected: FAIL — `Cannot find module '../src/redact.js'`.

- [ ] **Step 3: Implement `redact.ts`, `logger.ts`, `exit-codes.ts`, `args.ts`**

`redact.ts` holds a `Set<string>` of non-empty secrets and replaces every occurrence with `***`. Longest-first replacement so an overlapping shorter secret does not partially mask a longer one.

`logger.ts` writes one line per message to `sink` (default `process.stdout.write`), passing the line through `redactor.redact()` first. `debug` is a no-op unless `level === 'debug'`.

`args.ts` uses `parseArgs` from `node:util` in a **single strict pass** with `allowPositionals: true`, `allowNegative: true` (so `--no-ci` negates `--ci`). The declared schema is the global flags — `--project-path/-p`, `--config`, `--output-dir`, `--annotations`, `--ci`/`--no-ci`, `--verbose`, `--quiet`, `--help/-h`, `--version/-v`, `--json` — merged with any `extraOptions` the caller supplies. **Unknown options are a usage error**; there is no open set, because a bare unknown flag cannot be told apart from a typo without a per-command registry. Tokens after a literal `--` are collected in `passthrough` and are never parsed as options. `allowNegative` requires **Node 22.4 or newer**, which is the runtime floor the package declares.

Fix the root `.gitignore` at the same time. It carries a NuGet rule `**/[Pp]ackages/*` that would ignore a Unity project's `Packages/manifest.json` and `Packages/packages-lock.json` — and the lock file is exactly what `unity cache key` hashes, so an ignored lock file silently breaks the CI cache key. Append:

```
### Unity projects
!**/[Pp]ackages/manifest.json
!**/[Pp]ackages/packages-lock.json
node_modules/
!*/src/packages/**
dist/
*.tsbuildinfo
ci-output/
.superpowers/
```

The `!*/src/packages/**` negation is **not** cosmetic. The pre-existing NuGet rule `**/[Pp]ackages/*` matches the toolkit's **own** source directory `core/src/packages/`, so without the negation any new file placed there is invisible to `git status` and to `git add .` — it would be silently lost. Verified: with the rule alone, `git check-ignore --no-index -v core/src/packages/<new>.ts` matches; with the negation, `git status` reports the file and `git add -n` stages it.

`core/package.json` declares `"type": "module"`, `"bin": { "unityci": "./dist/cli.js" }`, the three dev dependencies at their exact pinned versions (`typescript@5.9.3`, `vitest@5.0.5`, `@types/node@26.6.5`), the scripts `build` (`tsc -p tsconfig.json`), `typecheck` (`tsc -p tsconfig.test.json`) and `test` (`vitest run`), and `"engines": { "node": ">=22.4" }`.

**The tests are typechecked too.** `core/tsconfig.json` is the *build* config — `include: ["src/**/*.ts"]`, `rootDir: "src"`, `outDir: "dist"` — so the test files are outside it. `core/tsconfig.test.json` extends it, sets `noEmit: true`, `rootDir: "."` and `include: ["src/**/*.ts", "test/**/*.ts"]`, and the `typecheck` script points at **that** file. A plain `tsc --noEmit` over the build config silently skips every test file, so a test that does not compile would pass the typecheck and fail only at runtime.

The **root** `package.json` declares `"engines": { "node": ">=22.12" }` — the development toolchain's floor — and `pnpm-workspace.yaml` contains `engineStrict: true` alongside `packages:` so pnpm refuses to install on an older Node instead of failing later at test time.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — every test green (redact, logger and args).

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml .gitignore core
git commit -m "chore: scaffold pnpm workspace and core primitives"
```

---

## Task 3: Config schema, validation and precedence

**Files:**
- Create: `core/src/config/schema.ts`, `core/src/config/validate.ts`, `core/src/config/env.ts`, `core/src/config/load.ts`, `core/src/context.ts`
- Test: `core/test/config.test.ts`

**Interfaces:**
- Consumes: `EXIT` from `core/src/exit-codes.ts`.
- Produces:
  - `core/src/config/schema.ts` → `export interface Config` (exact shape below), `export const DEFAULT_CONFIG: Config`, `export type ConfigIssue = { path: string; message: string }`.
  - `core/src/config/validate.ts` → `export function validateConfig(config: Config): ConfigIssue[]`.
  - `core/src/config/env.ts` → `export const ENV_KEYS: Record<string, string>` mapping each `UNITYCI_*` env var to its config path, `export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }`, and `export function readEnvConfig(env: NodeJS.ProcessEnv): { patch: DeepPartial<Config>; unknown: string[]; warnings: string[] }`. The patch is **deep**: `Partial<Config>` cannot express a nested path such as `unity.cli.version`. `unknown` holds env vars that are **not** in `ENV_KEYS`; `warnings` holds **malformed values for known vars** (a non-boolean where a boolean is expected). The two are different conditions and must not share one channel.
  - `core/src/config/load.ts` → `export function loadConfig(opts: { projectPath: string; cwd: string; argv: ParseResult['flags']; env: NodeJS.ProcessEnv; configFile?: string }): { config: Config; issues: ConfigIssue[]; unknownEnvVars: string[]; warnings: string[]; projectPath: string }`. The `argv` type is the parser's own `ParseResult['flags']` — do not restate it, or the two drift apart. **`projectPath` is the already-resolved project root**, supplied by the caller (from `--project-path`, else the working directory). The config file is discovered **at the project root** (`<projectPath>/unity-ci.yml`), not at the working directory — otherwise `unityci run test --project-path examples/minimal-project` would silently ignore that project's own configuration.
  - `core/src/context.ts` → `export interface CoreContext { config: Config; cwd: string; projectPath: string; env: NodeJS.ProcessEnv; logger: Logger; redactor: Redactor; binary: string; startedAt: number; cliVersion: string | null; licenseActivated?: boolean }`. `licenseActivated` starts unset and is set to `true` by the run loop immediately after an activation that took a seat — it is how the teardown knows the difference between "return the seat we took" and "return whatever licence this machine happens to have". It is **optional on purpose**, so an absent value is **fail-closed**: a context that predates the field, or a fixture that does not set it, cannot accidentally cause a licence to be returned.

`Config` shape (the spec's surface plus the additions Spike 0 forces):

```ts
export interface Config {
  unity: {
    cli: { version: string; allowLatest: boolean; binary: string };
    editor: { version: string; changeset: string | null; modules: string[]; childModules: boolean; terms: boolean; acceptEula: boolean };
  };
  license: { mode: 'none' | 'serial' | 'floating' | 'offline-file' | 'personal'; serialEnv: string; fileEnv: string };
  packages: { preflight: boolean };
  test: { modes: string[]; outputDir: string; filter: string | null; coverage: boolean; shards: string | null; retries: number; nographics: boolean };
  build: { target: string; profile: string | null; executeMethod: string | null; outputPath: string; versioningStrategy: 'none' | 'semantic' | 'tag' | 'custom'; buildVersion: string | null; androidVersionCode: number | null; allowDirtyBuild: boolean };
  retry: { onExitCodes: number[]; maxAttempts: number; backoffMs: number };
  output: { dir: string; annotations: 'none' | 'github'; ci: boolean };
}
```

- [ ] **Step 1: Write the failing tests**

`core/test/config.test.ts` must cover, at minimum:

```ts
// precedence
it('lets a CLI flag beat an env var and a config file', () => { /* flag wins */ });
it('lets an env var beat a config file', () => { /* env wins */ });
it('uses the config file when nothing else is set', () => { /* file wins over default */ });

// env
it('maps UNITYCI_TEST_MODES to test.modes', () => { /* ['EditMode','PlayMode'] */ });
it('warns but does not fail on an unknown UNITYCI_ var', () => { /* unknownEnvVars contains it, issues is empty */ });

// secrets
it('rejects a unity-ci.yml that contains a secret key', () => {
  const { issues } = loadConfig({ projectPath: tmp, cwd: tmp, argv: {}, env: {}, configFile: write('unity-ci.yml', 'license:\n  serial: "hunter2"\n') });
  expect(issues.some(i => /secret/i.test(i.message))).toBe(true);
});

// validation
it('rejects latest unless allowLatest is true', () => { /* version 'latest' */ });
it('rejects exit code 8 in retry.onExitCodes', () => { /* must never be retried */ });
it('rejects exit code 130 or 143 in retry.onExitCodes', () => { /* interrupts must fail, not loop */ });
it('caps exit code 6 at one extra attempt when it is enabled', () => { /* maxAttempts 2 */ });
it('rejects a version string with a shell-unsafe character', () => { /* '6000.0.47f1; rm -rf /' */ });
it('rejects an output dir that escapes the project root', () => { /* '../outside' */ });
it('rejects a report path that is an existing directory', () => { /* unity test silently writes no report */ });
it('accepts a build output path that is an existing directory', () => { /* unity build --output-path ./Build/WebGL is a directory */ });
it('accepts a normal config', () => { /* issues is empty */ });

// the validator is exercised directly, not only through the loader
it('validateConfig returns issues and does not mutate the config it is given', () => { /* purity */ });
it('validateConfig leaves retry.maxAttempts alone when exit code 6 is absent', () => { /* no cap */ });
it('the loader applies the exit-code-6 cap, not the validator', () => { /* maxAttempts === 2 after load */ });

// the project root, not the working directory, decides which config file is read
it('discovers unity-ci.yml at the project root', () => { /* not at cwd */ });
it('returns the resolved project path', () => { /* echoed back */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the four modules**

`schema.ts` — the `Config` interface, `DEFAULT_CONFIG`:
```ts
unity: { cli: { version: '1.0.0-beta.14', allowLatest: false, binary: 'unity' },
         editor: { version: 'from-project', changeset: null, modules: [], childModules: true, terms: true, acceptEula: false } },
license: { mode: 'none', serialEnv: 'UNITY_LICENSE_SERIAL', fileEnv: 'UNITY_LICENSE_FILE_BASE64' },
packages: { preflight: true },
test: { modes: ['EditMode'], outputDir: 'ci-output/tests', filter: null, coverage: false, shards: null, retries: 0, nographics: true },
build: { target: 'StandaloneWindows64', profile: null, executeMethod: null, outputPath: 'ci-output/build/game',
         versioningStrategy: 'none', buildVersion: null, androidVersionCode: null, allowDirtyBuild: false },
retry: { onExitCodes: [7, 9, 12, 14], maxAttempts: 2, backoffMs: 5000 },
output: { dir: 'ci-output', annotations: 'none', ci: true }
```

`validate.ts` — returns issues (never throws):
- version strings must match `^[A-Za-z0-9][A-Za-z0-9._+-]*$` — except the sentinel `from-project` and the literal `latest`.
- `latest` without `allowLatest: true` → issue.
- `retry.onExitCodes` containing `8`, `130` or `143` → issue ("this exit code is never retried"). `0` is rejected too: it is **success**, and retrying a successful run would double the job's work and can turn a flaky-but-green suite into a flaky-and-red one. `6` is allowed, but because re-running an identical broken configuration reproduces the failure, `6` caps `retry.maxAttempts` at 2 (one extra attempt). **The cap is applied by `loadConfig` after validation, not by `validateConfig` itself** — the validator is pure and returns issues; it does not mutate the config it is given.
- `output.dir`, `test.outputDir`, `build.outputPath` must resolve inside the project root (reject `..` escapes and absolute paths outside the root).
- A report path (`test.outputDir` files) that is an **existing directory** → issue. `unity test --output <dir>` runs the tests and writes no report at all, silently. The rule applies to **test report paths only**: `build.outputPath` may legitimately be a directory, because Unity's own CLI documents `unity build --profile WebGL --output-path ./Build/WebGL` — a directory — for directory-style targets. The core creates the output's **parent directory** before invoking `unity build`.
- `test.modes` entries must be `EditMode` or `PlayMode`.
- `license.serialEnv` and `license.fileEnv` must **not** name one of the variables the spawn layer strips (`UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET`, `UNITY_GITHUB_TOKEN`, `UNITY_GITLAB_TOKEN` — exported as `STRIPPED_ENV_VARIABLES` from `core/src/exec.ts`). A serial carried in a stripped variable would be removed from the child environment before `unity license activate` could read it, and the activation would fail with a message that says nothing about the cause.
- `license.mode` must be one of the five listed values.
- `build.target` and `build.profile` must match the version-string regex.
- `retry.maxAttempts` must be an integer ≥ 1.
- `retry.backoffMs` must be an integer ≥ 0. A negative delay would be handed to `setTimeout`, which treats it as 0 — so the backoff would silently vanish rather than fail loudly.

`env.ts` — `ENV_KEYS` maps: `UNITYCI_CLI_VERSION` → `unity.cli.version`, `UNITYCI_CLI_ALLOW_LATEST` → `unity.cli.allowLatest`, `UNITYCI_UNITY_BINARY` → `unity.cli.binary`, `UNITYCI_EDITOR_VERSION` → `unity.editor.version`, `UNITYCI_EDITOR_MODULES` → `unity.editor.modules` (comma-separated), `UNITYCI_EDITOR_CHANGESET` → `unity.editor.changeset`, `UNITYCI_EDITOR_ACCEPT_EULA` → `unity.editor.acceptEula`, `UNITYCI_EDITOR_TERMS` → `unity.editor.terms`, `UNITYCI_LICENSE_MODE` → `license.mode`, `UNITYCI_TEST_MODES` → `test.modes` (comma-separated), `UNITYCI_TEST_FILTER` → `test.filter`, `UNITYCI_TEST_COVERAGE` → `test.coverage`, `UNITYCI_TEST_NOGRAPHICS` → `test.nographics`, `UNITYCI_TEST_SHARDS` → `test.shards`, `UNITYCI_BUILD_TARGET` → `build.target`, `UNITYCI_BUILD_PROFILE` → `build.profile`, `UNITYCI_BUILD_METHOD` → `build.executeMethod`, `UNITYCI_RETRY_EXIT_CODES` → `retry.onExitCodes` (comma-separated), `UNITYCI_RETRY_MAX_ATTEMPTS` → `retry.maxAttempts`, `UNITYCI_OUTPUT_DIR` → `output.dir`, `UNITYCI_ANNOTATIONS` → `output.annotations`, `UNITYCI_CI` → `output.ci`, `UNITYCI_PACKAGES_PREFLIGHT` → `packages.preflight`.
`readEnvConfig` returns `{ patch, unknown, warnings }` where `unknown` lists every `UNITYCI_*` var not in `ENV_KEYS` **and** not matching `UNITYCI_SECRET_*`, and `warnings` lists env vars that **are** in `ENV_KEYS` but whose value could not be parsed (a non-boolean where a boolean is expected, a non-numeric where a number is expected). Booleans parse `true`/`false` case-insensitively; anything else is a warning, not a failure.

`load.ts` — loads `unity-ci.yml` (or `unity.ci.yml`, or the path given by `--config`) from the **project root** with the `yaml` package, then **deep-merges** the layers in order — `DEFAULT_CONFIG` < file < env < flags — so a layer that sets one nested key never erases its siblings. It then runs `validateConfig`, applies the `6`-retry cap to `retry.maxAttempts` (the validator itself is pure), and returns the config, the issues, the warnings and the resolved project path. A file that cannot be parsed yields a `ConfigIssue` (not a throw) and the loader still returns a usable config built from the defaults. A file containing any of `serial`, `fileBase64`, `serviceAccountId`, `serviceAccountSecret` anywhere under `license:` yields a `ConfigIssue` saying secrets travel through the environment or through git configuration only — never through a config file, a flag, or a command line (GC5, GC21).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/config core/test/config.test.ts
git commit -m "feat: add config schema, validation and precedence"
```

---

## Task 4: The Unity process runner

**Files:**
- Create: `core/src/exec.ts` (the generic argv-only spawner), `core/src/unity/exec.ts` (the Unity child-environment wrapper), `core/src/unity/cli.ts`
- Test: `core/test/unity-exec.test.ts`

**Interfaces:**
- Consumes: `EXIT` from `core/src/exit-codes.ts`, `Logger` from `core/src/logger.ts`, `Redactor` from `core/src/redact.ts`.
- Produces:
  - `core/src/exec.ts` → `export interface SpawnResult { code: number; stdout: string; stderr: string }`, `export interface SpawnOptions { file: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logger: Logger; redactor: Redactor; timeoutMs?: number }`, `export function spawnProcess(opts: SpawnOptions): Promise<SpawnResult>` — the **only** place a child process is started. Always `spawn(file, args, { shell: false })`.
  - `core/src/unity/exec.ts` → `export interface UnityEnvelope { success?: boolean; data?: unknown; errors?: { code?: string; message?: string }[]; warnings?: string[] }`, `export interface UnityResult { code: number; stdout: string; stderr: string; json: UnityEnvelope | null }`, `export interface RunUnityOptions { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logger: Logger; redactor: Redactor; timeoutMs?: number }`, `export function runUnity(opts: RunUnityOptions): Promise<UnityResult>` — builds the Unity child environment (GC13), calls `spawnProcess`, and parses the child's **raw** stdout into the typed envelope. `json` is a **typed envelope**, not `unknown`, so the later consumers do not each cast it by hand. The JSON is parsed from the raw stdout; only the exposed `stdout`/`stderr` strings are redacted, so a secret inside a JSON string can never corrupt the parse.
  - `core/src/unity/cli.ts` → typed wrappers, all of which call `runUnity` and all of which pass `--format json`:
    `export function unityVersion(opts): Promise<UnityResult>` — `unity version --format json`, which reports the CLI version, release channel, commit, platform, architecture and runtime. **`unity --version` is not trustworthy** (it reported `1.0.0-beta.13` while `unity version` and `unity doctor` reported `1.0.0-beta.14`), so the identity always comes from the `version` command.
    `export function unityDoctorCi(opts): Promise<UnityResult>` — `['doctor', '--ci', '--format', 'json']`.
    `export function unityInstall(opts, install: UnityInstallOptions): Promise<UnityResult>` — an **options object**, not a positional list, because the install needs more than four fields. `UnityInstallOptions = { version: string; modules?: string[]; childModules?: boolean; acceptEula?: boolean; yes?: boolean; changeset?: string; architecture?: string }`. `--cm` and `--no-cm` are mutually exclusive; the long spelling `--module` is used (verified: `unity install 6000.6.6f1 -m Android --dry-run --format json` parses, so `--format json` after a variadic module list is accepted).
    `export function unityModulesList(opts, version: string): Promise<UnityResult>` — `['install', version, '--list-modules', '--format', 'json']`. **This is the authoritative source for "is module X installed for editor V".** Its rows carry the lowercase module **id** (`android`, `ios`, `webgl`, `linux-il2cpp`, `linux-mono`, `linux-server`, `mac-mono`, `universal-windows-platform`, …), the display `name`, `status`, `aliases`, and an `isInstalled` **boolean**.
    `export function unityTermsAccept(opts, version: string): Promise<UnityResult>`
    `export function unityLicenseActivate(opts, args: string[]): Promise<UnityResult>`
    `export function unityLicenseReturn(opts): Promise<UnityResult>` — `['license', 'return', '--yes', '--format', 'json']`.
    `export function unityLicenseStatus(opts): Promise<UnityResult>` — `['license', 'status', '--format', 'json']`. Tasks 5 and 6 consume it, so it exists here rather than being added later.
    `export function unityTest(opts, args: string[]): Promise<UnityResult>`
    `export function unityBuild(opts, args: string[]): Promise<UnityResult>`
    `export function unityCacheKey(opts, projectPath: string, target?: string): Promise<UnityResult>`
    `export function unityCacheInfo(opts): Promise<UnityResult>`
    `export function unityProjectsVerify(opts, projectPath: string): Promise<UnityResult>` — `['projects', 'verify', projectPath, '--strict', '--format', 'json']`. Both the positional project path and `--strict` are confirmed by `unity projects verify --help` (`Usage: unity projects verify [options] [project]`, `--strict  Treat warnings as errors`).
    `export function unityEditorsInstalled(opts): Promise<UnityResult>` — `['editors', '--installed', '--format', 'json']`. Its rows carry a `modules` string that may be **empty** for a valid Editor. **That string holds display names, not module ids** (observed: `"Linux"`, `"Android, Android SDK & NDK Tools, Linux, OpenJDK, Web"`), so it is a *different namespace* from the ids `config.unity.editor.modules` uses. Do **not** compare against it — use `unityModulesList` and match on `id` + `isInstalled`.
    Each wrapper takes `{ binary, cwd, env, logger, redactor }` plus its own arguments. **The project path is always passed positionally** to the `unity` verb, and `cwd` is the directory the child runs in (the project root) — a caller must not rely on `cwd` alone to select the project.

    **The global `--format json` is inserted BEFORE any `--` separator.** Everything after a literal `--` is passed through to the Editor, not parsed by the CLI — so a wrapper that appends `['--format','json']` to the end of an argument list that ends with `-- -nographics` produces `… -- -nographics --format json`: the CLI never enters JSON mode **and** the Editor is handed a `--format` argument it does not understand. Each wrapper must therefore split its arguments at the first `--`, insert `['--format','json']` before the tail, and re-append the tail unchanged.

- [ ] **Step 1: Write the failing tests**

`core/test/unity-exec.test.ts`:
```ts
it('spawns the binary with an argv array and no shell', () => { /* assert spawn called with (file, argsArray, { shell: false }) */ });
it('parses stdout as JSON when --format json was requested', () => { /* json is populated */ });
it('returns json: null when stdout is not JSON', () => { /* no throw */ });
it('propagates the child exit code', () => { /* code === 8 */ });
it('redacts a registered secret found in the child stdout', () => { /* stdout has *** */ });
it('passes UNITY_NON_INTERACTIVE, UNITY_NO_UPDATE_CHECK and UNITY_NO_BANNER to the child', () => { /* assert env */ });
it('removes UNITY_SERVICE_ACCOUNT_SECRET from the child environment', () => { /* assert absent */ });
it('kills the child and returns 14 when the timeout elapses', () => { /* code === 14 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/unity-exec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `exec.ts`, `unity/exec.ts` and `unity/cli.ts`**

`core/src/exec.ts` uses `node:child_process.spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })`. It accumulates stdout and stderr, redacts both before returning, and logs each line as it arrives (redacted). It resolves `{ code, stdout, stderr }`. On timeout it kills the child and resolves with code `EXIT.TIMEOUT` (14).

**The timeout kills the whole process tree, not just the direct child.** A timed-out `unity` run leaves an Editor grandchild that can keep the project's `Library/` lock and the licence seat. Spawn with `detached: true` on POSIX and kill the process **group** (`process.kill(-child.pid, …)`), escalating `SIGTERM` → `SIGKILL`; on Windows kill the tree with `taskkill /pid <pid> /T /F`. A test must show a grandchild does not survive the timeout.

**Decode the child's output exactly once.** Call `child.stdout.setEncoding('utf8')` and `child.stderr.setEncoding('utf8')` so a multi-byte character split across chunk boundaries is not corrupted — Editor logs carry non-ASCII text and are the noisiest path in the toolkit.

`core/src/unity/exec.ts` builds the child environment as `{ ...process.env, ...opts.env }` **minus** `UNITY_SERVICE_ACCOUNT_SECRET`, `UNITY_SERVICE_ACCOUNT_ID`, `UNITY_GITHUB_TOKEN`, `UNITY_GITLAB_TOKEN`, then **plus** `UNITY_NON_INTERACTIVE=1`, `UNITY_NO_UPDATE_CHECK=1`, `UNITY_NO_BANNER=1`, `UNITY_NO_AGENT_HINTS=1`, `UNITY_NO_CLI_INVOKED_TELEMETRY=1`. (Unity's own CLI strips the four token variables from child processes too — GC23.) `UNITY_LICENSE_SERIAL` **is** passed through — the CLI reads it from the environment by design and never puts it in `argv`. It then calls `spawnProcess`, and parses the child's **raw** stdout as JSON into a typed `UnityEnvelope` in a `try`/`catch` that yields `json: null`.

`core/src/unity/cli.ts` builds the argv array for each wrapper: `['<verb>', ...args, '--format', 'json']`. `unityDoctorCi` uses `['doctor', '--ci', '--format', 'json']`. `unityLicenseReturn` uses `['license', 'return', '--yes', '--format', 'json']`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/unity core/test/unity-exec.test.ts
git commit -m "feat: add the Unity CLI process runner"
```

---

## Task 5: `doctor` and `setup` commands

**Files:**
- Create: `core/src/commands/doctor.ts`, `core/src/commands/setup.ts`, `core/src/lifecycle/setup.ts`
- Create: `core/src/packages/deps.ts`, `core/src/packages/git.ts`, `core/src/packages/modules.ts`
- Create: `core/test/fixtures/manifest-git-deps.json` (a `Packages/manifest.json` with a registry dependency, an `https://….git` dependency, an `ssh://` dependency and a `git@host:owner/repo.git` dependency)
- Modify: `core/src/unity/cli.ts` (add the `unityModulesList` wrapper)
- Test: `core/test/doctor.test.ts`, `core/test/setup.test.ts`, `core/test/packages.test.ts`

**Interfaces:**
- Consumes: `runUnity` and the wrappers from `core/src/unity/cli.ts`; `spawnProcess` from `core/src/exec.ts`; `Config` from `core/src/config/schema.ts`; `CoreContext` from `core/src/context.ts`.
- Produces:
  - `core/src/commands/doctor.ts` → `export async function doctorCommand(ctx: CoreContext): Promise<number>`.
  - `core/src/lifecycle/setup.ts` → `export async function setup(ctx: CoreContext): Promise<SetupResult>` where `SetupResult = { editorVersion: string; cliVersion: string; cliChannel: string | null; cliCommit: string | null; installed: boolean; doctorVerdict: 'pass' | 'fail' | 'unknown' }`.
  - `core/src/commands/setup.ts` → `export async function setupCommand(ctx: CoreContext): Promise<number>`.
  - `core/src/packages/deps.ts` → `export interface GitDependency { name: string; url: string; host: string; hasEmbeddedCredentials: boolean }`, `export function readGitDependencies(projectPath: string): GitDependency[]` — parses `Packages/manifest.json` (and `Packages/packages-lock.json` for the resolved set), and returns every dependency whose value is a git URL (`https://….git`, `git@host:owner/repo.git`, `ssh://…`, `git://…`). `host` is the hostname; `hasEmbeddedCredentials` is true when the URL carries a userinfo component (`https://user:token@host/…`).
  - `core/src/packages/git.ts` → `export interface GitPreflightResult { dependency: GitDependency; reachable: boolean; detail: string }`, `export async function preflightGitDependencies(deps: GitDependency[], opts: { cwd: string; env: NodeJS.ProcessEnv; logger: Logger; redactor: Redactor; timeoutMs?: number }): Promise<GitPreflightResult[]>` — runs `git ls-remote --exit-code <url>` **once per unique repository URL** through `spawnProcess`, using the ambient git configuration exactly as the Package Manager will.
  - `core/src/packages/modules.ts` → `export type HostPlatform = 'windows' | 'macos' | 'linux'`, `export function hostPlatform(): HostPlatform` (from `process.platform`), `export function modulesForBuildTarget(target: string, host: HostPlatform): string[]`, `export function modulesForTestMode(mode: string): string[]`, `export function isBuildTargetSupportedOnHost(target: string, host: HostPlatform): { supported: boolean; reason?: string }`. The mapping is **host-aware**: building `StandaloneWindows64` on a Linux runner needs the `windows-il2cpp` module, while on Windows it needs nothing — a host-blind table would let `setup` pass and `unity build` fail ten minutes later. The module **ids** come from `unity install --list-modules --format json`: `windows-il2cpp`, `linux-il2cpp`, `mac-mono`, `android`, `android-sdk-ndk-tools`, `ios`, `webgl`, `appletv`, `visionos`, `universal-windows-platform`, `linux-server`, `mac-server`. `isBuildTargetSupportedOnHost` reports the combinations Unity cannot build from that host (a macOS player needs macOS; an iOS, tvOS or visionOS build needs macOS), so the toolkit fails in seconds with a clear message instead of deep inside the Editor. `modulesForTestMode` returns `[]` for every mode — the test runner ships with the Editor, so no test mode needs a platform module today.

- [ ] **Step 1: Write the failing tests**

`core/test/doctor.test.ts`:
```ts
it('exits 0 and reports pass when every blocking check passes', () => { /* exit 0 */ });
it('exits non-zero when a blocking check fails', () => { /* e.g. code EDITOR_NOT_ENTITLED */ });
it('writes the doctor report to ci-output/logs/doctor.json', () => { /* file exists */ });
it('does not fail the run on a non-blocking failing check', () => { /* blocking: false */ });
it('runs unity projects verify and reports project integrity problems', () => { /* verify invoked */ });
it('warns but does not fail when the CLI is newer than the tested ceiling', () => { /* exit 0, warning emitted */ });
it('fails with exit 64 when the CLI is older than the tested floor', () => { /* exit 64 */ });
it('records the CLI version, channel and commit on the context', () => { /* ctx.cliVersion set */ });
it('reports the git package dependencies and their hosts', () => { /* doctor output lists them */ });
it('fails when a git package dependency is not fetchable', () => {
  /* git ls-remote fails → exit non-zero naming the URL */ });
it('passes when every git package dependency is fetchable', () => { /* ls-remote succeeds */ });
it('refuses to run when a git dependency URL embeds credentials', () => {
  /* https://user:token@host/x.git → exit 64 naming the package (it would be copied into packages-lock.json) */ });
it('does not run git ls-remote more than once per unique repository URL', () => { /* two packages, one repo → one call */ });
```

`core/test/packages.test.ts`:
```ts
it('reads git dependencies from Packages/manifest.json', () => { /* fixture */ });
it('reads a dependency written as git@github.com:owner/repo.git', () => { /* host github.com */ });
it('reads a dependency written as ssh://git@host/owner/repo.git', () => { /* host */ });
it('ignores registry dependencies', () => { /* com.unity.ugui → not a git dep */ });
it('ignores a scoped registry dependency', () => { /* https://packages.unity.com/... → not a git dep */ });
it('detects embedded credentials in a URL', () => { /* hasEmbeddedCredentials true */ });
it('returns an empty list for a project with no manifest', () => { /* */ });
```

`core/test/setup.test.ts`:
```ts
it('installs the editor when it is not installed', () => { /* unity install invoked */ });
it('accepts the Editor Software Terms after installing', () => { /* unity terms accept <v> --yes invoked after install */ });
it('does not reinstall an editor that is already installed', () => { /* no install call */ });
it('passes the module list and --cm to unity install', () => { /* args contain --module and --cm */ });
it('fails with exit 64 when the editor version is not from-project and is not a valid version', () => { /* invalid version */ });
it('fails when doctor --ci reports a blocking failure', () => { /* non-zero */ });
it('does not pass --accept-eula unless the config opts in', () => { /* acceptEula false → no flag */ });
it('passes --accept-eula when the config opts in', () => { /* acceptEula true */ });
it('fails when the installed editor is missing the module the build target needs', () => {
  /* unity editors --installed reports modules: "" for the target → exit 64 naming the module */ });
it('fails fast with the exact install command when the editor is missing', () => {
  /* never --allow-install; the error names `unity install <version> --yes --accept-eula` */ });
it('fails when unity license status reports no active license', () => {
  /* unity license status --format json → active:false → exit 64 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/doctor.test.ts core/test/setup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`setup.ts` (lifecycle) resolves the editor version: when `config.unity.editor.version === 'from-project'`, read `ProjectSettings/ProjectVersion.txt` from the project root and parse `m_EditorVersion:`; when the file is missing, fail with exit **64** naming the path. It then calls `unity editors --installed --format json`:
- if the version is **absent** → it does **not** silently install. It fails with exit **64** and the exact command to run (`unity install <version> --module <modules…> --yes --accept-eula`). `--allow-install` is **never** sent: whether the install it triggers accepts the EULA cannot be verified, so a missing Editor must never turn into a multi-GB download plus an unrecorded licence acceptance in the middle of a build.
- if the version is **present** → it verifies the **modules**: a row with `"modules": ""` is a valid installed Editor that lost its platform modules, so the module the **invoked command** needs must be present, or the run fails with exit **64** naming the missing module. The requirement belongs to the command, not to the project: a **test** run needs the test modules, a **build** needs the target's modules, and a command with no module requirement checks only the Editor version. The check reads `unity install <version> --list-modules --format json` and matches the lowercase module **id** with `isInstalled` — the `modules` string on an `editors --installed` row holds **display names** (`"Linux"`, `"Android, …"`), a different namespace, and must not be compared against the ids in `config.unity.editor.modules`.
- if `config.unity.editor.acceptEula` is true → it runs `unity install <version> --module <modules…> [--cm] --yes --accept-eula`; otherwise it never passes `--accept-eula` (accepting Unity's and every module's licence agreements is a **declared** input, not a silent default).
- then, when `config.unity.editor.terms` is true, it runs `unity terms accept <version> --yes`.
- **`setup` does NOT run `unity doctor --ci`, and does NOT apply the glibc, disk-space or capability-matrix checks.** Those belong to `unityci doctor` (the spec's Section 4.1 assigns them there). `setup` owns exactly: the CLI version gate, the Editor version, the modules, the Editor Software Terms, the licence precondition and the git-dependency preflight. The run path calls `doctor` **once**, after `setup` and before the licence step — so the preflight happens exactly once per run instead of twice.

Before any of that, it resolves the **CLI identity** with `unity version --format json` and stores `version`, `channel` and `commit` on the context. It compares the running version against the tested range (`TESTED_CLI_MIN = '1.0.0-beta.9'`, `TESTED_CLI_MAX = '1.0.0-beta.14'`, exported as constants from `core/src/unity/cli.ts`):
- running version **below** the floor → exit **64**, naming the tested floor.
- running version **above** the ceiling → a **warning** on stderr naming the tested ceiling; the run continues (GC17).

The comparison is a plain semver-ish comparison of the numeric `beta.N` suffix, not a full semver implementation. Use `unity version --format json`, **not** `unity --version` — on this machine the binary's `--version` reported `1.0.0-beta.13` while `unity env` and `unity doctor` reported `1.0.0-beta.14`, so only the `version` command's own report is trustworthy.

The license is checked with `unity license status --format json` (`data.active`, `data.licenses[]`, `data.floatingServer`). A run with `license.mode: 'none'` fails fast with exit 64 when `active` is `false`, naming the activation command to run.

`doctor.ts` runs `unity doctor --ci --format json` and `unity projects verify --strict --format json`, writes the doctor report to `<output.dir>/logs/doctor.json` (**redacted** through the context's redactor — Unity's own check messages can echo a secret, and this file is uploaded as a CI artifact), prints a one-line-per-check human summary, and exits 0 when no blocking check failed and `unity projects verify` found no error. `unity projects verify` catches missing/orphaned `.meta` files, duplicate GUIDs, conflict markers and an invalid package manifest **without launching the Editor** — a cheap preflight that catches a broken checkout before a ten-minute build.

The doctor's **own** checks — the capability matrix (R13), glibc on Linux, disk space and the mode-aware licence state — are added to the same report. glibc uses `process.report.getReport().header.glibcVersionRuntime` (no dependency) and is compared **numerically** against Unity's floor of **2.34**; below the floor is a blocking failure, and on Windows and macOS the check is `info`. Disk space uses `fs.statfsSync` and is compared against `doctor.minFreeBytes` (default **10 GiB**); when the free space cannot be determined the check is `info`, never a failure.

**Private git packages.** `setup.ts` runs the package-dependency preflight (it is in the run path), unless `config.packages.preflight` is `false`:
1. `readGitDependencies(projectPath)` reads `Packages/manifest.json` and returns the git-hosted dependencies with their hosts.
2. If any dependency URL **embeds credentials** (`https://user:token@host/…`), the core **refuses to run** with exit 64, naming the package and the URL — because Unity copies that URL verbatim into `packages-lock.json`, which is a committed file, so the token would land in the repository (GC21, Review Focus #10). The remedy is a credential-free URL plus a git-level rewrite.
3. `preflightGitDependencies` runs `git ls-remote --exit-code <url>` once per **unique repository URL** (two packages can come from one repo), through `spawnProcess`, using the ambient git configuration — the same configuration the Package Manager will use. A failure is a **blocking** check: the run stops in seconds with the URL and the remedy, instead of failing ten minutes later inside the Editor with a resolution error that reads like a Unity bug (Review Focus #9). A success proves the credentials are in place.

This preflight is the core's **detection** half. Supplying the credentials is the adapter's job (GC22): the core never reads a token variable and never writes git config.

Both commands are pure — they do not activate or return a license.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/commands/doctor.ts core/src/commands/setup.ts core/src/lifecycle/setup.ts core/src/packages core/src/unity/cli.ts core/test/doctor.test.ts core/test/setup.test.ts core/test/packages.test.ts
git commit -m "feat: add doctor and setup commands"
```

---

## Task 6: License lifecycle

**Files:**
- Create: `core/src/lifecycle/license.ts`, `core/src/commands/license.ts`
- Test: `core/test/license.test.ts`

**Interfaces:**
- Consumes: `runUnity` wrappers; `Config`; `CoreContext`.
- Produces:
  - `core/src/lifecycle/license.ts` → `export interface LicenseActivation { activated: boolean; mode: string }`, `export interface LicenseReturnResult { returned: boolean; code: number; error?: string; seatLeaked?: boolean }`, `export async function activateLicense(ctx: CoreContext): Promise<LicenseActivation>` and `export async function returnLicense(ctx: CoreContext, opts?: { force?: boolean }): Promise<LicenseReturnResult>`. `returnLicense` **never throws** — it catches everything and reports the outcome in its result. That is what lets the teardown log the failure loudly without changing the primary exit code (GC9), while the **standalone** `unityci license return` command can still report the failure honestly.

    **The teardown returns a seat only if the toolkit took one — and the gate lives inside `returnLicense`, not at the call site.** GC9 makes the teardown unconditional in the sense that the `finally` always calls it, but "unconditional" must not mean "return whatever licence this machine happens to have": under `license.mode: none` a developer's own personal licence is active and must be left alone, and a blanket `unity license return` would **return the developer's licence** as a side effect of running the toolkit locally. So `CoreContext` carries `licenseActivated?: boolean` (unset means false), the run loop sets it to `true` immediately after an activation that took a seat, and `returnLicense` **returns nothing** — with a debug log — when `ctx.licenseActivated` is not `true`. Putting the check inside `returnLicense` is what makes it hold for *every* caller, including Task 11's signal path, which has no activation state of its own.

    **`force` overrides the activation gate but never the `mode: none` guard.** `returnLicense(ctx, { force: true })` is for the **standalone** `unityci license return` command: a fresh process has `licenseActivated` unset, yet a user who types that command is asking to reclaim a seat a *previous* job took — that is the real recovery workflow after a job died mid-run. So `licenseReturnCommand` passes `{ force: true }`. But `license.mode: none` is the user stating that the toolkit does not manage licences at all, and forcing the return there would destroy the developer's own local licence — so under `mode: none` the command still does nothing. A return that was **not attempted** is reported as `skipped: true` in the result, and `licenseReturnCommand` exits **0** for it: there is nothing to return, which is not a failure. Only a real return failure, a non-zero exit from the CLI, or a leaked seat exits **6**.

    `seatLeaked` is set when the licence was an **offline `--file`** licence: `unity license return` leaves such a licence in place, so the CLI reports success while the seat is still held and must be reclaimed by hand. That fact is the **only** signal the caller gets, so it must be machine-readable rather than a log line nobody greps for.
  - `core/src/commands/license.ts` → `export async function licenseActivateCommand(ctx: CoreContext): Promise<number>` and `export async function licenseReturnCommand(ctx: CoreContext): Promise<number>`. The standalone `license return` command exits **non-zero** (`EXIT.COMMAND_FAILED`, 6) when the return failed **or when `seatLeaked` is true** — a user who explicitly asked for a seat to be returned must not be told it succeeded when the seat is still held. That is a different question from the teardown, which has a primary exit code to preserve.

- [ ] **Step 1: Write the failing tests**

```ts
it('activates with mode none without calling the CLI', () => { /* no unity call */ });
it('activates a serial without putting the serial in argv', () => {
  /* env UNITY_LICENSE_SERIAL=abc123 ; assert argv does NOT contain 'abc123'
     and argv DOES NOT contain '--serial' (the CLI reads the env var) */ });
it('activates floating with --floating', () => { /* argv contains --floating */ });
it('decodes an offline license file to a temp path and passes --file', () => {
  /* env UNITY_LICENSE_FILE_BASE64=<b64 of ulf bytes>; assert --file <temp> and temp deleted after */ });
it('activates personal with --personal --accept-eula', () => { /* both flags */ });
it('fails with exit 64 when the serial env var is empty', () => { /* mode serial, no env */ });
it('never writes the serial into the log', () => { /* log output has no secret */ });
it('returns the license with --yes', () => { /* argv contains --yes */ });
it('swallows a return failure without changing the caller exit code', () => { /* returnLicense resolves */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/license.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`activateLicense` switches on `config.license.mode`:
- `none` → `{ activated: false, mode: 'none' }`, no CLI call.
- `serial` → require `process.env[config.license.serialEnv]` to be non-empty, else exit **64** naming the env var. Then call `unity license activate --format json` with **no** `--serial` flag — the Unity CLI reads `UNITY_LICENSE_SERIAL` from the environment itself, so the serial never appears in `argv`.
- `floating` → `unity license activate --floating --format json`.
- `offline-file` → require `process.env[config.license.fileEnv]`; base64-decode it into a temp file with a `.ulf` suffix; call `unity license activate --file <temp> --format json`; delete the temp file in a `finally`.
- `personal` → `unity license activate --personal --accept-eula --format json`.

`returnLicense` calls `unity license return --yes --format json` inside a `try`/`catch` that logs the failure at error level and **never rethrows** (GC9).

Both the serial and the base64 license file are registered with the redactor **before** the first log line (GC6).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/lifecycle/license.ts core/src/commands/license.ts core/test/license.test.ts
git commit -m "feat: add license activate and return lifecycle"
```

---

## Task 7: Retry policy

**Files:**
- Create: `core/src/lifecycle/retry.ts`
- Test: `core/test/retry.test.ts`

**Interfaces:**
- Consumes: `Config['retry']`.
- Produces: `core/src/lifecycle/retry.ts` → `export interface RetryPolicy { onExitCodes: number[]; maxAttempts: number; backoffMs: number }`, `export function shouldRetry(policy: RetryPolicy, code: number, attempt: number): boolean`, `export async function withRetry<T>(fn: (attempt: number) => Promise<{ value: T; code: number }>, policy: RetryPolicy, onRetry?: (info: { attempt: number; code: number; waitMs: number }) => void, options?: { signal?: AbortSignal }): Promise<{ value: T; attempts: number; code: number }>`.

  **The backoff wait is abortable.** `options.signal` lets the caller cancel a wait in progress: when the signal fires, the wait ends immediately and `withRetry` rejects with the signal's reason. Without this, a Ctrl-C during a retry wait would hang until the backoff expired — up to a full minute — before the core could return the licence and exit. Task 11's signal handling supplies the signal.

  **The exit code is part of the attempt's outcome, not a rejection.** `fn` resolves with `{ value, code }` — the Unity exit code and whatever the caller wants to keep — and `withRetry` decides whether to try again from that `code`. A **rejection** from `fn` is an *internal* failure (a bug in the toolkit, a thrown error), not a Unity exit code: `withRetry` rethrows it immediately and never retries it. Retrying an internal error just reproduces it more slowly.

  `withRetry` returns the **last** attempt's `value` and `code` together with the number of attempts made. It does not throw when the run ends in a Unity failure — the caller needs that exit code to build `summary.json` (`unityExitCode`) and to derive the status, so turning it into an exception would throw away the one number that matters.

- [ ] **Step 1: Write the failing tests**

```ts
it('retries exit code 7 up to maxAttempts', () => { /* 2 attempts when 7 persists */ });
it('never retries exit code 8', () => { /* 1 attempt, even with 8 in onExitCodes */ });
it('never retries exit code 0 even when the policy opts it in', () => { /* 0 is success */ });
it('never retries interrupts from a hand-built policy', () => { /* 130 and 143 */ });
it('never retries exit code 6 by default', () => { /* 6 is not in the default onExitCodes */ });
it('retries exit code 6 once when it is opted in', () => { /* maxAttempts 2 → 2 attempts */ });
it('does not retry when the attempt count is exhausted', () => { /* exactly maxAttempts calls */ });
it('waits backoffMs before the second attempt', () => { /* fake timers */ });
it('doubles the wait before each further attempt', () => { /* backoffMs, then 2x backoffMs */ });
it('caps the wait at 60 seconds', () => { /* many attempts */ });
it('caps the first wait at 60 seconds', () => { /* backoffMs 90_000 → waits 60_000 */ });
it('returns the last attempt value and the number of attempts', () => { /* attempts === 2 */ });
it('returns the last attempt exit code', () => { /* attempt 1 → 7, attempt 2 → 9, code === 9 */ });
it('rethrows a rejection from the attempt without retrying', () => { /* an internal error is not a Unity exit code */ });
it('does not start an attempt when the signal is already aborted', () => { /* fn called zero times */ });
it('ends the backoff wait immediately when the signal aborts', () => { /* the timer is cleared */ });
it('retries normally when the signal never fires', () => { /* the normal path is unchanged */ });
it('calls onRetry with the attempt, the code and the wait', () => { /* */ });
it('reports the attempt that just finished to onRetry', () => { /* maxAttempts 3 → attempt 1 then attempt 2 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/retry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shouldRetry` returns `code !== 0 && code !== 8 && code !== 130 && code !== 143 && policy.onExitCodes.includes(code) && attempt < policy.maxAttempts`. The four guards are **unconditional** (GC8), not merely a property of the default policy: **`0`** is success and must never be retried; **`8`** means "the tests ran and some failed", and re-running the same suite reproduces the same failures; **`130`/`143`** are interrupts, and a signalled CI job must fail rather than loop. The same three codes are rejected at config-validation time — but validation only protects configurations that came through the loader, so the in-module guard is what makes the guarantee hold for a hand-built policy too.

`withRetry` calls `fn(attempt)` with a **1-based** attempt number. When the attempt resolves with a retryable `code`, it waits and calls `onRetry({ attempt, code, waitMs })`, then tries again. The wait before attempt *N+1* is `min(backoffMs * 2^(N-1), 60_000)` — the first wait is exactly `backoffMs`, and each further wait doubles, capped at one minute so a long pipeline cannot stall for hours. Implement the wait with `setTimeout`; the tests use `vi.useFakeTimers()` and `vi.advanceTimersByTimeAsync()`.

**Exit 6 is opt-in and capped at one extra attempt.** Unity's own documentation is explicit that re-running an identical broken configuration reproduces the failure, so `6` may be added per pipeline — but `loadConfig` caps `retry.maxAttempts` at **2** whenever `6` is in `onExitCodes`, and the validator rejects `8`, `130` and `143` outright (GC8).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/lifecycle/retry.ts core/test/retry.test.ts
git commit -m "feat: add exit-code driven retry policy"
```

---

## Task 8: Reporting — NUnit parsing, JUnit fallback, summary.json, annotations

**Files:**
- Create: `core/src/report/nunit.ts`, `core/src/report/junit.ts`, `core/src/report/summary.ts`, `core/src/report/annotations.ts`, `core/src/commands/report.ts`
- Create: `core/test/fixtures/editmode-pass.xml`, `core/test/fixtures/editmode-fail.xml`
- Test: `core/test/report.test.ts`

**Interfaces:**
- Consumes: `Config`; `CoreContext` from `core/src/context.ts`.
- Produces:
  - `core/src/report/nunit.ts` → `export interface TestCounts { total: number; passed: number; failed: number; skipped: number }`, `export function parseNUnit(xml: string): TestCounts`, `export interface TestFailure { name: string; message: string; stack: string | null }`, `export function parseNFailures(xml: string): TestFailure[]`.
  - `core/src/report/junit.ts` → `export function nunitToJUnit(nunitXml: string): string`.
  - `core/src/report/summary.ts` → `export interface Summary { schema: 1; command: 'test' | 'build'; status: 'passed' | 'tests_failed' | 'infra_failed' | 'config_error'; exitCode: number; unityExitCode: number; attempts: number; cliVersion: string; cliChannel: string | null; cliCommit: string | null; editorVersion: string; durationMs: number; tests: TestCounts; reports: { nunit: string[]; junit: string[] }; license: { mode: string; activated: boolean; returned: boolean; seatLeaked: boolean }; artifacts: string[]; logs: { editor: string | null; cli: string | null } }`, `export function writeSummary(outputDir: string, summary: Summary): void`, `export function buildSummary(partial: Partial<Summary> & Pick<Summary, 'command' | 'status' | 'exitCode'>): Summary`, `export function deriveStatus(exitCode: number): Summary['status']`. The `license` object is populated from `LicenseActivation` and `LicenseReturnResult` — `mode` from the config, `activated`/`returned` from what the lifecycle actually did, and `seatLeaked` from the return result. It **never** contains the serial.
  - `core/src/report/annotations.ts` → `export function emitAnnotations(ctx: CoreContext, failures: TestFailure[]): void` — writes `::error file=...,line=...::name — message` workflow commands to stdout when `config.output.annotations === 'github'`, and appends a job-summary block to `$GITHUB_STEP_SUMMARY` when that variable is set.
  - `core/src/commands/report.ts` → `export async function reportCommand(ctx: CoreContext): Promise<number>` — converts NUnit files under `config.test.outputDir` into JUnit files and refreshes `summary.json`. The JUnit file for a mode lands at `<test.outputDir>/<mode>.junit.xml`, beside the NUnit file `<test.outputDir>/<mode>.xml` it came from — the same two paths the `run test` command uses (Task 9), so the report command and the run command agree on where a report lives.
    **The conversion is a FALLBACK (D8).** `unity test` is asked for `nunit,junit` and Unity writes the JUnit file itself; the core's conversion exists only for the case where Unity produced **no** JUnit file. So `reportCommand` converts a mode's NUnit file **only when the sibling `<mode>.junit.xml` does not already exist** — it must never overwrite a JUnit file Unity wrote. A JUnit file Unity wrote that is **empty** does not count as produced: R18 requires every published artifact to exist **and be non-empty**, so an empty JUnit file falls back to the core's conversion, or fails with exit 6 when there is no NUnit file to convert. The NUnit file is never modified either: the conversion reads it and writes a new file beside it.
    **Redaction happens at the write boundary.** `nunitToJUnit` stays a pure function — it has no redactor and needs none — but `reportCommand` passes the resulting XML through `ctx.redactor` **before writing it to disk**, because the JUnit file is a build artifact that CI uploads. A secret echoed into a failure message must not survive into an uploaded artifact.
    **The report command decides the verdict, and the verdict is the exit code.** The job's status comes from the core's exit code, so a report command that writes `status: tests_failed` and exits 0 has turned a red suite into a green job. `reportCommand` therefore:
    - iterates the **configured modes** (`config.test.modes`), reading `<test.outputDir>/<mode>.xml` and `<test.outputDir>/<mode>.junit.xml` — never every `*.xml` in the directory, which would count stale and unrelated reports;
    - returns **0** (`passed`) when every configured mode's report parsed and no test failed;
    - returns **8** (`tests_failed`) when any report shows a failure;
    - returns **65** (`infra_failed`) when a report exists but cannot be parsed;
    - returns **6** (`infra_failed`) when **no** report was found for any configured mode — R18: "ran but produced nothing" is an infrastructure failure, not a pass;
    - and **writes the summary it decided on every path**, including the failure paths — a stale green `summary.json` left on disk after a failed report is worse than no summary at all.

- [ ] **Step 1: Write the failing tests**

```ts
it('counts total, passed, failed and skipped from NUnit XML', () => { /* fixture */ });
it('extracts failure names, messages and stacks', () => { /* fixture */ });
it('converts NUnit XML into JUnit XML with one testcase per test', () => { /* parse the result */ });
it('keeps the original NUnit file untouched when converting', () => { /* byte compare */ });
it('writes summary.json with schema 1 and the documented keys', () => { /* key set check */ });
it('derives status from the exit code', () => { /* 0→passed, 8→tests_failed, 64→config_error, 6→infra_failed */ });
it('records the CLI version, channel and commit', () => { /* cliVersion, cliChannel, cliCommit */ });
it('emits a GitHub annotation per failed test when annotations is github', () => { /* stdout capture */ });
it('emits nothing when annotations is none', () => { /* stdout capture */ });
it('writes to $GITHUB_STEP_SUMMARY when it is set', () => { /* temp file */ });
it('redacts a secret that appears in a failure message', () => { /* *** */ });
it('throws a typed error when the NUnit XML cannot be parsed', () => { /* caller maps it to exit 65 */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`parseNUnit` targets the **NUnit 3** schema, which is what Unity's Test Framework emits: the report root is `<test-run … testcasecount="2" total="2" passed="1" failed="1" inconclusive="0" skipped="0">` with `<test-suite>` and `<test-case>` children. It reads the root's `total`/`passed`/`failed`/`skipped`/`inconclusive` attributes when present and otherwise walks `<test-case>` elements counting `result="Passed" | "Failed" | "Skipped"`. It also tolerates the older NUnit 2 root `<test-results>`, but NUnit 3 is the shape to write against. When the XML is not parseable at all it throws a `ReportParseError` — the caller maps that to exit **65** (GC7), never to a silent zero-count pass. **Well-formed XML that is not a test report is also a parse error**: the root element must be `test-run`, `test-results` or `test-suite`, and anything else — an HTML error page from a proxy, a `<html><body>502 Bad Gateway</body></html>`, an empty shell — throws `ReportParseError` rather than parsing to zero tests. A report with zero tests is a legitimate result; a document that is not a report is not.

**The toolkit takes no XML dependency.** The plan's runtime-dependency budget is `yaml` and nothing else, so the NUnit reader is a small, focused parser written for this one schema. It must still handle the shapes real reports contain: attributes in **any order**, single- or double-quoted attribute values, self-closing elements, nested `<test-suite>` elements, and the standard XML entities (`&lt;` `&gt;` `&amp;` `&quot;` `&apos;`) plus numeric ones (`&#13;` `&#10;` `&#xA;`). A parser that only matches one attribute order or one quoting style will silently mis-count a real report, which is the failure mode this whole task exists to prevent — so the tests must cover each of those shapes.

**`inconclusive` counts as `skipped`.** The `TestCounts` interface has no separate field for it, and an inconclusive test did not pass.

`nunitToJUnit` emits a `<testsuites>` document with one `<testsuite>` per NUnit `<test-suite>`, and one `<testcase>` per `<test-case>`, mapping `result` to `<failure>` / `<skipped>`, with `classname` from the `classname` attribute and `time` from `duration`. Failure messages arrive with CRLF escaped as `&#13;&#10;`, so they must be decoded before they reach a summary or a GitHub annotation. **Everything written into the JUnit document must be XML-escaped** — a failure message containing `<`, `&` or a quote would otherwise produce a document that no CI system can parse.

`writeSummary` writes `<outputDir>/summary.json` with 2-space indentation and a trailing newline, creating parent directories as needed. `deriveStatus` maps the exit code to the status per GC11: `0` → `passed`, `8` → `tests_failed`, `64` → `config_error`, anything else non-zero → `infra_failed`.

`emitAnnotations` writes GitHub workflow commands for each failure, and appends a summary table to `$GITHUB_STEP_SUMMARY` when the variable is set. It must never print a secret — every line passes through the redactor.

**GC4 — provider neutrality is checked mechanically.** `core/src/**` must not match `GITHUB_|GITLAB_|JENKINS_|CIRCLECI_|BUILDKITE_|AZURE_` **except** inside `core/src/report/annotations.ts`. The `GITHUB_STEP_SUMMARY` lookup and the `::error` workflow-command format belong there and nowhere else — `nunit.ts`, `junit.ts` and `summary.ts` must not know which CI system is running.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/report core/src/commands/report.ts core/test/report.test.ts core/test/fixtures
git commit -m "feat: add NUnit parsing, JUnit conversion, summary and annotations"
```

---

## Task 9: `run test` — the core run loop

**Files:**
- Create: `core/src/lifecycle/test.ts`, `core/src/commands/run.ts`
- Test: `core/test/run-test.test.ts`

**Interfaces:**
- Consumes: `setup`, `activateLicense`, `returnLicense`, `withRetry`, `unityTest` (Task 4); `parseNUnit`, `writeSummary`, `buildSummary`, `deriveStatus` (Task 8); `Config`; `CoreContext`.
- Produces:
  - `core/src/lifecycle/test.ts` → `export interface TestRunResult { status: 'passed' | 'tests_failed' | 'infra_failed'; unityExitCode: number; attempts: number; reports: { nunit: string[]; junit: string[] }; tests: { total: number; passed: number; failed: number; skipped: number } }`, `export async function runTest(ctx: CoreContext): Promise<TestRunResult>`.
  - `core/src/commands/run.ts` → `export async function runCommand(ctx: CoreContext, sub: 'test' | 'build'): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('runs doctor, then setup, activates the license, runs the tests and returns the license', () => { /* call order asserted: doctor → setup → activate → run → teardown */ });
it('returns the license when the test run fails', () => { /* returnLicense called */ });
it('does not return a license it never took', () => { /* doctor or setup failed before activation → no unity license return */ });
it('does not return a license when activation did not take a seat', () => { /* activated:false → no unity license return */ });
it('runs one unity test per configured mode and collects both reports', () => { /* 2 invocations */ });
it('never emits two --mode flags in one invocation', () => { /* the CLI silently lets the last win */ });
it('rejects a report path that is an existing directory', () => { /* exit 64 */ });
it('never passes --allow-install', () => { /* a missing editor must fail fast, not download mid-build */ });
it('requests nunit and junit natively from unity', () => { /* argv contains --report-format nunit,junit and --junit-output */ });
it('retries exit code 7 and reports attempts 2', () => { /* summary.json attempts === 2 */ });
it('does not retry exit code 8', () => { /* one invocation */ });
it('exits 8 when tests ran and some failed', () => { /* exit code 8 */ });
it('exits 6 when the run produced no report at all', () => { /* infra_failed, not a false green */ });
it('exits 65 when the NUnit report exists but cannot be parsed', () => { /* internal error, not a false green */ });
it('passes -- -nographics for EditMode when nographics is enabled', () => { /* argv ends with ['--','-nographics'] */ });
it('puts --format json before the -- separator', () => { /* the final wrapper argv, asserted exactly */ });
it('does not pass -nographics for PlayMode', () => { /* absent */ });
it('exits 6 when the report file exists but is zero bytes', () => { /* exists is not enough — non-empty or nothing */ });
it('does not double-count the test totals when a run is retried', () => { /* one report's counts, not two */ });
it('reports total 0 and failed 0 only when a report really exists', () => { /* asserts the missing-report case is infra_failed */ });
it('writes summary.json with the documented schema', () => { /* shape check */ });
it('never leaks the license serial into summary.json', () => { /* no secret in file */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/run-test.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`runTest`:
1. `await doctorCommand(ctx)` — the preflight gate (R11), **first**. The spec's Section 4.5 gives the order as `doctor (preflight) → setup: verify or install (EULA-gated) + terms accept → packages preflight (git ls-remote)`, and the preflight gate comes first: if the machine itself cannot build or test (glibc, disk space, the CLI), that must be reported before the toolkit starts installing an Editor. `setup` deliberately does not run `unity doctor --ci` — that is `doctor`'s job — so without this call the run path would never execute the preflight at all.
2. `await setup(ctx)` — on failure, `finally` still runs the teardown.
3. `await activateLicense(ctx)` inside the same `try`.
4. `finally { await returnLicense(ctx) }` (GC9).
5. For each mode in `config.test.modes` (default `['EditMode']`), build argv:
   `['test', projectPath, '--mode', mode, '--output', <test.outputDir>/<mode>.xml, '--report-format', 'nunit,junit', '--junit-output', <test.outputDir>/<mode>.junit.xml, '--format', 'json']` plus `--filter <pattern>` when set, `--coverage --coverage-output <test.outputDir>/coverage` when `config.test.coverage`, `--shard <N/M>` when `config.test.shards` is set, `--retries <n>` when `config.test.retries > 0`, and the editor arguments `-- -nographics` when `config.test.nographics` is true **and** the mode is `EditMode` (PlayMode needs a graphics device for simulated input).

   **`--shard` takes `N/M`, not a plain number** — `unity test --help` says "Run only one slice of the suite, written as N/M, so parallel CI jobs can split it". `config.test.shards` is therefore a **string** (`'1/3'`), passed through verbatim; the core does not parse or derive it.

   **`--retries` and the toolkit's retry are different things.** `unity test --retries <n>` re-runs individual *failing tests* inside one invocation and reports any that pass on a retry as **flaky** (Unity's own range is 0–10). The toolkit's `withRetry` re-runs the whole *invocation*. Both may be active at once and they compose: the inner one settles a flaky test, the outer one retries an infrastructure failure.

   Exactly **one** `--mode` per invocation: the CLI accepts a repeated `--mode` and silently lets the **last one win**, so a config bug would run PlayMode instead of EditMode with no diagnostic. The core owns mode selection and must never emit two.
   `--junit-output` is only valid together with `nunit,junit` — with `junit` alone the JUnit report *is* `--output`, and passing both is a usage error (exit 2). The core therefore always requests `nunit,junit` and passes both paths.
   `--allow-install` is **never** sent (see Task 5): a missing Editor fails fast with the exact install command instead.
6. Each mode's run goes through `withRetry` with the configured policy.
7. After the runs, **verify the artifacts before believing them**: each NUnit report path must exist and be non-empty. Then parse it with `parseNUnit` (Task 8).
   - A mode exited 0 but produced **no report file** (or an empty one) → the run is `infra_failed` and the overall exit code is **6** — never a false green (Review Focus #1). This is a real failure mode: `unity test --output <directory>` runs the tests, exits 8, and writes **no report at all**, with no error and no warning.
   - A report exists but cannot be parsed → the exit code is **65** (GC7).
   - A mode that exited 8 (tests ran and failed) **must** have produced a report; a missing report alongside exit 8 is still `infra_failed` (6), because "tests failed" without an artifact is not a result anyone can act on.
8. Aggregate `tests` counts across modes; aggregate `reports`.
9. Write `summary.json` per GC11 using `buildSummary` and `writeSummary`, including `cliVersion`, `cliChannel` and `cliCommit` resolved by `setup`.

`runCommand` dispatches to `runTest` or `runBuild`, writes `summary.json`, and returns the exit code: `0` when the underlying result is `passed`, `8` when `tests_failed`, otherwise the raw Unity exit code (6, 11, 12, 14 …). A config-validation failure returns **64** without running anything.

**The teardown returns a seat only if the toolkit took one.** GC9 makes the teardown *unconditional* — the `finally` always runs it — but "unconditional" must not mean "return whatever licence this machine happens to have". Under `license.mode: none` a developer's own personal licence is active and must be left alone; a blanket `unity license return` would **return the developer's licence** as a side effect of running the toolkit locally. So the `finally` always calls `returnLicense`, and `returnLicense` is a **no-op** — with a debug log — when `activateLicense` reported that the toolkit activated nothing (`activated: false`). The same applies when `setup` or `doctor` failed before activation was ever attempted.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/lifecycle/test.ts core/src/commands/run.ts core/test/run-test.test.ts
git commit -m "feat: add the run test lifecycle"
```

---

## Task 10: `run build`, provenance and the JUnit fallback

**Files:**
- Modify: `core/src/commands/run.ts` (add the `build` branch), `core/src/lifecycle/test.ts` (share the lifecycle), `core/src/report/junit.ts` (fallback wiring)
- Create: `core/src/lifecycle/build.ts`
- Test: `core/test/run-build.test.ts`

**Interfaces:**
- Consumes: `setup`, `activateLicense`, `returnLicense`, `withRetry`, `unityBuild`, `writeSummary`; `Config`; `CoreContext`.
- Produces: `core/src/lifecycle/build.ts` → `export interface BuildRunResult { status: 'passed' | 'infra_failed'; exitCode: number; unityExitCode: number; attempts: number; artifacts: string[]; provenance: Record<string, unknown> | null }`, `export async function runBuild(ctx: CoreContext): Promise<BuildRunResult>`. `exitCode` is present for the same reason `TestRunResult` carries one: **6** and **65** cannot be told apart from `status` plus `unityExitCode`, and the caller must be able to say which. A build has no `tests_failed` status — a build either produced its artifact or it did not.

- [ ] **Step 1: Write the failing tests**

```ts
it('runs setup, activates, builds and returns the license', () => { /* call order */ });
it('passes --target and --output-path to unity build', () => { /* argv */ });
it('passes --log-file so the Editor log lands in ci-output/logs/editor.log', () => { /* argv */ });
it('passes --execute-method only when configured', () => { /* absent otherwise */ });
it('passes --versioning-strategy custom with --build-version', () => { /* both */ });
it('passes --android-export-type and --android-version-code when configured', () => { /* both */ });
it('passes --allow-dirty-build only when configured', () => { /* absent otherwise */ });
it('fails with exit 64 when the target needs an execute-method and none is configured', () => {
  /* unity build --list-targets --format json → zeroCode:false for Android */ });
it('never passes --allow-install', () => { /* absent */ });
it('writes the provenance manifest and merges it into summary.json', () => { /* provenance key present */ });
it('lists the build output under artifacts in summary.json', () => { /* non-empty */ });
it('returns the license when the build fails', () => { /* returnLicense called */ });
it('does not return a license it never took', () => { /* activation failed → no unity license return */ });
it('returns the recorded exit code on a failed build', () => { /* code preserved, including 6 and 65 */ });
it('converts NUnit to JUnit when unity produced no JUnit file', () => { /* fallback triggers */ });
it('does not convert when unity already produced a JUnit file', () => { /* no conversion */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/run-build.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`runBuild` mirrors `runTest`'s lifecycle — **`doctor` → `setup` → activate → build → report → `finally` return** — and builds argv:
`['build', projectPath, '--target', <target>, '--output-path', <outputPath>, '--log-file', <outputDir>/logs/editor.log, '--provenance-path', <outputDir>/build/provenance.json]` with `--format json` inserted **before any `--` separator** (the wrapper owns that placement, see Task 4 — do not append it to the end of the list).
(`unity build` is the only one of the two that accepts `--log-file`; `unity test` does not, so a test run leaves `logs.editor` null — GC10.)
plus, when set: `--profile <profile>`, `--execute-method <method>`, `--versioning-strategy <strategy>`, `--build-version <version>` (only when strategy is `custom`), `--android-export-type <type>`, `--android-version-code <n>`, `--android-target-sdk-version <n>`, `--allow-dirty-build`.

`--allow-install` is **never** sent (Task 5).

Before building, the target is validated against `unity build --list-targets --format json`, whose rows carry a machine-readable `zeroCode` boolean and a `requirement` string: `StandaloneWindows64`, `StandaloneLinux64` and `StandaloneOSX` are zero-code (no `--execute-method` needed, `--output-path` still required), while `Android`, `WebGL`, `iOS` and the rest require either `--execute-method` or a Unity 6+ build profile. If the configured target needs `--execute-method` and none is configured, the core fails with exit **64** naming both options, rather than letting the build start and fail. If no build profile exists in the project, `unity build --profile` exits **6** with an actionable message — the core surfaces that as a configuration problem, not a generic build failure. The human-formatted `--list-targets` output is a tab-separated table and is never parsed.

The JUnit fallback lives in the shared report step: after a test run, for each mode, if the JUnit file is **missing** and the NUnit file **exists**, convert it with `nunitToJUnit` and write the `.junit.xml` (Review Focus #2). If neither exists, the run is `infra_failed`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/lifecycle/build.ts core/src/commands/run.ts core/src/report/junit.ts core/test/run-build.test.ts
git commit -m "feat: add the run build lifecycle and JUnit fallback"
```

---

## Task 11: Signal handling

**Files:**
- Create: `core/src/lifecycle/signals.ts`
- Test: `core/test/signals.test.ts`

**Interfaces:**
- Consumes: `CoreContext`; `returnLicense` from `core/src/lifecycle/license.ts`.
- Produces: `core/src/lifecycle/signals.ts` → `export interface SignalHandlers { dispose(): void }`, `export function installSignalHandlers(ctx: CoreContext, onSignal: (code: number) => Promise<void>): SignalHandlers`.

- [ ] **Step 1: Write the failing tests**

```ts
it('returns the license on SIGINT', () => { /* emit SIGINT */ });
it('returns the license on SIGTERM', () => { /* emit SIGTERM */ });
it('exits 130 on SIGINT and 143 on SIGTERM', () => { /* exit codes */ });
it('writes summary.json before exiting on a signal', () => { /* file exists */ });
it('does not return the license twice when two signals arrive', () => { /* one call */ });
it('bounds the teardown with a timeout so a hung return cannot block the exit', () => { /* fake timers */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/signals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`installSignalHandlers` registers `process.on('SIGINT', handler)` and `process.on('SIGTERM', handler)`. The handler sets a `handled` flag (so a second signal is ignored), awaits `onSignal(code)` — which runs `returnLicense` under a 60 s `Promise.race` timeout and writes `summary.json` — then calls `process.exit(code)` with `130` for SIGINT and `143` for SIGTERM. `dispose()` removes the listeners.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/lifecycle/signals.ts core/test/signals.test.ts
git commit -m "feat: return the license on SIGINT and SIGTERM"
```

---

## Task 12: `cache-info` command

**Files:**
- Create: `core/src/commands/cache-info.ts`
- Test: `core/test/cache-info.test.ts`

**Interfaces:**
- Consumes: `unityCacheKey`, `unityCacheInfo`; `Config`; `CoreContext`.
- Produces: `core/src/commands/cache-info.ts` → `export interface CacheInfo { editor: { paths: string[]; key: string }; library: { paths: string[]; key: string; staticKey: string } }`, `export async function cacheInfo(ctx: CoreContext): Promise<CacheInfo>`, `export async function cacheInfoCommand(ctx: CoreContext): Promise<number>` (prints `--json` when `--json` is passed, otherwise a human summary).

- [ ] **Step 1: Write the failing tests**

```ts
it('reports the download cache path from unity cache info', () => { /* editor.paths contains it */ });
it('reports the library cache key from unity cache key', () => { /* library.key present */ });
it('reports a static library key made of the editor version and target', () => { /* library.staticKey */ });
it('reports the library path inside the project', () => { /* <root>/Library */ });
it('prints valid JSON when --json is passed', () => { /* JSON.parse */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/cache-info.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`cacheInfo` calls `unity cache info --format json` for `data.path` (the Editor **download cache** — `$XDG_CONFIG_HOME/unityhub/downloads` on Linux, `%APPDATA%\UnityHub\downloads` on Windows, `~/Library/Application Support/UnityHub/downloads` on macOS) and `unity cache key <project> --target <target> --format json` for `data.key`. It builds the spec's shape:
- `editor.paths` = `[<download cache path>]`, `editor.key` = `unity-downloads-<editorVersion>`.
- `library.paths` = `[<projectRoot>/Library]`, `library.key` = the key from `unity cache key`.
- `library.staticKey` = `unity-library-<editorVersion>-<target>` — for providers (like GitLab) that must compute a cache key **before** the job's script runs and therefore cannot shell out.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add core/src/commands/cache-info.ts core/test/cache-info.test.ts
git commit -m "feat: add cache-info command"
```

---

## Task 13: The fake `unity` binary and the CLI entrypoint

**Files:**
- Create: `testing/fake-unity/package.json`, `testing/fake-unity/fake-unity.mjs`, `testing/fake-unity/README.md`
- Create: `core/src/cli.ts` (wire every command), `core/src/index.ts`
- Test: `core/test/cli.test.ts`

**Interfaces:**
- Consumes: every command module from Tasks 5–12.
- Produces:
  - `core/src/cli.ts` → `export async function main(argv: string[]): Promise<number>` — parses args, loads config, builds the `CoreContext`, dispatches to `doctor | setup | license | run | report | cache-info`, and returns the exit code. Unknown command → exit **2** with usage text.
  - `core/src/index.ts` → `export { main } from './cli.js'` plus the public types.
  - `testing/fake-unity/fake-unity.mjs` → a Node script that emulates the `unity` CLI. It reads the scenario file named by the env var `FAKE_UNITY_SCENARIO` (a JSON file) and behaves accordingly:
    ```json
    { "results": [ { "args": ["test"], "code": 0, "json": { "success": true } } ],
      "files": { "ci-output/tests/EditMode.xml": "<nunit xml>" } }
    ```
    It writes any `files` entries relative to the current working directory, prints `json` as the stdout when `json` is set, and exits with `code`. Unmatched invocations exit **2** with a message naming the args, so a test can assert exactly which argv the core produced.

- [ ] **Step 1: Write the failing tests**

```ts
it('exits 2 with usage for an unknown command', () => { /* code 2 */ });
it('exits 0 for --version and prints the package version', () => { /* */ });
it('exits 0 for --help and prints usage', () => { /* */ });
it('dispatches run test to the run command', () => { /* summary.json written */ });
it('uses the fake unity binary when the config points at it', () => { /* scenario consumed */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`fake-unity.mjs` parses `FAKE_UNITY_SCENARIO`, matches the invocation by testing whether the scenario's `args` array is a prefix of `process.argv.slice(2)`, and falls back to the first matching result. It must also support a `default` result for invocations no scenario entry matches. Writing `files` uses `fs.mkdirSync(dirname, {recursive:true})` then `fs.writeFileSync`.

`cli.ts` wires the dispatch and is the only place that knows the command names. It registers the secret env vars with the redactor **before** the logger is created (GC6), so no secret can reach the log.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add testing/fake-unity core/src/cli.ts core/src/index.ts core/test/cli.test.ts
git commit -m "feat: add the CLI entrypoint and the fake unity binary"
```

---

## Task 14: GitHub adapter and adapter conformance

**Files:**
- Create: `adapters/github/action.yml`, `adapters/github/README.md`
- Create: `testing/conformance/check-adapters.ts`
- Test: `core/test/conformance.test.ts`

**Interfaces:**
- Consumes: the `unityci` binary and the `summary.json` / `ci-output/` contract.
- Produces:
  - `adapters/github/action.yml` — a composite action (`runs.using: composite`). Inputs: `command` (`test` | `build`), `project-path`, `config`, `output-dir`, `annotations`, `license-mode`, `accept-eula` (`false` | `true`), `unityci-version` (default `source`), `unity-version`, `build-target`, `shards`, `cache` (`true` | `false`). Steps, in order:
    1. Install the `unityci` binary — when `unityci-version` is `source`, run `pnpm install --frozen-lockfile && pnpm --filter @unityci/core build` and use `core/dist/cli.js`; otherwise `npm install -g @unityci/core@<unityci-version>`.
    2. Install the Unity CLI — `curl -fsSL https://unity.com/install.sh | bash` and add `$HOME/.local/bin` to `$GITHUB_PATH`. The installer takes the latest beta; the core warns when the running CLI is newer than tested and never fails on it (GC17).
    3. Install the Editor's runtime libraries — the exact `apt-get` list recorded in Spike 0 (S5), with a `t64`-suffix fallback for older images, plus `ulimit -n 4096`. The list is **inferred, not Unity-published**; the step's comment must say so.
    4. Restore the Editor **download** cache — `actions/cache` with `path: ~/.config/unityhub/downloads` and `key: unity-downloads-<editorVersion>`. Never cache or delete the Editor install directory: it is global and shared with the Hub and other projects.
    5. Restore the project `Library` folder — compute `unity cache key --target <target>` into `$GITHUB_OUTPUT`, then `actions/cache` with `path: <project-path>/Library` and `key: unity-library-<key>`.
    6. Run — `unityci run <command> --project-path <project-path> --output-dir <output-dir> --annotations github`.
    7. Upload artifacts — `actions/upload-artifact` with `path: <output-dir>` and `if: always()`.
    8. Return the licence — `unityci license return` with `if: always()`. **The teardown must not fail the job.** `unityci license return` exits **6** when the seat was not returned — a deliberate choice, because a user who explicitly asked for a seat back must not be told it succeeded when it did not (a leaked Unity seat is expensive and silent). But in an `if: always()` teardown step, a non-zero exit turns a green test run red, and the teardown is **not** the pass/fail signal — the core decides that (D4). So the step tolerates the failure and raises it as an annotation instead:
       ```yaml
       - name: Return the licence
         if: always()
         shell: bash
         run: |
           unityci license return || echo "::warning::unityci license return failed — the Unity seat may still be held on this runner"
       ```
       The job's own result is decided by the run step, never by the teardown.
    Every third-party action is pinned by **commit SHA**, not a tag. The implementer must look up the current SHA for `actions/checkout`, `actions/cache` and `actions/upload-artifact` and record the version each SHA corresponds to in a comment.
    The action never passes `--allow-install` (the core fails fast with the exact install command instead) and never puts a secret on a command line: the licence serial is read by `unity license activate` from `UNITY_LICENSE_SERIAL` in the environment, and the floating/offline alternatives are documented in the action's README.

  - **Private git packages.** A new input pair, `git-credentials` (`none` (default) | `token`) and `git-token`, plus `git-token-repos` — a comma-separated list of `owner/repo` entries, or the literal `all` for a host-wide rewrite. The **default is per-repository**: the input is required when `git-credentials` is `token`, and `all` is the explicit opt-in for a host-wide rewrite, because a host-wide rewrite grants the token read access to every repository in that host, not only the packages the project consumes. When `git-credentials` is `token` and `git-token-repos` is missing or empty, the action **fails with exit 64** naming the input — it never silently falls back to a host-wide rewrite.

    The action adds a step **before** the run step:

    ```yaml
    - name: Configure git credentials for private packages
      if: inputs.git-credentials == 'token'
      shell: bash
      env:
        UNITYCI_GIT_TOKEN: ${{ inputs.git-token }}
        UNITYCI_GIT_REPOS: ${{ inputs.git-token-repos }}
      run: |
        set -euo pipefail
        echo "::add-mask::$UNITYCI_GIT_TOKEN"
        umask 077
        if [ -f "$HOME/.gitconfig" ]; then cp "$HOME/.gitconfig" "$RUNNER_TEMP/gitconfig.snapshot"; fi
        {
          if [ "${UNITYCI_GIT_REPOS}" = "all" ]; then
            printf '[url "https://x-access-token:%s@github.com/"]\n' "$UNITYCI_GIT_TOKEN"
            printf '\tinsteadOf = https://github.com/\n'
          else
            for repo in ${UNITYCI_GIT_REPOS//,/ }; do
              printf '[url "https://x-access-token:%s@github.com/%s.git"]\n' "$UNITYCI_GIT_TOKEN" "$repo"
              printf '\tinsteadOf = https://github.com/%s.git\n' "$repo"
            done
          fi
        } >> "$HOME/.gitconfig"
    ```

    and a matching teardown step, `if: always()`, that restores the snapshot or removes `~/.gitconfig` when there was none.

    Four rules this step must obey, each with a reason:
    - **`::add-mask::` before the first use** — the value must never reach a log line (GC24).
    - **A shell *builtin*, not `git config --global url.…`** — `git config` would put the token in its own argv, and argv is visible in the process list and in shell tracing. `printf` and `cp` are bash builtins on the Actions runner, so the token never enters a process's arguments. The step therefore declares `shell: bash` explicitly.
    - **A credential-free URL in `Packages/manifest.json`** — the rewrite is applied by git at fetch time, so the manifest and the committed `packages-lock.json` keep the plain URL (GC21, measured in `docs/decisions/upm-git-auth-probe.md`).
    - **`GIT_CONFIG_GLOBAL` must not be used** — Unity's Package Manager ignores it, and it fails at resolution with an error that looks like a Unity bug. The rewrite goes into `~/.gitconfig`, which is measured to work.

    The action's README documents the no-file-on-disk alternative for a single-step job — the per-invocation `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` variables, which the Package Manager also honours (measured) — and warns that `GIT_CONFIG_GLOBAL` does not work.
  - `testing/conformance/check-adapters.ts` → `export async function checkAdapter(dir: string): Promise<{ file: string; rule: string; ok: boolean; detail: string }[]>` with these rules, each adapter file checked:
    - `calls-unityci`: the file contains `unityci ` and does **not** contain a bare `unity ` invocation outside a comment.
    - `has-teardown`: the file contains a step with `if: always()` that runs `unityci license return`.
    - `teardown-does-not-fail-the-job`: that teardown step tolerates a non-zero exit from `unityci license return` (an `||` fallback that emits a warning annotation), so a failed licence return cannot turn a green run red. The pass/fail decision belongs to the run step alone (D4).
    - `no-retry-logic`: the file contains no `retry`/`attempt`/`max-attempts` construct.
    - `no-exit-code-logic`: the file contains no comparison against a numeric Unity exit code.
    - `publishes-on-zero-and-eight`: the artifact/report upload step uses `if: always()` or an equivalent that does not gate on the run's success.
    - `pinned-actions`: every `uses:` line is pinned to a 40-character commit SHA.
    - `masks-credentials`: if the file mentions a token or a secret, it also contains an `add-mask` call for it, **before** the first use.
    - `no-credential-on-command-line`: the file never passes a credential to `git config` (whose argument would land in the process list) — the rewrite is written with a shell builtin instead.
    - `no-git-config-global-env`: the file never sets `GIT_CONFIG_GLOBAL`, which Unity's Package Manager ignores.

- [ ] **Step 1: Write the failing test**

`core/test/conformance.test.ts`:
```ts
it('the GitHub adapter satisfies every conformance rule', () => {
  const results = await checkAdapter('adapters/github');
  expect(results.filter(r => !r.ok)).toEqual([]);
});
it('detects a retry loop added to an adapter', () => { /* a temp file with 'maxAttempts' fails no-retry-logic */ });
it('detects a missing license-return teardown', () => { /* temp file without 'always()' fails */ });
it('detects an unpinned action', () => { /* 'actions/cache@v4' fails pinned-actions */ });
it('detects a credential passed to git config on a command line', () => { /* fails no-credential-on-command-line */ });
it('detects GIT_CONFIG_GLOBAL', () => { /* fails no-git-config-global-env */ });
it('detects a token used without being masked', () => { /* fails masks-credentials */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/conformance.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Write `adapters/github/action.yml` and `adapters/generic/README.md`, then `testing/conformance/check-adapters.ts`. The checker reads each `.yml`/`.yaml` file in the adapter directory and applies the six rules, returning one result per rule per file. Comment lines (starting with `#`) are stripped before the checks so that Unity's own annotated workflow text does not trip a rule.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add adapters testing/conformance core/test/conformance.test.ts
git commit -m "feat: add the GitHub adapter and adapter conformance checks"
```

---

## Task 15: The minimal example project

**Files:**
- Create: `examples/minimal-project/` (a real Unity project)
- Create: `examples/minimal-project/unity-ci.yml`
- Test: `core/test/example-project.test.ts`

**Interfaces:**
- Consumes: `unity projects create`; the `unityci` CLI.
- Produces: a Unity project at `examples/minimal-project` with:
  - `ProjectSettings/ProjectVersion.txt` naming an Editor version,
  - `Packages/manifest.json` **without** `com.unity.pipeline` (proving S7 — batch build/test does not need it),
  - `Assets/Tests/EditMode/` with an assembly definition (`DustGames.Minimal.Tests.asmdef`, `testAssemblies: true`) and one NUnit test that passes,
  - `Assets/Editor/Builder.cs` with a `public static void PerformBuild()` that builds the standalone player to the path given by `-buildOutput` (or a default under `Build/`),
  - `unity-ci.yml` configuring `test.modes: [EditMode]`, `build.target: StandaloneWindows64`, `output.dir: ci-output`.

- [ ] **Step 1: Write the failing test**

`core/test/example-project.test.ts`:
```ts
it('the example project exists and names its Editor version', () => { /* ProjectVersion.txt parses */ });
it('the example project does not depend on com.unity.pipeline', () => { /* manifest has no pipeline package */ });
it('the example project has an EditMode test assembly with at least one test', () => { /* asmdef + [Test] */ });
it('the example project has a static build method', () => { /* Builder.PerformBuild */ });
it('the example config sets the output dir and the test modes', () => { /* yaml parse */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/example-project.test.ts`
Expected: FAIL — the project does not exist yet.

- [ ] **Step 3: Create the project**

Run: `unity projects create "minimal-project" --path <repo>/examples --bare --no-cloud --editor-version <version>`

Then hand-write `Assets/Tests/EditMode/MinimalTests.cs`, `Assets/Tests/EditMode/DustGames.Minimal.Tests.asmdef`, `Assets/Editor/Builder.cs` and `examples/minimal-project/unity-ci.yml`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test`
Expected: PASS — all tests green.

- [ ] **Step 5: Verify the example actually runs (manual, not part of the automated suite)**

Run: `node core/dist/cli.js run test --project-path examples/minimal-project --output-dir examples/minimal-project/ci-output`
Expected: exit 0, `examples/minimal-project/ci-output/summary.json` written with `"status": "passed"`.

- [ ] **Step 6: Commit**

```bash
git add examples core/test/example-project.test.ts
git commit -m "feat: add the minimal example Unity project"
```

---

## Task 16: Repository self-CI and documentation

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/example.yml`, `.github/workflows/nightly.yml`
- Create: `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/local-development.md`, `docs/generic-ci.md`, `docs/compatibility.md`
- Modify: `unity-ci-design.md` (Section 12 hygiene items: license choice, trademark note)

**Interfaces:**
- Consumes: the `unityci` CLI, `adapters/github/action.yml`, `core/package.json` scripts.
- Produces:
  - `root package.json` scripts: `test` → `pnpm -C core test`, `build` → `pnpm -C core build`, `typecheck` → `pnpm -C core typecheck`, `lint:provider-neutrality` → the grep check, `lint:spawn` → the spawn check, `check:adapters` → the conformance check.
  - `.github/workflows/ci.yml` — runs on every push and PR: checkout, install pnpm, `pnpm install --frozen-lockfile`, `pnpm run typecheck`, `pnpm run test`, `pnpm run lint:provider-neutrality`, `pnpm run lint:spawn`, `pnpm run check:adapters`. No Unity licence needed.
  - `.github/workflows/example.yml` — the integration job: uses `adapters/github/action.yml` against `examples/minimal-project`. It runs only on pushes to `main` and on tags — **never on fork pull requests** — and takes the licence from repository secrets.
  - `.github/workflows/nightly.yml` — the **upstream drift test** (spec Section 8.4): a scheduled job that installs the **latest** Unity CLI and runs the unit suite plus the example integration, so a new beta that breaks the contract fails loudly instead of surprising a user. It opens an issue on failure.
  - `README.md` — what it is, the two-minute local quick start, the CI quick start, the status of the Unity CLI (**experimental**, beta channel, no stable release yet, GA undated), the **support caveat** (Unity supports the Editor on "workstations or laptop form factors running without emulation, container or compatibility layer"; a bare CI runner works but sits outside that statement, and RHEL 9 supports the CLI but not the Editor), the trademark disclaimer, and a table pointing at `docs/`.
  - `docs/local-development.md` — running `unityci` on a developer machine: install the Unity CLI, `pnpm install`, `pnpm -C core build`, `unityci doctor`, `unityci run test`, the fake-unity workflow, and how to run the same thing on Linux (including the runtime-library list and `ulimit -n 4096`).
  - `docs/generic-ci.md` — the documented minimum for any CI system (doctor → run → always-run licence return), plus how to wire cache from `unityci cache-info --json`.
  - `docs/compatibility.md` — a matrix of tested Unity CLI and Editor versions, the **pinning policy** (the CLI self-updates and cannot be reliably pinned: the Hub updates it automatically and that cannot be disabled, and winget/MSIX installs self-update with no rollback — so pin by *install method* (apt/dnf/brew with an explicit version, or a standalone binary outside the Hub's path), never by a version string), and the capability matrix the core probes.
  - `docs/private-packages.md` — consuming a package from a **private git repository**: why the manifest URL must stay credential-free (Unity copies it verbatim into the committed `packages-lock.json`), the git URL-rewrite mechanism, the three delivery mechanisms that are measured to work (`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, per-invocation `GIT_CONFIG_*`) and the one that does **not** (`GIT_CONFIG_GLOBAL`), the least-privilege per-repository rewrite, the local-developer equivalents (Git Credential Manager, `gh auth setup-git`), the `git ls-remote` preflight, and a copy-paste recipe for GitHub Actions and for generic CI. It cites `docs/decisions/upm-git-auth-probe.md` for the measurements and marks SSH support as unverified.
  - `CONTRIBUTING.md` — the adapter contract (Section 5.1) and the "no core changes for a new provider" rule, with a how-to for writing a new adapter.
  - `SECURITY.md` — how to report a vulnerability, and the secrets-handling rules (env only, never argv, redaction before logging).

- [ ] **Step 1: Write the failing test**

Extend `core/test/example-project.test.ts` with:
```ts
it('the root package.json exposes test, build, typecheck and the three lint scripts', () => { /* keys present */ });
it('the self-CI workflow never runs Unity on a fork pull request', () => { /* example.yml has no pull_request trigger */ });
it('a nightly workflow exists that installs the latest Unity CLI', () => { /* nightly.yml has a schedule trigger */ });
it('the nightly workflow is not secret-bearing on fork pull requests', () => { /* no pull_request trigger */ });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm -C core test test/example-project.test.ts`
Expected: FAIL — the scripts and workflow do not exist yet.

- [ ] **Step 3: Implement**

Write the workflows and the four documents. The provider-neutrality lint script is:
```
grep -rnE "GITHUB_|GITLAB_|JENKINS_|CIRCLECI_|BUILDKITE_|AZURE_" core/src --include=*.ts | grep -v "core/src/report/annotations.ts"
```
and must print nothing. The spawn lint script is:
```
grep -rnE "\b(spawn|spawnSync|exec|execFile|execSync)\(" core/src --include=*.ts | grep -v "core/src/exec.ts"
```
and must print nothing.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm -C core test` and `pnpm run lint:provider-neutrality` and `pnpm run lint:spawn` and `pnpm run check:adapters`
Expected: all green, both lint scripts print nothing.

- [ ] **Step 5: Commit**

```bash
git add .github README.md docs unity-ci-design.md package.json
git commit -m "docs: add repository self-CI, README and guides"
```

---

## Execution Order

Tasks 1–16 in order, one implementer at a time. The hard dependencies are:

- Task 2 → Task 3 (config needs the primitives)
- Task 3 → Task 5, 6, 7, 8, 9, 10, 12 (everything needs `Config` and `CoreContext`)
- Task 4 → Task 5, 6, 9, 10, 12 (everything spawns through `exec.ts`)
- Task 7 → Task 9, 10 (retry)
- **Task 8 (reporting) → Task 9, 10** (the run loops consume `parseNUnit`, `writeSummary`, `buildSummary`)
- Task 5 → Task 9, 10 (the run loops call `setup`)
- Task 6 → Task 9, 10 (the run loops activate and return the licence)
- Task 11 → Task 13 (the entrypoint installs the signal handlers)
- Task 13 → Task 14, 15, 16 (the entrypoint is needed to run the example end to end and to run the adapter conformance check)

Task 1 is documentation only and touches no code; it must still land first, because every later task's Global Constraints cite its resolved facts.

Tasks 14, 15 and 16 may be dispatched after Task 13. Tasks must not be implemented in parallel — the SDD skill dispatches one implementer at a time.
