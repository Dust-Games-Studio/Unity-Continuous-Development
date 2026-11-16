# Local development

The same `unityci` binary runs on a workstation and in CI. There is no Docker
image and no provider-specific local mode: everything below is the command the
adapter calls, with the same flags. A run that passes locally and fails in CI (or
the reverse) is a bug worth reporting.

## Prerequisites

- **Node 22.12+** for the development toolchain. The published `@unityci/core`
  package needs only **22.4+**; the test runner (vitest 5) raises the floor for
  working on this repository.
- **pnpm 12** (`npm install --global pnpm@12.15.0`, or Corepack).
- **git**, on `PATH`.
- **The Unity CLI**, named `unity`. It is stable at 1.0.x and still
  self-updating; see [compatibility.md](compatibility.md) for the tested range
  and the pinning policy.
- **A Unity Editor** matching the project's `ProjectSettings/ProjectVersion.txt`,
  or `unity.editor.acceptEula: true` so the toolkit can install the missing one
  explicitly.

## Install the Unity CLI

Unity's documented installer for a developer machine:

```bash
# macOS / Linux
curl -fsSL https://unity.com/install.sh | bash

# Windows (PowerShell)
irm https://unity.com/install.ps1 | iex
```

The installers now fetch the **latest stable** release. Set
`UNITY_CLI_CHANNEL=beta` before running one only if you deliberately want the
beta channel. Packages also exist for Homebrew, winget and apt/dnf. Whichever
route you use, verify the result with the machine-readable form, not
`--version`:

```bash
unity version --format json
```

The command echoes the version, channel and commit that the core records in
every `summary.json`. The CLI **self-updates** — the Hub updates it
automatically and cannot be told not to, and a winget/MSIX install keeps itself
current in the background with no rollback. If you need a repeatable local
build, pin the install *method* (an apt/dnf/brew package at an explicit version,
or a standalone binary outside the Hub's path) rather than writing a version
string and hoping. Details: [compatibility.md](compatibility.md).

## Build and run the toolkit

From the repository root:

```bash
pnpm install
pnpm -C core build
```

The compiled entrypoint is `core/dist/bin.js`. Run it against any project:

```bash
node core/dist/bin.js doctor --project-path /path/to/project
node core/dist/bin.js run test --project-path /path/to/project
node core/dist/bin.js run build --project-path /path/to/project
```

Once the package is published, the same commands are `unityci …` after
`npm install --global @unityci/core`; inside this repository the `node
core/dist/bin.js` form always works and needs no global install.

Everything is written under the project's `output.dir` (default `ci-output/`):

```
ci-output/
  summary.json          # the machine-readable result adapters consume
  tests/*.xml           # NUnit 3, one file per mode
  tests/*.junit.xml     # JUnit, written by Unity (the core converts only as a fallback)
  build/…               # build output
  logs/                 # editor and CLI logs where the CLI can produce them
```

`summary.json` is the verdict: `status` is `passed`, `tests_failed`,
`infra_failed` or `config_error`, `exitCode` is the process result, and
`tests`, `reports`, `license`, `cliVersion`/`cliChannel`/`cliCommit` and
`editorVersion` record what actually happened. A `git diff` on test counts is a
useful code-review signal.

### Configuration

`unity-ci.yml` at the project root is the file form. Precedence is **CLI flags
> `UNITYCI_*` environment variables > `unity-ci.yml` > defaults**. A minimal
file for a project with an already-active licence:

```yaml
unity:
  editor:
    version: from-project       # read ProjectSettings/ProjectVersion.txt
    terms: true                 # run `unity terms accept <version> --yes`
    acceptEula: false           # keep false unless the toolkit may install
    headless: false             # Linux only: install the headless Editor
    architecture: null          # x86_64 | arm64
    path: null                  # pin a specific Editor binary (--editor-path)
    resume: true                # resume a cached/interrupted download
test:
  modes: [EditMode]
  # 1.0.x: run only the tests a change can reach.
  affected: false
  since: origin/main
build:
  provenance: true              # false sends --no-provenance
output:
  dir: ci-output
```

The default `license.mode: none` does not activate anything: an active licence
is a precondition, and the run exits 64 with the three unattended routes if
none is active. The routes are `serial` (the serial comes from
`UNITY_LICENSE_SERIAL` in the environment, never from argv), `floating` (a
server must already be configured — check it with `unity license server
status` first) and `offline-file` (base64 `.ulf` in
`UNITY_LICENSE_FILE_BASE64`). An offline licence **cannot be returned**;
`license return` leaves it in place, so that runner leaks a seat and it has to
be reclaimed by hand.

Secrets never go in this file. `UNITY_SERVICE_ACCOUNT_ID`,
`UNITY_SERVICE_ACCOUNT_SECRET`, `UNITY_LICENSE_SERIAL`,
`UNITY_LICENSE_FILE_BASE64` and `UNITYCI_SECRET_*` are environment-only. The
loader's secret-name guard scans the whole parsed file — every key and string
value, at any depth, including array entries, case-insensitively and with
`_`/`-` variants — and turns a hit into a configuration issue and **exit 64**.
The message names the path and the variable to set in the environment, never the
value. The only exception is `license.serialEnv`/`license.fileEnv`, which exist
to name the environment variable and legitimately hold `UNITY_LICENSE_SERIAL`
or `UNITY_LICENSE_FILE_BASE64`. The same guard still rejects the legacy
`license.serial`, `license.fileBase64`, `license.serviceAccountId` and
`license.serviceAccountSecret` keys.

The Editor version comes from the project. If it is not installed, the core
fails fast with the exact `unity install …` command rather than silently
downloading gigabytes; set `unity.editor.acceptEula: true` to let it run that
install (which accepts Unity's and every selected module's licence agreements).
`unity.editor.headless: true` installs the headless Linux Editor (Linux only);
`unity.editor.resume: true` resumes a cached or interrupted download;
`unity.editor.architecture` selects `x86_64` or `arm64`.

`unity.editor.path` pins a specific Editor binary with `--editor-path`, for a
self-contained or non-Hub install. The run still verifies the project's Editor
version through `editors --installed`; the path only decides which binary the
test or build actually launches.

## The fake-`unity` loop (no Editor, no licence)

The unit suite never launches Unity. `testing/fake-unity/fake-unity.mjs` answers
from a JSON scenario: an argv prefix, an exit code, an optional JSON document
and optional files to write. That is how retry behaviour, licence teardown,
redaction, config precedence and report parsing are tested in milliseconds.

```bash
pnpm -C core test
```

To drive the real CLI against the fake binary by hand, point
`unity.cli.binary` at a shim and tell the fake which scenario to replay:

```yaml
# unity-ci.yml
unity:
  cli:
    binary: /absolute/path/to/unity-shim
```

```bash
FAKE_UNITY_SCENARIO=/absolute/path/to/scenario.json node core/dist/bin.js run test
```

`testing/fake-unity/README.md` documents the scenario format and the POSIX shim
and Windows preload-hook details. Windows matters here: the core spawns with
`shell: false`, and Node cannot launch a `.cmd` file that way.

## Running the same thing on Linux

The CI runner is normally Ubuntu. Two machine-level settings matter:

```bash
# The Editor's shared libraries. This list is INFERRED, not Unity-published:
# Unity's last published Linux dependency list dates from Unity 5.x (2015).
# It is the set Unity's own `ci init` scaffold installs on Ubuntu 24.04.
sudo apt-get update
sudo apt-get install -y --no-install-recommends \
  libgl1 libglu1-mesa libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libdrm2 \
  libxtst6 libxrandr2 libxcursor1 libxcomposite1 libxdamage1 libxfixes3 \
  libxi6 libxrender1 libxext6 libsm6 libice6 libxkbcommon0 libpango-1.0-0 \
  libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 libatk1.0-0t64 \
  libatk-bridge2.0-0t64 libcups2t64 libdbus-1-3 libnotify4 libsecret-1-0

# Ubuntu 24.04 renamed several packages with a `t64` suffix. On 22.04 the same
# list without the suffix is the fallback.

# The Editor opens many files; raise the soft limit or it reports "Pipe error !".
ulimit -n 4096
```

No virtual display is needed for EditMode tests or batch builds: `-nographics`
exists to run automated workflows on machines without a GPU, and Unity's release
notes record that `unity test` runs on Linux without a display server. **PlayMode
tests without a display are unverified** and are not claimed to work.

Unity supports the Editor on "workstations or laptop form factors running
without emulation, container or compatibility layer". A bare runner works but is
outside that statement. RHEL 9 supports the CLI (glibc 2.34+) but not the
Editor. Ubuntu 22.04/24.04 on x64 is the supported Editor target. See
[compatibility.md](compatibility.md).

## Troubleshooting

- **Exit 64 before any Editor starts** — a configuration or precondition
  problem: no active licence, a missing Editor (the message names the exact
  `unity install` command), an invalid target, or a credential-bearing package
  URL. Nothing was spawned.
- **`config_error` in `summary.json`** — the same class, recorded rather than
  only printed; read the `logs/` directory and the message.
- **A report is missing but tests "ran"** — `unity test --output` is a *file*,
  not a directory; a directory is accepted silently and writes nothing. The core
  rejects that shape and asserts every report exists and is non-empty, so this
  is reported as an infrastructure failure (exit 6), never a green run.
- **Tests failed (exit 8)** — the run produced a verdict. Publish the reports;
  do not retry it blindly. The core never retries exit 8.
- **Exit 15 (`RUN_FAILED`)** — the run failed without a more specific code.
  Terminal; read the log.
- **Exit 16 (`JOB_SUSPENDED`) or 17 (`UNAVAILABLE`)** — a transient state
  (install lock, Editor loading/compiling/reloading/Safe Mode). The core retries
  these by default.
- **Exit 18 (`AWAITING_INPUT`)** — a modal dialog blocks the Editor. Not retried
  by default: a batch Editor will not clear it on its own. Find the dialog with
  `unity status` or the Editor window.
- **Exit 141 (`OUTPUT_CLOSED`)** — the reader of stdout closed the pipe. Nothing
  was wrong with the run; fix the consumer.
