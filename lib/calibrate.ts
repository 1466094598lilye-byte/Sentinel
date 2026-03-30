/**
 * Intent calibration — LLM reasons about what the project SHOULD have
 * based on the user's one-line description of what it's for.
 *
 * Input:  "A CLI tool that tests any codebase from four perspectives"
 * Output: structured list of expected capabilities the PM uses to find intent gaps
 */

import { llm } from "./llm.js";
import type { ScanResult } from "./detect.js";

export interface CalibrationResult {
  intent: string;
  expectedCapabilities: string;  // LLM-generated reasoning about what should exist
}

const CALIBRATE_SYSTEM = `You are a senior software architect. Given a one-sentence description of what a project is FOR, and a scan of what the project currently HAS (language, files, API surface), reason about what capabilities this project MUST have to fulfill its stated purpose.

Think step by step:
1. What is the core use case? Who runs this, how, where?
2. What are the minimum entry points needed? (CLI? API? Plugin interface? Web endpoint?)
3. What are the must-have features implied by the stated purpose?
4. What infrastructure is expected? (config, error handling, output formats, docs)

Then compare against what actually exists in the scan. Call out every gap.

Output format:
## Expected Capabilities
- [EXPECTED] capability description — WHY it's required given the stated purpose
- [EXPECTED] ...

## Intent Gaps (expected but missing)
- [GAP] what's missing — impact on the stated purpose
- [GAP] ...

## Intent Alignment (expected and present)
- [OK] what exists and matches — brief note
- [OK] ...

Be specific. "Should have a CLI" is useless. "Should have a bin/ entry point registered in package.json so users can run \`npx sentinel ./project\` without installing globally" is useful.`;

/**
 * Run intent calibration: LLM reasons about what SHOULD exist given the user's stated purpose.
 */
export async function calibrate(intent: string, scan: ScanResult): Promise<CalibrationResult> {
  const scanSummary = [
    `Language: ${scan.language}`,
    `Source files: ${scan.sourceFiles.length} (${scan.sourceFiles.slice(0, 20).join(", ")}${scan.sourceFiles.length > 20 ? "..." : ""})`,
    `API surface: ${scan.apiSurface.map((e) => `${e.kind} ${e.name} (${e.file})`).join(", ")}`,
    `Existing tests: ${scan.existingTests.length > 0 ? scan.existingTests.join(", ") : "none"}`,
    `Dependencies: ${Object.keys(scan.dependencies).join(", ") || "none"}`,
    `Git scope: ${scan.scope}`,
    scan.changedFiles.length > 0 ? `Changed files: ${scan.changedFiles.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const prompt = `## User's stated purpose
> ${intent}

## Current project scan
${scanSummary}

Reason about what this project MUST have to fulfill the stated purpose, then compare against what exists.`;

  const response = await llm(prompt, {
    system: CALIBRATE_SYSTEM,
    maxTokens: 2048,
  });

  return {
    intent,
    expectedCapabilities: response,
  };
}
