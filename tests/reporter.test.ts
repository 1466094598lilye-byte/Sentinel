import test from "node:test";
import assert from "node:assert/strict";
import { formatFailureContext, formatTierReportInput } from "../lib/reporter.ts";
import type { TestResult } from "../lib/executor.ts";

test("formatFailureContext only exposes raw failure evidence fields", () => {
  const result: TestResult = {
    totalTests: 2,
    passed: 1,
    failed: 1,
    errors: 0,
    exitCode: 1,
    duration: 1234,
    rawOutput: "raw",
    failures: [
      {
        testFile: "__sentinel__/auth.test.ts",
        testName: "__compile__",
        failureType: "compile",
        error: "TS2304: Cannot find name 'foo'",
      },
    ],
  };

  const text = formatFailureContext(result);
  assert.match(text, /test_name: __compile__/);
  assert.match(text, /failure_type: compile/);
  assert.match(text, /error_message:/);
  assert.doesNotMatch(text, /source code/i);
});

test("formatTierReportInput produces a T-tier-only report contract", () => {
  const text = formatTierReportInput({
    totalTests: 5,
    passed: 3,
    failed: 2,
    durationSeconds: 4.2,
    failures: [
      {
        testName: "should reject invalid token",
        failureType: "test",
        errorMessage: "AssertionError: expected 401 but got 200",
        testFile: "__sentinel__/auth.test.ts",
      },
      {
        testName: "__setup__",
        failureType: "setup",
        errorMessage: "Missing tools: poetry",
      },
    ],
  });

  assert.match(text, /T1 — Immediate abandonment/);
  assert.match(text, /T4 — Background dissatisfaction/);
  assert.match(text, /test_name: should reject invalid token/);
  assert.match(text, /failure_type: setup/);
  assert.match(text, /"tier": "T1\|T2\|T3\|T4"/);
  assert.doesNotMatch(text, /RED|YLW|GRN/);
});
