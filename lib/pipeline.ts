/**
 * Full test pipeline — orchestrates LLM calls for PM, Tester, Hacker phases.
 * This is the brain of the CLI. Every phase calls the LLM, no manual copy-paste.
 */

import { llm } from "./llm.js";
import { calibrate, type CalibrationResult } from "./calibrate.js";
import { formatScanContext } from "./reporter.js";
import type { ScanResult } from "./detect.js";

// ── Scope guidance ──

const SCOPE_GUIDANCE: Record<string, string> = {
  commit: "Scope: COMMIT — only test uncommitted changes and their direct callers. 2-4 tests per changed function.",
  branch: "Scope: BRANCH — test all changes since main. 5-8 tests per changed module.",
  changes: "Scope: CHANGES — test specific changed files. 3-5 tests per changed function.",
  full: "Scope: FULL — comprehensive tests across all categories: Functional, Boundary, Stability, Recovery, Integration, Resource.",
};

// ── Phase results ──

export interface PipelineResult {
  calibration: CalibrationResult | null;
  pmCriteria: string;
  systemPlan: string;
  userPlan: string;
  hackerPlan: string;
  mergedPlan: string;
  testFiles: Record<string, string>;
}

export interface PipelineCallbacks {
  onPhase: (phase: string) => void;
}

// ── PM Phase ──

async function runPM(scan: ScanResult, calibration: CalibrationResult | null, cb: PipelineCallbacks): Promise<string> {
  cb.onPhase("PM: generating acceptance criteria");

  const context = formatScanContext(scan);
  const scopeGuide = SCOPE_GUIDANCE[scan.scope] || SCOPE_GUIDANCE.full;
  const intentBlock = calibration
    ? `## Intent Calibration\n${calibration.expectedCapabilities}\n\nIntent gaps ([GAP] items) are T1 findings — the most critical.\n`
    : "";

  const prompt = `You are a senior Product Manager with deep UX research expertise.

${intentBlock}
${context}

${scopeGuide}

Analyze this codebase and define acceptance criteria across 4 tiers:

### Tier 1 — IMMEDIATE ABANDONMENT
Find anything that makes a user leave forever after ONE incident: data loss, silent costs, dead ends, trust betrayal, security exposure.

### Tier 2 — RAPID TRUST EROSION
Find anything that breaks trust within 1-3 incidents: implementation leakage, behavioral inconsistency, silent wrong answers.

### Tier 3 — CUMULATIVE FRUSTRATION
Apply quantitative thresholds: >1s without feedback = FAIL, >7 params = FAIL, non-actionable errors = FAIL.

### Tier 4 — BACKGROUND DISSATISFACTION
Unbounded resource growth, documentation rot, accessibility assumptions.

## Output format
For each finding:
[PM][Tier N] target_function — criterion name
- What to check: specific condition
- Threshold: concrete pass/fail
- Severity: FAIL or WARNING

Produce at least 3 criteria per tier (12+ total). Every criterion MUST have a concrete, testable threshold.`;

  return await llm(prompt, { system: "You are a senior PM specializing in developer tools UX.", maxTokens: 4096 });
}

// ── System Tester Phase ──

async function runSystemTester(scan: ScanResult, cb: PipelineCallbacks): Promise<string> {
  cb.onPhase("System Tester: generating correctness tests");

  const context = formatScanContext(scan);
  const scopeGuide = SCOPE_GUIDANCE[scan.scope] || SCOPE_GUIDANCE.full;

  const prompt = `You are a senior QA engineer focused on code correctness.
You see ONLY the source code and API surface. You do NOT see UX criteria.

${context}

${scopeGuide}

Generate a test plan that validates functional correctness:
- Does each function do what its signature/name promises?
- Are edge cases at documented boundaries handled?
- Are error paths handled gracefully?
- Do components integrate correctly?

## Format each test as:
[T-Sys][Category] target_function — description
- Input: concrete values
- Expected: concrete expected behavior
- Why: what contract this validates

Categories: Functional, Boundary, Stability, Recovery, Integration, Resource

## Rules
- Assert CORRECT behavior, not current behavior
- If invalid input is accepted silently, assert it SHOULD throw
- Never write a test that PASSES on dangerous behavior`;

  return await llm(prompt, { system: "You are a senior QA engineer.", maxTokens: 4096 });
}

// ── User Tester Phase ──

async function runUserTester(scan: ScanResult, pmCriteria: string, cb: PipelineCallbacks): Promise<string> {
  cb.onPhase("User Tester: translating PM criteria into runnable tests");

  const context = formatScanContext(scan);

  const prompt = `You are a UX test engineer. Translate PM acceptance criteria into runnable tests.
You do NOT test correctness — the System Tester handles that.
You ONLY test whether the code meets the PM's quantitative UX thresholds.

${context}

## PM Acceptance Criteria (write a test for EVERY criterion):
${pmCriteria}

## How to translate:
- PM says ">1s = FAIL" → test that times the operation and asserts elapsed < 1000ms
- PM says "error must not contain file path" → test that triggers error and checks message
- PM says "memory must not grow >10MB after 1000 calls" → test that measures heap delta

## Format:
[T-UX][Tier N] target_function — criterion name
- PM Criterion: reference the exact PM criterion
- Setup: how to create the test condition
- Measure: what to measure
- Threshold: exact pass/fail value
- Assert: the specific assertion

Every PM criterion tagged FAIL is MANDATORY.`;

  return await llm(prompt, { system: "You are a UX test engineer.", maxTokens: 4096 });
}

// ── Hacker Phase ──

async function runHacker(scan: ScanResult, pmCriteria: string, systemPlan: string, userPlan: string, cb: PipelineCallbacks): Promise<string> {
  cb.onPhase("Hacker: finding what everyone else missed");

  const context = formatScanContext(scan);

  const prompt = `You are a black-hat attacker. Your job: BREAK this system.

A PM defined acceptance criteria and two testers validated it. Find what ALL THREE missed.

${context}

## PM criteria (attack T1/T2 concerns harder):
${pmCriteria}

## System Tester plan (find what they didn't cover):
${systemPlan}

## User Tester plan (find gaps in their thresholds):
${userPlan}

## Your 6 attack skills — apply ALL of them:

### SKILL 1: DATA POISONING
Feed inputs of correct type but wrong semantics. NaN, Infinity, -0, empty arrays, unicode edge cases.

### SKILL 2: STATE CORRUPTION
Mutate returned references. Rapid interleaved read/write. Delete while iterating.

### SKILL 3: SILENT WRONG ANSWERS
Edge-case inputs that produce plausible but wrong results. This is the most dangerous category.

### SKILL 4: RESOURCE EXHAUSTION
10MB strings to regex functions. Deeply nested objects. Unbounded concurrency.

### SKILL 5: INJECTION & ESCALATION
Prompt injection payloads. Path traversal. Command injection. XSS.

### SKILL 6: TEMPORAL & ORDERING
Call before prerequisites. Use after destroy. Concurrent state corruption.

## Format:
[H][Skill N] target_function — attack name
- Attack vector: exact steps
- Payload: the actual malicious input
- Expected defense: what SHOULD happen
- Blast radius if undefended: what breaks

Produce at least 3 attacks per skill (18+ total). Prefer SILENT corruption over crashes.`;

  return await llm(prompt, { system: "You are a black-hat security researcher.", maxTokens: 6144 });
}

// ── Merge + Generate Test Files ──

async function mergeAndGenerate(
  scan: ScanResult,
  systemPlan: string,
  userPlan: string,
  hackerPlan: string,
  cb: PipelineCallbacks,
): Promise<{ mergedPlan: string; testFiles: Record<string, string> }> {
  cb.onPhase("Generating executable test files");

  const context = formatScanContext(scan);

  const prompt = `You have three test plans from independent perspectives. Merge them and generate EXECUTABLE test files.

${context}

## System Tester plan:
${systemPlan}

## User Tester plan:
${userPlan}

## Hacker plan:
${hackerPlan}

## Your task:
1. Merge all three plans. Remove duplicates. If Hacker version is nastier than Tester version, keep Hacker's.
2. Generate REAL, EXECUTABLE test files. Not pseudocode. Not plans. Actual runnable code.

## Rules for ${scan.language} test files:
${getTestFileRules(scan.language)}

## Output format:
For EACH test file, output exactly:
--- FILE: <filename> ---
<complete file content>
--- END FILE ---

Generate 4-8 test files covering all perspectives. Every test must be independently runnable.
Show merge stats at the top: "X from Tester, Y unique from Hacker, Z upgraded [T+H]"`;

  const response = await llm(prompt, { system: "You are a senior test engineer writing production test code.", maxTokens: 8192 });

  // Parse test files from response
  const testFiles: Record<string, string> = {};
  const fileRegex = /---\s*FILE:\s*(.+?)\s*---\n([\s\S]*?)---\s*END FILE\s*---/g;
  let match;
  while ((match = fileRegex.exec(response)) !== null) {
    const filename = match[1].trim();
    const content = match[2].trim();
    if (filename && content) {
      testFiles[filename] = content;
    }
  }

  return { mergedPlan: response, testFiles };
}

function getTestFileRules(language: string): string {
  switch (language) {
    case "typescript":
    case "javascript":
      return `- Use vitest: import { describe, it, expect } from "vitest"
- Import from the actual source using relative paths (e.g. "../lib/store.js")
- Each file should be self-contained
- Use .test.ts extension`;
    case "python":
      return `- Use pytest
- Import from the actual source package
- Each file should be self-contained
- Use test_ prefix for filenames and functions`;
    case "go":
      return `- Use testing package
- Each file should be self-contained
- Use _test.go suffix`;
    case "rust":
      return `- Use #[cfg(test)] mod tests
- Each file should be self-contained`;
    case "java":
      return `- Use JUnit 5
- Each file should be self-contained
- Use Test suffix for class names`;
    default:
      return `- Use the standard test framework for ${language}
- Each file should be self-contained`;
  }
}

// ── Full Pipeline ──

export async function runPipeline(
  scan: ScanResult,
  intent: string | undefined,
  cb: PipelineCallbacks,
): Promise<PipelineResult> {
  // 1. Calibrate (if intent provided)
  let calibration: CalibrationResult | null = null;
  if (intent) {
    cb.onPhase("Calibrating: analyzing project intent");
    calibration = await calibrate(intent, scan);
  }

  // 2. PM
  const pmCriteria = await runPM(scan, calibration, cb);

  // 3. Dual Tester (independent — could parallelize later)
  const systemPlan = await runSystemTester(scan, cb);
  const userPlan = await runUserTester(scan, pmCriteria, cb);

  // 4. Hacker (sees all three previous outputs)
  const hackerPlan = await runHacker(scan, pmCriteria, systemPlan, userPlan, cb);

  // 5. Merge + Generate test files
  const { mergedPlan, testFiles } = await mergeAndGenerate(scan, systemPlan, userPlan, hackerPlan, cb);

  return {
    calibration,
    pmCriteria,
    systemPlan,
    userPlan,
    hackerPlan,
    mergedPlan,
    testFiles,
  };
}
