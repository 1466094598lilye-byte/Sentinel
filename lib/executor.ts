/**
 * Test execution and result parsing.
 * Runs tests via the language's runner config, parses output deterministically.
 */

import { readFileSync, existsSync } from "fs";
import { join, relative } from "path";
import type { Workspace } from "./workspace.js";
import { checkEnv } from "./runners.js";
import type { Language } from "./detect.js";
import { execAsync, testSemaphore, syncSemaphores } from "./concurrency.js";
import { getConfig } from "./config.js";

export interface TestResult {
  totalTests: number;
  passed: number;
  failed: number;
  errors: number;
  exitCode: number;
  duration: number;
  failures: FailureDetail[];
  rawOutput: string;
}

export interface FailureDetail {
  testFile: string;
  testName: string;
  error: string;
  expected?: string;
  actual?: string;
  stackLine?: string;
}

/** Run tests using the runner config for this language (async, with concurrency control) */
export async function runTests(ws: Workspace): Promise<TestResult> {
  const start = Date.now();
  const env = checkEnv(ws.language, ws.dir);

  if (!env.ready) {
    return errorResult(start, `Missing tools: ${env.missing.join(", ")}`);
  }

  const testDirRel = relative(ws.dir, ws.testDir);
  const cmd = env.runner.testCmd.replace(/\{testDir\}/g, testDirRel);
  const buildTool = env.runner.depManager;
  const cacheEnv = resolveCacheEnv(env.runner.cacheEnv, ws.dir);

  syncSemaphores();
  const cfg = getConfig();
  const testTimeout = cfg?.testTimeout || 300_000;

  return testSemaphore.run(async () => {
    const result = await execAsync(`${cmd} 2>&1`, { cwd: ws.dir, timeout: testTimeout, env: cacheEnv });
    const duration = Date.now() - start;
    return parseOutput(ws.language, ws.dir, result.stdout, result.exitCode, duration, buildTool);
  });
}

/** Resolve cache env vars */
function resolveCacheEnv(cacheEnv: Record<string, string> | undefined, wsDir: string): Record<string, string | undefined> {
  if (!cacheEnv) return {};
  const resolved: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(cacheEnv)) {
    resolved[key] = val.replace(/\{wsDir\}/g, wsDir);
  }
  return resolved;
}

// ── Dispatch to language-specific parser ──

function parseOutput(
  language: Language,
  wsDir: string,
  rawOutput: string,
  exitCode: number,
  duration: number,
  buildTool?: string,
): TestResult {
  switch (language) {
    case "typescript":
    case "javascript":
      return parseVitest(wsDir, rawOutput, exitCode, duration);
    case "python":
      return parsePytest(rawOutput, exitCode, duration);
    case "go":
      return parseGoTest(rawOutput, exitCode, duration);
    case "rust":
      return parseCargoTest(rawOutput, exitCode, duration);
    case "java":
      return buildTool === "gradle"
        ? parseGradle(rawOutput, exitCode, duration)
        : parseMaven(rawOutput, exitCode, duration);
    case "csharp":
      return parseDotnet(rawOutput, exitCode, duration);
    case "swift":
      return parseSwiftTest(rawOutput, exitCode, duration);
    case "ruby":
      return parseRspec(wsDir, rawOutput, exitCode, duration);
    default:
      return { totalTests: 0, passed: 0, failed: 0, errors: 0, exitCode, duration, failures: [], rawOutput };
  }
}

// ── Vitest (TypeScript / JavaScript) ──

function parseVitest(wsDir: string, rawOutput: string, exitCode: number, duration: number): TestResult {
  const jsonPath = join(wsDir, "vitest-results.json");
  if (existsSync(jsonPath)) {
    try {
      const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
      return parseVitestJson(json, exitCode, duration, rawOutput);
    } catch {
      // fall through to verbose parsing
    }
  }
  return parseVitestVerbose(rawOutput, exitCode, duration);
}

function parseVitestJson(json: any, exitCode: number, duration: number, rawOutput: string): TestResult {
  const failures: FailureDetail[] = [];
  let totalTests = 0;
  let passed = 0;
  let failed = 0;

  if (json.testResults) {
    for (const file of json.testResults) {
      for (const test of file.assertionResults || []) {
        totalTests++;
        if (test.status === "passed") {
          passed++;
        } else if (test.status === "failed") {
          failed++;
          failures.push({
            testFile: file.name || "",
            testName: (test.ancestorTitles || []).concat(test.title || "").join(" > "),
            error: (test.failureMessages || []).join("\n").slice(0, 500),
            stackLine: extractStack((test.failureMessages || []).join("\n")),
          });
        }
      }
    }
  }

  return { totalTests, passed, failed, errors: 0, exitCode, duration, failures, rawOutput };
}

function parseVitestVerbose(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  for (const line of output.split("\n")) {
    if (line.includes("✓") || line.includes("√")) passed++;
    if (line.includes("×") || line.includes("✗")) failed++;
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── Pytest (Python) ──

function parsePytest(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // Summary line takes priority: "X passed, Y failed"
  const passMatch = output.match(/(\d+)\s+passed/);
  const failMatch = output.match(/(\d+)\s+failed/);
  if (passMatch) passed = parseInt(passMatch[1]);
  if (failMatch) failed = parseInt(failMatch[1]);

  // Parse FAILURES section for details
  const failSections = output.split(/_{3,} FAILURES _{3,}/);
  if (failSections.length > 1) {
    const blocks = failSections[1].split(/_{3,}\s+/);
    for (const block of blocks) {
      if (!block.trim()) continue;
      const nameMatch = block.match(/^(\S+)/);
      failures.push({
        testFile: "",
        testName: nameMatch?.[1] || "",
        error: block.slice(0, 500),
        stackLine: extractStack(block),
      });
    }
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── Go test ──

function parseGoTest(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // go test -json outputs one JSON object per line
  for (const line of output.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.Action === "pass" && ev.Test) passed++;
      if (ev.Action === "fail" && ev.Test) {
        failed++;
        failures.push({
          testFile: ev.Package || "",
          testName: ev.Test,
          error: ev.Output || "",
        });
      }
    } catch {
      // not json, skip
    }
  }

  // Fallback: if no json lines parsed, try verbose text
  if (passed === 0 && failed === 0) {
    for (const line of output.split("\n")) {
      if (line.match(/^---\s+PASS:/)) passed++;
      if (line.match(/^---\s+FAIL:/)) {
        failed++;
        const m = line.match(/^---\s+FAIL:\s+(\S+)/);
        failures.push({ testFile: "", testName: m?.[1] || "", error: line });
      }
    }
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── Cargo test (Rust) ──

function parseCargoTest(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // Summary: "test result: ok. X passed; Y failed; Z ignored"
  const summary = output.match(/test result:.*?(\d+)\s+passed.*?(\d+)\s+failed/);
  if (summary) {
    passed = parseInt(summary[1]);
    failed = parseInt(summary[2]);
  }

  // Individual failures: "test module::test_name ... FAILED"
  const failRe = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    failures.push({ testFile: "", testName: m[1], error: "" });
  }

  // Try to attach error messages from failures section
  const failSection = output.split("failures:")[1];
  if (failSection) {
    for (const f of failures) {
      const block = failSection.split(`---- ${f.testName} `)[1];
      if (block) {
        f.error = block.split("----")[0]?.trim().slice(0, 500) || "";
      }
    }
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── Maven test (Java) ──

function parseMaven(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;
  let total = 0;

  // "Tests run: 10, Failures: 2, Errors: 1, Skipped: 0"
  const summary = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/);
  if (summary) {
    total = parseInt(summary[1]);
    failed = parseInt(summary[2]) + parseInt(summary[3]);
    passed = total - failed;
  }

  // Individual failures from surefire
  const failRe = /^\s*(\w+)\(([^)]+)\)\s+Time elapsed:.*?<<<\s*(FAILURE|ERROR)!/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    failures.push({ testFile: m[2], testName: m[1], error: m[3] });
  }

  return { totalTests: total, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── Gradle test (Java) ──

function parseGradle(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // "X tests completed, Y failed" or "X tests completed"
  const summary = output.match(/(\d+)\s+tests?\s+completed(?:,\s+(\d+)\s+failed)?/);
  if (summary) {
    const total = parseInt(summary[1]);
    failed = summary[2] ? parseInt(summary[2]) : 0;
    passed = total - failed;
  }

  // "> ClassName > testMethod FAILED"
  const failRe = />\s+(.+?)\s+>\s+(.+?)\s+FAILED/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    failures.push({ testFile: m[1].trim(), testName: m[2].trim(), error: "" });
  }

  // Attach assertion errors that follow each FAILED line
  for (const f of failures) {
    const needle = `${f.testFile} > ${f.testName} FAILED`;
    const idx = output.indexOf(needle);
    if (idx !== -1) {
      const after = output.slice(idx + needle.length, idx + needle.length + 500);
      const errorLine = after.split("\n").find((l) => l.trim().length > 0);
      if (errorLine) f.error = errorLine.trim();
    }
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── dotnet test (C#) ──

function parseDotnet(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // "Passed: 5, Failed: 2, Skipped: 0, Total: 7"
  const summary = output.match(/Passed:\s*(\d+).*?Failed:\s*(\d+).*?Total:\s*(\d+)/s);
  if (summary) {
    passed = parseInt(summary[1]);
    failed = parseInt(summary[2]);
  }

  // "Failed TestName [< 1ms]"
  const failRe = /^\s*Failed\s+(\S+)/gm;
  let m: RegExpExecArray | null;
  while ((m = failRe.exec(output)) !== null) {
    failures.push({ testFile: "", testName: m[1], error: "" });
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── swift test ──

function parseSwiftTest(output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // "Test Case 'ClassName.testMethod' passed (0.001 seconds)"
  for (const line of output.split("\n")) {
    if (line.includes("' passed")) passed++;
    if (line.includes("' failed")) {
      failed++;
      const m = line.match(/Test Case '([^']+)'/);
      failures.push({ testFile: "", testName: m?.[1] || "", error: line });
    }
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── RSpec (Ruby) ──

function parseRspec(wsDir: string, output: string, exitCode: number, duration: number): TestResult {
  const failures: FailureDetail[] = [];
  let passed = 0;
  let failed = 0;

  // Try JSON output first
  const jsonPath = join(wsDir, "rspec-results.json");
  if (existsSync(jsonPath)) {
    try {
      const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
      const summary = json.summary || {};
      passed = summary.example_count - (summary.failure_count || 0);
      failed = summary.failure_count || 0;

      for (const ex of json.examples || []) {
        if (ex.status === "failed") {
          failures.push({
            testFile: ex.file_path || "",
            testName: ex.full_description || "",
            error: ex.exception?.message?.slice(0, 500) || "",
          });
        }
      }

      return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
    } catch {
      // fall through
    }
  }

  // Fallback: "X examples, Y failures"
  const summary = output.match(/(\d+)\s+examples?,\s+(\d+)\s+failures?/);
  if (summary) {
    const total = parseInt(summary[1]);
    failed = parseInt(summary[2]);
    passed = total - failed;
  }

  return { totalTests: passed + failed, passed, failed, errors: 0, exitCode, duration, failures, rawOutput: output };
}

// ── Helpers ──

function extractStack(text: string): string | undefined {
  // Vitest style
  const vitest = text.match(/❯\s+(.+:\d+)/);
  if (vitest) return vitest[1];
  // Python style
  const py = text.match(/File "(.+?)", line (\d+)/);
  if (py) return `${py[1]}:${py[2]}`;
  // Go style
  const go = text.match(/(\S+\.go:\d+)/);
  if (go) return go[1];
  // Rust style
  const rs = text.match(/(\S+\.rs:\d+)/);
  if (rs) return rs[1];
  // Generic file:line
  const generic = text.match(/(\S+\.\w+):(\d+)/);
  if (generic) return `${generic[1]}:${generic[2]}`;
  return undefined;
}

function errorResult(start: number, message: string): TestResult {
  return {
    totalTests: 0,
    passed: 0,
    failed: 0,
    errors: 1,
    exitCode: 1,
    duration: Date.now() - start,
    failures: [{ testFile: "", testName: "", error: message }],
    rawOutput: "",
  };
}
