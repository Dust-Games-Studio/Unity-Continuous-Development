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
      ctx.logger.error(error.message);
      return error.exitCode;
    }
    throw error;
  }
}

/**
 * `unityci license return`: the teardown command adapters call from an
 * `always()` step.
 *
 * It always exits 0. `returnLicense` logs a failed return loudly but never
 * throws, and a teardown must never mask the primary exit code (GC9) — an
 * adapter step that turned red here would fail a job whose tests passed.
 */
export async function licenseReturnCommand(ctx: CoreContext): Promise<number> {
  await returnLicense(ctx);
  return EXIT.SUCCESS;
}
