# Unity CLI 1.0.x upgrade (stable channel)

## Why this record exists

The toolkit was designed and tested against the beta channel (`1.0.0-beta.9`
through `1.0.0-beta.14`). Unity has since shipped a stable channel. On
2026-11-17 the reference machine reported:

```json
{ "success": true, "command": "version",
  "data": { "version": "1.0.1", "channel": "stable",
            "commit": "664cda391d19328aab4547b6d9d88cec14e5e17d",
            "buildDate": "2026-11-16T14:37:33Z", "platform": "win32",
            "arch": "x64", "runtime": "Rust 1.100.0" } }
```

This document records what changed, what the toolkit adopts, and what it
deliberately leaves out. The measurements come from `unity commands --format
json`, `unity <command> --help`, the JSON envelopes below, and
`unity changelog --target <version>` for `1.0.0-beta.15` through `1.0.1`.

## Measured changes

### Listings moved to one envelope

Every listing now returns `data.items` plus paging fields, instead of a bare
array or a named key:

```json
{ "data": { "items": [ … ], "total": 4, "nextPage": null, "partial": false } }
```

Verified for `editors --installed`, `install <version> --list-modules` and
`build --list-targets`. The toolkit reads `items` first and still accepts the
pre-1.0 array and named-key shapes (`core/src/unity/listings.ts`). Without this,
an installed Editor and its modules are both reported missing.

### `build --output-path` became `build --output`

1.0.0 states: "`--output-path` is now `--output` … The old spellings still work:
`--output-path` silently." The toolkit now emits the documented spelling and
never the deprecated one.

### New exit codes

`unity commands --format json` in 1.0.1 reports:

| Code | Name | Retry |
|---|---|---|
| 15 | `RUN_FAILED` | no |
| 16 | `JOB_SUSPENDED` | yes |
| 17 | `UNAVAILABLE` (Editor loading, compiling, reloading, Safe Mode) | yes |
| 18 | `AWAITING_INPUT` (modal dialog) | yes |
| 141 | `OUTPUT_CLOSED` | no |

The toolkit `EXIT` map now carries them. The default retry set adds 16 and 17;
15 is terminal, and 18 is opt-in per pipeline because a modal dialog in a batch
Editor does not clear on its own.

### New CI-relevant features

- `install --headless` (Linux only), `--resume`, `--architecture`,
  `--download-only`, `--download-directory`.
- `test --affected`, `--affected-compare`, `--since`, `--rerun-failed`,
  `--editor-path`, `--architecture`, `--accelerator`, `--no-accelerator`.
- `build --output`, `--no-provenance`, `--build-target-group`,
  `--editor-path`, `--architecture`, `--accelerator`, `--no-accelerator`.
- `doctor --ci --skip-license`.
- `license server health` (floating servers, no sign-in or licensing client).
- `UNITY_EDITOR_VERSION` and `UNITY_ARCHITECTURE` now steer `build` as well as
  `run`/`test`; the flag wins.
- `unity build` now exits 6 when Unity exits 0 without a build result and
  nothing was written to the output path (the toolkit's own artifact assertion
  remains the authority for the verdict).
- `license return` now returns Assigned seats (Unity Pro) as well as serial
  seats.
- `ProjectSettings/UnityCliConfig.json` can pin a CLI range with `cli.version`;
  in CI a command outside the range stops with exit 1 and
  `CLI_VERSION_OUT_OF_RANGE`. `unity version` itself is exempt.

## Adopted in this change

1. Tested range is now **1.0.0 … 1.0.1** (`TESTED_CLI_MIN`/`TESTED_CLI_MAX`).
   The last beta, `1.0.0-beta.17`, is below the floor.
2. The listing envelope (`items`) for Editors, modules and build targets.
3. `build --output`.
4. The 15–18/141 exit codes and the retry policy above.
5. `unity.editor.headless` (Linux only), `unity.editor.resume`,
   `unity.editor.architecture`, `unity.editor.path`.
6. `test.affected`, `test.affectedCompare`, `test.since`, `test.rerunFailed`.
7. `build.provenance` and `build.buildTargetGroup`.
8. `accelerator.endpoint` / `accelerator.disabled`, shared by test and build.
9. `doctor.skipLicense` (plus an automatic `--skip-license` under every
   activation mode, since the lifecycle activates a seat immediately after the
   preflight).
10. A floating-licence health probe before `license activate --floating`.
11. Ambient `UNITY_EDITOR_VERSION`/`UNITY_ARCHITECTURE` are removed from every
    child; the resolved Editor version and the configured architecture are
    passed explicitly instead.

Every new setting has an `UNITYCI_*` environment variable and is validated
before it reaches argv.

## Deliberately not adopted

- **`build --create-profile`** is a standalone action ("then exit — no build
  happens"), not a build argument. It belongs in a project-setup workflow, not
  a CI run.
- **`unity ci init`** generates Unity's stock workflow. The design (R12)
  deliberately does not reimplement it; this toolkit exists for what the stock
  workflow lacks. An adapter may still call it if a user wants both.
- **`install --download-directory`** installs an Editor the Hub does not
  register; pairing it with `--editor-path` needs a platform-specific binary
  path the toolkit cannot yet derive safely. `--download-only` is a cache
  warming step with no CI verdict.
- **`install --set-default`** mutates the machine-wide default Editor, which a
  CI runner must not do.
- **`license server status`** lists seats; `health` is the fail-fast signal a
  pipeline needs.
- **`cache key --component`** returns one component of a key the toolkit
  already computes in full, with a documented static fallback.
- **Cloud, VCS, MCP, plugins, `watch`, `build run`, `close`, `self-update`,
  changelog** are outside the CI contract.

## Sources

- `unity commands --format json` (1.0.1): command/flag/exit-code manifest.
- `unity changelog --target 1.0.0-beta.15|.16|.17|1.0.0|1.0.1`.
- Live envelopes captured on the reference machine: `editors --installed`,
  `install 6000.6.6f1 --list-modules`, `build --list-targets`,
  `projects verify --strict`, `doctor --ci`, `license status`, `cache info`.
