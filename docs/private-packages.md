# Private git packages

A Unity project can depend on a UPM package that lives in a **private** git
repository. The credential must never enter the project, and Unity's own token
environment variables cannot carry it. The supported mechanism is a **git URL
rewrite**: the manifest keeps a credential-free URL and git applies the
credential at fetch time.

The measurements behind every claim on this page are in
[`docs/decisions/upm-git-auth-probe.md`](decisions/upm-git-auth-probe.md). They
were taken end to end through `unity build` (the CLI spawned the Editor and the
Editor's Package Manager performed the clone) on Editor 6000.6.6f1 with Unity
CLI 1.0.0-beta.14.

## Why the manifest URL must stay credential-free

Unity copies a git dependency's URL into `Packages/packages-lock.json` **exactly
as written in `Packages/manifest.json`**. Both files are normally committed.
A URL such as:

```json
"com.example.private": "https://user:token@github.com/owner/private.git"
```

therefore writes the token into the lock file and into the repository's
history. A rewrite does not: with any working mechanism, the lock file recorded
the plain URL, and the rewritten, credential-bearing URL appeared **nowhere** in
it. The rewrite is applied by git at fetch time, after Unity has already written
down the manifest's text.

The core enforces the safe half of this. It reads the project's git
dependencies and **refuses to run** (exit 64) when a manifest URL embeds
credentials. It never reads or writes the credential itself.

## Detection and preflight

Before any Editor starts, a `unityci run` performs the setup preflight. It:

1. reads the git dependencies from `Packages/manifest.json`;
2. refuses a credential-bearing URL;
3. proves each dependency is fetchable with
   `git ls-remote --exit-code <url>`, using the same ambient git configuration
   the Package Manager will use.

That turns "ten minutes into an Editor launch" into a failure in seconds. A
successful preflight is silent; when a `git ls-remote` fails, the run names the
dependency and its (redacted) URL in the error, so the log identifies the host
that could not be reached. `unityci doctor` does **not** read the manifest or run
this preflight. To reproduce it locally, with your credential in place:

```bash
git ls-remote --exit-code https://github.com/owner/private-packages.git
```

## The measured mechanisms

| Where the rewrite is delivered | Unity's Package Manager honours it? |
|---|---|
| `~/.gitconfig` (an `[url "…"] insteadOf = …` section) | **Yes** — measured |
| `$XDG_CONFIG_HOME/git/config` | **Yes** — measured |
| Per-invocation `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` (git ≥ 2.31) | **Yes** — measured, and it writes nothing to disk |
| `GIT_CONFIG_GLOBAL=<file>` (git ≥ 2.32) | **No** — measured: the Package Manager ignores it |

### The `GIT_CONFIG_GLOBAL` trap

`GIT_CONFIG_GLOBAL` is the most convenient-looking mechanism — point git at a
throwaway file and delete it afterwards — and it is the one that does not work.
The failure appears at package resolution with an error that reads like a Unity
bug, which makes it expensive to diagnose. Do not build a recipe on it. The
adapter's conformance check fails any adapter YAML that sets it.

### The three working forms

A file-based rewrite, in `~/.gitconfig` (or `$XDG_CONFIG_HOME/git/config` —
both are honoured):

```gitconfig
[url "https://x-access-token:<token>@github.com/owner/private-packages.git"]
    insteadOf = https://github.com/owner/private-packages.git
```

The same rewrite with no file on disk, for a single step:

```bash
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='url.https://x-access-token:<token>@github.com/owner/private-packages.git.insteadOf'
export GIT_CONFIG_VALUE_0='https://github.com/owner/private-packages.git'
```

Both change URL *resolution* only. `Packages/manifest.json` and
`Packages/packages-lock.json` keep the plain URL.

### Least privilege

Rewrite **only the repositories the project consumes**. A host-wide rewrite:

```gitconfig
[url "https://x-access-token:<token>@github.com/"]
    insteadOf = https://github.com/
```

grants the token read access to every repository on the host. It is an explicit
opt-in (`git-token-repos: all` in the adapter), never a fallback: an empty
repository list is a hard error (exit 64). For several packages, write one
section per `owner/repo`.

## Local developer equivalents

The measured route above is the one to use in CI. On a workstation:

- **Git Credential Manager** is commonly configured and makes a plain
  `git ls-remote` work. Whether Unity's Package Manager honours a credential
  helper is **unverified**; the URL-rewrite route does not depend on it.
- **`gh auth setup-git`** installs GitHub CLI as a credential helper. Like any
  credential helper, its behaviour under UPM is unverified.
- A private URL rewrite in your own `~/.gitconfig` is the route that was
  measured, and it keeps the manifest unchanged.

**SSH is unverified.** Whether UPM accepts `git@host:owner/repo.git` and
honours `ssh-agent` was not measured for this project. Do not assume it works;
the URL-rewrite route depends on neither SSH nor a credential helper.

The probe used a local bare repository behind a fake host, so a real private
GitHub repository was not exercised end to end. The mechanism (rewrite →
credential) is the same; the exact interaction with GitHub's authentication was
not measured.

## GitHub Actions

The adapter does the file-based rewrite, masks the token before its first use,
and restores or removes `~/.gitconfig` in an `if: always()` teardown — but only
when it actually wrote it:

```yaml
      - name: Run the tests
        uses: your-org/unity-ci-kit/adapters/github@<commit-sha>
        with:
          command: test
          license-mode: serial
          git-credentials: token
          # Required. Per repository by default; `all` is an explicit opt-in to
          # a host-wide rewrite, which grants the token read access to every repo.
          git-token-repos: owner/private-packages,owner/another-package
          git-token: ${{ secrets.PACKAGES_TOKEN }}
```

The token is written with `printf`/`cp` shell builtins, not
`git config --global url.…`: `git config` would put the token in its own argv,
where the process list and shell tracing can see it. `GIT_CONFIG_GLOBAL` is
never set. The adapter's README has the full recipe, including the
no-file `GIT_CONFIG_*` alternative.

If you are not using the adapter, the minimal sequence is:

```bash
umask 077
{
  printf '[url "https://x-access-token:%s@github.com/owner/private-packages.git"]\n' "$PACKAGES_TOKEN"
  printf '\tinsteadOf = https://github.com/owner/private-packages.git\n'
} >> "$HOME/.gitconfig"

unityci run test --project-path . --output-dir ci-output
```

and, in the always-run teardown, restore the previous file (or remove the one
you created). Remove only what you wrote: a checkout step may have its own
`safe.directory` entry in the same file. Snapshot it before appending.

## Generic CI

Any provider can set the per-invocation variables for one step and leave no file
behind:

```bash
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0="url.https://x-access-token:${PACKAGES_TOKEN}@github.com/owner/private-packages.git.insteadOf"
export GIT_CONFIG_VALUE_0='https://github.com/owner/private-packages.git'

unityci doctor --project-path .
unityci run test --project-path . --output-dir ci-output

# always, with a tolerated exit 6: the teardown is not the verdict
unityci license return || echo "warning: unityci license return failed — the Unity seat may still be held"
```

The token is still a CI secret: mask it before it can reach a log line
(`::add-mask::` on GitHub, a masked variable on GitLab, `withCredentials` on
Jenkins). Values placed in environment variables are visible to child processes
by design — that is the channel — so treat provider log masking as part of the
contract, not a substitute for it.

## What the core will never do

- It will not embed a credential in `Packages/manifest.json` or the lock file.
- It will not pass a credential on a command line.
- It will not write git configuration, set `GIT_CONFIG_GLOBAL`, or add a token
  environment variable Unity strips anyway (`UNITY_GITHUB_TOKEN`,
  `UNITY_GITLAB_TOKEN`, `UNITY_SERVICE_ACCOUNT_*`).

The credential belongs to the adapter, which is the layer that already owns
provider secrets. The core owns detection and preflight.
