import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { SetupError, setup } from '../lifecycle/setup.js';

/**
 * `unityci setup [--required-module <id>…]`: the Editor preflight.
 *
 * `requiredModules` belongs to the command that called setup — a test run
 * passes the test platform's modules, a build its target's modules, and a
 * command with no module requirement passes none. The core only reports a
 * missing Editor or module; it installs one only when `unity.editor.acceptEula`
 * is true.
 */
export async function setupCommand(
  ctx: CoreContext,
  requiredModules: string[] = [],
): Promise<number> {
  try {
    const result = await setup(ctx, requiredModules);
    ctx.logger.info(
      `Editor ${result.editorVersion} is ready (Unity CLI ${result.cliVersion}` +
        `${result.cliChannel === null ? '' : ` ${result.cliChannel}`}` +
        `${result.cliCommit === null ? '' : ` @ ${result.cliCommit}`}` +
        `; ${result.installed ? 'installed this run' : 'already installed'}; doctor: ${result.doctorVerdict}).`,
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
