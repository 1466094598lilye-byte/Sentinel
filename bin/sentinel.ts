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
import type { ScanResult } from "../lib/detect.js";

// ── Arg parsing ──

interface CliArgs {
  command: "scan" | "run" | "context" | "auto";
  target: string;
  scope?: string;
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

  const knownCommands = ["scan", "run", "context"];
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
  sentinel <target>                  Scan + run existing tests
  sentinel scan <target>             Scan project, print context
  sentinel run <target>              Run tests from __sentinel__/
  sentinel context <target>          Print full prompts (PM + Tester + Hacker)

Options:
  --scope <scope>     Override scope: commit | branch | changes | full
  --tests <dir>       Custom test file directory (default: __sentinel__/)
  --save              Save test files back to project after run
  --json              Output results as JSON (for CI pipelines)
  --timeout <ms>      Test execution timeout (default: 300000)
  -h, --help          Show this help

Examples:
  sentinel .                         # scan + test current directory
  sentinel scan ~/my-project         # scan only
  sentinel run . --tests ./tests     # run custom test dir
  sentinel . --scope full --json     # full scan, JSON output for CI
`);
}

// ── Logging ──

function log(msg: string) {
  console.error(`[sentinel] ${msg}`);
}

// ── Commands ──

function cmdScan(scanResult: ScanResult, args: CliArgs): void {
  const context = formatScanContext(scanResult);
  const config = proposeConfig(scanResult);
  const configSummary = formatConfigProposal(config, scanResult);

  if (args.json) {
    const output = {
      language: scanResult.language,
      scope: scanResult.scope,
      changedFiles: scanResult.changedFiles,
      sourceFiles: scanResult.sourceFiles.length,
      apiSurface: scanResult.apiSurface.length,
      existingTests: scanResult.existingTests.length,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(context);
    console.log();
    console.log(configSummary);
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
    case "scan":
      cmdScan(scanResult, args);
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
      // Auto mode: scan first, then run if tests exist
      const env = checkEnv(scanResult.language, args.target);
      const testDir = join(args.target, env.runner?.testFileDir || "__sentinel__");

      if (existsSync(testDir)) {
        log(`Found test directory: ${testDir}`);
        const code = await cmdRun(scanResult, args);
        process.exit(code);
      } else {
        // No tests yet — just scan
        cmdScan(scanResult, args);
        console.log();
        console.log("---");
        console.log(`No test directory found at ${basename(testDir)}/`);
        console.log("Run 'sentinel context' to generate prompts for your LLM,");
        console.log(`or create test files in ${basename(testDir)}/ and re-run.`);
      }
      break;
    }
  }
}

main().catch((err) => {
  console.error(`[sentinel] Fatal: ${err?.message || err}`);
  process.exit(1);
});
