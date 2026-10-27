import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import {
  SetupError,
  setup,
  type SetupInput,
} from '../lifecycle/setup.js';

/**
 * `unityci setup [--required-module <id>…]`: the Editor preflight.
 *
 * The module requirement belongs to the command that called setup:
 * `{ command: 'build' }` derives it from `config.build.target`,
 * `{ command: 'test' }` checks no platform module, and no command checks only
 * the Editor version. `requiredModules` is an explicit override. The core only
 * reports a missing Editor or module; it installs one only when
 * `unity.editor.acceptEula` is true.
 */
export async function setupCommand(
  ctx: CoreContext,
  input: SetupInput = {},
): Promise<number> {
  try {
    const result = await setup(ctx, input);
    ctx.logger.info(
      `Editor ${result.editorVersion} is ready (Unity CLI ${result.cliVersion}` +
        `${result.cliChannel === null ? '' : ` ${result.cliChannel}`}` +
        `${result.cliCommit === null ? '' : ` @ ${result.cliCommit}`}` +
        `; ${result.installed ? 'installed this run' : 'already installed'}).`,
    );
    return EXIT.SUCCESS;
  } catch (error) {
    if (error instanceof SetupError) {
      ctx.logger.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}
