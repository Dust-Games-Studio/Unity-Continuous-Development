# Any other CI system

An adapter is a convenience. The only thing a CI system has to do is run
commands, pass secrets through the environment, and keep files it asks for. If
it can do that, `unityci` works there with **no adapter code** — that is the
point of the core/adapter split.

## The minimum

Three steps, in this order:

```bash
unityci doctor --project-path .                 # 1. the preflight gate
unityci run test --project-path . --output-dir ci-output --annotations none
unityci license return                          # 3. ALWAYS run, in the teardown
```

`build` is the same with `unityci run build`. `--annotations none` is the
default; a provider that understands GitHub workflow commands may pass
`--annotations github`.

### Why the teardown is unconditional and tolerates exit 6

`unityci license return` exits **6** when a seat was not returned. That is
deliberate: a user who explicitly asked for the seat back must not be told it
worked when it did not. A leaked seat is expensive and **silent** — the next job
that needs a licence is the one that fails.

But the teardown is **not the pass/fail signal**. Run it under the provider's
always-condition and turn a non-zero exit into a warning, not a failed job:

```bash
unityci license return || echo "warning: the Unity seat may still be held"
```

If the teardown failed the job, a green test run would turn red after the run
step had already decided the result. The run step's exit code is the verdict;
the teardown is a cleanup obligation. The teardown is also the only recovery
from a runner teardown or `SIGKILL`: the core's own signal handler cannot catch
`SIGKILL`.

The command is a safe no-op under `license.mode: none` (it exits 0); under an
offline `--file` licence it reports that the seat cannot be returned, which is
the signal to reclaim it by hand.

### What "always" means per provider

| Provider | Always-run hook |
|---|---|
| GitHub Actions | a step with `if: always()` |
| GitLab CI | `after_script:` (or a job in `after_script`) |
| Jenkins | `post { always { … } }` |
| Buildkite | a `post-command` hook |
| CircleCI | a `when: always` step |
| A shell script | `trap 'unityci license return || …' EXIT` |

## Exit codes and what to publish

| Code | Meaning | Publish reports? |
|---|---|---|
| 0 | Success | yes |
| 8 | Tests ran, some failed | **yes** — the reports are the useful output |
| 6 | The run produced no verdict (compile error, crash, expired licence, unknown platform) | no: logs and diagnostics only |
| 64 | Configuration/precondition error; nothing was spawned | no |
| 7, 9, 12, 14 | Retried by the core; if still failing, infrastructure | no |
| 130 / 143 | Interrupted / terminated | no |

Publish on **0 or 8** only. On anything else there is no test result to show,
and an empty report viewer is worse than a link to the logs. Read `status`,
`exitCode`, `tests` and `reports` from `ci-output/summary.json` rather than
parsing Unity's output; the adapter contract is the file and the exit code.

## Caching

`unityci cache-info --json` prints descriptors. It never touches a cache
service — restoring is the CI system's job (design D7):

```json
{
  "editor":  { "paths": ["/home/runner/.config/unityhub/downloads"],
               "key": "unity-downloads-6000.6.6f1" },
  "library": { "paths": ["/work/project/Library"],
               "key": "596615056ab5c9c1b75e57b3ea52872ad6beb292b223f6faa1d796d1f54d9993",
               "staticKey": "unity-library-6000.6.6f1-StandaloneLinux64" }
}
```

```bash
unityci cache-info --json > cache-info.json

# jq is common on CI images; node works wherever the core runs.
EDITOR_PATH=$(node -e "const i=require(process.argv[1]); process.stdout.write(i.editor.paths[0] || '')" "$PWD/cache-info.json")
LIBRARY_PATH=$(node -e "const i=require(process.argv[1]); process.stdout.write(i.library.paths[0] || '')" "$PWD/cache-info.json")
EDITOR_KEY=$(node -e "const i=require(process.argv[1]); process.stdout.write(i.editor.key)" "$PWD/cache-info.json")
LIBRARY_KEY=$(node -e "const i=require(process.argv[1]); process.stdout.write(i.library.key)" "$PWD/cache-info.json")
```

Then restore/save:

- **Editor download cache** — `$EDITOR_PATH`, key `$EDITOR_KEY`. It holds the
  installer archives, so a re-run does not download the Editor again.
- **Project `Library/`** — `$LIBRARY_PATH`, key `$LIBRARY_KEY`. The key is
  computed from the Editor version, the resolved package set and the target;
  **script content is excluded by design**, so a script-only change is not a
  cache miss and the toolkit's own logic must not treat it as one.

Providers that compute cache keys **before** the job's script runs (GitLab CI
`cache:key`) cannot shell out to `cache-info`. Use `library.staticKey` — it is
derived only from the Editor version and the target — or call `cache-info` in a
preceding job and pass the value as a variable.

**Never cache or clean the Editor install directory.** It is global, shared with
the Unity Hub and with every other project on the machine; restoring over it can
corrupt all of them. `cache-info` therefore never lists it.

Cache steps are an optimisation. If `cache-info` fails, warn and continue; the
run step is the only thing that decides anything.

## Secrets

Licence material and git credentials are **environment or git configuration
only**: never a flag, never a config file, never a command line. Pass them as
masked variables:

```bash
# The core reads these names itself.
export UNITY_LICENSE_SERIAL="$UNITY_LICENSE_SERIAL"   # already in the job env
export UNITY_LICENSE_FILE_BASE64="$UNITY_LICENSE_FILE_BASE64"

# A provider may register any extra value for redaction under this prefix.
export UNITYCI_SECRET_MY_TOKEN="$MY_TOKEN"
```

A private git UPM package needs a **git URL rewrite**, not a Unity token
variable: the core strips Unity's `UNITY_GITHUB_TOKEN`/`UNITY_GITLAB_TOKEN` from
every child, and Unity's Package Manager ignores `GIT_CONFIG_GLOBAL`. The three
mechanisms that are measured to work, and the recipes, are in
[private-packages.md](private-packages.md).

## A complete generic pipeline

A POSIX-flavoured template; translate the verbs to your provider's YAML:

```bash
set -eu

# Machine prerequisites the provider image may not have installed:
#   the Editor runtime libraries (see local-development.md) and `ulimit -n 4096`.

unalias unity 2>/dev/null || true
unity version --format json

unityci doctor --project-path . --output-dir ci-output

# The run step decides the job. `set -e` means the teardown still has to run.
status=0
unityci run test --project-path . --output-dir ci-output --annotations none || status=$?

# Always: return the seat, but never let the teardown change the verdict.
unityci license return || echo "warning: unityci license return failed — the Unity seat may still be held"

exit "$status"
```

`doctor`'s own failure stops the pipeline before any Editor starts. Keep it as
a separate step when the provider can express it, so its diagnostics are easy to
find.
