# The generic adapter contract

`unity-ci-kit` is provider-neutral. GitHub, GitLab and Jenkins get thin
adapters; every other CI system needs **no adapter code at all** — it needs to
run commands. The core owns configuration, retries, licence handling, report
verification, `summary.json` and the pass/fail verdict (D4). An adapter only
wires the provider's cache, artifact, annotation and teardown features.

The minimum for any CI system is:

```bash
unityci doctor
unityci run test --project-path . --output-dir ci-output --annotations none
unityci license return   # in the provider's always-run teardown
```

`build` is the same with `unityci run build`. `unityci cache-info --json`
describes the two caches worth carrying between runs; restoring them is the
adapter's job.

## What an adapter may do

1. Install or locate the `unityci` binary at a pinned version.
2. Set environment variables and flags (including `--annotations <provider>`).
3. Call `unityci` commands.
4. Read `summary.json` and the files under `ci-output/`.
5. Wire provider-native features: cache, artifact upload, report display, job
   summary, secrets injection, and an unconditional licence teardown.
6. Supply credentials the core must not hold: the licence through the
   environment, and private git package credentials through a git URL rewrite.

## What an adapter must not do

- No retries (`retry`, `attempt`, `max-attempts`). The core owns the retry set.
- No override of a configured value with an input the caller did not set. The
  core applies environment variables after the config file, so export an
  override only when its input is non-empty and let `unity-ci.yml` win otherwise.
- No auxiliary step that can pre-empt the verdict. Cache and descriptor steps are
  best-effort: warn, record the degradation, exit 0, and let the run step decide.
- No interpretation of a numeric Unity exit code. **0** passed, **8** means the
  tests ran and failed, **6** means there was no verdict. The core translates
  these into its own exit code and `summary.json`; the adapter must not second
  guess it.
- No parsing of Unity output, and no version resolution.
- No `--allow-install`: the core fails fast with the exact `unity install`
  command instead, so an interactive or EULA-changing install is never a
  surprise.
- No secret on a command line. Licence material and git tokens travel through
  the environment or git configuration only.

## Teardown

Every adapter needs a step that runs **unconditionally** (GitHub
`if: always()`, GitLab `after_script`, Jenkins `post { always { … } }`):

```bash
unityci license return || echo "::warning::unityci license return failed — the Unity seat may still be held"
```

`unityci license return` deliberately exits **6** when the seat was not
returned. A user who explicitly asked for a seat back must not be told it
worked when it did not. But the teardown is not the pass/fail signal: running it
under an always-condition and letting a non-zero exit fail the job would turn a
green test run red. The adapter tolerates the failure and raises it as a
provider warning/annotation. The run step alone decides the job.

The teardown is also the only recovery from a runner teardown or `SIGKILL`; the
core's own signal handler cannot catch `SIGKILL`.

## Private git packages

The manifest keeps a credential-free URL, and the adapter rewrites it in git
configuration so git applies the token at fetch time. The measured rules:

- `~/.gitconfig` and `$XDG_CONFIG_HOME/git/config` both work; the per-invocation
  `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` variables also
  work and leave no file on disk.
- **`GIT_CONFIG_GLOBAL` does not work.** Unity's Package Manager ignores it and
  fails at package resolution with an error that looks like a Unity bug.
- Never put the token on a command line (`git config --global url.…` would put
  it in argv). Write the rewrite with shell builtins, or use the
  `GIT_CONFIG_*` environment variables.
- Mask the token before its first use (GitHub `::add-mask::`, GitLab masked
  variables, Jenkins `withCredentials`).
- Scope the rewrite to the repositories the project consumes. A host-wide
  rewrite grants the token read access to every repository on that host.

## Caches

Cache the Editor **download** cache and the project's `Library/` folder, using
the keys from `unityci cache-info --json`. Never cache or delete the Editor
install directory: it is global and shared with the Hub and other projects.

## Checking an adapter

`testing/conformance/check-adapters.ts` exports:

```ts
checkAdapter(dir: string): Promise<{ file: string; rule: string; ok: boolean; detail: string }[]>
```

It reads every `.yml`/`.yaml` file under `dir`, strips full-line comments and
applies ten rules: `calls-unityci`, `has-teardown`,
`teardown-does-not-fail-the-job`, `no-retry-logic`, `no-exit-code-logic`,
`publishes-on-zero-and-eight`, `pinned-actions`, `masks-credentials`,
`no-credential-on-command-line`, `no-git-config-global-env`.

One result is returned per rule per file, and `detail` names the offending line
so a failure is actionable without opening the checker.

## Adding a provider

Adding a provider means adding `adapters/<name>/` and documentation. It must
change **zero** files under `core/`. If a provider needs behaviour the core does
not expose, the fix belongs in the core (as a flag, an environment variable or a
`summary.json` field), not in provider-specific YAML.
