# Security policy

`unity-ci-kit` runs build tooling around credentials: Unity licence material,
Unity service-account secrets, and tokens for private git packages. Treat a
leak of any of them as a security issue, even when it only reaches a log line.

## Reporting a vulnerability

**Do not open a public issue.** Use the repository's private vulnerability
reporting: on GitHub, **Security → Advisories → Report a vulnerability** (or the
`/security/advisories/new` URL for this repository). Include:

- the affected version or commit;
- the command or adapter configuration that triggers it;
- what leaks, or what an attacker can do;
- the smallest reproduction you can manage — the fake `unity` binary means this
  rarely needs a real Editor or a real licence.

You will get an acknowledgement as soon as the maintainers see it. This project
is pre-1.0 and does not maintain backport branches: fixes land on `main`.

## Supported versions

The project is pre-1.0 and the Unity CLI it wraps is experimental beta software.
Security fixes are made on `main`. There is no long-term-support branch and no
backporting to older tags.

## Secrets are environment-only

These values are read **only** from the environment:

| Variable | Purpose |
|---|---|
| `UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET` | Unity *services* (they cannot activate an Editor licence) |
| `UNITY_LICENSE_SERIAL` (name configurable via `license.serialEnv`) | serial activation |
| `UNITY_LICENSE_FILE_BASE64` (name configurable via `license.fileEnv`) | offline `.ulf` activation |
| `UNITYCI_SECRET_*` | any extra value the provider wants redacted |

The configuration loader **rejects** these in `unity-ci.yml` with exit 64. They
are never accepted as CLI flags. The core has no flag that accepts a secret, and
no code path builds a command string: every child is
`spawn(file, argvArray, { shell: false })`.

The serial is passed to Unity through the environment, which is why it is not in
the child-process strip list (Unity must read it). It is registered with the
redactor instead, so a Unity log line that echoes it is masked.

### Git credentials are a separate channel

A token for a private UPM package travels through **git configuration**
(`~/.gitconfig`, `$XDG_CONFIG_HOME/git/config`, or per-invocation
`GIT_CONFIG_*`), never through a Unity token variable and never on a command
line. The reasons are in [private-packages.md](private-packages.md): Unity's CLI
strips `UNITY_GITHUB_TOKEN`/`UNITY_GITLAB_TOKEN` from its children, Unity's
Package Manager ignores `GIT_CONFIG_GLOBAL`, and a credential embedded in
`Packages/manifest.json` is copied verbatim into the committed
`packages-lock.json`.

Adapters that inject a git token must mask it (`::add-mask::` and equivalents)
before its first use, write the rewrite with a shell builtin rather than
`git config` (whose argv would contain the token), and remove or restore only
the configuration they wrote.

## What `core/src/exec.ts` actually does

`spawnProcess` is the single place in the core that starts a child process. The
following is the enforcement, not an aspiration:

- **argv arrays only**, with `shell: false`. A space, quote or `;` in an argument
  stays part of that argument; no shell ever parses it.
- **A fixed strip list** is removed from the child environment before every
  spawn, Unity and git alike:

  ```
  UNITY_SERVICE_ACCOUNT_ID
  UNITY_SERVICE_ACCOUNT_SECRET
  UNITY_GITHUB_TOKEN
  UNITY_GITLAB_TOKEN
  ```

  These are the credentials Unity's own CLI strips; leaving them behind would
  expose them to the Editor and to the Package Manager's git.
- **Streamed redaction.** stdout and stderr are decoded with a streaming UTF-8
  decoder, split into lines, and each line is redacted **before** it is logged —
  in `exec.ts` itself, not only in the caller's logger. A trailing unterminated
  line is redacted at flush.
- **Redacted return values.** `SpawnResult.stdout`/`stderr` are redacted. The
  unredacted `rawStdout`/`rawStderr` exist only so the core can parse a
  machine-readable document before masking; no code path logs or persists them.
- **No secrets in `summary.json`.** It records the licence *mode* and booleans
  (`activated`, `returned`, `seatLeaked`), never the serial. The caller writes
  already-redacted values, and the summary holds no free-form Unity text.
- **Timeout kills the tree**, not just the direct child, so a timed-out Editor
  does not keep holding the project's `Library/` lock or a licence seat.

The redactor is registered **before the first log line**: the default secret
names are registered at startup, and the licence variable names the
configuration chose are registered immediately after the config loads — still
before the logger is created. Values pasted from a CI variable are registered in
both raw and trimmed forms, because Unity trims them before echoing.

### Redaction is defence in depth, not a guarantee

The redactor masks **registered values**. A project script that prints its own
credential, or a third-party tool that transforms a secret before emitting it,
cannot be saved by a substring match. Do not echo secrets in project build
scripts, and do not put them in `unity-ci.yml`.

If a value does leak into a log or an artifact:

1. revoke and rotate it immediately — a Unity licence seat can be reclaimed with
   `unity license return`, but a git token may already be used;
2. delete the artifact and, if it was uploaded, the run's retained artifacts;
3. report it using the private advisory process above.

## Out of scope by design

- **Android signing.** `unity build` accepts keystore material only on argv
  (`--android-keystore-base64`, passwords, aliases), and Unity's own help warns
  that those arguments may appear in shell history and CI logs. This CLI build
  has no environment or file route, so the toolkit exposes no keystore flags
  and passes none. Sign a release artifact outside the toolkit.
- **Untrusted pull requests with secrets.** A secret-bearing integration job
  must never run on a fork pull request. This repository's
  `.github/workflows/example.yml` runs only on `main` and tags; `.github/workflows/ci.yml`
  uses no secrets at all.
- **The Unity CLI and the Editor themselves.** Report vulnerabilities in Unity's
  software to Unity. This project can only control what it passes and logs.

## Dependency policy

The core has one runtime dependency, `yaml`, pinned exactly; everything else is
a development dependency. The published binary is built from this repository and
the lock file is committed. If you consume the GitHub Action with
`unityci-version: source`, it builds the checkout it lives in; third-party
actions are pinned to full commit SHAs.
