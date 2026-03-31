/**
 * Format test results into structured reports.
 * Deterministic — no LLM needed.
 */

import type { TestResult, FailureDetail } from "./executor.js";
import type { ScanResult } from "./detect.js";

export interface Report {
  summary: string;
  details: string;
  passRate: number;
  overall: "PASS" | "FAIL";
}

// ── Triage: classify failures by severity ──

type TrafficLight = "red" | "yellow" | "green";

interface TriagedFailure {
  light: TrafficLight;
  failure: FailureDetail;
  reason: string;
}

const RED_PATTERNS = [
  /\bTier\s*1\b/i, /\bT1\b/, /\bUX-T1\b/,
  /\bTier\s*2\b/i, /\bT2\b/, /\bUX-T2\b/,
  /\bSkill\s*3\b/i, /\bSilent Wrong/i,    // silent wrong answers
  /\bSkill\s*5\b/i, /\bInjection/i,        // injection & escalation
  /\bdata\s*loss/i, /\bsecurity/i, /\bcorrupt/i,
  /\bCR-[12]\b/,                            // research: critical category risks
];

const YELLOW_PATTERNS = [
  /\bTier\s*3\b/i, /\bT3\b/, /\bUX-T3\b/,
  /\bSkill\s*2\b/i, /\bState Corruption/i,
  /\bSkill\s*4\b/i, /\bResource Exhaustion/i,
  /\bSkill\s*6\b/i, /\bTemporal/i,
  /\bCR-[3-5]\b/,                           // research: medium category risks
];

function triageFailure(f: FailureDetail): TriagedFailure {
  const text = `${f.testFile} ${f.testName} ${f.error || ""}`;

  for (const pat of RED_PATTERNS) {
    if (pat.test(text)) {
      return { light: "red", failure: f, reason: "T1/T2 or critical attack vector" };
    }
  }
  for (const pat of YELLOW_PATTERNS) {
    if (pat.test(text)) {
      return { light: "yellow", failure: f, reason: "T3 or state/resource issue" };
    }
  }
  return { light: "green", failure: f, reason: "T4 or low-priority" };
}

function lightEmoji(light: TrafficLight): string {
  switch (light) {
    case "red": return "[RED]";
    case "yellow": return "[YLW]";
    case "green": return "[GRN]";
  }
}

/** Generate a structured markdown report with triage */
export function formatReport(scan: ScanResult, result: TestResult): Report {
  const overall = result.exitCode === 0 && result.failed === 0 ? "PASS" : "FAIL";
  const passRate = result.totalTests > 0 ? result.passed / result.totalTests : 0;

  const summary = [
    `## Sentinel Report: ${scan.language} project`,
    `Scope: ${scan.scope}`,
    scan.changedFiles.length > 0 ? `Changed files: ${scan.changedFiles.join(", ")}` : `Changed files: all`,
    "",
    `### Summary`,
    `Total: ${result.totalTests} tests | Passed: ${result.passed} | Failed: ${result.failed} | Duration: ${(result.duration / 1000).toFixed(1)}s`,
    `**Overall: ${overall}**`,
  ].join("\n");

  let details = "";

  if (result.failures.length > 0) {
    // Triage all failures
    const triaged = result.failures.map(triageFailure);
    const reds = triaged.filter((t) => t.light === "red");
    const yellows = triaged.filter((t) => t.light === "yellow");
    const greens = triaged.filter((t) => t.light === "green");

    // Triage summary
    details += "\n### Triage\n";
    details += `${reds.length} critical (fix now) | ${yellows.length} important (fix soon) | ${greens.length} minor (fix when possible)\n`;

    if (reds.length > 0) {
      details += "\n### [RED] Fix Now — Blocks Ship\n\n";
      for (const t of reds) {
        details += formatTriagedFailure(t);
      }
    }

    if (yellows.length > 0) {
      details += "\n### [YLW] Fix Soon — Degrades Experience\n\n";
      for (const t of yellows) {
        details += formatTriagedFailure(t);
      }
    }

    if (greens.length > 0) {
      details += "\n### [GRN] Fix When Possible — Low Priority\n\n";
      for (const t of greens) {
        details += formatTriagedFailure(t);
      }
    }
  }

  if (result.totalTests === 0) {
    details += "\n### Warning\nNo tests were executed. Check for compilation errors.\n";
  }

  return { summary, details, passRate, overall };
}

function formatTriagedFailure(t: TriagedFailure): string {
  const f = t.failure;
  const lines = [`#### ${lightEmoji(t.light)} ${f.testFile} > ${f.testName}`];
  lines.push(`- **Priority:** ${t.reason}`);
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

// ── Seeded PRNG for deterministic shuffling ──

function seededShuffle<T>(arr: T[], seed: number): T[] {
  const copy = [...arr];
  // LCG: a=1664525, c=1013904223, m=2^32
  let s = seed >>> 0;
  const next = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
  // Fisher-Yates
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** Format scan context with shuffled API surface order (for Hacker sub-agent diversity) */
export function formatScanContextShuffled(scan: ScanResult, seed: number): string {
  const shuffled = { ...scan, apiSurface: seededShuffle(scan.apiSurface, seed) };
  return formatScanContext(shuffled);
}

/** Format scan result as context for the agent to generate test plans */
/** Format scan context for LLM prompts — includes full source code. */
export function formatScanContext(scan: ScanResult): string {
  const lines: string[] = [];

  lines.push(`# Test Context`);
  lines.push(`Language: ${scan.language}`);
  lines.push(`Scope: ${scan.scope}`);
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
  lines.push(`The following tests FAILED. Analyze each failure and suggest fixes.`);
  lines.push(`These are REAL test failures from the test runner — not LLM judgment.`);
  lines.push("");

  for (const f of result.failures) {
    lines.push(`### [FAIL] ${f.testName}`);
    lines.push(`File: ${f.testFile}`);
    if (f.error) lines.push(`Error: ${truncate(f.error, 500)}`);
    if (f.stackLine) lines.push(`Location: ${f.stackLine}`);
    lines.push("");
  }

  return lines.join("\n");
}
