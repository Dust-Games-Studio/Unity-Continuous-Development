# Contributing

Thanks for helping. This project wraps experimental beta software, so the rules
below are less about style and more about keeping failures attributable.

The design document is the source of truth: [unity-ci-design.md](unity-ci-design.md).
If a change contradicts it, say so in the pull request and argue from evidence.

## Ground rules

- **One logical change per commit**, conventional-commit style (`feat:`, `fix:`,
  `test:`, `docs:`, `chore:`). Every commit leaves `pnpm -C core test` green.
- **Tests first** for a behaviour change. The suite uses
  [fake-unity](testing/fake-unity/README.md), so no Editor or licence is needed.
- **No new dependency without a reason.** The core has exactly one runtime
  dependency (`yaml`), pinned. Prefer the standard library.
- **Node 22.12+** for development (the published package supports 22.4+).
- **Secrets never appear in a test, fixture, workflow or log.** See
  [SECURITY.md](SECURITY.md).

## Local workflow

```bash
pnpm install
pnpm -C core typecheck
pnpm -C core test
pnpm -C core build

pnpm run lint:provider-neutrality
pnpm run lint:spawn
pnpm run check:adapters
```

`pnpm -C core test test/<file>.test.ts` runs one file. The example project's
acceptance tests are static (`core/test/example-project.test.ts`) and the real
end-to-end run is manual: see [docs/local-development.md](docs/local-development.md).

## The architecture rule: no core changes for a new provider

```
Adapters (provider-specific, thin)  →  Core (provider-neutral)  →  Unity CLI
```

Dependencies point one way. The core must never know which CI system called it.
Adding GitLab, Jenkins, Buildkite, CircleCI or a home-grown runner means adding
`adapters/<name>/` plus documentation — **zero files under `core/`**. That is a
hard rule, enforced by review and by the checks below. If a provider needs
something the core does not expose, the fix is a provider-neutral flag,
environment variable, `summary.json` field or output file in the core, never
provider-specific YAML logic.

`pnpm run lint:provider-neutrality` scans `core/src` for
`\b(GITHUB_|GITLAB_|JENKINS_|CIRCLECI_|BUILDKITE_|AZURE_)`. The word boundary is
load-bearing: `UNITY_GITHUB_TOKEN` and `UNITY_GITLAB_TOKEN` are *Unity's*
credential names and stay in the child-environment strip list in
`core/src/exec.ts`. The reporting layer's `core/src/report/annotations.ts` is the
one allowed exception (it writes the provider's workflow command).

`pnpm run lint:spawn` enforces the single spawn point. It fails if any
`core/src` file other than `core/src/exec.ts` calls
`spawn`/`spawnSync`/`exec`/`execFile`/`execSync` or imports
`child_process`. The match excludes a preceding `.`, letter, digit or
underscore, so `regex.exec(` is not a false positive, and the import check
closes the aliasing hole the call check cannot see.

Both scripts print nothing and exit 0 on a clean tree; a match prints the
`file:line:text` and exits non-zero.

## The adapter contract

An adapter may **only**:

1. install or locate the `unityci` binary at a pinned version;
2. set environment variables and flags (including `--annotations <provider>`);
3. call `unityci` commands;
4. read `summary.json` and the files under `ci-output/`;
5. wire provider-native features: cache, artifact upload, test-report display,
   job summary, secrets injection, and an **always-run** licence return;
6. supply credentials the core must not hold: the licence through the
   environment, and private git package credentials through a git URL rewrite.

An adapter must **not**:

- implement retries, or compare a numeric Unity exit code;
- parse Unity's human output or resolve versions;
- pass `--allow-install` (the core fails fast with the exact install command);
- override a configured value with an input the caller did not set. The core
  applies environment variables **after** `unity-ci.yml`, so export an override
  only when its input is non-empty;
- put a secret on a command line;
- gate the artifact upload on success: exit **8** means the tests ran and
  failed, and those reports are the useful output;
- leave a `~/.gitconfig` it did not write, or remove one it did.

The executable rules live in
[`testing/conformance/check-adapters.ts`](testing/conformance/check-adapters.ts)
and run as `pnpm run check:adapters` (and in the unit suite). One result is
returned per rule per YAML file, with the offending line number.

## Writing a new adapter

1. **Create `adapters/<name>/`** with the provider's workflow file(s) and a
   `README.md` documenting every input and the required secrets.
2. **Install the binary at a pinned version.** Pin any third-party action or
   include to a 40-character commit SHA; never a moving tag. The conformance
   check rejects anything else.
3. **Map inputs 1:1 onto core flags and env.** Keep logic in the core. The five
   override-style inputs (`license-mode`, `accept-eula`, `unity-version`,
   `build-target`, `shards` in the GitHub adapter) are the reference: empty
   means "let the project's `unity-ci.yml` win".
4. **Run `unityci doctor`** as the preflight, then `unityci run test|build`.
   The run step's exit code is the verdict; do not interpret it.
5. **Wire an always-run teardown**:
   ```bash
   unityci license return || echo "warning: the Unity seat may still be held"
   ```
   Exit 6 means the seat was not returned. Surface it as a warning; the run step
   alone decides the job. This is the only tolerated non-zero exit.
6. **Cache from `unityci cache-info --json`** — the Editor download cache and
   the project `Library/`, never the Editor install directory. If the
   descriptor step fails, warn and continue; a cache hint must never pre-empt
   the run.
7. **Publish on 0 or 8**: upload `summary.json` and `ci-output/` with the
   provider's always-condition, and point the provider's test-report viewer at
   `ci-output/tests/*.junit.xml`.
8. **Private packages**: use a git URL rewrite confined to the repositories the
   project consumes, mask the token before its first use, and clean up only what
   you wrote. `GIT_CONFIG_GLOBAL` is measured not to work; see
   [docs/private-packages.md](docs/private-packages.md).
9. **Never trigger a secret-bearing job on a fork pull request.** Use a
   protected branch/tag trigger, and say so in a comment.
10. **Check it**:
    ```bash
    pnpm run check:adapters
    ```
    To check a different directory, call the checker directly:
    ```bash
    node --experimental-strip-types --input-type=module -e \
      "import { checkAdapter } from './testing/conformance/check-adapters.ts'; console.log(await checkAdapter('adapters/<name>'))"
    ```

## Tests, specifically

- Unit tests never launch Unity. Point `unity.cli.binary` at a shim and set
  `FAKE_UNITY_SCENARIO`; the fake emits configured exit codes, JSON and report
  files. It fails loudly on an unmatched invocation, which is also how the tests
  assert the exact argv the core produced.
- A test that asserts a verdict must assert the **exit code** and the artifact,
  not a log line. "A report was not written" is an infrastructure failure, never
  a pass.
- The adapter is YAML and is never executed by the suite. Adapter tests are
  **structural**: parse `action.yml`/the workflow with `yaml` and assert the
  shape (guards, teardown gating, triggers). These exist because two real bugs —
  unconditional config overrides and a teardown that could delete a
  `~/.gitconfig` it never wrote — shipped green before the structural tests.
- The published bin is tested by **executing it**, not by grepping its source:
  import the module with a cache-busting query, set `process.argv`, assert
  `process.exitCode`, restore both in a `finally`.

## Documentation

Update the relevant `docs/` page in the same change. Claims about Unity's
behaviour need a source in `docs/decisions/` or a measured probe; label
inference and "unverified" as such. Do not turn an unverified mechanism into a
recommendation.

## Licence

MIT. By contributing you agree that your contribution is licensed under the
same terms. "Unity" is a trademark of Unity Technologies; this project is not
affiliated with, endorsed by, or sponsored by Unity Technologies.
