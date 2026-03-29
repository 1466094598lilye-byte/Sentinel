/**
 * Temporary workspace management for test execution.
 * Creates isolated copy of target, installs test runner, cleans up.
 */

import { mkdtempSync, cpSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { Language } from "./detect.js";
import { checkEnv } from "./runners.js";
import { execAsync, installSemaphore, syncSemaphores } from "./concurrency.js";
import { getConfig } from "./config.js";

export interface Workspace {
  dir: string;
  testDir: string;
  language: Language;
}

// Dirs that should always be skipped regardless of language
const ALWAYS_IGNORE = [".git", ".git/"];

/** Resolve cache env vars — replace {wsDir} placeholders with actual workspace dir */
function resolveCacheEnv(cacheEnv: Record<string, string> | undefined, wsDir: string): Record<string, string | undefined> {
  if (!cacheEnv) return {};
  const resolved: Record<string, string | undefined> = {};
  for (const [key, val] of Object.entries(cacheEnv)) {
    resolved[key] = val.replace(/\{wsDir\}/g, wsDir);
  }
  return resolved;
}

/** Create a temporary workspace with a copy of the target project */
export function createWorkspace(targetDir: string, language: Language): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"));

  const env = checkEnv(language, targetDir);
  const skipDirs = [...ALWAYS_IGNORE, ...(env.runner?.ignoreDirs || [])];

  cpSync(targetDir, dir, {
    recursive: true,
    filter: (src: string) => {
      const rel = src.replace(targetDir, "");
      return !skipDirs.some((d) => rel.includes(d));
    },
  });

  const testFileDir = env.runner?.testFileDir || "__sentinel__";
  const testDir = join(dir, testFileDir);
  mkdirSync(testDir, { recursive: true });

  // Language-specific workspace bootstrap
  if (language === "csharp") {
    bootstrapCSharp(dir, testDir);
  } else if (language === "swift") {
    bootstrapSwift(dir);
  }

  return { dir, testDir, language };
}

/** Install project dependencies + test runner (async, with concurrency control + cache isolation) */
export async function installDeps(ws: Workspace): Promise<{ success: boolean; output: string }> {
  const env = checkEnv(ws.language, ws.dir);

  if (!env.ready) {
    return {
      success: false,
      output: `Missing tools for ${ws.language}: ${env.missing.join(", ")}\nInstall them and try again.`,
    };
  }

  const { runner } = env;
  const cacheEnv = resolveCacheEnv(runner.cacheEnv, ws.dir);

  syncSemaphores();
  const cfg = getConfig();
  const installTimeout = cfg?.installTimeout || 120_000;
  const runnerInstallTimeout = cfg?.testRunnerInstallTimeout || 60_000;

  return installSemaphore.run(async () => {
    try {
      let output = "";

      // Python: install deps via the appropriate mechanism
      if (ws.language === "python") {
        const hasPackage = existsSync(join(ws.dir, "setup.py")) ||
                           existsSync(join(ws.dir, "pyproject.toml")) ||
                           existsSync(join(ws.dir, "setup.cfg"));
        const hasRequirements = existsSync(join(ws.dir, "requirements.txt"));

        if (hasPackage) {
          const r = await execAsync(`${runner.installCmd} 2>&1`, { cwd: ws.dir, timeout: installTimeout, env: cacheEnv });
          output += r.stdout;
          if (r.exitCode !== 0) return { success: false, output };
        } else if (hasRequirements) {
          const r = await execAsync("pip install -r requirements.txt 2>&1", { cwd: ws.dir, timeout: installTimeout, env: cacheEnv });
          output += r.stdout;
          if (r.exitCode !== 0) return { success: false, output };
        }
      } else {
        const r = await execAsync(`${runner.installCmd} 2>&1`, { cwd: ws.dir, timeout: installTimeout, env: cacheEnv });
        output += r.stdout;
        if (r.exitCode !== 0) return { success: false, output };
      }

      // Install test runner if not built-in
      if (!runner.builtinTestRunner && runner.testRunnerInstallCmd) {
        const r = await execAsync(`${runner.testRunnerInstallCmd} 2>&1`, { cwd: ws.dir, timeout: runnerInstallTimeout, env: cacheEnv });
        output += r.stdout;
        if (r.exitCode !== 0) return { success: false, output };
      }

      return { success: true, output };
    } catch (err: any) {
      return { success: false, output: err?.message || String(err) };
    }
  });
}

/** Write test files into the workspace */
export function writeTestFiles(ws: Workspace, files: Record<string, string>): string[] {
  const written: string[] = [];
  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(ws.testDir, filename);
    writeFileSync(filePath, content, "utf-8");
    written.push(filePath);
  }
  return written;
}

/** Clean up workspace */
export function destroyWorkspace(ws: Workspace): void {
  try {
    rmSync(ws.dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

/** Copy test files from workspace back to target project */
export function saveTestFiles(ws: Workspace, targetDir: string): string {
  const env = checkEnv(ws.language, targetDir);
  const testFileDir = env.runner?.testFileDir || "__sentinel__";
  const destDir = join(targetDir, testFileDir);
  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true });
  }
  cpSync(ws.testDir, destDir, { recursive: true });
  return destDir;
}

// ── Language-specific workspace bootstrap ──

/**
 * C#: generate a minimal xunit test project in SentinelTests/.
 * dotnet test requires a .csproj — without it, nothing gets compiled.
 */
function bootstrapCSharp(wsDir: string, testDir: string): void {
  let mainProjects: string[] = [];
  try {
    mainProjects = readdirSync(wsDir)
      .filter((f) => f.endsWith(".csproj") && f !== "SentinelTests.csproj")
      .map((f) => `../${f}`);
  } catch {
    // no .csproj at root
  }

  const projectRefs = mainProjects.length > 0
    ? `\n  <ItemGroup>\n${mainProjects.map((p) => `    <ProjectReference Include="${p.trim()}" />`).join("\n")}\n  </ItemGroup>`
    : "";

  const csproj = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.8.0" />
    <PackageReference Include="xunit" Version="2.6.1" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.5.3">
      <IncludeAssets>runtime; build; native; contentfiles; analyzers; buildtransitive</IncludeAssets>
      <PrivateAssets>all</PrivateAssets>
    </PackageReference>
  </ItemGroup>${projectRefs}
</Project>`;
  writeFileSync(join(testDir, "SentinelTests.csproj"), csproj, "utf-8");
}

/**
 * Swift: patch Package.swift to add a SentinelTests test target.
 */
function bootstrapSwift(wsDir: string): void {
  const pkgPath = join(wsDir, "Package.swift");
  if (!existsSync(pkgPath)) return;

  let content: string;
  try {
    content = readFileSync(pkgPath, "utf-8");
  } catch {
    return;
  }

  if (content.includes('"SentinelTests"')) return;

  const targetNames: string[] = [];
  const targetRe = /\.target\s*\(\s*name\s*:\s*"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = targetRe.exec(content)) !== null) {
    targetNames.push(`"${m[1]}"`);
  }
  const deps = targetNames.length > 0 ? targetNames.join(", ") : "";
  const newTarget = `\n        .testTarget(name: "SentinelTests", dependencies: [${deps}])`;

  const patched = content.replace(
    /(\btargets\s*:\s*\[)([\s\S]*?)(\s*\])/,
    (_, open, body, close) => {
      const comma = body.trimEnd().endsWith(",") ? "" : ",";
      return `${open}${body}${comma}${newTarget}${close}`;
    },
  );

  if (patched !== content) {
    writeFileSync(pkgPath, patched, "utf-8");
  }
}
