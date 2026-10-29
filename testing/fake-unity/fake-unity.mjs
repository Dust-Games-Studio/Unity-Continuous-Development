#!/usr/bin/env node
/**
 * A deterministic stand-in for Unity's `unity` CLI.
 *
 * It reads the JSON scenario named by `FAKE_UNITY_SCENARIO`, picks the first
 * entry whose `args` array is a prefix of its own argv, optionally writes
 * files relative to the current working directory, prints the entry's `json`
 * as stdout and exits with its `code`. An unmatched invocation exits 2 and
 * names the argv, so a test can assert exactly what the core produced.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const scenarioPath = process.env.FAKE_UNITY_SCENARIO;

function fail(message) {
  process.stderr.write(`fake-unity: ${message}\n`);
  process.exitCode = 2;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPrefix(prefix, invocation) {
  if (!Array.isArray(prefix)) return false;
  if (prefix.length > invocation.length) return false;
  return prefix.every((value, index) => value === invocation[index]);
}

function entryLabel(label, result) {
  return Array.isArray(result.args)
    ? `${label} (args ${JSON.stringify(result.args)})`
    : label;
}

function apply(result, label) {
  if (!isObject(result)) {
    fail(`${label} is not an object`);
    return;
  }

  // A scenario that says "8" must never become a silent success. The code is
  // required and must be an integer; a typo or a missing value is a broken
  // scenario, not an implicit 0.
  if (!Object.hasOwn(result, 'code')) {
    fail(
      `scenario entry ${entryLabel(label, result)} has no "code"; refusing to assume success`,
    );
    return;
  }
  if (typeof result.code !== 'number' || !Number.isInteger(result.code)) {
    fail(
      `scenario entry ${entryLabel(label, result)} has a non-integer "code" (${JSON.stringify(result.code)}); refusing to report success`,
    );
    return;
  }

  const files = result.files;
  if (files !== undefined) {
    if (!isObject(files)) {
      fail('the scenario "files" value must be an object of path -> content');
      return;
    }
    for (const [relative, content] of Object.entries(files)) {
      const path = resolve(process.cwd(), relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(content), 'utf8');
    }
  }

  if (result.json !== undefined) {
    process.stdout.write(`${JSON.stringify(result.json)}\n`);
  }

  process.exitCode = result.code;
}

if (scenarioPath === undefined || scenarioPath === '') {
  fail('FAKE_UNITY_SCENARIO is not set');
} else {
  let scenario;
  let readable = true;
  try {
    // A UTF-8 BOM is common in files written by Windows editors; JSON.parse
    // rejects it, so strip it before parsing.
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    readable = false;
    fail(
      `cannot read scenario ${scenarioPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (readable) {
    if (!isObject(scenario)) {
      fail(`scenario ${scenarioPath} must contain a JSON object`);
    } else if (scenario.results !== undefined && !Array.isArray(scenario.results)) {
      fail(`scenario ${scenarioPath} has a non-array "results"`);
    } else {
      const results = Array.isArray(scenario.results) ? scenario.results : [];
      const matched = results.findIndex(
        (entry) => isObject(entry) && isPrefix(entry.args, argv),
      );

      if (matched !== -1) {
        apply(results[matched], `results[${matched}]`);
      } else if (scenario.default !== undefined) {
        apply(scenario.default, 'default');
      } else {
        fail(`no scenario entry matches: ${JSON.stringify(argv)}`);
      }
    }
  }
}
