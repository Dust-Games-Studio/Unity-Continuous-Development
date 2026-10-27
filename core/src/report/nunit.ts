/**
 * NUnit 3 reading, with no XML dependency.
 *
 * Unity's Test Framework emits NUnit 3: the root is `<test-run … total=…
 * passed=… failed=… inconclusive=… skipped=…>` with `<test-suite>` and
 * `<test-case>` children. The plan's runtime-dependency budget is `yaml` and
 * nothing else, so this is a deliberately small parser for exactly the XML
 * shapes real reports contain rather than a general XML implementation:
 * attributes in any order, single- or double-quoted values, self-closing
 * elements, nested suites, comments, a DOCTYPE, CDATA and the standard XML
 * entities (named and numeric, decimal or hex).
 *
 * Anything that is not well-formed throws {@link ReportParseError}. The caller
 * must map that to exit 65 (GC7): a malformed report is never a silent
 * zero-count pass.
 */

/** A NUnit report that could not be parsed. The caller maps it to exit 65. */
export class ReportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReportParseError';
  }
}

export interface TestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface TestFailure {
  name: string;
  message: string;
  stack: string | null;
}

/** One `<test-case>` as the converter needs it. */
export interface NUnitCase {
  name: string;
  fullname: string;
  classname: string;
  /** The raw NUnit `result` attribute (`Passed`, `Failed`, `Skipped`, …). */
  result: string;
  /** The raw NUnit `duration` attribute, in seconds. */
  duration: string;
  failure: TestFailure | null;
}

/** One `<test-suite>` and the test cases it directly contains. */
export interface NUnitSuite {
  name: string;
  cases: NUnitCase[];
}

export interface NUnitReport {
  counts: TestCounts;
  suites: NUnitSuite[];
  failures: TestFailure[];
}

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** The element's direct text content, with entities already decoded. */
  text: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

const ENTITY_PATTERN = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

function decodeEntities(value: string): string {
  return value.replace(ENTITY_PATTERN, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[body] ?? match;
  });
}

const NAME_PATTERN = /[A-Za-z_:][-A-Za-z0-9_:.]*/y;

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\r' || char === '\n';
}

/**
 * Parses a document into an element tree. Throws {@link ReportParseError} at
 * the first piece of markup that is not well-formed, including an unclosed
 * element, a mismatched closing tag, an unquoted attribute and a missing root.
 */
export function parseXml(xml: string): XmlElement {
  let index = 0;
  const length = xml.length;
  const stack: XmlElement[] = [];
  const roots: XmlElement[] = [];

  const fail = (message: string): never => {
    throw new ReportParseError(`${message} (at offset ${index})`);
  };

  while (index < length) {
    if (xml[index] !== '<') {
      const next = xml.indexOf('<', index);
      const end = next === -1 ? length : next;
      const raw = xml.slice(index, end);
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += decodeEntities(raw);
      }
      index = end;
      continue;
    }

    if (xml.startsWith('<!--', index)) {
      const end = xml.indexOf('-->', index + 4);
      if (end === -1) throw fail('unterminated comment');
      index = end + 3;
      continue;
    }

    if (xml.startsWith('<![CDATA[', index)) {
      const end = xml.indexOf(']]>', index + 9);
      if (end === -1) throw fail('unterminated CDATA section');
      if (stack.length > 0) {
        stack[stack.length - 1]!.text += xml.slice(index + 9, end);
      }
      index = end + 3;
      continue;
    }

    if (xml.startsWith('<?', index)) {
      const end = xml.indexOf('?>', index + 2);
      if (end === -1) throw fail('unterminated processing instruction');
      index = end + 2;
      continue;
    }

    if (xml.startsWith('<!', index)) {
      const end = xml.indexOf('>', index + 2);
      if (end === -1) throw fail('unterminated document declaration');
      index = end + 1;
      continue;
    }

    if (xml[index + 1] === '/') {
      const end = xml.indexOf('>', index + 2);
      if (end === -1) throw fail('unterminated closing tag');
      const name = xml.slice(index + 2, end).trim();
      const open = stack.pop();
      if (open === undefined) throw fail(`unexpected closing tag </${name}>`);
      if (open.name !== name) {
        throw fail(`closing tag </${name}> does not match <${open.name}>`);
      }
      index = end + 1;
      continue;
    }

    index += 1;
    NAME_PATTERN.lastIndex = index;
    const nameMatch = NAME_PATTERN.exec(xml);
    if (nameMatch === null) throw fail('expected an element name');
    const name = nameMatch[0];
    index = NAME_PATTERN.lastIndex;

    const attributes: Record<string, string> = {};
    let selfClosing = false;

    while (true) {
      while (index < length && isWhitespace(xml[index]!)) index += 1;
      if (index >= length) throw fail(`unterminated <${name}>`);
      if (xml[index] === '>') {
        index += 1;
        break;
      }
      if (xml[index] === '/') {
        if (xml[index + 1] !== '>') throw fail(`expected ">" after "/" in <${name}>`);
        index += 2;
        selfClosing = true;
        break;
      }

      NAME_PATTERN.lastIndex = index;
      const attributeMatch = NAME_PATTERN.exec(xml);
      if (attributeMatch === null) throw fail(`invalid attribute in <${name}>`);
      const attributeName = attributeMatch[0];
      index = NAME_PATTERN.lastIndex;

      while (index < length && isWhitespace(xml[index]!)) index += 1;
      if (xml[index] !== '=') throw fail(`attribute ${attributeName} has no "="`);
      index += 1;
      while (index < length && isWhitespace(xml[index]!)) index += 1;

      const quote = xml[index];
      if (quote !== '"' && quote !== "'") {
        throw fail(`attribute ${attributeName} is not quoted`);
      }
      const endQuote = xml.indexOf(quote, index + 1);
      if (endQuote === -1) throw fail(`attribute ${attributeName} is not terminated`);
      attributes[attributeName] = decodeEntities(xml.slice(index + 1, endQuote));
      index = endQuote + 1;
    }

    const element: XmlElement = { name, attributes, children: [], text: '' };
    if (stack.length > 0) {
      stack[stack.length - 1]!.children.push(element);
    } else {
      roots.push(element);
    }
    if (!selfClosing) stack.push(element);
  }

  if (stack.length > 0) {
    throw new ReportParseError(`unclosed element <${stack[stack.length - 1]!.name}>`);
  }
  if (roots.length === 0) {
    throw new ReportParseError('the XML document contains no elements');
  }
  if (roots.length > 1) {
    throw new ReportParseError('the XML document has more than one root element');
  }
  return roots[0]!;
}

/** The text content of an element, including its descendants. */
function textContent(element: XmlElement): string {
  return element.text + element.children.map(textContent).join('');
}

function findChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

function collectTestCases(element: XmlElement): XmlElement[] {
  const cases: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === 'test-case') cases.push(child);
      else visit(child);
    }
  };
  visit(element);
  return cases;
}

/** A non-negative integer attribute, or `undefined` when it is absent. */
function countAttribute(element: XmlElement, name: string): number | undefined {
  const raw = element.attributes[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new ReportParseError(
      `NUnit report attribute "${name}" is not a non-negative integer: ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) {
    throw new ReportParseError(
      `NUnit report attribute "${name}" is out of range: ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

type Outcome = 'passed' | 'failed' | 'skipped';

/**
 * An inconclusive test did not pass, and `TestCounts` has no field for it, so it
 * counts as skipped (the brief's rule).
 */
function outcomeOf(result: string | undefined): Outcome {
  switch ((result ?? '').toLowerCase()) {
    case 'passed':
      return 'passed';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'skipped';
  }
}

function walkCounts(cases: XmlElement[]): TestCounts {
  const counts: TestCounts = { total: cases.length, passed: 0, failed: 0, skipped: 0 };
  for (const testCase of cases) {
    counts[outcomeOf(testCase.attributes.result)] += 1;
  }
  return counts;
}

function readFailure(testCase: XmlElement): TestFailure | null {
  const failure = findChild(testCase, 'failure');
  const result = outcomeOf(testCase.attributes.result);
  if (failure === undefined && result !== 'failed') return null;

  const messageNode = failure === undefined ? undefined : findChild(failure, 'message');
  const stackNode = failure === undefined ? undefined : findChild(failure, 'stack-trace');
  const stack = stackNode === undefined ? '' : textContent(stackNode).trim();
  return {
    // The short `name` is what a CI annotation should show; `fullname` often
    // carries the namespace as well.
    name: testCase.attributes.name ?? testCase.attributes.fullname ?? 'unknown test',
    message: messageNode === undefined ? '' : textContent(messageNode).trim(),
    stack: stack === '' ? null : stack,
  };
}

function readCase(testCase: XmlElement): NUnitCase {
  return {
    name: testCase.attributes.name ?? testCase.attributes.fullname ?? 'unknown test',
    fullname: testCase.attributes.fullname ?? testCase.attributes.name ?? '',
    classname: testCase.attributes.classname ?? '',
    result: testCase.attributes.result ?? '',
    duration: testCase.attributes.duration ?? '',
    failure: readFailure(testCase),
  };
}

/** The roots NUnit 2 and NUnit 3 reports use. */
const REPORT_ROOTS = new Set(['test-run', 'test-results', 'test-suite']);

/**
 * Parses a whole report once, so `parseNUnit`, `parseNFailures` and the JUnit
 * converter agree on what the document says.
 */
export function parseNUnitReport(xml: string): NUnitReport {
  const root = parseXml(xml);
  // Well-formed XML is not necessarily a test report: an HTML error page or a
  // JSON blob left by a proxy must be a parse error (GC7), never a zero-count
  // pass. A real report with zero tests is still legitimate and parses below.
  if (!REPORT_ROOTS.has(root.name)) {
    throw new ReportParseError(
      `not an NUnit report: root element <${root.name}> is not test-run, test-results or test-suite`,
    );
  }
  const allCases = collectTestCases(root);
  const walked = walkCounts(allCases);

  // NUnit 3 (and Unity) put the aggregate counts on the root. Read them when
  // present and otherwise walk the <test-case> elements. NUnit 2 names some of
  // them differently (`failures`, `not-run`, `ignored`); it is tolerated, not
  // the shape this parser is written for.
  const total = countAttribute(root, 'total') ?? countAttribute(root, 'testcasecount') ?? walked.total;
  const failed = countAttribute(root, 'failed') ?? countAttribute(root, 'failures') ?? walked.failed;

  const skippedFromRoot =
    root.name === 'test-results'
      ? (countAttribute(root, 'not-run') ?? countAttribute(root, 'ignored'))
      : sumOptional(countAttribute(root, 'skipped'), countAttribute(root, 'inconclusive'));
  const skipped = skippedFromRoot ?? walked.skipped;

  const derivedPassed =
    total !== undefined && failed !== undefined && skipped !== undefined
      ? Math.max(0, total - failed - skipped)
      : undefined;
  const passed = countAttribute(root, 'passed') ?? derivedPassed ?? walked.passed;

  const counts: TestCounts = { total, passed, failed, skipped };

  // One suite per NUnit <test-suite>, each holding its direct test cases. The
  // converter emits one <testsuite> per entry; a parent assembly suite is an
  // empty container and the fixture suite below it carries the tests.
  const suites: NUnitSuite[] = [];
  const collectSuites = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === 'test-suite') {
        suites.push({
          name: child.attributes.name ?? child.attributes.fullname ?? 'tests',
          cases: child.children
            .filter((grandchild) => grandchild.name === 'test-case')
            .map(readCase),
        });
      }
      collectSuites(child);
    }
  };
  collectSuites(root);

  if (suites.length === 0 && allCases.length > 0) {
    // A report with <test-case> elements but no <test-suite> wrapper is not
    // the NUnit 3 shape, but it is readable: keep every case in one suite.
    suites.push({ name: root.attributes.name ?? 'tests', cases: allCases.map(readCase) });
  }

  const failures = allCases
    .map((testCase) => readFailure(testCase))
    .filter((failure): failure is TestFailure => failure !== null);

  return { counts, suites, failures };
}

function sumOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

export function parseNUnit(xml: string): TestCounts {
  return parseNUnitReport(xml).counts;
}

export function parseNFailures(xml: string): TestFailure[] {
  return parseNUnitReport(xml).failures;
}
