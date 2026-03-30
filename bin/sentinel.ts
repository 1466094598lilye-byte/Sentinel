#!/usr/bin/env npx tsx
/**
 * Sentinel CLI — standalone entry point, no OpenClaw required.
 *
 * Usage:
 *   npx sentinel <target>                  # scan + run existing __sentinel__/ tests
 *   npx sentinel scan <target>             # scan only — print context for LLM
 *   npx sentinel run <target>              # run existing tests in __sentinel__/
 *   npx sentinel run <target> --tests dir  # run tests from custom directory
 *   npx sentinel context <target>          # print full PM + Tester + Hacker prompts
 *
 * Options:
 *   --scope <commit|branch|changes|full>   # override auto-detected scope
 *   --save                                 # save test files back to project after run
 *   --json                                 # output results as JSON (for CI)
 *   --timeout <ms>                         # test execution timeout (default: 300000)
 */

import { resolve, join, basename } from "path";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { scan } from "../lib/detect.js";
import { createWorkspace, installDeps, writeTestFiles, destroyWorkspace, saveTestFiles } from "../lib/workspace.js";
import { runTests } from "../lib/executor.js";
import { formatReport, formatScanContext } from "../lib/reporter.js";
import { proposeConfig, setConfig, formatConfigProposal } from "../lib/config.js";
import { syncSemaphores } from "../lib/concurrency.js";
import { checkEnv } from "../lib/runners.js";
import { calibrate } from "../lib/calibrate.js";
import { detectProvider } from "../lib/llm.js";
import { runPipeline } from "../lib/pipeline.js";
import type { ScanResult } from "../lib/detect.js";

// ── Arg parsing ──

interface CliArgs {
  command: "scan" | "run" | "test" | "context" | "auto";
  target: string;
  scope?: string;
  intent?: string;
  testsDir?: string;
  save: boolean;
  json: boolean;
  timeout: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // skip node, script

  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--scope" && args[i + 1]) {
      flags.scope = args[++i];
    } else if (args[i] === "--tests" && args[i + 1]) {
      flags.tests = args[++i];
    } else if (args[i] === "--timeout" && args[i + 1]) {
      flags.timeout = args[++i];
    } else if (args[i] === "--intent" && args[i + 1]) {
      flags.intent = args[++i];
    } else if (args[i] === "--save") {
      flags.save = true;
    } else if (args[i] === "--json") {
      flags.json = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      printUsage();
      process.exit(0);
    } else if (!args[i].startsWith("-")) {
      positional.push(args[i]);
    } else {
      console.error(`Unknown flag: ${args[i]}`);
      process.exit(1);
    }
  }

  // Determine command and target
  let command: CliArgs["command"] = "auto";
  let target: string;

  const knownCommands = ["scan", "run", "test", "context"];
  if (positional.length >= 2 && knownCommands.includes(positional[0])) {
    command = positional[0] as CliArgs["command"];
    target = resolve(positional[1]);
  } else if (positional.length === 1) {
    // Could be "sentinel scan" (no target = cwd) or "sentinel ./path" (auto command)
    if (knownCommands.includes(positional[0])) {
      command = positional[0] as CliArgs["command"];
      target = resolve(".");
    } else {
      target = resolve(positional[0]);
    }
  } else {
    target = resolve(".");
  }

  return {
    command,
    target,
    scope: flags.scope as string | undefined,
    intent: flags.intent as string | undefined,
    testsDir: flags.tests as string | undefined,
    save: !!flags.save,
    json: !!flags.json,
    timeout: flags.timeout ? parseInt(flags.timeout as string, 10) : 300_000,
  };
}

function printUsage() {
  console.log(`
Sentinel — AI testing agent

Usage:
  sentinel test <target>             Full pipeline: scan → LLM generates tests → run → report
  sentinel test <target> --intent "what this project is for"
  sentinel scan <target>             Scan only (no LLM needed)
  sentinel run <target>              Run existing tests from __sentinel__/
  sentinel <target>                  Auto: test if API key available, else scan + run existing

Options:
  --intent <text>     What is this project for? (enables intent-gap detection)
  --scope <scope>     Override scope: commit | branch | changes | full
  --tests <dir>       Custom test file directory (default: __sentinel__/)
  --save              Save generated test files back to project
  --json              Output results as JSON (for CI pipelines)
  --timeout <ms>      Test execution timeout (default: 300000)
  -h, --help          Show this help

API Key:
  Set ANTHROPIC_API_KEY or OPENAI_API_KEY in your environment, .env file,
  or ~/.sentinel/.env. If not found, Sentinel will ask you to paste it.

Examples:
  sentinel test .                                 # full AI pipeline
  sentinel test . --intent "CLI testing tool"     # with intent calibration
  sentinel test . --save                          # keep generated tests
  sentinel run .                                  # re-run existing tests
  sentinel scan .                                 # just scan, no LLM
`);
}

// ── Logging ──

function log(msg: string) {
  console.error(`[sentinel] ${msg}`);
}

// ── Commands ──

async function cmdScan(scanResult: ScanResult, args: CliArgs): Promise<void> {
  const context = formatScanContext(scanResult);
  const config = proposeConfig(scanResult);
  const configSummary = formatConfigProposal(config, scanResult);

  if (args.json) {
    const output: any = {
      language: scanResult.language,
      scope: scanResult.scope,
      changedFiles: scanResult.changedFiles,
      sourceFiles: scanResult.sourceFiles.length,
      apiSurface: scanResult.apiSurface.length,
      existingTests: scanResult.existingTests.length,
    };

    if (args.intent) {
      output.intent = args.intent;
      if (detectProvider()) {
        const cal = await calibrate(args.intent, scanResult);
        output.calibration = cal.expectedCapabilities;
      }
    }

    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(context);
    console.log();
    console.log(configSummary);

    if (args.intent) {
      console.log();
      console.log(`## Project Intent`);
      console.log(`> ${args.intent}`);

      if (detectProvider()) {
        log("Running intent calibration...");
        try {
          const cal = await calibrate(args.intent, scanResult);
          console.log();
          console.log("## Intent Calibration");
          console.log(cal.expectedCapabilities);
        } catch (err: any) {
          log(`Calibration failed: ${err?.message}`);
        }
      } else {
        console.log();
        console.log("(Set ANTHROPIC_API_KEY or OPENAI_API_KEY for intent-gap detection)");
      }
    }
  }
}

async function cmdTest(scanResult: ScanResult, args: CliArgs): Promise<number> {
  // Full pipeline: LLM generates everything, then run
  log("Starting full AI pipeline...");

  const pipelineResult = await runPipeline(scanResult, args.intent, {
    onPhase: (phase) => log(phase),
  });

  const fileCount = Object.keys(pipelineResult.testFiles).length;
  if (fileCount === 0) {
    console.error("LLM did not generate any test files. Check the merged plan output.");
    console.error("This usually means the LLM response didn't use the expected --- FILE: --- format.");
    return 1;
  }

  log(`LLM generated ${fileCount} test files. Setting up workspace...`);

  // Setup config
  const config = proposeConfig(scanResult);
  config.testTimeout = args.timeout;
  setConfig(config);
  syncSemaphores();

  // Create workspace
  const ws = createWorkspace(args.target, scanResult.language);

  try {
    // Install deps
    log("Installing dependencies...");
    const installResult = await installDeps(ws);
    if (!installResult.success) {
      console.error("Dependency installation failed:");
      console.error(installResult.output.slice(0, 3000));
      return 1;
    }

    // Write LLM-generated test files
    writeTestFiles(ws, pipelineResult.testFiles);
    log(`Wrote ${fileCount} test files`);

    // Run tests
    log("Running tests...");
    const result = await runTests(ws);

    // Report
    const report = formatReport(scanResult, result);

    if (args.json) {
      const output = {
        overall: report.overall,
        passRate: report.passRate,
        totalTests: result.totalTests,
        passed: result.passed,
        failed: result.failed,
        duration: result.duration,
        failures: result.failures.map((f) => ({
          file: f.testFile,
          test: f.testName,
          error: f.error,
          expected: f.expected,
          actual: f.actual,
        })),
        calibration: pipelineResult.calibration?.expectedCapabilities || null,
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log();
      console.log(report.summary);
      console.log(report.details);
    }

    // Write full report
    const reportPath = join(args.target, "sentinel-report.md");
    const fullReport = [
      report.summary,
      report.details,
      "",
      pipelineResult.calibration ? `---\n## Intent Calibration\n${pipelineResult.calibration.expectedCapabilities}\n` : "",
      "---",
      "## Raw Test Output",
      "```",
      result.rawOutput,
      "```",
    ].join("\n");
    writeFileSync(reportPath, fullReport, "utf-8");

    if (result.failed > 0) {
      log(`Report written to: ${reportPath}`);
      log(`Open it to see full failure details and raw test output.`);
    } else {
      log(`Report: ${reportPath}`);
    }

    // Save test files to project if requested
    if (args.save) {
      const savedDir = saveTestFiles(ws, args.target);
      log(`Test files saved to: ${savedDir}`);
    }

    log(`Done: ${result.passed}/${result.totalTests} passed`);
    return result.failed > 0 ? 1 : 0;
  } finally {
    destroyWorkspace(ws);
  }
}

function cmdContext(scanResult: ScanResult): void {
  const context = formatScanContext(scanResult);
  const scopeGuide: Record<string, string> = {
    commit: "Scope is COMMIT — focus on uncommitted changes only.",
    branch: "Scope is BRANCH — test all changes since diverged from main.",
    changes: "Scope is CHANGES — test specific changed files.",
    full: "Scope is FULL — comprehensive test across all categories.",
  };

  console.log("=".repeat(60));
  console.log("SENTINEL CONTEXT — Feed this to your LLM");
  console.log("=".repeat(60));
  console.log();
  console.log(context);
  console.log();
  console.log("## Scope Guidance");
  console.log(scopeGuide[scanResult.scope] || scopeGuide.full);
  console.log();
  console.log("## Next Steps");
  console.log("1. Feed the context above to your LLM");
  console.log("2. Ask it to generate test files for this project");
  console.log('3. Save tests to __sentinel__/ in the project directory');
  console.log("4. Run: sentinel run <target>");
}

async function cmdRun(scanResult: ScanResult, args: CliArgs): Promise<number> {
  // Find test files
  const env = checkEnv(scanResult.language, args.target);
  const defaultTestDir = env.runner?.testFileDir || "__sentinel__";
  const testsDir = args.testsDir
    ? resolve(args.testsDir)
    : join(args.target, defaultTestDir);

  if (!existsSync(testsDir)) {
    console.error(`No test directory found at: ${testsDir}`);
    console.error();
    console.error("To generate tests, run:");
    console.error("  sentinel context <target>   # get prompts for your LLM");
    console.error(`  # then save test files to ${defaultTestDir}/`);
    return 1;
  }

  // Read test files
  const testFiles: Record<string, string> = {};
  const entries = readdirSync(testsDir).filter((f) => {
    // Match test file patterns across languages
    return /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(f)
      || /^test_.*\.py$/.test(f)
      || /_test\.go$/.test(f)
      || /_test\.rs$/.test(f)
      || /_spec\.rb$/.test(f)
      || /Test\.java$/.test(f)
      || /Tests?\.cs$/.test(f)
      || /Tests?\.swift$/.test(f);
  });

  if (entries.length === 0) {
    console.error(`No test files found in: ${testsDir}`);
    console.error("Expected patterns: *.test.ts, test_*.py, *_test.go, etc.");
    return 1;
  }

  for (const file of entries) {
    testFiles[file] = readFileSync(join(testsDir, file), "utf-8");
  }

  log(`Found ${entries.length} test files in ${testsDir}`);

  // Setup config
  const config = proposeConfig(scanResult);
  config.testTimeout = args.timeout;
  setConfig(config);
  syncSemaphores();

  // Create workspace
  log(`Creating isolated workspace...`);
  const ws = createWorkspace(args.target, scanResult.language);

  try {
    // Install deps
    log(`Installing dependencies...`);
    const installResult = await installDeps(ws);
    if (!installResult.success) {
      console.error("Dependency installation failed:");
      console.error(installResult.output.slice(0, 3000));
      return 1;
    }
    log(`Dependencies installed`);

    // Write test files
    writeTestFiles(ws, testFiles);
    log(`Wrote ${entries.length} test files`);

    // Run tests
    log(`Running tests...`);
    const result = await runTests(ws);

    // Report
    const report = formatReport(scanResult, result);

    if (args.json) {
      const output = {
        overall: report.overall,
        passRate: report.passRate,
        totalTests: result.totalTests,
        passed: result.passed,
        failed: result.failed,
        duration: result.duration,
        failures: result.failures.map((f) => ({
          file: f.testFile,
          test: f.testName,
          error: f.error,
          expected: f.expected,
          actual: f.actual,
        })),
      };
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log();
      console.log(report.summary);
      console.log(report.details);
    }

    // Always write report file — user can open it anytime after the run
    const reportPath = join(args.target, "sentinel-report.md");
    const fullReport = [
      report.summary,
      report.details,
      "",
      "---",
      "## Raw Test Output",
      "```",
      result.rawOutput,
      "```",
    ].join("\n");
    writeFileSync(reportPath, fullReport, "utf-8");

    if (result.failed > 0) {
      log(`Report written to: ${reportPath}`);
      log(`Open it to see full failure details and raw test output.`);
    } else {
      log(`Report: ${reportPath}`);
    }

    // Save if requested
    if (args.save) {
      const savedDir = saveTestFiles(ws, args.target);
      log(`Test files saved to: ${savedDir}`);
    }

    log(`Done: ${result.passed}/${result.totalTests} passed`);
    return result.failed > 0 ? 1 : 0;
  } finally {
    destroyWorkspace(ws);
  }
}

// ── Main ──

async function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(args.target)) {
    console.error(`Target directory does not exist: ${args.target}`);
    process.exit(1);
  }

  log(`Scanning ${args.target}...`);
  const scanResult = scan(args.target, args.scope);
  log(`Detected: ${scanResult.language}, scope=${scanResult.scope}, ${scanResult.sourceFiles.length} files, ${scanResult.apiSurface.length} exports`);

  switch (args.command) {
    case "test": {
      const code = await cmdTest(scanResult, args);
      process.exit(code);
      break;
    }

    case "scan":
      await cmdScan(scanResult, args);
      break;

    case "context":
      cmdContext(scanResult);
      break;

    case "run": {
      const code = await cmdRun(scanResult, args);
      process.exit(code);
      break;
    }

    case "auto": {
      // Auto mode: if API key available, full pipeline; otherwise run existing tests
      const env = checkEnv(scanResult.language, args.target);
      const testDir = join(args.target, env.runner?.testFileDir || "__sentinel__");

      if (detectProvider()) {
        // Has LLM — run full pipeline
        log("API key detected — running full AI pipeline");
        const code = await cmdTest(scanResult, args);
        process.exit(code);
      } else if (existsSync(testDir)) {
        // No LLM but has existing tests — run them
        log(`No API key, but found existing tests at ${basename(testDir)}/`);
        const code = await cmdRun(scanResult, args);
        process.exit(code);
      } else {
        // Nothing — scan only
        await cmdScan(scanResult, args);
        console.log();
        console.log("---");
        console.log("No API key and no existing test files.");
        console.log("Set ANTHROPIC_API_KEY or OPENAI_API_KEY, then run: sentinel test <target>");
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error(`[sentinel] Fatal: ${err?.message || err}`);
  process.exit(1);
});
