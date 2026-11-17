# GitHub adapter for `unityci`

A composite GitHub Action that installs the `unityci` binary, supplies the
provider-specific wiring (caches, artifacts, the licence teardown, private git
package credentials) and calls the core. **It decides nothing**: the run step's
exit code and the core's `summary.json` are the verdict (D4). There is no retry
loop and no exit-code interpretation in the YAML.

The action is intended for Linux runners (`ubuntu-*`). It installs the Editor's
runtime libraries with `apt-get` and the Unity CLI with Unity's own
`curl … | bash` installer.

## Quick start

```yaml
name: Unity
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      # Every third-party action is pinned to a commit SHA. The released
      # versions are recorded in the comment.
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1

      - name: Run the tests
        uses: your-org/unity-ci-kit/adapters/github@<commit-sha>
        with:
          command: test
          unityci-version: '<published-version>'
          license-mode: serial
        env:
          UNITY_LICENSE_SERIAL: ${{ secrets.UNITY_LICENSE_SERIAL }}
```

`license-mode` is an explicit input, not an environment variable the action
happens to read: the adapter exports it only when you set it, so the project's
own `unity-ci.yml` remains authoritative otherwise.

Inside this repository, use the action by path and leave `unityci-version` at its
`source` default, which builds `core/dist/bin.js` from the checked-out workspace:

```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: ./adapters/github
        with:
          command: test
          license-mode: serial
        env:
          UNITY_LICENSE_SERIAL: ${{ secrets.UNITY_LICENSE_SERIAL }}
```

On a clean runner the Editor is not installed. Either pre-install the version in
`ProjectSettings/ProjectVersion.txt`, or add `accept-eula: true` to the `with:`
block — a declared acceptance of Unity's and every module's licence agreements,
which is why the action never assumes it.

`accept-eula: true` is also what lets the doctor preflight get past a clean
runner: the preflight runs before the install, so it sees a missing Editor, and
the core treats that as `info` (`EDITOR_WILL_BE_INSTALLED`) only when an install
is allowed. Leave it empty and a missing Editor is a hard failure — the run has
no way to proceed.

## Inputs

| Input | Default | Meaning |
|---|---|---|
| `command` | `test` | `test` or `build`; passed to `unityci run <command>` |
| `project-path` | `.` | Unity project root |
| `config` | empty | explicit `unity-ci.yml`; empty discovers the project's own |
| `output-dir` | `ci-output` | receives `summary.json`, reports and build output |
| `annotations` | `github` | annotation format passed to the core |
| `license-mode` | empty | `none`, `serial`, `floating`, `offline-file`, `personal`; empty leaves the project's `license.mode` |
| `accept-eula` | empty | declared EULA acceptance for an explicit Editor install; empty leaves the project's `unity.editor.acceptEula` |
| `unityci-version` | `source` | `@unityci/core` version, or `source` to build the checkout |
| `unity-version` | empty | Editor version, or `from-project`; empty leaves the project's `unity.editor.version` |
| `build-target` | empty | `build.target`; empty leaves the project's value |
| `shards` | empty | `N/M` for `unity test --shard`; empty leaves the project's `test.shards` |
| `cache` | `true` | restore the Editor download cache and the project `Library` |
| `git-credentials` | `none` | `none` or `token` for private git packages |
| `git-token` | empty | the private-package token (from a repository secret) |
| `git-token-repos` | empty | comma-separated `owner/repo` entries, or `all` |

The five override inputs (`license-mode`, `accept-eula`, `unity-version`,
`build-target`, `shards`) default to empty and are exported only when set. The
core applies environment variables **after** the config file, so an exported
empty default would silently replace the project's `unity-ci.yml` value — for
example `license-mode: none` would disable a configured `license.mode`, and
`shards: ''` would clear a configured `test.shards`. Leaving them empty lets the
file win.

The action never passes `--allow-install`. The core fails fast with the exact
`unity install` command when the Editor version is missing; installing an Editor
is a separate, explicit decision (and EULA acceptance is a declared input, never
a silent default).

## Licences

The serial is read by the core from `UNITY_LICENSE_SERIAL` in the environment.
It is never a flag, so it never appears in a process listing. Set it on the job
or step:

```yaml
env:
  UNITY_LICENSE_SERIAL: ${{ secrets.UNITY_LICENSE_SERIAL }}
```

The other unattended routes are documented in the design and the core's README:

- **Floating**: set the action input `license-mode: floating`; the licensing
  server endpoint comes from the machine's `licensingServiceBaseUrl` setting.
  Check it with `unity license server list --format json` before the run.
- **Offline file**: set the action input `license-mode: offline-file` and provide
  `UNITY_LICENSE_FILE_BASE64`. An offline licence **cannot be returned**;
  `unity license return` leaves it in place, so those runners must be counted by
  hand. The adapter's teardown downgrades the resulting exit 6 to a warning so a
  green test run does not turn red — but the warning means the seat may be held.

`unityci license return` deliberately exits **6** when a seat was not returned.
Because the teardown runs under `if: always()`, a non-zero exit there would turn
a green run red even though the run itself passed. The teardown therefore ends
with `|| echo "::warning::…"`: the failure is surfaced as an annotation, and the
run step alone decides the job (D4). This is the one place the adapter tolerates
a non-zero exit, and it is not a pass/fail decision.

## Private git packages

The manifest must keep a **credential-free** URL. Unity copies a URL that embeds
credentials verbatim into the committed `packages-lock.json`; the core refuses to
run when it sees one. Supply the credential as a git URL rewrite instead, which
git applies at fetch time:

```yaml
      - uses: ./adapters/github
        with:
          command: test
          git-credentials: token
          git-token: ${{ secrets.PACKAGES_TOKEN }}
          git-token-repos: owner/private-packages,owner/another-package
```

`git-token-repos` is **required** and is per-repository by default. The literal
`all` is an explicit opt-in to a host-wide rewrite:

```yaml
          git-token-repos: all   # grants the token read access to EVERY repo on github.com
```

If `git-credentials` is `token` and `git-token-repos` is missing or empty, the
step fails with **exit 64**, naming the input. It never falls back to a
host-wide rewrite.

What the step does, and why:

- `echo "::add-mask::$UNITYCI_GIT_TOKEN"` runs **before** the first use, so the
  value cannot reach a log line (GC24).
- The rewrite is written with shell builtins (`printf`, `cp`) into
  `~/.gitconfig`, never with `git config --global url.…`. `git config` would put
  the token in its own argv, visible in the process list and in shell tracing.
  The step therefore declares `shell: bash` explicitly and uses `umask 077`.
- **`GIT_CONFIG_GLOBAL` is never set.** Unity's Package Manager ignores it and
  fails at package resolution with an error that looks like a Unity bug. This is
  measured in `docs/decisions/upm-git-auth-probe.md`; `~/.gitconfig` is measured
  to work.
- The teardown restores the previous `~/.gitconfig` from a snapshot, or removes
  the file when there was none — but only when the step reports `touched=true`.
  A guard failure (missing `git-token` or `git-token-repos`) exits 64 before the
  rewrite, and the teardown then leaves the existing file alone (for example
  checkout's `safe.directory` entry). GC24: remove only what you wrote.

### No file on disk: `GIT_CONFIG_*`

For a single-step job that must leave no file behind, git's per-invocation
configuration also works with Unity's Package Manager (measured):

```yaml
        env:
          GIT_CONFIG_COUNT: '1'
          GIT_CONFIG_KEY_0: url.https://x-access-token:${{ secrets.PACKAGES_TOKEN }}@github.com/owner/private-packages.git.insteadOf
          GIT_CONFIG_VALUE_0: https://github.com/owner/private-packages.git
```

`GIT_CONFIG_GLOBAL` looks like the convenient version of this and is the trap:
it is the one mechanism the Package Manager ignores.

## Caches

Two things are cached, both described by the core's `cache-info` (D7) and
performed by `actions/cache`:

- the Editor **download** cache at `~/.config/unityhub/downloads`, keyed by the
  Editor version;
- the project's `Library/` folder, keyed by `unity cache key` (Editor version,
  resolved package set and target — script content is excluded by design).

The descriptor step is best-effort. If `unityci cache-info` cannot read the
configuration (for example a missing `--config` file), the step warns, records
`ok=false` and exits 0; both restores are skipped, and the run step still
executes and writes the real `config_error` summary. A cache hint must never
pre-empt the verdict.

Consumers must not override a configured cache key with an empty default: the
adapter passes `unity-version` and `build-target` only when they are non-empty,
so the project's own settings decide the key otherwise.

The Editor **install** directory is never cached or deleted. It is global and
shared with the Unity Hub and with other projects on the machine. Restoring or
clearing it would corrupt other work.

## Artifacts and the verdict

`summary.json` and everything under `output-dir` (test reports, build output)
are uploaded with `if: always()`, so a failed test run (exit 8) still publishes
its reports. The upload is the adapter's job; interpreting those reports is not.

Every third-party action is pinned to a 40-character commit SHA. The versions
currently pinned are `actions/cache` v6.1.0 and `actions/upload-artifact` v7.0.2;
the quick start pins `actions/checkout` v7.0.1. The adapter conformance check
(`testing/conformance/check-adapters.ts`) fails an adapter with any `uses:` line
that is not a SHA.
