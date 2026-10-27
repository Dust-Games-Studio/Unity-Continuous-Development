# Spike 0 — `unity` CLI empirical findings

Probe environment (all commands run on this machine, 2026-10-27):

- `unity --version` → `1.0.0-beta.13`.
  `unity env --format json` and `unity doctor --ci --format json` both report `"cliVersion": "1.0.0-beta.14"` — the binary self-reports b.13 but the data files say b.14. Worth pinning the exact build in the toolkit's preflight.
- Throwaway project: `.spike-tmp/` (empty `Assets/`, `ProjectSettings/ProjectVersion.txt` = `m_EditorVersion: 6000.6.6f1`, minimal `Packages/manifest.json`), deleted after the probes. The real project open in the Editor ("Game Collector") was never touched; `unity status` was read-only.
- A live Editor was running the whole time (`unity status` → 1 instance, project `...\Game Collector`, `state: "unreachable"`), which did not interfere with any batch probe.

---

## S1 — Which license types work headlessly, and what is on this machine now

**Answer**

Viable unattended: `--floating` (needs a floating server already configured on the machine, exit 4 otherwise), `--file <ulf|xml>` (offline import of a license file), and `--serial` (no sign-in; a *subscription* serial can still be refused with "This license requires a signed-in Unity account"). `--personal --accept-eula` only works with a signed-in user session and is rejected outright for service-account sessions; the default (no mode flag) needs a browser OAuth sign-in, so it is not unattended. `--generate-request .alf` is not activation at all — it writes a request that must be exchanged elsewhere and imported with `--file`, so it is a two-phase manual route, not an unattended one.

This machine right now: license active, signed in via OAuth, **Unity Personal (`Assigned`)** plus Asset Store, `floatingServer: null` — i.e. it works headlessly today only because a Personal entitlement is already activated on the machine, which is exactly the state CI cannot be assumed to start in.

There is **no `UNITY_LICENSING_SERVER` environment variable** anywhere in the CLI's documented env-var table (50 `UNITY_*` variables checked). The floating endpoint comes from the machine's `licensingServiceBaseUrl` setting, which `unity license server list` reads (pure settings read, no licensing-client download); `unity license server status` contacts it and exits 4 (none configured) / 6 (configured but unreachable). Service-account credentials (`UNITY_SERVICE_ACCOUNT_ID` + `UNITY_SERVICE_ACCOUNT_SECRET`) exist but cover Unity *services* only — they cannot activate an Editor license.

**Evidence**

```
$ unity license activate --help
Options:
  --serial <serial>          Activate with a license serial number
  --personal                 Activate the free Unity Personal license
  --floating                 Acquire a license from the configured floating
                             license server
  --file <path>              Activate offline from a license file (.ulf or .xml)
  --generate-request <path>  Save an offline activation request (.alf) to the
                             given path
  --accept-eula              Accept the Unity Personal license terms (required
                             with --personal)
```

```
$ unity license status --format json
{
  "success": true,
  "command": "license",
  "data": {
    "active": true,
    "signedIn": true,
    "authMode": "oauth",
    "licenses": [
      { "product": "Unity Personal", "type": "Assigned", "organization": "", "expires": "" },
      { "product": "Asset Store",   "type": "Assigned", "organization": "", "expires": "" }
    ],
    "floatingServer": null,
    "machineId": "78ann2PU0le4i3LFBybCtM/k3mE="
  },
  "errors": [],
  "warnings": []
}
```

```
$ unity license server list --format json
{ "success": true, "command": "license", "data": { "servers": [] }, "errors": [], "warnings": [] }
```

`auth-license-cloud.md` (lines 143, 149, 184):

> `activate` takes a single mode flag (combining them is a usage error). … `--personal` also requires `--accept-eula` to acknowledge the Unity Personal license terms. `--serial`, `--floating`, `--file` and `--generate-request` need no sign-in, and `--file` and `--generate-request` also work offline. `--floating` requires a configured floating license server (exit `4` if none is set).

> For build agents, lab machines, and any machine with no browser. There is **no username/password option** … a service account cannot activate a license, because Unity's licensing backend does not accept service-account tokens for activation.

> `unity license server list` shows the configured floating license server (from the `licensingServiceBaseUrl` machine setting; a pure settings read, no client download).

What the help text implies about EULA: `--accept-eula` is opt-in and scoped ("Accept the Unity Personal license terms (**required** with `--personal`)"); nothing in the CLI implies or detects prior acceptance. Unattended Personal activation therefore means the pipeline programmatically agreeing to Unity's terms, and the CLI documents no way to distinguish "org accepts" from "individual accepts".

**Implications for the toolkit**

- Model licensing as a *precondition*, not a step the toolkit owns: detect via `unity license status --format json` and fail fast on `active: false` / non-zero exit (exit 4 = no license), rather than trying to activate.
- Offer exactly three documented unattended routes, in this order: `--serial` from a secret, `--floating` (with `unity license server status` seat check first), `--file` (base64 secret → `.ulf`). Exclude `--generate-request` from "unattended" (it needs a human/other machine round-trip) and exclude plain `--personal`/default (browser OAuth, rejected for service accounts).
- Do **not** advertise `UNITY_LICENSING_SERVER`; the only supported lever is the machine's `licensingServiceBaseUrl` setting. The toolkit may check it with `unity license server list`.
- Warn that an offline `--file` license cannot be returned (`license return` leaves it in place) — those runners leak seats and must be counted manually.

---

## S2 — Full flag surface of `unity test` and `unity build`

**Answer**

Verbatim help for both is below. Specifics: `unity test --output` is a **FILE** path (default `test-results.xml`) — a directory is accepted silently and the report is then simply not written. `unity test` runs **exactly one** mode per invocation, but passing `--mode` twice is *not* a usage error: the parser accepts repeats and the **last one wins** (the Editor argv carried a single `-testPlatform PlayMode`). `unity build` works with **no** `--execute-method`: on Unity 6 it auto-discovers a Build Profile, or with a desktop `--target` it drives the legacy player flags (`-buildWindows64Player`) — proven by a real zero-code build. With `--profile` it resolves a `.asset` path or a name under `Assets/Settings/Build Profiles`, and if no profile exists it exits **6** with a message telling you to `--create-profile`.

**Evidence**

`$ unity test --help` (complete option list):

```
Usage: unity test [options] [project]

Run a project's EditMode/PlayMode tests in the editor and write a results report

Arguments:
  project                       Project path or name (defaults to the current
                                directory)

Options:
  --mode <mode>                 Test platform to run: EditMode or PlayMode. If
                                omitted, the editor's default test platform
                                runs.
  --filter <pattern>            Run only tests whose names match this filter
  --output <path>               Path to write the results report (NUnit XML by
                                default) (default: "test-results.xml")
  --report-format <formats>     Report formats to produce, comma-separated:
                                nunit, junit, or both (default: nunit)
  --junit-output <path>         Path to write the JUnit report to when both
                                report formats are produced
  --shard <n/m>                 Run only one slice of the suite, written as N/M,
                                so parallel CI jobs can split it
  --shard-inventory <path>      Path to the results report a full run wrote,
                                whose test list the shards are computed from
                                (default: the unsharded output path)
  --retries <n>                 Re-run failing tests up to this many extra times
                                (0-10), and report any that pass on a retry as
                                flaky (default: 0)
  --rerun-failed                Run only the tests that failed in the previous
                                run's results report, instead of the whole suite
  --affected                    Run only the tests a change can reach, from the
                                guid impact graph; runs the whole suite when it
                                cannot tell
  --affected-compare            Run every test, then report what affected-test
                                selection would have skipped and how many of
                                those failed
  --since <ref>                 Revision to compare against. Its merge base with
                                HEAD is used. Defaults to HEAD, which reports
                                uncommitted work.
  --coverage                    Collect code coverage (requires the Unity Code
                                Coverage package in the project)
  --coverage-output <path>      Directory to write the coverage report to
                                (default: CodeCoverage)
  --coverage-options <options>  Semicolon-separated options passed through to
                                the Code Coverage package
  --editor-version <version>    Override editor version (default: from
                                ProjectVersion.txt) (env: UNITY_EDITOR_VERSION)
  -e, --editor-path <path>      Path to a specific editor binary
  -a, --architecture <arch>     Editor architecture (x86_64 or arm64) (default:
                                "unknown", env: UNITY_ARCHITECTURE)
  --allow-install               Install the project's editor version if it is
                                not already installed
  --timeout <seconds>           Kill the Unity process after this many seconds
                                (disabled by default) (env: UNITY_TEST_TIMEOUT)
  --accelerator <host:port>     Unity Accelerator endpoint for this invocation.
                                A bare host defaults to port 10080. (env:
                                UNITY_ACCELERATOR)
  --no-accelerator              Ignore any configured Unity Accelerator for this
                                invocation
  -h, --help                    display help for command
```

(plus the identical global block: `-V/--version`, `--format human|json|tsv|ndjson|github`, `--json`, `--no-banner`, `--no-pager`, `--non-interactive`, `--quiet`, `--verbose`, `--color/--no-color`, `--proxy`, `--proxy-disable`, `--log-proxy`, `--no-log-proxy`.)

`$ unity build --help` (complete option list):

```
Usage: unity build [options] [command] [project]

Build a Unity project from the command line. Spawns the editor in batch mode and
forwards conventional CI flags.

Arguments:
  project                              Project path or name (defaults to the
                                       current directory)

Options:
  --target <target>                    Build target (e.g. StandaloneWindows64,
                                       Android, iOS, WebGL). Required unless
                                       --profile is used.
  --list-targets                       List every valid --target value, then
                                       exit
  --execute-method <method>            Static C# method to invoke (e.g.
                                       Builder.PerformBuild). Optional: without
                                       it, the CLI uses Unity's built-in build —
                                       a build profile on Unity 6+, or the
                                       legacy desktop player flags.
  --profile <profile>                  Build profile to build with: a path to a
                                       .asset file, or a profile name in
                                       Assets/Settings/Build Profiles (Unity 6+
                                       only; the profile defines the target).
                                       This is the supported way to build
                                       partner or package-provided platforms,
                                       like Meta Quest, that aren't in
                                       --target's list.
  --create-profile <target>            Create a build profile for a target (e.g.
                                       WebGL, Android), then exit — no build
                                       happens. Requires Unity 6+. Build with it
                                       afterward using --profile.
  --list-profiles                      List a project's build profile assets,
                                       then exit. Build profiles are the
                                       supported way to build partner or
                                       package-provided platforms, like Meta
                                       Quest, that aren't in --target's list.
  --build-target-group <group>         Optional build target group, forwarded to
                                       Unity as -buildTargetGroup
  -o, --output-path <path>             Output path for the build. Forwarded as
                                       -buildOutput with --execute-method (your
                                       method is responsible for honoring it);
                                       otherwise the built-in build's
                                       destination, and required
  -l, --log-file <path>                Log file path (default:
                                       <project>/Logs/build-<target>-<timestamp>.log).
                                       The log also streams to the console by
                                       default; --no-tail disables it.
  --editor-version <version>           Override editor version (default: from
                                       ProjectVersion.txt)
  -e, --editor-path <path>             Path to a specific editor binary
  -a, --architecture <arch>            Editor architecture (x86_64 or arm64)
                                       (default: "unknown")
  --args <string>                      Extra arguments passed to Unity
                                       (shell-split)
  --no-tail                            Do not stream the log to stdout in real
                                       time
  --allow-install                      Install the project's editor version if
                                       it is not already installed
  --android-export-type <type>         Android export type: apk, aab, or
                                       android-studio-project (Android targets
                                       only) (choices: "apk", "aab",
                                       "android-studio-project", default: "apk")
  --android-keystore-base64 <content>  Base64-encoded keystore file contents —
                                       decoded to a temp file before the build
                                       and deleted after (Android targets only;
                                       warning: CLI args may appear in shell
                                       history and CI logs)
  --android-keystore-password <pass>   Password for the keystore (Android
                                       targets only, required with
                                       --android-keystore-base64; warning: CLI
                                       args may appear in shell history and CI
                                       logs)
  --android-key-alias <alias>          Key alias inside the keystore (Android
                                       targets only, required with
                                       --android-keystore-base64)
  --android-key-alias-password <pass>  Password for the key alias (Android
                                       targets only, defaults to
                                       --android-keystore-password; warning: CLI
                                       args may appear in shell history and CI
                                       logs)
  --android-target-sdk-version <N>     Android SDK target version integer, e.g.
                                       34 (Android targets only)
  --android-symbol-type <type>         Debug symbol export type: none, public,
                                       or debugging (Android targets only)
                                       (choices: "none", "public", "debugging",
                                       default: "none")
  --android-version-code <N>           Explicit Android versionCode integer
                                       (Android targets only)
  --versioning-strategy <strategy>     Versioning strategy to apply to the build
                                       (semantic, tag, custom, none) (choices:
                                       "semantic", "tag", "custom", "none",
                                       default: "none")
  --build-version <version>            Explicit version string to stamp on the
                                       build. Only used when
                                       --versioning-strategy is 'custom';
                                       ignored for all other strategies.
  --allow-dirty-build                  Skip the uncommitted-changes guard
                                       (default: false)
  --timeout <seconds>                  Abort the build if it runs longer than
                                       this many seconds (disabled by default)
                                       (env: UNITY_BUILD_TIMEOUT)
  --provenance-path <path>             Where to write the build provenance
                                       manifest (default: beside the build
                                       output, or beside the log file when
                                       --output-path is not set)
  --no-provenance                      Do not write the build provenance
                                       manifest
  --accelerator <host:port>            Unity Accelerator endpoint for this
                                       invocation. A bare host defaults to port
                                       10080. (env: UNITY_ACCELERATOR)
  --no-accelerator                     Ignore any configured Unity Accelerator
                                       for this invocation
  -h, --help                           display help for command

Commands:
  run [options] [project]              Launch the project's most recent
                                       successful build without rebuilding.
                                       Standalone players launch natively; WebGL
                                       builds are served from a local static
                                       server.
```

**`--output` is a file, not a directory.** Same project, same mode, only the argument changed:

```
$ unity test .spike-tmp --mode EditMode --output .spike-tmp/reports --format json
{"success": false, "command": "test", "data": null,
 "errors": [{"code": "TESTS_FAILED", "message": "Tests failed: Unity process exited with code 2."}],
 "warnings": []}
EXIT=8
$ Get-ChildItem .spike-tmp/reports          # before and after: identical
full.xml    4683
junit.xml    843
```

The run happened, the tests ran and failed, and **no report appeared either at the path or inside it** — no error, no warning. Compare the file-path run below (S3), which produced both artifacts at the given paths.

**One mode per run; repeats are silently last-wins.** `unity test .spike-tmp --mode EditMode --mode PlayMode` did not exit 2 — it started an Editor. Its `Logs/Editor.log` argv block:

```
-runTests
-testResults
Z:\...\Unity-Continuous-Development\test-results.xml
-testPlatform
PlayMode
```

Only the second `--mode` reached Unity (the editor accepts a single `-testPlatform`). That particular probe also hung, because the project's `manifest.json` had no `com.unity.test-framework`, so `-runTests` never produced a verdict; it was killed, no report was written.

**Zero-code build works.** `unity build .spike-tmp --target StandaloneWindows64 --output-path .spike-tmp/Build/Spike.exe` with no `--execute-method` launched the built-in pipeline (masked log):

```
$ unity build .spike-tmp --target StandaloneWindows64 --output-path .spike-tmp/Build/Spike.exe --format github
Building StandaloneWindows64 with editor 6000.6.6f1 (x86_64)... (logs: ...\Logs\build-StandaloneWindows64-1793099892935.log)
COMMAND LINE ARGUMENTS:
  ...\6000.6.6f1\Editor\Unity.exe -batchmode -nographics -quit -projectPath ...\.spike-tmp
  -buildTarget StandaloneWindows64
  -buildWindows64Player ...\.spike-tmp\Build\Spike.exe
  -logFile ...\Logs\build-StandaloneWindows64-1793099892935.log
  -accessToken ***
building x86_64 windows player!
BuildPlayer: start building target 19
Build Failed
'' is an incorrect path for a scene file. BuildPlayer expects paths relative to the project folder.
Build Finished, Result: Failure.
The Editor log reported the following errors:
  [license] [Licensing::Module] LicensingClient has failed validation; ignoring
::error::Build failed (exit 1). See log: ...\Logs\build-StandaloneWindows64-1793099892935.log
EXIT=6
```

It failed only because the throwaway project has no scene in Build Settings — the zero-code path itself ran end-to-end with **no C# build method**. Note also that `-accessToken` is masked as `***` in the streamed log, and Unity reported `Result: Failure` / `exit 1`, which the CLI surfaced as exit **6**.

**No target and no profile** → exit 6 (not 2), and the message itself documents the auto-discovered-profile behaviour:

```
$ unity build .spike-tmp --output-path .spike-tmp/Build/Game.exe --format json
{"success": false, "command": "build", "data": null,
 "errors": [{"code": "COMMAND_FAILED",
   "message": "No build profiles found in Assets\\Settings\\Build Profiles. Create one with --create-profile <target>, pass --profile <path>, --target with a desktop target, or --target with --execute-method."}],
 "warnings": []}
EXIT=6
```

```
$ unity build .spike-tmp --profile "Windows Release" --output-path .spike-tmp/Build/Game.exe --format json
... {"code": "COMMAND_FAILED",
     "message": "Build profile \"Windows Release\" was not found. No build profiles exist in Assets\\Settings\\Build Profiles. Pass a path to a .asset file."}
EXIT=6

$ unity build .spike-tmp --list-profiles --format json
{ "success": true, "command": "build", "data": [], "errors": [], "warnings": [] }
EXIT=0
```

**`--list-targets`** (human, note the bare tab-separated table; abbreviated to the first rows plus the full JSON set):

```
$ unity build .spike-tmp --list-targets
target	requirement
Android	Requires --execute-method, or a Unity 6+ build profile (--profile)
CloudRendering	Requires --execute-method, or a Unity 6+ build profile (--profile)
... (same for EmbeddedLinux, GameCoreScarlett, GameCoreXboxOne, Lumin, N3DS, PS4, PS5, PSP2, QNX, Stadia, Switch, Switch2, VisionOS, WebGL, WindowsStoreApps, XboxOne, iOS, tvOS)
```

```json
$ unity build .spike-tmp --list-targets --format json     # 23 entries; zero-code ones:
{ "target": "StandaloneLinux64",   "zeroCode": true,  "requirement": "Zero-code (no --execute-method needed, but --output-path is still required)" },
{ "target": "StandaloneOSX",       "zeroCode": true,  "requirement": "Zero-code (no --execute-method needed, but --output-path is still required)" },
{ "target": "StandaloneWindows64", "zeroCode": true,  "requirement": "Zero-code (no --execute-method needed, but --output-path is still required)" }
```

**Implications for the toolkit**

- Validate every artifact path as a **file** before invoking: require a non-empty extension or at minimum reject an existing directory, and after the run assert the report exists (and is non-empty). A directory silently produced no report and still exited 8 — “tests failed” with no artifact would look like a reporting bug later.
- Never pass `--mode` more than once and never rely on the CLI to reject it: the toolkit must own mode selection (one `unity test` per mode), otherwise a config bug silently runs PlayMode instead of EditMode with no diagnostic.
- Do not require an `--execute-method`: the toolkit's build step must support three shapes — `--profile`, `--target` (desktop only, zero-code), and `--execute-method` — and choose per project. `--list-targets --format json` gives a machine-readable `zeroCode` flag to gate the choice, so validate against it instead of a hardcoded target list.
- Treat “no profile exists” as a **configuration** signal, not a crash: exit 6 carries an actionable message; surface it (and `--list-profiles`' empty array) as "project has no build profile" in the toolkit's own diagnostics instead of a generic build failure.
- Do not parse the human `--list-targets` output: it is a tab-separated table with no header styling guarantees — always pass `--format json`.

---

## S3 — `--format github` + `--output`, and which NUnit XML version Unity emits

**Answer**

Yes — `--format github` is a global *output format* and `--output` is a test report *file*; they are orthogonal and compose. In one invocation I got `::error::…` annotations on stdout **and** two report files on disk. Unity's Test Framework emits **NUnit 3**, not 2: the report root is `<test-run … engine-version="3.5.0.0" clr-version="4.0.30319.42000">` with `testcasecount`/`total`/`passed`/`failed` attributes and `<test-case>` children — the NUnit 3 schema (NUnit 2 roots at `<test-results>`). The JUnit side is plain `<testsuites>/<testsuite>/<testcase>` with `<failure message=… type=…>`. `--report-format nunit,junit` + `--junit-output` is a **valid, verified** combination.

**Evidence**

```
$ unity test .spike-tmp --mode EditMode --output .spike-tmp/reports/full.xml \
    --report-format nunit,junit --junit-output .spike-tmp/reports/junit.xml --format github
Running tests with Unity 6000.6.6f1 (x86_64)...
::error::Tests failed: Unity process exited with code 2.
  Code: TESTS_FAILED
EXIT=8
$ Get-ChildItem .spike-tmp/reports
full.xml    4683
junit.xml    843
```

NUnit report head (`full.xml`):

```xml
<?xml version="1.0" encoding="utf-8"?>
<test-run id="2" testcasecount="2" result="Failed(Child)" total="2" passed="1" failed="1" inconclusive="0" skipped="0" asserts="0" engine-version="3.5.0.0" clr-version="4.0.30319.42000" start-time="2026-10-27 11:16:39Z" end-time="2026-10-27 11:16:39Z" duration="0.045408">
  <test-suite type="TestSuite" id="1000" name=".spike-tmp" fullname=".spike-tmp" runstate="Runnable" testcasecount="2" result="Failed" site="Child" ...>
    <properties>
      <property name="platform" value="EditMode" />
    </properties>
```

JUnit report (`junit.xml`, complete):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<testsuites name=".spike-tmp" tests="2" failures="1" errors="0" skipped="0" time="0.023">
  <testsuite name="Spike.Tests.SpikeTests" tests="2" failures="1" errors="0" skipped="0" time="0.023">
    <testcase name="Fails" classname="Spike.Tests.SpikeTests" time="0.018">
      <failure message="Expected: 3&#13;&#10;  But was:  2" type="Failed">at Spike.Tests.SpikeTests.Fails () [0x00000] in Z:\...\.spike-tmp\Assets\Tests\SpikeTests.cs:16</failure>
    </testcase>
    <testcase name="Passes" classname="Spike.Tests.SpikeTests" time="0.005">
      <system-out>Saving results to: Z:\...\.spike-tmp\reports\full.xml</system-out>
    </testcase>
  </testsuite>
</testsuites>
```

Invalid combination is a pre-flight usage error (exit 2, no Editor spawned):

```
$ unity test .spike-tmp --report-format junit --junit-output .spike-tmp/reports/x.xml --format json
{"success": false, "command": "test", "data": null,
 "errors": [{"code": "COMMAND_FAILED",
   "message": "--junit-output only applies when both reports are produced. Use --report-format nunit,junit, or drop --junit-output and let --output be the JUnit report."}],
 "warnings": []}
EXIT=2
```

Also note the mismatch between the *code* and the *text* here: `"code": "COMMAND_FAILED"` on an **exit 2** — so exit code, not `errors[0].code`, is the reliable usage-error signal in this case.

Two further observations from the same run: the JUnit `<failure>` message contains the raw CRLF-escaped `&#13;&#10;` from Unity's assertion text (expect escaped newlines in summaries), and the JUnit file contains a `<system-out>` with the *NUnit* path — the converter carries the editor's own diagnostic through.

**Implications for the toolkit**

- Always request `--report-format nunit,junit`: NUnit 3 is the only machine-readable full record, and the CLI's own `--affected` / `--rerun-failed` / `--shard` all read NUnit. JUnit alone is a dead end for its own retry logic.
- Write the NUnit→JUnit conversion *into the pipeline as a fallback*, not the primary path — Unity's converter is already used by the CLI, and re-converting can only lose `test-case` ids. If the toolkit converts anyway (to normalize `classname` or strip `<system-out>`), implement it against the NUnit **3** schema (`test-run`/`test-suite`/`test-case`), not 2 (`test-results`/`results`).
- Combine `--format github` (annotations, no upload step) with `--report-format nunit,junit` (artifacts) and rely on the **exit code** for gating: the annotation text ("Unity process exited with code 2") is Unity's internal test-runner code, not the CLI's, and is not a stable branch key.
- Do not use `errors[0].code` alone to classify failures: exit 2 shipped with `COMMAND_FAILED` in the `--junit-output` misuse case. Branch on exit code first, `errors[0].code` second.

---

## S4 — Exit codes 6, 8, 14 and retry policy (resolving the design-doc conflict)

**Answer**

`8` = “tests ran, some failed” → **never retry**. `6` = the run never produced a verdict (compile error, crash, expired license, unknown platform) → the CLI's own table marks it **not retryable**, and the reference text agrees it must not be re-run blindly, but *is* re-runnable once the environmental cause is fixed. `14` = `TIMEOUT` and **is** retryable. The conflict in the design doc resolves in favour of the table + `unity commands --json`, with one additional correction: the prose in `build-run-test.md` saying a `--timeout` exits **6** for `unity test` is **wrong** — measured, `unity test --timeout 1` exits **14** with `errors[0].code: "TEST_TIMED_OUT"`. So “retry 6” in the docs' prose is a stale sentence, not a second policy.

**Evidence**

`build-run-test.md` line 153:

> It exits 0 when every test passes, 8 (EXIT_TESTS_FAILED) when the run completed and reported failing tests, and 6 (EXIT_COMMAND_FAILURE) when the run never produced a verdict — a compile error, an unavailable license, an editor crash, an unknown test platform, or `--timeout`. That split is what lets CI retry an infrastructure failure without ever retrying a failing test …

`build-run-test.md` line 164:

> **Never re-run a suite on code that has not changed.** The last run's report already holds the answer, so read it. Exit `8` means the tests ran and failed: fix the cause, then use `--rerun-failed`. Repeat a run only when it never produced a verdict (exit `6`) and the cause is gone.

`build-run-test.md` line 275 (about `--retries`):

> **A run that never produced a verdict is not retried.** A compile error, a crashed editor, an expired license or a `--timeout` all keep exit **6** and stop immediately, without spending the budget: there is no failing set to narrow to, and re-running the same broken configuration would only reproduce the same error.

`SKILL.md` lines 208 + 214-215 (this is where 14 lives; `build-run-test.md` itself never mentions 14):

> | 14 | `TIMEOUT` | yes | An operation ran out of time: an Editor request, an HTTP request, a batch run. |

> `8` is `unity test` only: the tests ran and some failed. A run that never completed exits `6` and a timed-out one `14`, so CI can retry those and never blindly re-run a failing test.

`unity commands --json` → `data.exitCodes` (the CLI's own machine-readable table; authoritative):

```json
{"code": 6,  "name": "COMMAND_FAILED", "retry": false, "errorCodes": []}
{"code": 8,  "name": "TESTS_FAILED",   "retry": false, "errorCodes": []}
{"code": 14, "name": "TIMEOUT",        "retry": true,
 "errorCodes": ["EDITOR_TIMEOUT","BATCH_TIMEOUT","EDITOR_NOT_READY","TEST_TIMED_OUT","ETIMEDOUT","ECONNABORTED"]}
{"code": 7,  "name": "NETWORK_UNREACHABLE", "retry": true,  "errorCodes": []}
{"code": 9,  "name": "INSTALL_LOCKED",      "retry": true,  "errorCodes": []}
{"code": 10, "name": "READY_TIMEOUT",       "retry": true,  "errorCodes": []}
{"code": 12, "name": "EDITOR_UNREACHABLE",  "retry": true,  "errorCodes": [...]}
```

Measured timeout behaviour (`--timeout 1`, mid-run kill):

```
$ unity test .spike-tmp --mode EditMode --timeout 1 --format json
Unity process timed out after 1 seconds. Terminating.
{"success": false, "command": "test", "data": null,
 "errors": [{"code": "TEST_TIMED_OUT", "message": "Unity process timed out after 1 seconds. Terminating."}],
 "warnings": []}
EXIT=14
```

**Resolution of the S4 conflict.** The two doc statements are not two policies: the table (`retry: false` for 6) and the `--retries` note (never auto-retry 6) are consistent; the sentence “a run that never completed exits 6 … so CI can retry those” is the outlier, and the measured behaviour shows that timeouts — the classic infra flake — are **14**, not 6. Practical rule: **6 is retryable only as an explicit, opt-in, once-after-remediation retry** (re-run the same command unchanged can never fix a compile error or a license problem), while **7/9/10/12/14/130/143 are retry-eligible as-is**.

**Implications for the toolkit**

- Default retry set: `{7, 9, 10, 12, 14, 130, 143}` with backoff and a hard attempt cap; **never** retry `8`, `2`, `3`, `4`, `11`, `13`, `141`.
- Expose `retry.onExitCodes` so `6` can be added per pipeline, but default it **off**, and when it is enabled cap it at 1 extra attempt: the docs are explicit that re-running an identical broken configuration reproduces the failure.
- Classify `14` as infrastructure (retry), and treat `TEST_TIMED_OUT` as the first-class code for “the Editor hung”, not as a test failure — the toolkit's summary must not report a timed-out suite as red tests.
- Do not encode the doc's “`--timeout` on `unity test` exits 6” anywhere: it is factually wrong for this CLI build (b.13/b.14 files). Update the design doc's exit-code table accordingly, and pin the observed codes in a test against `unity commands --json` so a future CLI bump that changes them fails loudly.

---

## S6 — Reusing a restored/cached Editor install

**Answer**

Yes, an already-present Editor is reused without any reinstall: every probe in this spike ran against the pre-installed `6000.6.6f1` by resolving it from the install path, with no install step at all. `unity install --help` says **nothing about `--allow-install`** — that flag does not exist on `install`; it lives on `build`/`test`/`run` as “Install the project's editor version if it is not already installed”. The only cache/reuse hints in `unity install`'s help are indirect: `-f, --force  Force reinstall of an already-installed editor` (so the default is “already installed → leave it alone”) and `--resume  Resume interrupted downloads from cache`; there is no “reuse”, “cache” or “detect existing install” wording. `unity install-path` is a single getter/setter with **no subcommands**: `-s, --set <path>` and `-g, --get`. The real cache API is a separate command family: `unity cache info|clean|key`, and `unity cache key` is the CI-cache key generator (editor version + packages lock + target).

**Evidence**

`$ unity install --help` — arguments and options, complete:

```
Arguments:
  version                            Version of the editor to install
                                     (interactive selection if omitted)

Options:
  -a, --architecture <architecture>  Editor architecture (x86_64 or arm64)
                                     (default: "unknown", env:
                                     UNITY_ARCHITECTURE)
  -c, --changeset <changeset>        Changeset for archive installs
  -m, --module <module...>           Module IDs to install alongside editor
  --cm, --child-modules              Install all child modules automatically
  --no-cm, --no-child-modules        Do not install child modules automatically
  -f, --force                        Force reinstall of an already-installed
                                     editor
  -y, --yes                          Automatically select the first match
                                     without prompting
  --accept-eula                      Accept all module license agreements
                                     automatically
  --dry-run                          Print what would be downloaded without
                                     installing
  --resume                           Resume interrupted downloads from cache
  --no-elevate                       Skip the elevated (UAC) install helper on
                                     Windows; the Editor installer still asks
                                     for elevation if Windows requires it
  --list-modules                     List the editor's modules with the Hub id
                                     and accepted aliases, then exit
  --no-wait                          Fail at once instead of waiting when
                                     another install (from the Hub or the CLI)
                                     is running
  --wait-timeout <seconds>           Stop waiting for another install after this
                                     many seconds and fail (default: wait until
                                     it finishes)
```

No occurrence of `--allow-install`, “cache”, “reuse”, “existing” or “detected” in that text (other than the `--force` and `--resume` lines quoted).

`$ unity install-path --help` — no subcommands:

```
Usage: unity install-path|ip [options]

Set or get the editor install path

Options:
  -s, --set <path>   Set the install path
  -g, --get          Get the current install path
  -h, --help         display help for command
```

```
$ unity install-path --format json
{ "success": true, "command": "install-path", "data": { "path": "C:\\Program Files\\Unity\\Hub\\Editor" }, "errors": [], "warnings": [] }
```

(No `-g` needed — the default action is get.)

```
$ unity editors --installed --format json
{
  "success": true,
  "command": "editors",
  "data": [
    { "version": "6000.7.0b3",   "alias": "6.7.0b3",   "architecture": "x86_64",
      "location": "C:\\Program Files\\Unity\\Hub\\Editor\\6000.7.0b3\\Editor\\Unity.exe",
      "modules": "", "default": false },
    { "version": "6000.6.6f1",   "alias": "6.6.6f1",   "architecture": "x86_64",
      "location": "C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.6f1\\Editor\\Unity.exe",
      "modules": "", "default": false },
    { "version": "6000.6.2f1",   "alias": "6.6.2f1",   "architecture": "x86_64",
      "location": "C:\\Program Files\\Unity\\Hub\\Editor\\6000.6.2f1\\Editor\\Unity.exe",
      "modules": "Linux", "default": false },
    { "version": "6000.3.15f1",  "alias": "6.3.15f1",  "architecture": "x86_64",
      "location": "C:\\Program Files\\Unity\\Hub\\Editor\\6000.3.15f1\\Editor\\Unity.exe",
      "modules": "Android, Android SDK & NDK Tools, Linux, OpenJDK, Web",
      "default": false }
  ],
  "errors": [], "warnings": []
}
```

Note `"modules": ""` on the 6000.6.6f1 and 6000.7.0b3 installs — a Windows editor can be listed as installed while carrying **no** platform modules, which is exactly what a restored/cached install risks.

Reuse without reinstall, from the actual build log (S2 probe):

```
COMMAND LINE ARGUMENTS:
  C:\Program Files\Unity\Hub\Editor\6000.6.6f1\Editor\Unity.exe -batchmode -nographics -quit -projectPath ...\.spike-tmp
```

No `unity install` ran anywhere in this spike, and both `unity test` and `unity build` resolved that binary from `ProjectVersion.txt`.

```
$ unity cache info --format json
{ "success": true, "command": "cache",
  "data": { "path": "C:\\Users\\areme\\AppData\\Roaming\\UnityHub\\downloads",
            "sizeBytes": 0, "size": "0 B", "fileCount": 0, "unreadable": false },
  "errors": [], "warnings": [] }

$ unity cache key .spike-tmp --format json
{ "success": true, "command": "cache",
  "data": { "key": "596615056ab5c9c1b75e57b3ea52872ad6beb292b223f6faa1d796d1f54d9993",
            "component": null,
            "compositeKey": "596615056ab5c9c1b75e57b3ea52872ad6beb292b223f6faa1d796d1f54d9993",
            "algorithm": "sha256", "algorithmVersion": 1,
            "components": {
              "editor":   { "version": "6000.6.6f1", "hash": "fedf791b4740bf5e35292fac1f2d46035d4c80298a12c1c52a80e9c7681105d5" },
              "packages": { "source": "packages-lock.json", "hash": "3912e502f1f488a1d7d8c08d70e470f8ff13116645f162f0afa0df4cba16e169" },
              "target":   { "target": null, "hash": "0ac68a86abbfece3524d8b7727fc81db00585dd7b7396118cd02cc417159f2a1" } } },
  "errors": [], "warnings": [] }
```

Additional relevant fact: `unity ci init --dry-run` (read-only, printed the workflow) emits a cache restore for the **download cache** (`~/.config/unityhub/downloads`, key `unity-downloads-6000.6.6f1`) plus a separate `Library/` cache keyed by `unity cache key`, and then still runs `unity install 6000.6.6f1 --yes --accept-eula` **unconditionally** — implying that step is a cheap no-op when the editor is already present.

**Implications for the toolkit**

- Detect, don't install: `unity editors --installed --format json` (checking `location` exists on disk) plus `unity install-path` is the whole prerequisite check; only call install when that list lacks the `ProjectVersion.txt` version. That makes a cached/restored editor a first-class fast path.
- Verify **modules** as well as the version: `"modules": ""` is a valid row, so a restored editor that lost its Android/iOS module would still pass a version-only check and fail much later in the build. Check the module the target needs (e.g. `Android`, `WebGL`) or run `--list-modules`.
- Use `unity cache key [project] --target <target>` as the CI cache key (it is explicitly designed for `Library/`) rather than hashing the project yourself; note it excludes script content by design, so a script-only change must not be treated as a cache miss trigger by the toolkit's own logic.
- Cache the download **cache directory** (`unity cache info` gives it, and `unity env` → `downloadCachePath`), not the install directory, and never delete/rewrite `C:\Program Files\Unity\Hub\Editor` — installs are shared with the Hub and other projects (`install-path` is global, not per-project).

---

## S8 — Is `--allow-install` EULA-safe in CI?

**Answer**

`--allow-install` itself has **no EULA surface and no EULA flag** — it is a three-word convenience on `build`/`test`/`run` meaning “install the project's editor version if it is not already installed”, and it cannot carry `--accept-eula`. The separate `unity install` command has `--accept-eula` ("Accept all module license agreements automatically") and `-y, --yes`, and the CLI's own generated CI workflow uses both together: `unity install 6000.6.6f1 --yes --accept-eula`. So in CI the safe pattern is an explicit install step with `--yes --accept-eula` and `--allow-install` only as a fallback for the “editor somehow missing” case — never as the primary install route, because whether `--allow-install`'s internal install supplies `--accept-eula` cannot be verified without performing a real (forbidden, license-affecting) install. UNRESOLVED: the exact acceptance behaviour of the install that `--allow-install` triggers.

**Evidence**

Exact `unity install` flags and one-line descriptions (verbatim from `--help`; every flag listed, including `--cm` and its negation — note there is no `--install-path` or `--include` flag on `install`):

```
  -a, --architecture <architecture>  Editor architecture (x86_64 or arm64)
                                     (default: "unknown", env:
                                     UNITY_ARCHITECTURE)
  -c, --changeset <changeset>        Changeset for archive installs
  -m, --module <module...>           Module IDs to install alongside editor
  --cm, --child-modules              Install all child modules automatically
  --no-cm, --no-child-modules        Do not install child modules automatically
  -f, --force                        Force reinstall of an already-installed
                                     editor
  -y, --yes                          Automatically select the first match
                                     without prompting
  --accept-eula                      Accept all module license agreements
                                     automatically
  --dry-run                          Print what would be downloaded without
                                     installing
  --resume                           Resume interrupted downloads from cache
  --no-elevate                       Skip the elevated (UAC) install helper on
                                     Windows; the Editor installer still asks
                                     for elevation if Windows requires it
  --list-modules                     List the editor's modules with the Hub id
                                     and accepted aliases, then exit
  --no-wait                          Fail at once instead of waiting when
                                     another install (from the Hub or the CLI)
                                     is running
  --wait-timeout <seconds>           Stop waiting for another install after this
                                     many seconds and fail (default: wait until
                                     it finishes)
```

`--allow-install`, as it appears on the commands that have it (`unity build --help` / `unity test --help`):

```
  --allow-install                     Install the project's editor version if
                                      it is not already installed
```

`unity install --help` contains no `--allow-install` line at all.

What the CLI's own generated pipeline does (`unity ci init --dry-run --project-path .spike-tmp`):

```yaml
      # The Editor installer archives, so a re-run does not re-download them.
      - name: Restore the Unity download cache
        uses: actions/cache@v4
        with:
          path: ~/.config/unityhub/downloads
          key: unity-downloads-6000.6.6f1

      - name: Install the Unity Editor
        run: unity install 6000.6.6f1 --yes --accept-eula
```

And the reason it does not rely on `--allow-install` for licensing (from the generated file's own comments):

```yaml
      #   Floating license server:
      #     unity license activate --floating
      #
      #   Offline license file, from a base64 secret:
      #     printf '%s' "${{ secrets.UNITY_LICENSE_FILE_BASE64 }}" | base64 -d > unity.ulf
      #     unity license activate --file unity.ulf
      #
      # `unity license activate --personal` does NOT work here: Unity's
      # licensing backend rejects service-account tokens for activation.
```

**Implications for the toolkit**

- Do the install **explicitly** and first: `unity install <version> --yes --accept-eula` (+ `--module` per target), then verify with `unity editors --installed`. Treat `--allow-install` as a recovery path only.
- Make EULA acceptance a **declared input**, not a silent default: `--accept-eula` is the toolkit accepting Unity's and every module's license agreements on the user's behalf. Surface it as an explicit config flag the user turns on (with the text it accepts quoted in the docs/log), rather than baking `--accept-eula` into every command.
- Never send `--allow-install` on a normal run: if the Editor is missing, fail fast with the exact `unity install` command to run, so a missing editor cannot silently turn into a multi-GB download plus an unrecorded EULA acceptance mid-build.
- Record what was installed (version, architecture, modules, `--accept-eula` state) in the toolkit's build provenance, mirroring `unity build`'s own manifest, so an audit can answer which license terms a given artifact was produced under.
