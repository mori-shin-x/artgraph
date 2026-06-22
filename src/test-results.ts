import { readFileSync, existsSync } from "node:fs";
import { globSync } from "glob";
import type { TestResultRecord, TestResultMap } from "./types.js";

/**
 * Extract REQ tags (e.g. [REQ-001] or [namespace/REQ-001]) from text.
 * Returns a deduplicated array of tag identifiers.
 */
export function extractReqTags(text: string): string[] {
  const regex = /\[(?:([^\]/]+)\/)?([A-Z]+-\d+)\]/g;
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
      let reqTags = extractReqTags(assertion.title);

      if (reqTags.length === 0) {
        for (const ancestor of assertion.ancestorTitles) {
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
          testName: assertion.title,
          passed,
        });
      }
    }
  }

  return records;
}

/**
 * Parse JUnit XML output into TestResultRecords using regex.
 */
export function parseJUnitXml(content: string): TestResultRecord[] {
  const records: TestResultRecord[] = [];

  const suiteRegex =
    /<testsuite\s[^>]*name="([^"]*)"[^>]*>([\s\S]*?)<\/testsuite>/g;
  let suiteMatch: RegExpExecArray | null;

  while ((suiteMatch = suiteRegex.exec(content)) !== null) {
    const suiteName = suiteMatch[1]!;
    const suiteBody = suiteMatch[2]!;
    const suiteReqTags = extractReqTags(suiteName);

    // Match both self-closing and non-self-closing testcase elements
    const testcaseRegex =
      /<testcase\s[^>]*?\bname="([^"]*)"[^>]*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let tcMatch: RegExpExecArray | null;

    while ((tcMatch = testcaseRegex.exec(suiteBody)) !== null) {
      const testName = tcMatch[1]!;
      const testBody = tcMatch[2] ?? "";

      const hasFailed =
        /<failure/.test(testBody) || /<error/.test(testBody);
      const hasSkipped = /<skipped/.test(testBody);
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
    const resolvedPaths = globSync(pattern, { cwd: rootDir, absolute: true });

    for (const filePath of resolvedPaths) {
      if (!existsSync(filePath)) continue;

      try {
        const content = readFileSync(filePath, "utf-8");
        const records = parseTestResults(content);
        if (records.length === 0) {
          console.error(`spectrace: warning: no test results found in ${filePath}`);
        }
        allRecords.push(...records);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`spectrace: warning: failed to read ${filePath}: ${msg}`);
      }
    }
  }

  return buildTestResultMap(allRecords);
}
