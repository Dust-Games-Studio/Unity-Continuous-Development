# fake-unity

A deterministic stand-in for Unity's `unity` CLI, used by the core tests and the
adapter conformance checks. It spawns nothing and touches no Editor: every
invocation is answered from a JSON scenario.

## Scenario

`fake-unity.mjs` reads the file named by the `FAKE_UNITY_SCENARIO` environment
variable:

```json
{
  "results": [
    {
      "args": ["test"],
      "code": 0,
      "json": { "success": true, "data": {} },
      "files": {
        "ci-output/tests/EditMode.xml": "<test-run ...>"
      }
    }
  ],
  "default": { "code": 0, "json": { "success": true, "data": {} } }
}
```

- An entry matches when its `args` array is a **prefix** of the process's own
  arguments. The first match wins, so put the more specific entries first.
- `default` answers any invocation no entry matched. Without it, an unmatched
  invocation exits **2** and prints the argv it received, e.g.
  `fake-unity: no scenario entry matches: ["cache","key","..."]`. That is what
  lets a test assert the exact argv the core produced.
- `files` is an object of path → content. Paths are relative to the child's
  working directory (`process.cwd()`); parent directories are created.
- `json`, when present, is serialised to stdout. It is not printed when the key
  is absent.
- `code` is **required** and must be an integer. A missing or non-integer code
  fails loudly instead of becoming an implicit success, so a scenario that says
  `"code": "8"` cannot accidentally report a green run.

## Running it

The script has a `#!/usr/bin/env node` shebang and is committed executable, so
on Linux and macOS it can be invoked directly:

```bash
./testing/fake-unity/fake-unity.mjs version --format json
```

Spawn takes one executable plus an argv array, and `unity.cli.binary` is a
single path; the script path cannot be a separate argument. Use a shim:

**POSIX**

```sh
#!/bin/sh
exec node /absolute/path/to/testing/fake-unity/fake-unity.mjs "$@"
```

(`chmod +x` the shim.)

**Windows**

Node's `spawn(file, args, { shell: false })` **cannot** launch a `.cmd` or
`.bat`; it fails with `EINVAL`, and the core never uses `shell: true`. The
Windows tests therefore rely on the Node-preload hook below, because that is the
only way to point a single `unity.cli.binary` path at this script without a
compiled launcher. A real Windows launcher can instead be a small compiled
`.exe`, or the same preload approach:

1. point `unity.cli.binary` at `process.execPath` (Node itself);
2. set `NODE_OPTIONS=--require <hook.cjs>` for the child;
3. have the hook redirect Node's first entry request to `fake-unity.mjs` and
   put back the verb Node consumed as `argv[1]`:

```js
const Module = require('node:module');
const path = require('node:path');
const fake = 'C:/absolute/path/testing/fake-unity/fake-unity.mjs';
const entryPath = process.argv[1];
const entryArg = path.basename(entryPath);
const original = Module._resolveFilename;
let redirected = false;
Module._resolveFilename = function (request, ...rest) {
  if (!redirected && request === entryPath) {
    redirected = true;
    return fake;
  }
  return original.call(this, request, ...rest);
};
process.argv[1] = fake;
process.argv.splice(2, 0, entryArg);
```

`NODE_OPTIONS` must contain the hook path **quoted** and use forward slashes,
for example `--require "C:/temp/hook.cjs"`: quoting keeps a `%TEMP%` path with
spaces working, while forward slashes avoid Node stripping Windows backslashes
inside quotes. Running the suite under WSL also works and needs only the POSIX
shim.

Point the configuration at the shim and set the scenario for the child:

```yaml
unity:
  cli:
    binary: /absolute/path/to/unity-shim
```

```bash
FAKE_UNITY_SCENARIO=/absolute/path/to/scenario.json unityci run test
```

## Exit codes

A matched entry's integer `code`, and `2` for a missing/invalid scenario, a
missing or non-integer code, or an unmatched invocation. `2` mirrors the real
CLI's usage-error code, so an accidental extra or missing argument fails loudly.
