/**
 * Language runner config table.
 * Defines what each language needs to install deps and run tests.
 * No interfaces, no polymorphism — just a lookup table + env checks.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
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
  /**
   * Explicit binaries required for this runner when install/test commands are
   * launched through wrappers such as corepack, mvnw, or gradlew.
   */
  requiredTools?: string[];
  /**
   * Optional hint used by result parsing when the depManager is wrapper-driven.
   */
  buildTool?: string;
}

export const RUNNERS: Partial<Record<Language, RunnerConfig>> = {
  typescript: {
    depManager: "npm",
    installCmd: "npm install",
    builtinTestRunner: false,
    testRunnerInstallCmd: "npm install -D vitest",
    testCmd: "npx vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json",
    ignoreDirs: ["node_modules", "dist", "coverage", ".yarn", ".pnpm-store"],
    testFileDir: "__sentinel__",
    cacheEnv: { npm_config_cache: "{wsDir}/.npm-cache" },
  },
  javascript: {
    depManager: "npm",
    installCmd: "npm install",
    builtinTestRunner: false,
    testRunnerInstallCmd: "npm install -D vitest",
    testCmd: "npx vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json",
    ignoreDirs: ["node_modules", "dist", "coverage", ".yarn", ".pnpm-store"],
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
    buildTool: "maven",
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

type NodePackageManager = "npm" | "pnpm" | "yarn" | "bun";
type PythonPackageManager = "pip" | "poetry" | "pdm" | "uv";

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function readPackageJson(targetDir: string): any | null {
  const pkgPath = join(targetDir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    return JSON.parse(readText(pkgPath));
  } catch {
    return null;
  }
}

function detectNodePackageManager(targetDir: string): NodePackageManager {
  const pkg = readPackageJson(targetDir);
  const packageManager = typeof pkg?.packageManager === "string" ? pkg.packageManager : "";

  for (const name of ["pnpm", "yarn", "bun", "npm"] as const) {
    if (packageManager.startsWith(`${name}@`) || packageManager === name) return name;
  }

  if (existsSync(join(targetDir, "bun.lockb")) || existsSync(join(targetDir, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(targetDir, "pnpm-lock.yaml")) || existsSync(join(targetDir, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(targetDir, "yarn.lock")) || existsSync(join(targetDir, ".yarnrc.yml")) || existsSync(join(targetDir, ".yarn"))) {
    return "yarn";
  }

  return "npm";
}

function resolveNodeCommand(manager: NodePackageManager): { requiredTools?: string[]; prefix: string; cacheEnv?: Record<string, string> } {
  switch (manager) {
    case "pnpm":
      if (hasTool("pnpm")) {
        return {
          prefix: "pnpm",
          cacheEnv: { pnpm_config_store_dir: "{wsDir}/.pnpm-store" },
        };
      }
      return {
        requiredTools: ["corepack"],
        prefix: "corepack pnpm",
        cacheEnv: { pnpm_config_store_dir: "{wsDir}/.pnpm-store" },
      };
    case "yarn":
      if (hasTool("yarn")) {
        return {
          prefix: "yarn",
          cacheEnv: { YARN_CACHE_FOLDER: "{wsDir}/.yarn-cache" },
        };
      }
      return {
        requiredTools: ["corepack"],
        prefix: "corepack yarn",
        cacheEnv: { YARN_CACHE_FOLDER: "{wsDir}/.yarn-cache" },
      };
    case "bun":
      return {
        requiredTools: ["bun"],
        prefix: "bun",
        cacheEnv: { BUN_INSTALL_CACHE_DIR: "{wsDir}/.bun-cache" },
      };
    case "npm":
    default:
      return {
        prefix: "npm",
        cacheEnv: { npm_config_cache: "{wsDir}/.npm-cache" },
      };
  }
}

function createNodeRunner(manager: NodePackageManager): RunnerConfig {
  const command = resolveNodeCommand(manager);
  const shared = {
    depManager: manager,
    builtinTestRunner: false,
    ignoreDirs: ["node_modules", "dist", "coverage", ".yarn", ".pnpm-store"],
    testFileDir: "__sentinel__",
    cacheEnv: command.cacheEnv,
    requiredTools: command.requiredTools,
  } satisfies Partial<RunnerConfig>;

  switch (manager) {
    case "pnpm":
      return {
        ...shared,
        depManager: "pnpm",
        installCmd: `${command.prefix} install`,
        testRunnerInstallCmd: `${command.prefix} add -D vitest`,
        testCmd: `${command.prefix} exec vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json`,
      };
    case "yarn":
      return {
        ...shared,
        depManager: "yarn",
        installCmd: `${command.prefix} install`,
        testRunnerInstallCmd: `${command.prefix} add -D vitest`,
        testCmd: `${command.prefix} vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json`,
      };
    case "bun":
      return {
        ...shared,
        depManager: "bun",
        installCmd: "bun install",
        testRunnerInstallCmd: "bun add -d vitest",
        testCmd: "bun x vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json",
      };
    case "npm":
    default:
      return {
        ...shared,
        depManager: "npm",
        installCmd: "npm install",
        testRunnerInstallCmd: "npm install -D vitest",
        testCmd: "npx vitest run {testDir} --reporter=verbose --reporter=json --outputFile=vitest-results.json",
      };
  }
}

function readPyproject(targetDir: string): string {
  const pyproject = join(targetDir, "pyproject.toml");
  if (!existsSync(pyproject)) return "";
  return readText(pyproject);
}

function detectPythonPackageManager(targetDir: string): PythonPackageManager {
  const pyproject = readPyproject(targetDir);

  if (existsSync(join(targetDir, "uv.lock")) || /\[tool\.uv(?:[.\]])?/m.test(pyproject)) {
    return "uv";
  }
  if (existsSync(join(targetDir, "poetry.lock")) || /\[tool\.poetry(?:[.\]])?/m.test(pyproject)) {
    return "poetry";
  }
  if (existsSync(join(targetDir, "pdm.lock")) || /\[tool\.pdm(?:[.\]])?/m.test(pyproject)) {
    return "pdm";
  }

  return "pip";
}

function createPythonRunner(manager: PythonPackageManager): RunnerConfig {
  switch (manager) {
    case "uv":
      return {
        depManager: "uv",
        installCmd: "uv sync",
        builtinTestRunner: false,
        testRunnerInstallCmd: "uv add --dev pytest pytest-timeout",
        testCmd: "uv run pytest {testDir} -v --tb=short",
        ignoreDirs: ["__pycache__", "venv", ".venv", "*.egg-info"],
        testFileDir: "__sentinel__",
        cacheEnv: { UV_CACHE_DIR: "{wsDir}/.uv-cache", PIP_CACHE_DIR: "{wsDir}/.pip-cache" },
      };
    case "poetry":
      return {
        depManager: "poetry",
        installCmd: "poetry install",
        builtinTestRunner: false,
        testRunnerInstallCmd: "poetry add --group dev pytest pytest-timeout",
        testCmd: "poetry run pytest {testDir} -v --tb=short",
        ignoreDirs: ["__pycache__", "venv", ".venv", "*.egg-info"],
        testFileDir: "__sentinel__",
        cacheEnv: { POETRY_CACHE_DIR: "{wsDir}/.poetry-cache", PIP_CACHE_DIR: "{wsDir}/.pip-cache" },
      };
    case "pdm":
      return {
        depManager: "pdm",
        installCmd: "pdm install",
        builtinTestRunner: false,
        testRunnerInstallCmd: "pdm add -dG test pytest pytest-timeout",
        testCmd: "pdm run pytest {testDir} -v --tb=short",
        ignoreDirs: ["__pycache__", "venv", ".venv", "*.egg-info"],
        testFileDir: "__sentinel__",
        cacheEnv: { PDM_CACHE_DIR: "{wsDir}/.pdm-cache", PIP_CACHE_DIR: "{wsDir}/.pip-cache" },
      };
    case "pip":
    default:
      return {
        depManager: "pip",
        installCmd: 'pip install -e ".[dev]" || pip install -e .',
        builtinTestRunner: false,
        testRunnerInstallCmd: "pip install pytest pytest-timeout",
        testCmd: "python -m pytest {testDir} -v --tb=short",
        ignoreDirs: ["__pycache__", "venv", ".venv", "*.egg-info"],
        testFileDir: "__sentinel__",
        cacheEnv: { PIP_CACHE_DIR: "{wsDir}/.pip-cache" },
      };
  }
}

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
  if ((language === "typescript" || language === "javascript") && targetDir) {
    return createNodeRunner(detectNodePackageManager(targetDir));
  }

  if (language === "python" && targetDir) {
    return createPythonRunner(detectPythonPackageManager(targetDir));
  }

  const runner = RUNNERS[language];
  if (!runner) return undefined;

  // Java: detect Gradle vs Maven at runtime
  if (language === "java" && targetDir) {
    const hasGradleWrapper = existsSync(join(targetDir, "gradlew"));
    const hasGradle = existsSync(join(targetDir, "build.gradle")) ||
                      existsSync(join(targetDir, "build.gradle.kts"));
    if (hasGradleWrapper || hasGradle) {
      return {
        ...runner,
        depManager: "gradle",
        installCmd: hasGradleWrapper ? "sh ./gradlew dependencies --quiet" : "gradle dependencies --quiet",
        testCmd: hasGradleWrapper ? "sh ./gradlew test" : "gradle test",
        testFileDir: "src/test/java/sentinel",
        buildTool: "gradle",
        requiredTools: hasGradleWrapper ? ["sh"] : undefined,
      };
    }

    const hasMavenWrapper = existsSync(join(targetDir, "mvnw"));
    if (hasMavenWrapper) {
      return {
        ...runner,
        depManager: "mvn",
        installCmd: "sh ./mvnw dependency:resolve -q",
        testCmd: "sh ./mvnw test --batch-mode",
        testFileDir: "src/test/java/sentinel",
        buildTool: "maven",
        requiredTools: ["sh"],
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

  const requiredTools = runner.requiredTools && runner.requiredTools.length > 0
    ? runner.requiredTools
    : [runner.depManager];

  for (const tool of requiredTools) {
    if (!hasTool(tool)) {
      missing.push(tool);
    }
  }

  // For non-builtin test runners, check if the install tool exists
  // (the runner itself gets installed via installCmd, so we just need the package manager)
  if (!runner.builtinTestRunner && runner.testRunnerInstallCmd) {
    const installBin = runner.testRunnerInstallCmd.split(" ")[0];
    if (!requiredTools.includes(installBin) && installBin !== runner.depManager && !hasTool(installBin)) {
      missing.push(installBin);
    }
  }

  return { ready: missing.length === 0, runner, missing };
}
