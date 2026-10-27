# Spike 0 research — unity-ci-kit

Research date: **2026-10-27**. Target: Unity's standalone CLI (`unity`), pre-1.0 beta.

## Scope and method

- Sources were fetched from the live web on 2026-10-27. Everything marked **CONFIRMED** was read on an
  official Unity property: `docs.unity.com`, `docs.unity3d.com`, `unity.com/blog`, `unity.com/resources`,
  Unity's public release notes, or the `Unity-Technologies` GitHub organisation.
- Third-party field reports are labelled **third-party** in the source line. They are never used as the
  sole basis for a CONFIRMED verdict.
- Quotations from `docs.unity.com` keep Unity's wording; inline code spans are re-rendered as `code`
  because the HTML-to-Markdown conversion flattens Unity's fence blocks. Where a page is a long
  bulleted release-note list, the quoted text is the assembled sentence from that bullet.
- **Version note that matters:** the brief says 1.0.0-beta.13 is current. Unity's release notes page
  (`https://docs.unity.com/en-us/unity-cli/release-notes`, "Last updated 6 days ago") now leads with
  **1.0.0-beta.14, October 21, 2026**. All quotes below are pinned to the beta number in which they
  appeared, not to a moving "latest".

---

## S5 — What the Unity Editor needs on a bare Linux CI runner

**Answer**

Nothing in Unity's official 6000.x documentation describes a supported *bare-runner* Linux install.
The only officially documented Linux target for the Editor is Ubuntu 22.04 / 24.04 on x64, with a
Gnome desktop on X11 or Wayland and an OpenGL 3.2+ or Vulkan-capable Nvidia/AMD GPU — and Unity states
plainly that the Editor is supported only on workstations/laptops "without emulation, container or
compatibility layer". RHEL 9 is *not* an Editor platform; it appears only in the CLI's own binary
compatibility list (glibc 2.34+) and, for the Hub, as explicitly "not officially supported". A virtual
display is **not** required for headless EditMode tests or batch builds: Unity's `-nographics` flag
exists precisely to run "automated workflows on machines that don't have a GPU", and Unity's own
release notes record that `unity test` "now runs on a Linux machine without a display server". The
shared-library list is the one genuine gap: Unity published a dependency list in 2015 (Unity 5.x) and
has not published a 6000.x equivalent, so any concrete `apt install` line today is inference plus field
report, not documentation.

**Confidence**

- Editor OS/GPU/desktop requirements, RHEL 9 not being an Editor platform, CLI glibc floor:
  **CONFIRMED**.
- `-nographics` removing the GPU/display requirement, and `unity test` running with no display server:
  **CONFIRMED** (official manual + official release notes).
- The specific shared-library set (`libgtk-3-0`, `libglu1-mesa`, `libnss3`, `libasound2`, `libx11-6`,
  `libxrandr2`, …) for 6000.x: **INFERRED** from a dated official 2015 list + third-party field
  reports. No official 6000.x list exists.
- `xvfb` NOT required for EditMode tests / Linux standalone builds with `-nographics`:
  **INFERRED** (strong: two official statements plus a 2026 third-party field report), not stated as a
  support guarantee.
- `xvfb` for PlayMode tests: **UNRESOLVED**. No official statement either way.

**Sources**

1. Unity 6.6 system requirements — Editor, Linux row (official).
   <https://docs.unity.com/en-us/engine/6000.6/manual/get-started/install-and-upgrade/getting-started-installing-unity/system-requirements>
   > "**Linux** | Ubuntu 22.04, Ubuntu 24.04 | X64 architecture with SSE2 instruction set support |
   > OpenGL 3.2+ or Vulkan-capable, Nvidia and AMD GPUs | Gnome desktop environment running on top of
   > X11 or Wayland windowing system, Nvidia official proprietary graphics driver, or AMD Mesa graphics
   > driver. Other configurations and user environments as provided with the supported distribution
   > (Kernel, Compositor, etc.)"

   Same page, immediately above the table:
   > "For all operating systems, the Unity Editor is supported on workstations or laptop form factors
   > running without emulation, container or compatibility layer."

   Same page, Linux Editor limitations:
   > "If the Editor generates a `Pipe error !` message, you must increase the maximum open file limit in
   > your current Editor session. For example, run `ulimit -n 4096` in the terminal before launching the
   > Editor."

2. Unity Editor command line arguments — `-nographics` and `-batchmode` (official manual, 6000.2).
   <https://docs.unity3d.com/6000.2/Documentation/Manual/EditorCommandLineArguments.html>
   > "`-nographics` | When you run this in batch mode, Unity doesn't initialize the graphics device. You
   > can then run automated workflows on machines that don't have a GPU. Automated workflows only work
   > when you have a window in focus, otherwise you can't send simulated input commands. `-nographics`
   > does not allow you to bake GI, because Enlighten Realtime Global Illumination requires a GPU for
   > Meta Pass rendering … **Note**: Output logs are turned off in this mode. To enable the creation of
   > output logs, specify a file location using the command `-logFile`."

   > "`-batchmode` | Run Unity in batch mode. In batch mode, Unity runs command line arguments without
   > the need for human interaction. It also suppresses pop-up windows that require human interaction …
   > You can't open a project in batch mode while the Editor has the same project open; only a single
   > instance of Unity can run at a time."

3. Unity CLI release notes — 1.0.0-beta.8, Issues fixed (official).
   <https://docs.unity.com/en-us/unity-cli/release-notes>
   > "`unity test` now runs on a Linux machine without a display server. It also refuses to run on a
   > project that is already open in an Editor instead of starting a batch Editor that cannot acquire
   > the project lock."

   Release notes, 1.0.0-beta.6, Issues fixed — evidence that `xvfb-run` and CI runners are a supported
   wrapping style the CLI explicitly recognises:
   > "Headless or wrapped editors (running under `xvfb-run`, `dbus-run-session`, or a CI runner) are
   > counted correctly again by `unity status`, instead of appearing as duplicates or \"ambiguous.\""

4. Unity CLI compatibility list (official) — the CLI binary, not the Editor.
   <https://docs.unity.com/en-us/unity-cli/use-unity-cli>
   > "The Unity CLI is compatible with the following operating systems: … Linux RHEL 9 and Ubuntu 22.04
   > and later. Requires glibc 2.34 or newer. Debian 11, CentOS 8, Amazon Linux 2 aren't supported."

   Release notes, 1.0.0-beta.4, Breaking changes:
   > "Linux now requires glibc 2.34 or newer. This drops support for Ubuntu 20.04 and earlier, Debian 11,
   > RHEL and CentOS 8, and Amazon Linux 2. RHEL 9 and Ubuntu 22.04 are the oldest supported releases."

5. Unity Hub on Linux (official) — RHEL is a Hub install target but explicitly unsupported, and Editor
   Arm64 is excluded.
   <https://docs.unity.com/en-us/hub/install-hub-linux>
   > "You can install the Unity Hub on the following Linux Distributions: Ubuntu. Red Hat Enterprise
   > Linux (RHEL), CentOS, or Fedora. These distributions are not officially supported and Unity makes no
   > guarantee that the Hub works on them."
   > "The Unity Editor doesn't support Linux on Arm64 (aarch64) devices yet. The commands on this page
   > install correctly on an Arm64 device, but the Hub can't download or run an Editor on Arm64."

6. Unity on Linux release-notes thread — the last official dependency list Unity published (Unity 5.1,
   2015). **Dated; not a 6000.x statement.**
   <https://discussions.unity.com/t/unity-on-linux-release-notes-and-known-issues/595006>
   > "**Dependencies and Recommended Packages** — The dependencies for Unity itself are: gconf-service,
   > lib32gcc1 (>= 1:4.1.1), lib32stdc++6 (>= 4.6), libasound2 (>= 1.0.23), libc6 (>> 2.15),
   > libc6-i386 (>= 2.15), libcairo2 (>= 1.6.0), libcap2 (>= 2.10), libcups2 (>= 1.4.0), libdbus-1-3
   > (>= 1.2.14), libexpat1 (>= 1.95.8), libfontconfig1 (>= 2.8.0), libfreetype6 (>= 2.3.9),
   > libgcc1 (>= 1:4.1.1), libgconf-2-4 (>= 2.31.1), libgdk-pixbuf2.0-0 (>= 2.22.0),
   > libgl1-mesa-glx | libgl1, libglib2.0-0 (>= 2.31.8), libglu1-mesa | libglu1,
   > libgtk2.0-0 (>= 2.24.0), libnspr4 (>= 1.8.0.10), libnss3 (>= 3.14.3), libpango1.0-0 (>= 1.22.0),
   > libstdc++6 (>= 4.6), libx11-6 (>= 2:1.4.99.1), libxcomposite1 (>= 1:0.3-1), libxcursor1 (>> 1.1.2),
   > libxdamage1 (>= 1:1.1), libxext6, libxfixes3, libxi6 (>= 2:1.2.99.4), libxrandr2 (>= 2:1.2.99.2),
   > libxrender1, libxtst6, zlib1g (>= 1:1.1.4), debconf (>= 0.5) | debconf-2.0, npm"
   > "Machines also need a modern graphics card with vendor-supported graphics drivers … We do not
   > explicitly support running the Linux editor inside a virtual machine due to limitations related to
   > GPU virtualization (although it does usually work)."

   Note what is **absent** from that list: `xvfb`, `libgtk-3`, `libgbm1`. The `libgtk2.0-0` entry is a
   reminder that this list predates the GTK3-based Editor.

7. Third-party field report — Unity 6000.3.26f1 fully headless in an Ubuntu 24.04 container.
   <https://dev.to/nydjustin/running-unity-6000x-headless-builds-in-a-linux-container-a-field-report-including-licensing-519b>
   > "Environment: Ubuntu 24.04.5 LTS, x86_64, unprivileged container user (non-root), ~95 GB free disk,
   > no GPU, `xvfb` available but not required for batch mode."
   > "On 2026-10-09 I got Unity 6000.3.26f1 (LTS) running fully headless in an Ubuntu 24.04 container —
   > no display, no human at a keyboard — and used it to assemble a 3D scene from a C# editor script and
   > produce a working Linux x86_64 game build."

8. Third-party field report — historical evidence that some Editor code paths still open X11 even with
   `-nographics`, and that `-nographics` is what removes the need for `xvfb`.
   <https://stackoverflow.com/questions/47399488/building-running-headless-unity3d-game-in-ubuntu-docker-container>
   > "The trick is in using \"-nographics\" argument after implementation of which the need in xvfb-run
   > disappeared."

**Implications for the toolkit**

- Treat "bare runner" and "supported platform" as different things. The core must be able to *detect*
  "this is a container / non-Gnome / GPU-less box" and surface it as a warning with a documented
  support caveat, because Unity's own requirements page says containers are not a supported Editor
  environment. Do not let the toolkit imply it makes that supported.
- Ship a pinned, versioned Linux bootstrap as an **adapter**, not in core: `libasound2`, `libglib2.0-0`,
  `libgtk-3-0`, `libglu1-mesa`, `libnss3`, `libx11-6`, `libxrandr2`, `libxi6`, `libxcursor1`,
  `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxtst6`, `libfontconfig1`, `libfreetype6`,
  `libdbus-1-3`, plus `ulimit -n 4096`. Mark the package list "inferred, not Unity-published" in the
  docs, and keep the list data-driven so it can be corrected per Ubuntu release without a code change.
- Default to `-nographics` for EditMode tests and batch builds, expose it as an explicit knob, and do
  **not** install `xvfb` by default. Add an opt-in `--with-virtual-display` path for PlayMode/GPU cases
  and document it as the unverified edge (PlayMode + no display is UNRESOLVED).
- Enforce the real floors as preflight refusals, not silent failures: Ubuntu 22.04/24.04 for the Editor,
  glibc ≥ 2.34 for the CLI, x64 only for the Editor, RHEL 9 = CLI-only (warn that the Hub and the
  Editor are outside Unity's support statement there).
- RHEL 9 needs a separate adapter branch: `dnf` package names differ (`gtk3`, `mesa-libGLU`, `nss`,
  `alsa-lib`, `libX11`, `libXrandr`, …), and nothing in Unity's docs guarantees it. That adapter must
  be labelled "best effort".

---

## S7 — Does `unity build` / `unity test` need `com.unity.pipeline`?

**Answer**

**No — not for `unity test`, and almost certainly not for `unity build`.** Unity's own CLI skill
reference states that `unity test` "runs the tests **directly via the editor command line** — no pipeline
package or server is involved." `com.unity.pipeline` is consistently scoped in Unity's docs to
*controlling a running Editor or Player*: the package page says it exists "to control the Unity Editor
remotely through a local HTTP API", and the CLI docs gate only the Editor-driving surface behind it
("To use the Unity CLI to control the Unity Editor, install and set up the Unity Pipeline package").
Every command that genuinely needs it says so explicitly in Unity's reference (`run --command`,
`recompile`, `command`, `list`, `status`, `mcp`, `logs --console`, `recompile`), while `build` and
`test` are described purely as batch-mode Editor invocations. The strongest practical evidence is
`unity ci init`'s generated workflow, which runs `unity doctor --ci`, `unity test` and `unity build`
without ever calling `unity pipeline install`.

**Confidence**

- `unity test` without the package: **CONFIRMED** (explicit official statement).
- `unity build` without the package: **INFERRED** (no explicit statement, but the package requirement
  is stated everywhere it applies and is absent here; the generated CI workflow does not install it).
- The package is required for `command` / `status` / `command script eval` / `run --command` /
  `recompile` / `mcp` / `logs --console`: **CONFIRMED**.

**Sources**

1. Unity `unity-cli` skill reference, `build-run-test.md` — **official** (`Unity-Technologies` GitHub
   org, the skill Unity ships to agents).
   <https://github.com/Unity-Technologies/unity-agent-plugin/blob/main/skills/unity-cli/references/build-run-test.md>
   > "`unity test` launches the editor's built-in test runner in batch mode (`-runTests -testPlatform
   > <mode> -testResults <path> -testFilter <pattern>`), waits for it to finish, and writes the report to
   > `--output` (default `test-results.xml`). … It runs the tests **directly via the editor command
   > line** — no pipeline package or server is involved."

   Same file, on `run --command`, for contrast:
   > "Requires the `com.unity.pipeline` package (`unity pipeline install` — see
   > [integration-advanced.md](integration-advanced.md))."

   Same file, on `recompile`, for contrast:
   > "**Requires a running Editor with the Pipeline package.** That is what makes it fast (the Editor is
   > already warm) … There is no batch-mode fallback: with no reachable Editor it reports which Editors
   > it found and what to do, and exits `7`."

2. Unity CLI reference — command table (official).
   <https://docs.unity.com/en-us/unity-cli/unity-cli-reference>
   > "build | | Builds a project in batch mode with CI-friendly flags, including Android signing and
   > export options."
   > "test | | Runs a project's Edit Mode and Play Mode tests through the Editor test runner and write an
   > NUnit report."
   > "run | | Runs a project in batch mode or runs a registered Editor command in headless mode with
   > `--command`."

3. Unity Pipeline package page (official) — scope of the package.
   <https://docs.unity.com/en-us/unity-cli/unity-pipeline/unity-pipeline-package>
   > "Use the Unity Pipeline package to control the Unity Editor remotely through a local HTTP API. Use
   > it to integrate the Unity Editor with CI/CD pipelines, automate testing and development workflows,
   > and execute custom commands from the Unity CLI."
   > "Prerequisites … Install the Unity Editor version 6.0 or later. Install the Unity CLI."

4. Unity CLI introduction / use page (official) — the conditional wording.
   <https://docs.unity.com/en-us/unity-cli/use-unity-cli>
   > "Note: To use the Unity CLI to control the Unity Editor, install and set up the Unity Pipeline
   > package."

5. Release notes, 1.0.0-beta.3 (official) — the one place that states the dependency for a command.
   <https://docs.unity.com/en-us/unity-cli/release-notes>
   > "Added `unity run --command <name>` to run a registered `[CliCommand]` Editor command headlessly in a
   > single invocation. The CLI starts the Editor in batch mode, runs the command, prints the return
   > value, and shuts the Editor down. Requires the Unity pipeline package."

   Release notes, 1.0.0-beta.14 — new projects get it by default, `--bare` does not:
   > "`unity projects create` adds the Pipeline package to every new project, so `unity command` works on
   > it without a separate `unity pipeline install`. `--bare` leaves it out, and `--with-pipeline`, which
   > used to opt in, is still accepted and does nothing."

6. `unity ci init` generated-workflow description — **official** skill reference
   (`diagnostics-maintenance.md`). The workflow it writes never installs the package.
   <https://github.com/Unity-Technologies/unity-agent-plugin/blob/main/skills/unity-cli/references/diagnostics-maintenance.md>
   > "The generated workflow installs the CLI, restores the editor download cache and the project's
   > `Library/` folder, installs the editor version from `ProjectSettings/ProjectVersion.txt`, activates a
   > license, runs `unity doctor --ci` as a preflight, runs the tests with a JUnit report, builds,
   > uploads the report and the build, and returns the license seat in a teardown step that runs even
   > when the job failed or was cancelled."

7. Third-party corroboration of the optional-package framing.
   <https://xgamedev.com/blog/unity-cli-explained>
   > "An optional package, `com.unity.pipeline`, lets you register your own commands with a `[CliCommand]`
   > attribute and run them, or arbitrary C#, against an Editor that is already open, with no recompile."

**Implications for the toolkit**

- Do **not** make `com.unity.pipeline` a project prerequisite for the `build`/`test` adapters. The
  adapters must work on a clean project with an untouched `Packages/manifest.json`, and the toolkit must
  never add a package to a user's project to run CI.
- Split capability detection explicitly: `test`/`build`/`install`/`doctor`/`license` = no package;
  `command`/`eval`/`status`/`recompile`/`run --command`/`mcp` = package required, and those must fail
  with a clear "install the pipeline package" message instead of a generic connection error.
- Keep a separate "live Editor" adapter family that is opt-in and version-gated (package versions are
  `0.x-exp.1` and drift against CLI betas). Never let that family be on the critical path of a CI run.
- In docs, state the answer to this question directly and cite the exact sentence, because the "install
  the pipeline package" note on the CLI landing page reads like a global prerequisite and will be
  misread by users and by other agents.

---

## S9 — Stability, versioning and pinning policy

**Answer**

Unity's own documentation labels the CLI **experimental**: "The Unity command-line interface (CLI) is
experimental. The features and documentation might change in an upcoming release." It is versioned
`1.0.0-beta.N`, with 1.0 beta.1 described as "the move to 1.0 versioning", and it has been shipping
roughly fortnightly (beta.1 on 2026-06-30 through beta.14 on 2026-10-21). There is **no stable channel
yet**: the installer "gets the latest beta on its own" "until a stable release ships", the apt/dnf
repositories currently publish to an `unstable` suite with a note that "general availability (GA)
releases publish to `stable`", and `unity self-update --check --channel stable` is documented as the
thing you run "when moving off a beta once GA ships" — i.e. a forward-looking check that today finds
nothing. Unity has committed to **no GA date**; a staff post says only that features are planned
"before the CLI goes GA", under a safe-harbour disclaimer. Breaking changes are real and frequent, and
are announced per-release under explicit `Breaking changes` headings with no semver compatibility
promise. Pinning is possible (`--target <version>`, `unity changelog --target`, or a package-manager
version pin) but is **not reliable on machines where the Hub or winget manages the binary**, because
those channels self-update and cannot be switched off.

**Confidence**

- Experimental status: **CONFIRMED**.
- Beta-only releases / no stable channel today: **CONFIRMED** (three independent official statements).
- Breaking changes happen in beta with per-release announcements: **CONFIRMED**.
- GA date: **UNRESOLVED** (no date anywhere; only intent language).
- Pinning being defeated by Hub auto-update and winget/MSIX auto-update: **CONFIRMED** (docs state it
  explicitly). The practical workaround (apt/dnf/brew/standalone) is **INFERRED** from the same page.

**Sources**

1. CLI landing page — the status statement (official).
   <https://docs.unity.com/en-us/unity-cli>
   > "Important — The Unity command-line interface (CLI) is experimental. The features and documentation
   > might change in an upcoming release."

2. Release notes — 1.0.0-beta.1 (official).
   <https://docs.unity.com/en-us/unity-cli/release-notes>
   > "The first 1.0 beta of the Unity CLI. This release marks the move to 1.0 versioning and rolls up the
   > functionality shipped across the 0.1.0 betas."

   Release notes, 1.0.0-beta.10:
   > "`install.sh` and `install.ps1` now install the latest beta when you don't choose a release channel,
   > until the CLI has a stable release."

   Release notes, 1.0.0-beta.12:
   > "The CI workflows `unity ci init` writes now install the CLI with the plain `install.sh` command,
   > without setting `UNITY_CLI_CHANNEL=beta`. Until a stable release ships, the installer gets the latest
   > beta on its own."

   Release notes, 1.0.0-beta.4:
   > "… packages to Unity's apt and rpm repositories on every beta and general availability (GA) release,
   > so package-managed installs update through the system package manager."

3. Install docs — the `unstable` suite vs `stable` for GA, and the `--target` pin (official).
   <https://docs.unity.com/en-us/unity-cli/use-unity-cli>
   > "`unstable` suite; general availability (GA) releases publish to `stable`."
   > "Replace `<version>` with a release version such as `1.0.0`. The `--target` option also accepts a
   > leading `v`, such as `v1.0.0`, and `latest` for the latest release."
   > "To review the release notes for the version before you install it, run `unity changelog --target
   > <version>`."

4. Install docs — the automatic-update limits, which are the pinning trap (official).
   <https://docs.unity.com/en-us/unity-cli/use-unity-cli>
   > "The Unity Hub updates the Unity CLI automatically. You can't disable these updates in the Hub."
   > "`unity config update-check off` disables only the CLI's notice that a new release is available. It
   > doesn't stop the Hub from updating the CLI."
   > "If you installed the CLI as an MSIX package, including through winget, Windows keeps the CLI
   > current in the background. Rollback isn't available for MSIX installs."
   > "`unity self-update` … no longer installs an older version on its own. When the channel's latest
   > version is lower than the one you run, it reports that and changes nothing (exit 1), even with
   > `--yes`, piped output or `--format json`." *(release notes, beta.13)*

5. Official Unity agent skill — the only explanation of `--channel stable` Unity publishes.
   <https://github.com/Unity-Technologies/unity-agent-plugin/blob/main/skills/unity-cli/SKILL.md>
   > "`unity --version` prints the version you have. `unity self-update --check --format json` says
   > whether a newer one exists on your installed channel (a beta follows betas). `unity self-update
   > --check --channel stable --format json` checks for a stable release, for example when moving off a
   > beta once GA ships."

   Same file, on version identity:
   > "`unity version` reports the CLI version, release channel (`stable`, `beta`, …), commit, platform,
   > architecture, and runtime — the same version fact `env` and `doctor` carry, as one parseable
   > object."

6. Breaking-change evidence (official release notes).
   > 1.0.0-beta.8: "**Breaking changes** … This release supersedes 1.0.0-beta.7, which reached the beta
   > channel and was withdrawn the same day. The changes from beta.7 are included in this section. If you
   > upgraded directly from 1.0.0-beta.6, you receive the complete set of changes."
   > 1.0.0-beta.6: "Two changes worth knowing about if you have CI depending on the old behavior"
   > 1.0.0-beta.4: "**Breaking change**"
   > 1.0.0-beta.12: "`unity command` with no arguments now lists the Editor's command groups instead of
   > its tags, and an Editor with an older Pipeline package still lists its tags."

7. GA intent, no date (official Unity staff post, Unity Discussions).
   <https://discussions.unity.com/t/announcing-the-unity-cli-a-new-way-to-connect-your-tools-and-agents/1731104>
   > "We're also planning on adding integrations with the profiler and frame debugger before the CLI goes
   > GA!"

   And the blog's safe-harbour statement:
   <https://unity.com/blog/meet-the-unity-cli>
   > "This roadmap represents Unity's current intentions for the development of our product suite. It is
   > provided for informational purposes only and is not a commitment to deliver any specific feature or
   > functionality."

8. Documentation drift as a stability signal (official Unity content disagreeing with official Unity
   docs, 13 days apart). Unity's own resource uses `--junit-output`, which the reference restricts.
   <https://unity.com/resources/20-cli-commands-in-10-min> (Oct 8, 2026)
   > "`unity test --mode EditMode --filter MyNamespace.MyTests --junit-output results.xml`"
   vs. <https://github.com/Unity-Technologies/unity-agent-plugin/blob/main/skills/unity-cli/references/build-run-test.md>
   > "`--junit-output` is only valid with `nunit,junit` — with `junit` alone the JUnit report *is*
   > `--output`, so passing both is an error rather than a silent no-op."

   The same resource also pins a known-good triple, which is the only version-alignment guidance Unity
   publishes:
   > "At the time of writing, I'm using the 1.0.0-beta.10 version of Unity CLI combined with 0.6.0-exp.1
   > of the com.unity.pipeline package and Unity 6000.6.0f1."

9. Third-party framing, for corroboration only.
   <https://xgamedev.com/blog/unity-cli-explained>
   > "Unity's docs label the CLI experimental, so commands and output can still change."

**Implications for the toolkit**

- The toolkit must own a **CLI capability matrix**, not a "minimum CLI version" constant: probe
  `unity version --format json` + the presence of specific flags/commands, and degrade gracefully. Beta
  releases add and rename commands between fortnightly drops, so a hard version gate will be wrong
  within a month.
- Pinning must be implemented as an **install-method policy**, not a version string. Refuse to promise
  reproducibility on Hub-managed or winget/MSIX installs (they self-update; MSIX cannot even roll back).
  Pin only through apt/dnf/brew with an explicit version, or a standalone binary kept out of the Hub's
  path; document `UNITY_CLI_HOME` and `--target` as the only supported pinning levers.
- Record the CLI identity in every artefact: `unity version --format json` (version, channel, commit) is
  the field that makes a failure reproducible. `unity build`'s provenance manifest already records CLI
  version — the adapter must surface it and the docs must tell users to archive it.
- Treat "stable channel" as a future migration path, not a current option: expose a
  `unity self-update --check --channel stable` check as an advisory ("GA available, plan the move"), and
  never silently switch channels mid-pipeline.
- Version-lock the toolkit's own supported range to a tested beta (e.g. beta.13/beta.14) and make
  "untested CLI newer than X" a loud warning rather than a hard failure, because GA is undated.

---

## Additional findings

### Official CI/CD guidance with the Unity CLI

**`unity ci init` is the recommended workflow shape — and it is barely documented publicly.** It appears
in Unity's shipped agent skill but not on the public CLI reference page (which says "Run `unity --help`
to check the authoritative command list … including any commands not yet covered on this page"). It
generates a real, committed workflow rather than prose. Official description:

> "`unity ci init` writes a committed CI workflow generated from the project. Use it instead of
> assembling the steps by hand — it wires up the CLI's own CI features in the right order and encodes
> the parts that are otherwise learned by trial and error."
> "GitHub Actions -> `.github/workflows/unity.yml` (the default provider)."
> "`unity ci init --provider gitlab` … `.gitlab-ci.yml`"

The generated job, in order:

> "installs the CLI, restores the editor download cache and the project's `Library/` folder, installs the
> editor version from `ProjectSettings/ProjectVersion.txt`, activates a license, runs `unity doctor --ci`
> as a preflight, runs the tests with a JUnit report, builds, uploads the report and the build, and
> returns the license seat in a teardown step that runs even when the job failed or was cancelled."

Secrets and licensing guidance encoded in that workflow:

> "Secrets are referenced by name only. The command never reads a credential and the generated file
> never contains one — it expects `UNITY_SERVICE_ACCOUNT_ID`, `UNITY_SERVICE_ACCOUNT_SECRET`, and
> `UNITY_LICENSE_SERIAL` to exist as repository secrets, and reports which ones to add after it writes."
> "Two things about licensing that the workflow states in comments, because they surprise people:
> service-account auth covers Unity *services*, not the editor licence, and `unity license activate
> --personal` is rejected outright for a service account. The generated step therefore activates from a
> serial, and ships the floating-server and offline-`.ulf` alternatives as commented blocks beside it."

Non-interactive defaults and sharding (useful for reproducing the shape without running the command):

> "In that case the unpassed values take their defaults (`github`, `StandaloneLinux64`, no sharding) and
> an existing workflow is an exit-2 error naming `--overwrite` rather than a question."
> "Accepts 2 to 64 [shards] — `1` is rejected rather than generating a one-leg matrix."
> "`--dry-run` prints the workflow to stdout and nothing else, so it pipes into a file or a diff."
> "Templates are embedded in the binary, so this works offline and always matches the CLI it ships with."

### The blog's recommended command shape (official, Sep 15 2026)

<https://unity.com/blog/cicd-made-easier-with-unity-cli>

> "With Unity CLI, the same step can be expressed in terms of its intent: `unity test . --mode EditMode
> --output ./results/editmode.xml --allow-install`"
> "`unity build . --target Android --execute-method Builder.PerformBuild --output-path ./out/app.aab
> --allow-install`"
> "With `--allow-install`, the CLI can read the Unity version required by the project and install it if
> necessary. The project, rather than the build machine, becomes the source of truth for which Editor
> version to use."

Note that the blog's "before" example is a bare Editor invocation with `-batchmode -nographics -quit`
and no `xvfb` — consistent with S5.

Licensing lifecycle, and the teardown rule the toolkit should encode:

> "Licensing can also become an explicit part of the job lifecycle. The runner activates a license before
> it performs Unity work and returns it when the job ends: `unity license activate --floating` … `unity
> license return`"
> "For ephemeral runners, the return command should be placed in an unconditional teardown step so it
> runs even when a test or build fails. That prevents failed jobs from leaving seats checked out and
> affecting later builds."

Credential hygiene for signing keys:

> "Signing files can follow the same pattern. For example, an Android keystore can be stored as a
> base64-encoded CI secret, decoded only for the build, and deleted during teardown."

### Honest caveat: service accounts cannot activate licences

This is the single most likely CI footgun, and it is stated in both official sources:

<https://github.com/Unity-Technologies/unity-agent-plugin/blob/main/skills/unity-cli/references/auth-license-cloud.md>
> "Unity's licensing backend does **not** accept service-account tokens for license activation, so with a
> service-account session the default entitlement mode and `--personal` fail up front — before contacting
> the licensing client — with guidance toward the unattended options (`--floating`, `--file`,
> `--generate-request`, or a perpetual `--serial`)."

### Useful official CI primitives worth wrapping

| Primitive | Why it matters | Source |
|---|---|---|
| `unity doctor --ci` | Preflight with real exit-code semantics: `0` pass, `6` definitive (don't retry), `7` unreachable (retry). Checks license, required editor, disk, network, plus a non-blocking Accelerator probe. | `docs.unity.com/.../release-notes` (beta.6) + `unity-agent-plugin/.../diagnostics-maintenance.md` |
| `unity cache key [--target]` | Deterministic `Library/` cache key from editor version + resolved package set + target; identical across OSes; "does not change for unrelated edits — scenes, scripts, assets". | `unity-agent-plugin/.../diagnostics-maintenance.md` |
| `--format github` | Emits `::error::` / `::warning::` annotations, inert outside Actions. | same file; `unity-cli-reference` |
| `--report-format junit` | Native GH Actions / GitLab test ingestion, written even when tests fail; NUnit stays the default because `--affected`/`--rerun-failed` can only read NUnit. | `unity-agent-plugin/.../build-run-test.md` |
| `unity test --shard N/M` | Deterministic hash-based sharding, but needs an NUnit inventory from a prior full run — the first cold run pays one full suite. | same file |
| `unity install --download-directory <dir>` | Self-contained Editor into a CI workspace "without changing the install path or adding it to the Hub's Editor list". | release notes, beta.14 |
| `unity projects create --no-cloud` / `UNITY_NO_CLOUD` | Keeps an entirely local pipeline without a Unity Cloud project. | `use-unity-cli` |

### Things that are explicitly NOT available / not promised

- **No offline-first story for the CLI itself**: `unity changelog` "needs a network connection", and the
  CLI checks for updates in the background by default. Set `UNITY_NO_UPDATE_CHECK` in CI.
- **No container support statement** for the Editor (see S5). Unity's Build Automation cloud product is
  the officially supported "cloud build" path; the local CLI is documented for "CI and build agents",
  which is a different claim.
- **No documented `unity build`/`unity test` CI example on `docs.unity.com`** beyond the command tables;
  the concrete examples live in the blog and in the shipped agent skill. That asymmetry is itself a
  finding: the skill repo is currently the most precise CI documentation Unity publishes.
