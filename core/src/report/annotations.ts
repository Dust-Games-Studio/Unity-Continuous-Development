/**
 * CI annotations. This is the **only** module allowed to know which CI system
 * is running (GC4): the `::error` workflow-command format and the
 * `GITHUB_STEP_SUMMARY` lookup live here and nowhere else. Everything else in
 * the core stays provider-neutral.
 *
 * Every line that reaches stdout or the job summary goes through the context's
 * redactor first (GC5).
 */
import { appendFileSync } from 'node:fs';
import type { CoreContext } from '../context.js';
import type { TestFailure } from './nunit.js';

interface Location {
  file: string;
  line: number;
}

/**
 * Finds the source location in an NUnit stack trace. Unity/NUnit writes frames
 * such as `at Game.Tests.Foo.Bar () [0x00000] in /repo/Assets/Tests/Foo.cs:42`;
 * the second pattern covers the `(Foo.cs:42)` form other runners use. A missing
 * or non-positive line means there is no usable location, not line 0.
 */
function locate(stack: string | null): Location | null {
  if (stack === null) return null;
  const match =
    /\bin\s+(.+?):(\d+)(?=\s|$)/.exec(stack) ?? /\((.+?):(\d+)\)/.exec(stack);
  if (match === null) return null;
  const line = Number(match[2]);
  if (!Number.isSafeInteger(line) || line <= 0) return null;
  return { file: match[1]!, line };
}

/** A failure message is one annotation, so its newlines become spaces. */
function oneLine(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ').trim();
}

function annotationFor(failure: TestFailure): string {
  const location = locate(failure.stack);
  const head =
    location === null ? '::error' : `::error file=${location.file},line=${location.line}`;
  const message = oneLine(failure.message);
  return message === '' ? `${head}::${failure.name}` : `${head}::${failure.name} — ${message}`;
}

/**
 * Markdown table cells must not carry raw markup or embedded newlines: a
 * failure message is Unity's text, and `<` in it would otherwise be swallowed
 * as an HTML tag in the rendered summary.
 */
function markdownCell(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/\r\n|\r|\n/g, '<br>');
}

function summaryBlock(failures: TestFailure[]): string {
  const lines = ['### Unity test failures', ''];
  if (failures.length === 0) {
    lines.push('No failing tests.', '');
  } else {
    lines.push('| Test | Message |', '| --- | --- |');
    for (const failure of failures) {
      lines.push(`| ${markdownCell(failure.name)} | ${markdownCell(failure.message)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Emits one `::error` workflow command per failed test to stdout when
 * `output.annotations` is `github`, and appends a summary table to
 * `$GITHUB_STEP_SUMMARY` when that variable is set. Writes nothing when
 * annotations are disabled.
 *
 * A failure to append to the job summary must not fail the run that produced
 * it, so it is reported through the logger instead.
 */
export function emitAnnotations(ctx: CoreContext, failures: TestFailure[]): void {
  if (ctx.config.output.annotations !== 'github') return;

  for (const failure of failures) {
    process.stdout.write(`${ctx.redactor.redact(annotationFor(failure))}\n`);
  }

  const summaryPath = ctx.env.GITHUB_STEP_SUMMARY ?? process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath === undefined || summaryPath === '') return;

  const block = `${ctx.redactor.redact(summaryBlock(failures))}\n`;
  try {
    appendFileSync(summaryPath, block, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      ctx.logger.warn(`could not append to the job summary at ${summaryPath}: ${detail}`);
    } catch {
      // A broken logger must not turn a reporting failure into a crash.
    }
  }
}
