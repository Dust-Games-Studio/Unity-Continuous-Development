# Compatibility

The Unity CLI is stable at 1.0.x, and still self-updating. This page records
what this project has actually been run against, how to make a pipeline
repeatable **without** pretending a version string is a pin, and what the core
probes at runtime instead of trusting a version.

## Tested versions

| Component | Tested here | Behaviour outside the range |
|---|---|---|
| Unity CLI | **1.0.0 – 1.0.1** (`TESTED_CLI_MIN` / `TESTED_CLI_MAX` in `core/src/unity/cli.ts`) | Below the floor: exit **64**, blocking. Above the ceiling: a loud warning and the run continues. Unparsable version: `info`, no verdict. |
| Unity Editor | **6000.6.6f1** — the version pinned by `examples/minimal-project/ProjectVersion.txt` and used for the end-to-end reference runs | The Editor version comes from the project's `ProjectVersion.txt`; it is not version-gated. A missing Editor is a fail-fast with the exact `unity install` command, or an explicit install when `unity.editor.acceptEula: true`. |
| Linux | Ubuntu 22.04 / 24.04 on x64 (the Editor's supported target); glibc 2.34+ for the CLI | RHEL 9 is **CLI-only**: the CLI supports it, the Editor does not. |
| macOS | CLI floor macOS 14+ (declared by the CLI) | Not exercised by this repository's CI yet. |
| Windows | Windows 10 21H1+ (CLI floor); the core's unit suite runs on Windows during development | The Editor and the CLI were exercised on Windows during Spike 0; CI runs Linux first. |

`summary.json` always records `cliVersion`, `cliChannel`, `cliCommit` and
`editorVersion`, so a failure can be traced to the exact CLI build and Editor
that produced it. `unity version --format json` is captured **first**, before
any other Unity call.

### Editor support is narrower than "it runs in CI"

Unity supports the Editor on "workstations or laptop form factors running
without emulation, container or compatibility layer". A bare CI runner **works**
— Unity's release notes record that `unity test` runs on a Linux machine without
a display server — but it sits outside that support statement. The Editor's
supported Linux target is Ubuntu 22.04/24.04 on x64 with a Gnome desktop on
X11/Wayland and an OpenGL 3.2+/Vulkan GPU.

`-nographics` exists to run automated workflows on machines without a GPU and is
used for EditMode tests and batch builds. **PlayMode tests without a display are
unverified** and are not claimed to work; `test.nographics` is forced off for
PlayMode, where simulated input needs a graphics device.

## Pinning policy: pin the install method, not a version string

The obvious instruction — "pin the CLI version" — is wrong for this tool, and
saying only that would give a false sense of reproducibility. The measured
facts:

- **The Unity Hub updates the CLI automatically, and that cannot be disabled.**
  A Hub-managed install is therefore not pinned, whatever version you asked
  for.
- **A winget/MSIX install keeps the CLI current in the background, and rollback
  is not available** for MSIX installs. The winget package now carries stable
  releases only.
- **`install.sh` / `install.ps1` now install the latest stable release.**
  `UNITY_CLI_CHANNEL=beta` before the installer selects the beta channel.
- `unity self-update --target <version>` keeps the version you chose; the Hub
  no longer replaces it at start. `unity self-update --rollback <version>`
  restores a kept build (the last three are kept by default).
- `unity config update-check off` silences the CLI's update *notice*; it does
  not stop the Hub from updating the binary.

A version string in a cache key or a config file is therefore a comment, not a
control. Pin the **install method** instead:

1. **A package manager with an explicit version** — apt, dnf or Homebrew — and
   hold that version (apt-mark hold / dnf versionlock / brew pin or a locked
   formula). This is the most repeatable route.
2. **A standalone binary kept outside the Hub's path**, downloaded from a
   specific release, with `PATH` selecting it. Verify with `which unity` and
   `unity version --format json`, and record the commit hash you observed.

Also pin the things that actually define the machine: the runner image or
container digest, the Editor version from `ProjectVersion.txt`, and the package
lock file. The CLI's own update behaviour is the part you cannot pin from the
inside.

A run against a newer CLI is not failed: the core warns, records the build and
continues. The weekly [nightly workflow](../.github/workflows/nightly.yml)
installs the **latest** CLI on purpose, runs the unit suite and the real example
integration, and opens an issue when upstream has drifted — so a new release
fails there, loudly, instead of surprising a user mid-week.

A project can also pin the CLI range it supports with `cli.version` in
`ProjectSettings/UnityCliConfig.json`. In CI, a command run outside that range
stops with exit **1** and `CLI_VERSION_OUT_OF_RANGE`; `unity version`,
`unity upgrade`, `unity doctor` and `unity config` stay exempt so the CLI can
still be updated.

## The capability matrix the core probes

The core never gates a run on a **high** version number. Releases still add,
rename and remove commands and flags between drops, so it probes for what it
needs and reports a clear "this CLI does not support X" instead of crashing
(R13, GC18). A command the CLI does not recognise is *unsupported*, not a
generic crash.

| Area | What is probed / called | What happens when it is missing |
|---|---|---|
| Identity | `unity version --format json` | Recorded in `summary.json`; an incomparable version is `info`, not a failure. |
| Preflight | `unity doctor --ci [--skip-license] --format json` | The core's own checks (CLI range, glibc, disk space, licence, `projects verify`) still run. `doctor.skipLicense` defers the licence question to the runner. |
| Run preflight | `git ls-remote --exit-code <url>` in the setup step of `run` | A broken manifest is exit 64; an unreachable private dependency is exit 64 before an Editor starts. `doctor` does not run this check. |
| Project integrity | `unity projects verify --strict --format json` | A missing/unparsable report is `info`; a non-zero exit or findings is a blocking failure. |
| Editor | `unity editors --installed --format json`, `unity install` | An install happens only with `acceptEula: true`; otherwise exit 64 names the exact `unity install` command. Modules required by the invoked command are checked too. `--headless` (Linux), `--resume` and `--architecture` are supported. |
| Terms | `unity terms accept <version> --yes` | A CLI without it is reported; the Editor may stop on the terms dialog. `unity.editor.terms: false` is the explicit opt-out. |
| Licence | `unity license status`, `activate`, `return`, `license server health` | Under `license.mode: none`, no active licence is exit 64. A floating server is health-checked before a seat is requested; an activation route the CLI cannot run is a configuration error. |
| Tests | `unity test` with `--mode`, `--output` (a file), `--report-format nunit,junit`, `--junit-output`, `--shard`, `--affected`, `--rerun-failed`, `--editor-path`, `--accelerator`, … | An unsupported flag/command is reported with the CLI's message; the run produces no false green. |
| Builds | `unity build` with `--target`/`--profile`/`--execute-method`, `--output`, `--no-provenance`, `--build-target-group`, `--editor-path`, `--accelerator`, … | Same: an explicit unsupported-capability report, never a silent fallback. |
| Caches | `unity cache info`, `unity cache key` | `cache-info` degrades to a documented fallback key and still exits 0: a cache hint is never a gate. |

The version range is recorded **and** the capabilities are probed. Either alone
would be fragile: the range cannot predict a release surprise, and a probe
cannot tell you which build produced a suspicious result.

## Reporting a compatibility problem

Include the output of:

```bash
unity version --format json
node core/dist/bin.js doctor --project-path . --verbose
cat ci-output/summary.json
```

and the section of `ci-output/logs/` around the failure. The first two lines
identify the exact CLI and Editor; the summary distinguishes "the tests failed"
from "the run never produced a verdict".

## Exit codes added in 1.0.x

`unity commands --format json` reports these in addition to the codes the
toolkit already handled. The core passes them through unchanged.

| Code | Name | Retried by default |
|---|---|---|
| 15 | `RUN_FAILED` | no |
| 16 | `JOB_SUSPENDED` | yes |
| 17 | `UNAVAILABLE` (Editor loading, compiling, reloading or Safe Mode) | yes |
| 18 | `AWAITING_INPUT` (modal dialog) | no — opt in per pipeline |
| 141 | `OUTPUT_CLOSED` | no |
