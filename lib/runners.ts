/**
 * Language runner config table.
 * Defines what each language needs to install deps and run tests.
 * No interfaces, no polymorphism — just a lookup table + env checks.
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
import type { Language } from "./detect.js";

export interface RunnerConfig {
  /** Binary needed to manage deps (npm, go, cargo, ...) */
  depManager: string;
  /** Command to install project dependencies */
  installCmd: string;
  /** Whether the test runner is built into the language toolchain */
  builtinTestRunner: boolean;
  /** Command to install test runner (only if !builtinTestRunner) */
  testRunnerInstallCmd?: string;
  /** Command to run tests (use {testDir} as placeholder for test directory) */
  testCmd: string;
  /** Directories to skip when copying project to workspace */
  ignoreDirs: string[];
  /**
   * Where test files must be placed relative to workspace root.
   * Some frameworks require tests in specific locations.
   */
  testFileDir: string;
  /**
   * Environment variables to isolate package cache per workspace.
   * Use {wsDir} as placeholder for the workspace root.
   */
  cacheEnv?: Record<string, string>;
}

export const RUNNERS: Partial<Record<Language, RunnerConfig>> = {
  typescript: {
    depManager: "npm",
    installCmd: "npm install",
    builtinTestRunner: false,
    testRunnerInstallCmd: "npm install -D vitest",
    testCmd: "npx vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json",
    ignoreDirs: ["node_modules", "dist", "coverage"],
    testFileDir: "__sentinel__",
    cacheEnv: { npm_config_cache: "{wsDir}/.npm-cache" },
  },
  javascript: {
    depManager: "npm",
    installCmd: "npm install",
    builtinTestRunner: false,
    testRunnerInstallCmd: "npm install -D vitest",
    testCmd: "npx vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json",
    ignoreDirs: ["node_modules", "dist", "coverage"],
    testFileDir: "__sentinel__",
    cacheEnv: { npm_config_cache: "{wsDir}/.npm-cache" },
  },
  python: {
    depManager: "pip",
    installCmd: 'pip install -e ".[dev]" || pip install -e .',
    builtinTestRunner: false,
    testRunnerInstallCmd: "pip install pytest pytest-timeout",
    testCmd: "python -m pytest {testDir} -v --tb=short",
    ignoreDirs: ["__pycache__", "venv", ".venv", "*.egg-info"],
    testFileDir: "__sentinel__",
    cacheEnv: { PIP_CACHE_DIR: "{wsDir}/.pip-cache" },
  },
  go: {
    depManager: "go",
    installCmd: "go mod download",
    builtinTestRunner: true,
    testCmd: "go test ./sentinel_test/... -v -json",
    ignoreDirs: ["vendor"],
    testFileDir: "sentinel_test",
    cacheEnv: { GOMODCACHE: "{wsDir}/.gomod-cache" },
  },
  rust: {
    depManager: "cargo",
    installCmd: "cargo fetch",
    builtinTestRunner: true,
    testCmd: "cargo test --tests --verbose",
    ignoreDirs: ["target"],
    testFileDir: "tests",
    cacheEnv: { CARGO_HOME: "{wsDir}/.cargo" },
  },
  java: {
    depManager: "mvn",
    installCmd: "mvn dependency:resolve -q",
    builtinTestRunner: true,
    testCmd: "mvn test --batch-mode",
    ignoreDirs: ["target", ".gradle", "build"],
    testFileDir: "src/test/java/sentinel",      // Maven/Gradle convention
  },
  csharp: {
    depManager: "dotnet",
    installCmd: "dotnet restore",
    builtinTestRunner: true,
    testCmd: "dotnet test SentinelTests/SentinelTests.csproj --verbosity normal",
    ignoreDirs: ["bin", "obj"],
    testFileDir: "SentinelTests",               // test project dir
  },
  swift: {
    depManager: "swift",
    installCmd: "swift package resolve",
    builtinTestRunner: true,
    testCmd: "swift test --verbose",
    ignoreDirs: [".build"],
    testFileDir: "Tests/SentinelTests",         // Swift Package Manager convention
  },
  ruby: {
    depManager: "bundle",
    installCmd: "bundle install",
    builtinTestRunner: false,
    testRunnerInstallCmd: "gem install rspec",
    testCmd: "rspec {testDir} --format documentation --format json --out rspec-results.json",
    ignoreDirs: ["vendor/bundle"],
    testFileDir: "__sentinel__",
  },
};

/** Check if a binary exists on this machine */
export function hasTool(bin: string): boolean {
  try {
    execSync(`command -v ${bin}`, { encoding: "utf-8", stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export interface EnvCheck {
  ready: boolean;
  runner: RunnerConfig;
  missing: string[];
}

/** Resolve the runner for a language, with runtime overrides (e.g. Gradle vs Maven) */
function resolveRunner(language: Language, targetDir?: string): RunnerConfig | undefined {
  const runner = RUNNERS[language];
  if (!runner) return undefined;

  // Java: detect Gradle vs Maven at runtime
  if (language === "java" && targetDir) {
    const hasGradle = existsSync(join(targetDir, "build.gradle")) ||
                      existsSync(join(targetDir, "build.gradle.kts"));
    if (hasGradle) {
      return {
        ...runner,
        depManager: "gradle",
        installCmd: "gradle dependencies --quiet",
        testCmd: "gradle test",
        testFileDir: "src/test/java/sentinel",
      };
    }
  }

  return runner;
}

/** Check if this machine can run tests for the given language */
export function checkEnv(language: Language, targetDir?: string): EnvCheck {
  const runner = resolveRunner(language, targetDir);
  if (!runner) {
    return {
      ready: false,
      runner: undefined!,
      missing: [`No runner configured for language: ${language}`],
    };
  }

  const missing: string[] = [];

  if (!hasTool(runner.depManager)) {
    missing.push(runner.depManager);
  }

  // For non-builtin test runners, check if the install tool exists
  // (the runner itself gets installed via installCmd, so we just need the package manager)
  if (!runner.builtinTestRunner && runner.testRunnerInstallCmd) {
    const installBin = runner.testRunnerInstallCmd.split(" ")[0];
    if (installBin !== runner.depManager && !hasTool(installBin)) {
      missing.push(installBin);
    }
  }

  return { ready: missing.length === 0, runner, missing };
}
