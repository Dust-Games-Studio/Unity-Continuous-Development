import type { CoreContext } from '../context.js';
import { EXIT } from '../exit-codes.js';
import { LicenseError, activateLicense, returnLicense } from '../lifecycle/license.js';

/**
 * `unityci license activate`: the explicit form of the lifecycle's licence
 * step. It performs the route selected by `license.mode` (S1) and reports what
 * it did. Under `license.mode: none` it calls nothing and exits 0, because an
 * active licence is then a precondition the toolkit does not satisfy itself
 * (R17).
 *
 * A missing secret or a failed activation is a configuration error (64), never
 * a retryable one.
 */
export async function licenseActivateCommand(ctx: CoreContext): Promise<number> {
  try {
    await activateLicense(ctx);
    return EXIT.SUCCESS;
  } catch (error) {
    if (error instanceof LicenseError) {
      try {
        ctx.logger.error(error.message);
      } catch {
        // A broken logger must not turn a controlled 64 into a rejection.
      }
      return error.exitCode;
    }
    throw error;
  }
}

/**
 * `unityci license return`: the teardown command adapters call from an
 * `always()` step.
 *
 * A failed return — or a return that leaves a seat held (`seatLeaked`) — exits
 * **6**. This is deliberately different from the run lifecycle's teardown: that
 * teardown has a primary exit code to preserve and only logs the result (GC9),
 * while this command has no primary exit code — the user explicitly asked for a
 * seat to be returned, and exit 0 on a failed or leaked return is exactly how a
 * Unity seat goes unnoticed on a runner. `returnLicense` has already logged the
 * reason at error/warn level.
 *
 * An adapter's `always()` step must therefore tolerate this non-zero exit when
 * it runs the command after the job's real result is already known; the
 * adapter conformance rule covers that, not this command.
 */
export async function licenseReturnCommand(ctx: CoreContext): Promise<number> {
  const result = await returnLicense(ctx);
  const freed = result.returned && result.seatLeaked !== true;
  return freed ? EXIT.SUCCESS : EXIT.COMMAND_FAILED;
}
