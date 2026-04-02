/**
 * Format test results into structured reports.
 * Deterministic summaries only. Final T-tier judgment should be done
 * one failure at a time by the host model using raw failure evidence.
 */

import type { TestResult, FailureDetail, FailureType } from "./executor.js";
import type { ScanResult } from "./detect.js";

export interface Report {
  summary: string;
  details: string;
  passRate: number;
  overall: "PASS" | "FAIL";
}

export interface FailureEvidenceInput {
  testName: string;
  failureType: FailureType | string;
  errorMessage: string;
  testFile?: string;
}

export interface TierReportInput {
  failures: FailureEvidenceInput[];
  totalTests?: number;
  passed?: number;
  failed?: number;
  durationSeconds?: number;
}

/** Generate a structured markdown report with raw failure evidence only. */
export function formatReport(scan: ScanResult, result: TestResult): Report {
  const overall = result.exitCode === 0 && result.failed === 0 ? "PASS" : "FAIL";
  const passRate = result.totalTests > 0 ? result.passed / result.totalTests : 0;

  const summary = [
    `## Sentinel Report: ${scan.language} project`,
    `Context: full repository scan`,
    `Validation tree: current checkout`,
    scan.changedFiles.length > 0 ? `Changed files: ${scan.changedFiles.join(", ")}` : `Changed files: all`,
    "",
    `### Summary`,
    `Total: ${result.totalTests} tests | Passed: ${result.passed} | Failed: ${result.failed} | Duration: ${(result.duration / 1000).toFixed(1)}s`,
    `**Overall: ${overall}**`,
  ].join("\n");

  let details = "";

  if (result.failures.length > 0) {
    details += "\n### Failures\n\n";
    for (const failure of result.failures) {
      details += formatFailureRecord(failure);
    }
  }

  if (result.totalTests === 0) {
    details += "\n### Warning\nNo tests were executed. Check for compilation errors.\n";
  }

  return { summary, details, passRate, overall };
}

function formatFailureRecord(f: FailureDetail): string {
  const lines = [`#### ${f.testFile || "(global)"} > ${f.testName}`];
  lines.push(`- **Failure Type:** ${f.failureType}`);
  if (f.error) lines.push(`- **Error:** ${truncate(f.error, 300)}`);
  if (f.expected) lines.push(`- **Expected:** ${f.expected}`);
  if (f.actual) lines.push(`- **Actual:** ${f.actual}`);
  if (f.stackLine) lines.push(`- **Location:** ${f.stackLine}`);
  lines.push("");
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

/** Format scan result as context for the agent to generate test plans */
/** Format scan context for LLM prompts — includes full source code. */
export function formatScanContext(scan: ScanResult): string {
  const lines: string[] = [];

  lines.push(`# Test Context`);
  lines.push(`Language: ${scan.language}`);
  lines.push(`Context: full repository scan`);
  lines.push(`Validation tree: current checkout`);
  lines.push("");

  if (scan.changedFiles.length > 0) {
    lines.push(`## Changed Files`);
    for (const f of scan.changedFiles) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (scan.apiSurface.length > 0) {
    lines.push(`## API Surface (exported functions/classes)`);
    for (const entry of scan.apiSurface) {
      const asyncTag = entry.async ? "async " : "";
      lines.push(`- \`${entry.file}\`: ${asyncTag}${entry.kind} **${entry.name}**${entry.signature ? ` ${entry.signature}` : ""}`);
    }
    lines.push("");
  }

  if (scan.existingTests.length > 0) {
    lines.push(`## Existing Test Files (do not duplicate)`);
    for (const f of scan.existingTests) {
      lines.push(`- ${f}`);
    }
    lines.push("");
  }

  if (scan.gitDiff) {
    lines.push(`## Git Diff`);
    lines.push("```diff");
    // Truncate diff if too large
    const maxDiff = 5000;
    if (scan.gitDiff.length > maxDiff) {
      lines.push(scan.gitDiff.slice(0, maxDiff));
      lines.push(`\n... (diff truncated, ${scan.gitDiff.length - maxDiff} chars omitted)`);
    } else {
      lines.push(scan.gitDiff);
    }
    lines.push("```");
    lines.push("");
  }

  // Skill definitions — SKILL.md files contain core logic for skill-driven projects
  const skillEntries = Object.entries(scan.skillContents || {});
  if (skillEntries.length > 0) {
    lines.push(`## Skill Definitions (SKILL.md)`);
    for (const [file, content] of skillEntries) {
      lines.push(`### ${file}`);
      lines.push("```markdown");
      lines.push(content);
      lines.push("```");
      lines.push("");
    }
  }

  // Source code — LLM needs to see actual code to write correct tests
  const sourceEntries = Object.entries(scan.sourceContents || {});
  if (sourceEntries.length > 0) {
    lines.push(`## Source Code`);
    for (const [file, content] of sourceEntries) {
      lines.push(`### ${file}`);
      lines.push("```");
      lines.push(content);
      lines.push("```");
      lines.push("");
    }
  }

  const depEntries = Object.entries(scan.dependencies);
  if (depEntries.length > 0) {
    lines.push(`## Dependencies`);
    for (const [name, version] of depEntries) {
      lines.push(`- ${name}: ${version}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** Format failure results as context for the agent to analyze and fix */
export function formatFailureContext(result: TestResult): string {
  if (result.failures.length === 0) return "";

  const lines: string[] = [];
  lines.push(`The following failure items are raw runner evidence.`);
  lines.push(`Classify each item independently into a final T-tier using ONLY test_name, failure_type, and error_message.`);
  lines.push("");

  for (const [index, f] of result.failures.entries()) {
    lines.push(`### Failure ${index + 1}`);
    lines.push(`test_name: ${f.testName}`);
    lines.push(`failure_type: ${f.failureType}`);
    lines.push(`error_message: ${JSON.stringify(truncate(f.error || "", 500))}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatTierReportInput(input: TierReportInput): string {
  const lines: string[] = [];
  lines.push(`# Sentinel Final Report`);
  lines.push(`Use ONLY the failure items below.`);
  lines.push(`Do NOT use source code, prior assumptions, or architectural guesses.`);
  lines.push(`Assign each failure a final T-tier based on actual user impact implied by the failure evidence.`);
  lines.push("");

  if (typeof input.totalTests === "number" || typeof input.passed === "number" || typeof input.failed === "number") {
    const total = typeof input.totalTests === "number" ? input.totalTests : input.failures.length;
    const passed = typeof input.passed === "number" ? input.passed : Math.max(0, total - (input.failed || 0));
    const failed = typeof input.failed === "number" ? input.failed : input.failures.length;
    const duration = typeof input.durationSeconds === "number" ? `${input.durationSeconds.toFixed(1)}s` : "unknown";
    lines.push(`## Run Summary`);
    lines.push(`- Total tests: ${total}`);
    lines.push(`- Passed: ${passed}`);
    lines.push(`- Failed: ${failed}`);
    lines.push(`- Duration: ${duration}`);
    lines.push("");
  }

  lines.push(`## T-Tier Definitions`);
  lines.push(`- T1 — Immediate abandonment: one incident can make a user leave or stop trusting the product immediately.`);
  lines.push(`- T2 — Rapid trust erosion: not instant abandonment, but trust breaks within a few incidents.`);
  lines.push(`- T3 — Cumulative frustration: clearly bad and user-visible, but still usually tolerable in the short term.`);
  lines.push(`- T4 — Background dissatisfaction: low-severity, edge-case, or likely test/harness issue with limited real user impact.`);
  lines.push("");

  lines.push(`## Failure Evidence`);
  input.failures.forEach((failure, index) => {
    lines.push(`### Failure ${index + 1}`);
    lines.push(`test_name: ${failure.testName}`);
    lines.push(`failure_type: ${failure.failureType}`);
    if (failure.testFile) lines.push(`test_file: ${failure.testFile}`);
    lines.push(`error_message: ${JSON.stringify(truncate(failure.errorMessage || "", 500))}`);
    lines.push("");
  });

  lines.push(`## Output Format`);
  lines.push(`Return one item per failure in this exact shape:`);
  lines.push("```json");
  lines.push("[");
  lines.push('  { "test_name": "string", "tier": "T1|T2|T3|T4", "why_user_cares": "one sentence" }');
  lines.push("]");
  lines.push("```");
  lines.push("");
  lines.push(`Rules:`);
  lines.push(`- Judge the observed failure, not the importance of the component in the abstract.`);
  lines.push(`- If the evidence suggests a likely test harness/setup artifact with limited user impact, prefer T4.`);
  lines.push(`- Do not invent details not present in the failure evidence.`);

  return lines.join("\n");
}
