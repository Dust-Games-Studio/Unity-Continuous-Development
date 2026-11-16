import type { CoreContext } from '../context.js';

/**
 * The editor-identity flags shared by `unity test` and `unity build`.
 *
 * 1.0.x lets `UNITY_EDITOR_VERSION` and `UNITY_ARCHITECTURE` steer both
 * commands. Passing the resolved values explicitly keeps the run on the Editor
 * `setup` verified, whatever the operator's shell exports. `--editor-path`
 * pins a specific binary, including one installed with
 * `unity install --download-directory` that the Hub registry does not list.
 */
export function editorIdentityArgs(ctx: CoreContext): string[] {
  const args: string[] = [];
  if (typeof ctx.editorVersion === 'string' && ctx.editorVersion !== '') {
    args.push('--editor-version', ctx.editorVersion);
  }
  const architecture = ctx.config.unity.editor.architecture;
  if (architecture !== null) args.push('--architecture', architecture);
  const path = ctx.config.unity.editor.path;
  if (path !== null) args.push('--editor-path', path);
  return args;
}

/**
 * `--accelerator <host[:port]>` or `--no-accelerator`, shared by test and build.
 * Unity accepts both only after the command name.
 */
export function acceleratorArgs(ctx: CoreContext): string[] {
  const accelerator = ctx.config.accelerator;
  if (accelerator.disabled) return ['--no-accelerator'];
  if (accelerator.endpoint !== null) return ['--accelerator', accelerator.endpoint];
  return [];
}
