#!/usr/bin/env node
/**
 * The published `unityci` entrypoint.
 *
 * It sets `process.exitCode` instead of calling `process.exit`: the run
 * lifecycle's licence return and `summary.json` write must be allowed to drain,
 * and a truncated stdout on a passing run would look identical to a crash.
 * There is no entry guard and no logic here; `cli.ts` has no top-level side
 * effects, so importing it (from `index.ts` or a test) never runs a command.
 */
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
