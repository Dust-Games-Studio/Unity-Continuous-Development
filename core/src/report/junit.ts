/**
 * NUnit 3 → JUnit conversion: the core's fallback for when Unity's own
 * converter did not produce a JUnit file (D8), and what `unityci report` uses
 * to guarantee that every NUnit report has a JUnit sibling. The conversion
 * escapes every value it writes: a failure message containing `<`, `&` or a
 * quote must never break the document a CI system parses.
 */
import { parseNUnitReport, type NUnitCase, type TestCounts } from './nunit.js';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function outcomeOf(result: string): 'passed' | 'failed' | 'skipped' {
  switch (result.toLowerCase()) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'skipped';
  }
}

/** NUnit's `duration` is already in seconds, as is JUnit's `time`. */
function timeOf(raw: string): string {
  const trimmed = raw.trim();
  return /^\d+(?:\.\d+)?$/.test(trimmed) ? trimmed : '0';
}

function classnameOf(testCase: NUnitCase): string {
  if (testCase.classname !== '') return testCase.classname;
  const dot = testCase.fullname.lastIndexOf('.');
  return dot > 0 ? testCase.fullname.slice(0, dot) : '';
}

function countsOf(cases: NUnitCase[]): TestCounts {
  const counts: TestCounts = { total: cases.length, passed: 0, failed: 0, skipped: 0 };
  for (const testCase of cases) {
    counts[outcomeOf(testCase.result)] += 1;
  }
  return counts;
}

function sumSeconds(cases: NUnitCase[]): string {
  const total = cases.reduce((sum, testCase) => {
    const value = Number(timeOf(testCase.duration));
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
  return total.toFixed(3);
}

function renderCase(testCase: NUnitCase): string {
  const classname = classnameOf(testCase);
  const attributes =
    `classname="${escapeXml(classname)}" ` +
    `name="${escapeXml(testCase.name)}" ` +
    `time="${escapeXml(timeOf(testCase.duration))}"`;
  const outcome = outcomeOf(testCase.result);

  if (outcome === 'failed') {
    const message = testCase.failure?.message ?? '';
    const detail = testCase.failure?.stack ?? '';
    return (
      `    <testcase ${attributes}>\n` +
      `      <failure message="${escapeXml(message)}">${escapeXml(detail)}</failure>\n` +
      `    </testcase>`
    );
  }
  if (outcome === 'skipped') {
    return `    <testcase ${attributes}>\n      <skipped />\n    </testcase>`;
  }
  return `    <testcase ${attributes} />`;
}

function renderSuite(name: string, cases: NUnitCase[]): string {
  const counts = countsOf(cases);
  const attributes =
    `name="${escapeXml(name)}" ` +
    `tests="${counts.total}" ` +
    `failures="${counts.failed}" ` +
    `errors="0" ` +
    `skipped="${counts.skipped}" ` +
    `time="${sumSeconds(cases)}"`;

  if (cases.length === 0) return `  <testsuite ${attributes} />`;
  return [`  <testsuite ${attributes}>`, ...cases.map(renderCase), `  </testsuite>`].join('\n');
}

/**
 * Converts an NUnit 3 document into a JUnit `<testsuites>` document: one
 * `<testsuite>` per NUnit `<test-suite>` and one `<testcase>` per `<test-case>`.
 * Throws {@link import('./nunit.js').ReportParseError} for a malformed report.
 */
export function nunitToJUnit(nunitXml: string): string {
  const report = parseNUnitReport(nunitXml);
  const allCases = report.suites.flatMap((suite) => suite.cases);
  const counts = countsOf(allCases);

  const rootAttributes =
    `tests="${counts.total}" ` +
    `failures="${counts.failed}" ` +
    `errors="0" ` +
    `skipped="${counts.skipped}" ` +
    `time="${sumSeconds(allCases)}"`;

  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<testsuites ${rootAttributes}>`,
    ...report.suites.map((suite) => renderSuite(suite.name, suite.cases)),
    '</testsuites>',
    '',
  ].join('\n');
}
