import { readFileSync, existsSync } from "node:fs";
import { globSync } from "glob";
import type { TestResultRecord, TestResultMap } from "./types.js";
import { REQ_ID_TOKEN } from "./req-id.js";

function warn(message: string): void {
  console.error(`spectrace: warning: ${message}`);
}

/**
 * Extract REQ tags (e.g. [REQ-001] or [namespace/REQ-001]) from text.
 * Returns a deduplicated array of tag identifiers.
 *
 * The ID shape is shared with the code parsers via REQ_ID_TOKEN so that
 * mixed-case IDs such as `[Requirement-001]` or `[Auth-1]` are recognized
 * here exactly as they are in source code (previously `[A-Z]+-\d+` silently
 * dropped them, downgrading passing requirements to impl-only).
 */
export function extractReqTags(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];

  const regex = new RegExp(`\\[(?:([^\\]/]+)\\/)?(${REQ_ID_TOKEN})\\]`, "g");
  const tags: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const namespace = match[1];
    const tag = match[2]!;
    const full = namespace ? `${namespace}/${tag}` : tag;
    if (!tags.includes(full)) {
      tags.push(full);
    }
  }

  return tags;
}

/**
 * Parse Vitest JSON reporter output into TestResultRecords.
 */
export function parseVitestJson(content: string): TestResultRecord[] {
  let data: {
    testResults: {
      name: string;
      assertionResults: {
        ancestorTitles: string[];
        title: string;
        status: string;
      }[];
    }[];
  };

  try {
    data = JSON.parse(content);
  } catch {
    return [];
  }

  const records: TestResultRecord[] = [];

  for (const testResult of data.testResults ?? []) {
    for (const assertion of testResult.assertionResults ?? []) {
      const title = assertion.title ?? "";
      let reqTags = extractReqTags(title);

      if (reqTags.length === 0) {
        // `ancestorTitles` is optional in some reporters — guard against a
        // missing array so a single malformed entry can't crash the parse.
        for (const ancestor of assertion.ancestorTitles ?? []) {
          const ancestorTags = extractReqTags(ancestor);
          reqTags.push(...ancestorTags);
        }
        // Deduplicate after collecting from ancestors
        reqTags = [...new Set(reqTags)];
      }

      const passed = assertion.status === "passed";

      for (const reqId of reqTags) {
        records.push({
          reqId,
          testName: title,
          passed,
        });
      }
    }
  }

  return records;
}

/**
 * Read an attribute value from a tag's attribute string, independent of
 * attribute order and quote style. Returns undefined if the attribute is
 * absent so callers can fall back gracefully (e.g. a testcase with no `name`
 * inherits its REQ tags from the enclosing testsuite instead of being lost).
 */
function getAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[2] ?? m[3] ?? "";
}

/**
 * Parse JUnit XML output into TestResultRecords using regex.
 *
 * This is a deliberately tolerant, dependency-free parser. It handles missing
 * `name` attributes, arbitrary attribute order/quote style, self-closing and
 * block testcases, and `<failure>`/`<error>`/`<skipped>` children. It does NOT
 * attempt to be a full XML parser: deeply nested testsuites and `<failure>`-like
 * text inside CDATA/comments are out of scope.
 */
export function parseJUnitXml(content: string): TestResultRecord[] {
  const records: TestResultRecord[] = [];

  // Capture the opening-tag attributes (group 1) and body (group 2) so the
  // `name` attribute is optional rather than required by the pattern itself.
  const suiteRegex = /<testsuite\b([^>]*)>([\s\S]*?)<\/testsuite>/g;
  let suiteMatch: RegExpExecArray | null;

  while ((suiteMatch = suiteRegex.exec(content)) !== null) {
    const suiteName = getAttr(suiteMatch[1]!, "name") ?? "";
    const suiteBody = suiteMatch[2]!;
    const suiteReqTags = extractReqTags(suiteName);

    // Match both self-closing and block testcase elements; `name` optional.
    const testcaseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let tcMatch: RegExpExecArray | null;

    while ((tcMatch = testcaseRegex.exec(suiteBody)) !== null) {
      const testName = getAttr(tcMatch[1]!, "name") ?? "";
      const testBody = tcMatch[2] ?? "";

      const hasFailed = /<failure[\s/>]/.test(testBody) || /<error[\s/>]/.test(testBody);
      const hasSkipped = /<skipped[\s/>]/.test(testBody);
      const passed = !hasFailed && !hasSkipped;

      let reqTags = extractReqTags(testName);
      if (reqTags.length === 0) {
        reqTags = suiteReqTags;
      }

      for (const reqId of reqTags) {
        records.push({
          reqId,
          testName,
          passed,
        });
      }
    }
  }

  return records;
}

/**
 * Auto-detect test result format and parse accordingly.
 */
export function parseTestResults(content: string): TestResultRecord[] {
  const trimmed = content.trimStart();
  const first = trimmed[0];

  if (first === "{" || first === "[") {
    return parseVitestJson(content);
  }

  if (first === "<") {
    return parseJUnitXml(content);
  }

  return [];
}

/**
 * Group TestResultRecords by reqId into a Map.
 */
export function buildTestResultMap(
  records: TestResultRecord[],
): TestResultMap {
  const map: TestResultMap = new Map();

  for (const record of records) {
    const existing = map.get(record.reqId);
    if (existing) {
      existing.push(record);
    } else {
      map.set(record.reqId, [record]);
    }
  }

  return map;
}

/**
 * Load test result files from glob patterns and return a merged TestResultMap.
 */
export function loadTestResults(paths: string[], rootDir: string): TestResultMap {
  const allRecords: TestResultRecord[] = [];

  for (const pattern of paths) {
    let resolvedPaths: string[];
    try {
      resolvedPaths = globSync(pattern, { cwd: rootDir, absolute: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`invalid test-results pattern "${pattern}": ${msg}`);
      continue;
    }

    // A typo'd path or a glob that matches nothing used to be silently ignored,
    // which then quietly downgraded requirements to impl-only. Surface it.
    if (resolvedPaths.length === 0) {
      warn(`no files matched test-results pattern "${pattern}"`);
      continue;
    }

    for (const filePath of resolvedPaths) {
      if (!existsSync(filePath)) continue;

      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warn(`failed to read ${filePath}: ${msg}`);
        continue;
      }

      // Distinguish a *malformed* file from a valid-but-empty one. Without this,
      // corrupt JSON and "tests genuinely produced no REQ-tagged results" both
      // collapse to silence and then to impl-only, which is indistinguishable
      // from a real test failure.
      const trimmed = content.trimStart();
      if (trimmed[0] === "{" || trimmed[0] === "[") {
        try {
          JSON.parse(trimmed);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          warn(`failed to parse JSON in ${filePath}: ${msg}`);
          continue;
        }
      }

      const records = parseTestResults(content);
      if (records.length === 0) {
        warn(`no test results found in ${filePath}`);
      }
      allRecords.push(...records);
    }
  }

  return buildTestResultMap(allRecords);
}
