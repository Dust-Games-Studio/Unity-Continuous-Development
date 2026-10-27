# Spike 0 (addendum) — how Unity's Package Manager authenticates to a private git package

**Date:** 2026-10-27. **Editor:** 6000.6.6f1. **Unity CLI:** 1.0.0-beta.14.
**Status:** empirically measured, end-to-end, through `unity build`.

This addendum answers the question the design doc did not ask: how does a project consume a
package from a **private** git repository, and where does the credential have to live so it
never ends up in a committed file?

---

## Method

The probe avoided needing a real private repository, and avoided a DNS confound.

1. A minimal, valid UPM package (`com.probe.test` 1.0.0, with `Runtime/Marker.cs` containing
   the literal string `probe-ok`) was committed to a **local bare git repository**.
2. A throwaway Unity project declared it as
   `"com.probe.test": "https://fake.private.test/org/pkg.git"` — a host that **has no DNS
   record** (verified: `Resolve-DnsName fake.private.test` returns nothing), so the *only* way
   it can resolve is through a git URL rewrite.
3. Each case configured the rewrite differently, then ran
   `unity build . --target StandaloneWindows64 --output-path … --no-tail` — a full batch-mode
   Editor launch, so the **Unity CLI spawned the Editor and the Editor's Package Manager
   performed the clone**.
4. Success was decided by the presence of `Library/PackageCache/com.probe.test@<commit>/Runtime/Marker.cs`
   containing `probe-ok` — a file that exists in no other place. The commit hash observed
   (`c7f497913b48…`) matches the local repository's `HEAD`.

Every case ended in `unity build` exit **6**, which is the expected outcome: the throwaway
project has no scene in Build Settings, so the *build* step fails. The package *resolution*,
which happens earlier, is what the probe measures.

---

## Results

| # | Where the rewrite was delivered | UPM honoured it? |
|---|---|---|
| A/E | `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=url.<base>.insteadOf`, `GIT_CONFIG_VALUE_0=<prefix>` (per-invocation config, git ≥ 2.31) | **YES** |
| C | the real `~/.gitconfig` (an `[url "…"] insteadOf = …` section) | **YES** |
| D | `$XDG_CONFIG_HOME/git/config` | **YES** |
| B | `GIT_CONFIG_GLOBAL=<file>` (git ≥ 2.32) | **NO** |

**`GIT_CONFIG_GLOBAL` is the trap.** It is the most convenient way to point git at a
throwaway config file, and it is the one mechanism Unity's Package Manager ignores. A CI
recipe built on it fails at package resolution with an error that reads like a Unity bug.

### The credential never reaches a committed file

With any of the working mechanisms, `Packages/packages-lock.json` recorded the URL **exactly
as written in the manifest**:

```json
"es.dustgames.common": {
  "version": "https://github.com/Dust-Games-Studio/Dust-Games-Packages.git?path=Packages/es.dustgames.common",
  "depth": 0,
  "source": "git",
  "hash": "936a274cd923d0a2c0b9b97f7a1aa034df40451e"
}
```

The rewritten, credential-bearing URL appears **nowhere** in the lock file. The rewrite is
applied by git at fetch time, so the manifest and the lock file keep the plain URL.

The converse is the hazard: a URL that **embeds** credentials
(`https://user:token@host/org/repo.git`) is copied verbatim into `packages-lock.json` by
Unity, and that file is committed. The token would land in the repository.

### What this implies

- **Use a git URL rewrite.** The manifest keeps a credential-free URL; the credential lives in
  git configuration, which git applies at fetch time.
- **Never embed a token in `Packages/manifest.json`.** The core refuses to run when it sees one.
- **`~/.gitconfig` and `$XDG_CONFIG_HOME/git/config` both work**, so a CI job can point git at
  a file it creates and deletes in the teardown. `GIT_CONFIG_GLOBAL` does not.
- **The per-invocation `GIT_CONFIG_*` variables work** and write nothing to disk at all.
- **Preflight with `git ls-remote`.** The same ambient configuration that makes UPM succeed also
  makes `git ls-remote --exit-code <url>` succeed — so the core can prove the credential is in
  place in a second, before any Editor is launched.

---

## Not measured here

- **SSH.** Whether UPM accepts `git@host:owner/repo.git` and honours `ssh-agent` was not
  measured on this machine (no SSH key was configured for the probe). Treat it as unverified.
- **A real private GitHub repository.** The probe used a local repository behind a fake host.
  The *mechanism* is the same (git URL rewrite → credential), but the exact behaviour against
  GitHub's authentication was not exercised.
- **`git credential.helper`.** Not measured. The local machine has Git Credential Manager
  configured, and it works for the plain `git ls-remote` path; whether UPM's git honours a
  credential helper is unverified. The URL-rewrite route does not depend on it.
