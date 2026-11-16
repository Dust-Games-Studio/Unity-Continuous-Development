# unity-ci-kit

Provider-neutral CI for Unity projects, built on **Unity's own CLI** (`unity`)
— no Docker layer, no provider lock-in, and the same commands on a developer
machine and in CI.

The toolkit installs the Editor, handles the licence lifecycle, runs tests or a
build with retries, verifies that the artifacts Unity promised actually exist,
and writes one machine-readable `summary.json`. A thin adapter per CI system
supplies secrets, caches, artifacts and an always-run licence teardown. The core
owns the verdict; the adapter only displays it.

> **The Unity CLI is stable at 1.0.x.** Unity shipped the stable channel after
> the beta series this toolkit was designed against. This toolkit is tested
> against **1.0.0 and 1.0.1**; a CLI below that floor fails, a newer one warns
> and continues, and the exact build is recorded in every `summary.json`.
> Pinning is still an *install-method* policy, not a version string: see
> [docs/compatibility.md](docs/compatibility.md). The upgrade from the beta
> range — including the listing-envelope change, `build --output`, the new
> exit codes and the 1.0.x flags the toolkit now sends — is recorded in
> [docs/decisions/unity-cli-1.0.x-upgrade.md](docs/decisions/unity-cli-1.0.x-upgrade.md).
>
> **Unity's support statement covers a narrower set of machines than CI.**
> Unity supports the Editor on "workstations or laptop form factors running
> without emulation, container or compatibility layer". A bare CI runner
> **works** — Unity's release notes record that `unity test` runs on Linux
> without a display server — but it sits outside that statement. RHEL 9 supports
> the CLI (glibc 2.34+) but **not** the Editor. PlayMode tests without a display
> are unverified and not claimed.

`unity-ci-kit` is not affiliated with, endorsed by, or sponsored by Unity
Technologies. "Unity" and the Unity logo are trademarks of Unity Technologies.

## Local quick start

Prerequisites: Node **22.12+** (the published core needs 22.4+), pnpm 12, git,
and the Unity CLI. Install the CLI with Unity's installer (macOS/Linux
`install.sh`, Windows `install.ps1`), then check what you got:

```bash
curl -fsSL https://unity.com/install.sh | bash
unity version --format json
```

Build the toolkit and run it against a project:

```bash
git clone https://github.com/<owner>/unity-ci-kit.git
cd unity-ci-kit
pnpm install
pnpm -C core build

node core/dist/bin.js doctor --project-path /path/to/your/unity/project
node core/dist/bin.js run test --project-path /path/to/your/unity/project
```

`doctor` is the preflight gate: it runs `unity doctor --ci`, checks the CLI
version, glibc (on Linux), free disk space, the project's `.meta` files and the
licence state. `run test` repeats the checks it needs, resolves the Editor from
`ProjectSettings/ProjectVersion.txt`, preflights the project's git package
dependencies with `git ls-remote` (so a missing private-package credential fails
before an Editor starts), runs one Editor per configured test mode, asserts the
reports exist, and writes `ci-output/summary.json`.

By default `license.mode: none` means an **active licence is a precondition** —
the toolkit never activates one silently. Point it at one of the unattended
routes in `unity-ci.yml`:

```yaml
license:
  mode: serial                  # serial | floating | offline-file | none
  serialEnv: UNITY_LICENSE_SERIAL
unity:
  editor:
    headless: false             # 1.0.x: headless Linux Editor (install only, Linux)
    architecture: null          # x86_64 | arm64
    path: null                  # 1.0.x: pin a specific Editor binary
    resume: true                # 1.0.x: resume a cached/interrupted download
test:
  modes: [EditMode]
  affected: false               # 1.0.x: only tests the change can reach
  since: origin/main            # 1.0.x: the revision --affected compares against
build:
  target: StandaloneLinux64
  provenance: true              # 1.0.x: --no-provenance when false
accelerator:
  endpoint: null                # 1.0.x: host:port, or set disabled: true
  disabled: false
```

An offline `--file` licence cannot be returned; those runners leak a seat and it
must be reclaimed by hand. Read
[docs/local-development.md](docs/local-development.md) for the full local
workflow and the fake-`unity` test loop.

## CI quick start (GitHub Actions)

```yaml
name: Unity
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Install pnpm
        run: npm install --global pnpm@12.15.0
      - name: Run the tests
        uses: your-org/unity-ci-kit/adapters/github@<commit-sha>
        with:
          command: test                 # test | build
          unityci-version: source       # builds the binary from this checkout
          license-mode: serial
          accept-eula: true             # declared: installs a missing Editor
        env:
          UNITY_LICENSE_SERIAL: ${{ secrets.UNITY_LICENSE_SERIAL }}
```

The `pnpm` step is required because the action's default
`unityci-version: source` builds the binary from the checkout it lives in. If
you pass a published `@unityci/core` version instead, you can omit it.

The action installs the binary, restores the Editor download cache and the
project `Library/`, calls `unityci`, uploads `ci-output/`, returns the licence
under `if: always()`, and never overrides a project setting you did not pass.
Every input is documented in
[adapters/github/README.md](adapters/github/README.md).

Any other CI system needs no adapter code: run `doctor`, then `run`, then an
always-run licence return. See [docs/generic-ci.md](docs/generic-ci.md).

A secret-bearing integration job must never run on a fork pull request. This
repository's [`.github/workflows/example.yml`](.github/workflows/example.yml)
runs only on `main` and release tags for exactly that reason.

## Documentation

| Document | What it covers |
|---|---|
| [docs/local-development.md](docs/local-development.md) | running `unityci` on a developer machine, the fake-`unity` loop, Linux libraries and limits |
| [docs/generic-ci.md](docs/generic-ci.md) | the minimum for any CI system: `doctor` → `run` → always-run `license return`, plus caching from `cache-info --json` |
| [docs/compatibility.md](docs/compatibility.md) | tested Unity CLI/Editor versions, the install-method pinning policy, the capability matrix the core probes |
| [docs/decisions/unity-cli-1.0.x-upgrade.md](docs/decisions/unity-cli-1.0.x-upgrade.md) | the measured beta → stable 1.0.x changes, what the toolkit adopted, and what it left out |
| [docs/private-packages.md](docs/private-packages.md) | private git UPM packages, the measured git URL-rewrite mechanisms, the local and CI recipes |
| [adapters/github/README.md](adapters/github/README.md) | the GitHub composite action and every input |
| [adapters/generic/README.md](adapters/generic/README.md) | the adapter contract in checklist form |
| [CONTRIBUTING.md](CONTRIBUTING.md) | how to add an adapter — and why it never changes `core/` |
| [SECURITY.md](SECURITY.md) | vulnerability reporting and the secrets-handling rules |
| [unity-ci-design.md](unity-ci-design.md) | the design, the Spike 0 findings and the requirements they established |

## Repository layout

```
core/                 provider-neutral core, published as @unityci/core (bin: unityci)
adapters/github/      composite GitHub Action
testing/fake-unity/   deterministic stand-in for the Unity CLI (no Editor, no licence)
testing/conformance/  executable adapter rules
examples/minimal-project/  a real project the integration job runs
docs/                 guides and docs/decisions/ (Spike 0 evidence)
.github/workflows/    this repository's own CI, example run and weekly drift test
```

## Licence

MIT. See [LICENSE](LICENSE).
