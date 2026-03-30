/**
 * Language detection and git diff analysis.
 * All deterministic — no LLM needed.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

export type Language = "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "csharp" | "swift" | "ruby" | "unknown";

export interface ScanResult {
  language: Language;
  scope: "commit" | "branch" | "changes" | "full";
  changedFiles: string[];
  sourceFiles: string[];
  sourceContents: Record<string, string>;
  apiSurface: ExportEntry[];
  dependencies: Record<string, string>;
  existingTests: string[];
  gitDiff: string;
}

export interface ExportEntry {
  file: string;
  name: string;
  kind: "function" | "class" | "const" | "interface" | "type";
  signature: string;
  async: boolean;
}

// ── Language detection ──

const STRONG_SIGNALS: [string | string[], Language][] = [
  ["tsconfig.json", "typescript"],
  ["go.mod", "go"],
  ["Cargo.toml", "rust"],
  [["pyproject.toml", "setup.py", "setup.cfg"], "python"],
  [["pom.xml", "build.gradle", "build.gradle.kts"], "java"],
  [["Package.swift"], "swift"],
  ["Gemfile", "ruby"],
];

const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".swift": "swift",
  ".rb": "ruby",
};

const ALL_SOURCE_EXTENSIONS = Object.keys(EXTENSION_MAP);

export function detectLanguage(targetDir: string): Language {
  // Layer 1: strong signals — language-specific config files
  for (const [files, lang] of STRONG_SIGNALS) {
    const checks = Array.isArray(files) ? files : [files];
    if (checks.some((f) => existsSync(join(targetDir, f)))) return lang;
  }

  // .csproj / .sln need glob-style check (filenames vary)
  try {
    const topLevel = readdirSync(targetDir);
    if (topLevel.some((f) => f.endsWith(".csproj") || f.endsWith(".sln"))) return "csharp";
  } catch {
    // skip if unreadable
  }

  // Layer 2: file extension distribution — count source files, pick the majority
  const counts = new Map<Language, number>();
  const files = walkDir(targetDir, targetDir, ALL_SOURCE_EXTENSIONS);
  for (const f of files) {
    const ext = ALL_SOURCE_EXTENSIONS.find((e) => f.endsWith(e));
    if (ext) {
      const lang = EXTENSION_MAP[ext];
      counts.set(lang, (counts.get(lang) || 0) + 1);
    }
  }

  if (counts.size > 0) {
    let best: Language = "unknown";
    let bestCount = 0;
    for (const [lang, count] of counts) {
      if (count > bestCount) {
        best = lang;
        bestCount = count;
      }
    }
    return best;
  }

  return "unknown";
}

// ── Git scope detection ──

function exec(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: "utf-8", timeout: 10_000 }).trim();
  } catch {
    return "";
  }
}

function isGitRepo(dir: string): boolean {
  return exec("git rev-parse --is-inside-work-tree", dir) === "true";
}

function getDefaultBranch(dir: string): string {
  // Try common names
  for (const branch of ["main", "master"]) {
    if (exec(`git rev-parse --verify ${branch}`, dir)) return branch;
  }
  return "main";
}

export function detectScope(
  targetDir: string,
  explicitScope?: string,
): { scope: ScanResult["scope"]; changedFiles: string[]; gitDiff: string } {
  if (explicitScope && ["commit", "branch", "changes", "full"].includes(explicitScope)) {
    // Even with explicit scope, still get the relevant files
    return getFilesForScope(targetDir, explicitScope as ScanResult["scope"]);
  }

  if (!isGitRepo(targetDir)) {
    return { scope: "full", changedFiles: [], gitDiff: "" };
  }

  // Check uncommitted changes (staged + unstaged)
  const staged = exec("git diff --cached --name-only", targetDir);
  const unstaged = exec("git diff --name-only", targetDir);
  const uncommitted = [...new Set([...staged.split("\n"), ...unstaged.split("\n")])].filter(Boolean);

  if (uncommitted.length > 0) {
    const diff = exec("git diff HEAD", targetDir) || exec("git diff", targetDir);
    return { scope: "commit", changedFiles: uncommitted, gitDiff: diff };
  }

  // Check branch divergence
  const defaultBranch = getDefaultBranch(targetDir);
  const currentBranch = exec("git rev-parse --abbrev-ref HEAD", targetDir);

  if (currentBranch && currentBranch !== defaultBranch) {
    const branchFiles = exec(`git diff --name-only ${defaultBranch}...HEAD`, targetDir);
    const branchDiff = exec(`git diff ${defaultBranch}...HEAD`, targetDir);
    const files = branchFiles.split("\n").filter(Boolean);
    if (files.length > 0) {
      return { scope: "branch", changedFiles: files, gitDiff: branchDiff };
    }
  }

  // No changes detected — full scan
  return { scope: "full", changedFiles: [], gitDiff: "" };
}

function getFilesForScope(
  targetDir: string,
  scope: ScanResult["scope"],
): { scope: ScanResult["scope"]; changedFiles: string[]; gitDiff: string } {
  if (scope === "full") return { scope, changedFiles: [], gitDiff: "" };
  if (!isGitRepo(targetDir)) return { scope: "full", changedFiles: [], gitDiff: "" };

  const defaultBranch = getDefaultBranch(targetDir);

  if (scope === "commit") {
    const files = exec("git diff HEAD --name-only", targetDir).split("\n").filter(Boolean);
    const diff = exec("git diff HEAD", targetDir);
    return { scope, changedFiles: files, gitDiff: diff };
  }
  if (scope === "branch") {
    const files = exec(`git diff --name-only ${defaultBranch}...HEAD`, targetDir).split("\n").filter(Boolean);
    const diff = exec(`git diff ${defaultBranch}...HEAD`, targetDir);
    return { scope, changedFiles: files, gitDiff: diff };
  }
  // changes — same as commit
  const files = exec("git diff HEAD --name-only", targetDir).split("\n").filter(Boolean);
  const diff = exec("git diff HEAD", targetDir);
  return { scope, changedFiles: files, gitDiff: diff };
}

// ── Source file discovery ──

const LANGUAGE_EXTENSIONS: Record<Language, string[]> = {
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx"],
  python: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  csharp: [".cs"],
  swift: [".swift"],
  ruby: [".rb"],
  unknown: [],
};

const IGNORE_DIRS = [
  "node_modules", "dist", ".git", "__pycache__", "venv", ".venv",
  "build", "coverage", "target", "vendor", ".build", "bin", "obj",
  "Pods", ".gradle", ".idea",
];

const TEST_PATTERNS = [
  ".test.", ".spec.", "test_", "_test.",  // JS/TS/Python
  "_test.go",                              // Go
  "#[cfg(test)]",                          // Rust (file-level, caught by name below)
  "Test.java", "Tests.java",              // Java
  "Tests.cs",                              // C#
  "Tests.swift",                           // Swift
  "_spec.rb",                              // Ruby
];

function walkDir(dir: string, base: string, extensions: string[]): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const relPath = relative(base, fullPath);

      if (IGNORE_DIRS.some((d) => relPath.startsWith(d) || relPath.includes(`/${d}/`))) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results.push(...walkDir(fullPath, base, extensions));
        } else if (extensions.some((ext) => entry.endsWith(ext))) {
          results.push(relPath);
        }
      } catch {
        // skip inaccessible files
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return results;
}

function extensionsForLanguage(language: Language): string[] {
  return LANGUAGE_EXTENSIONS[language] || [];
}

function isTestFile(filePath: string): boolean {
  return TEST_PATTERNS.some((p) => filePath.includes(p));
}

export function findSourceFiles(targetDir: string, language: Language): string[] {
  const extensions = extensionsForLanguage(language);
  if (extensions.length === 0) return [];
  const all = walkDir(targetDir, targetDir, extensions);
  return all.filter((f) => !isTestFile(f));
}

export function findTestFiles(targetDir: string, language: Language): string[] {
  const extensions = extensionsForLanguage(language);
  if (extensions.length === 0) return [];
  const all = walkDir(targetDir, targetDir, extensions);
  return all.filter((f) => isTestFile(f));
}

// ── API surface extraction ──
// Regex-based per language, not AST — good enough for plugin context, avoids dependencies.

export function extractApiSurface(targetDir: string, files: string[], language: Language): ExportEntry[] {
  const entries: ExportEntry[] = [];

  for (const file of files) {
    const fullPath = join(targetDir, file);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    switch (language) {
      case "typescript":
      case "javascript":
        entries.push(...extractTS(file, content));
        break;
      case "python":
        entries.push(...extractPython(file, content));
        break;
      case "go":
        entries.push(...extractGo(file, content));
        break;
      case "rust":
        entries.push(...extractRust(file, content));
        break;
      case "java":
        entries.push(...extractJava(file, content));
        break;
      case "csharp":
        entries.push(...extractCSharp(file, content));
        break;
      case "ruby":
        entries.push(...extractRuby(file, content));
        break;
      case "swift":
        entries.push(...extractSwift(file, content));
        break;
    }
  }

  return entries;
}

// ── TypeScript / JavaScript ──

const TS_EXPORT_RE =
  /export\s+(async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)(?:\s*[(<:=])?([^{]*)?/g;

function extractTS(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];
  let match: RegExpExecArray | null;
  TS_EXPORT_RE.lastIndex = 0;

  while ((match = TS_EXPORT_RE.exec(content)) !== null) {
    const isAsync = !!match[1];
    const name = match[2];
    const rest = (match[3] || "").trim();
    const line = match[0];

    let kind: ExportEntry["kind"] = "const";
    if (line.includes("function")) kind = "function";
    else if (line.includes("class")) kind = "class";
    else if (line.includes("interface")) kind = "interface";
    else if (line.includes("type ")) kind = "type";

    const sigMatch = rest.match(/^([^{]*)/);
    const signature = sigMatch ? sigMatch[1].trim().replace(/\s+/g, " ") : "";

    entries.push({ file, name, kind, signature, async: isAsync });
  }

  const defaultMatch = content.match(/export\s+default\s+(?:async\s+)?function\s+(\w+)/);
  if (defaultMatch) {
    entries.push({
      file,
      name: defaultMatch[1],
      kind: "function",
      signature: "(default export)",
      async: content.includes("export default async"),
    });
  }

  return entries;
}

// ── Python ──
// Catches top-level def/class (not indented = public API)

function extractPython(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  // Top-level functions: "def func_name(..."
  const defRe = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = defRe.exec(content)) !== null) {
    if (m[2].startsWith("_")) continue; // skip private
    entries.push({
      file,
      name: m[2],
      kind: "function",
      signature: `(${m[3].trim()})`,
      async: !!m[1],
    });
  }

  // Top-level classes: "class ClassName(..."
  const classRe = /^class\s+(\w+)\s*(?:\(([^)]*)\))?/gm;
  while ((m = classRe.exec(content)) !== null) {
    if (m[1].startsWith("_")) continue;
    entries.push({
      file,
      name: m[1],
      kind: "class",
      signature: m[2] ? `(${m[2].trim()})` : "",
      async: false,
    });
  }

  return entries;
}

// ── Go ──
// Exported = capitalized name

function extractGo(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  // Functions: "func FuncName(..."
  const funcRe = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?([A-Z]\w*)\s*\(([^)]*)\)/gm;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "function", signature: `(${m[2].trim()})`, async: false });
  }

  // Structs: "type TypeName struct"
  const structRe = /^type\s+([A-Z]\w*)\s+struct/gm;
  while ((m = structRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "class", signature: "struct", async: false });
  }

  // Interfaces: "type TypeName interface"
  const ifaceRe = /^type\s+([A-Z]\w*)\s+interface/gm;
  while ((m = ifaceRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "interface", signature: "interface", async: false });
  }

  return entries;
}

// ── Rust ──
// "pub fn", "pub struct", "pub trait", etc.

function extractRust(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  const fnRe = /pub\s+(async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = fnRe.exec(content)) !== null) {
    entries.push({ file, name: m[2], kind: "function", signature: `(${m[3].trim()})`, async: !!m[1] });
  }

  const structRe = /pub\s+struct\s+(\w+)/g;
  while ((m = structRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "class", signature: "struct", async: false });
  }

  const traitRe = /pub\s+trait\s+(\w+)/g;
  while ((m = traitRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "interface", signature: "trait", async: false });
  }

  return entries;
}

// ── Java ──
// "public class/interface/void/Type methodName(..."

function extractJava(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  const classRe = /public\s+(?:abstract\s+)?class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "class", signature: "", async: false });
  }

  const ifaceRe = /public\s+interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "interface", signature: "", async: false });
  }

  const methodRe = /public\s+(?:static\s+)?(?:[\w<>\[\],\s]+?)\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = methodRe.exec(content)) !== null) {
    if (["class", "interface", "enum", "new"].includes(m[1])) continue;
    entries.push({ file, name: m[1], kind: "function", signature: `(${m[2].trim()})`, async: false });
  }

  return entries;
}

// ── C# ──

function extractCSharp(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  const classRe = /public\s+(?:abstract\s+|static\s+|sealed\s+)*class\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "class", signature: "", async: false });
  }

  const ifaceRe = /public\s+interface\s+(\w+)/g;
  while ((m = ifaceRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "interface", signature: "", async: false });
  }

  const methodRe = /public\s+(?:static\s+)?(?:async\s+)?(?:[\w<>\[\]?]+)\s+(\w+)\s*\(([^)]*)\)/g;
  while ((m = methodRe.exec(content)) !== null) {
    if (["class", "interface", "enum", "new"].includes(m[1])) continue;
    const isAsync = content.slice(Math.max(0, m.index - 20), m.index + m[0].length).includes("async");
    entries.push({ file, name: m[1], kind: "function", signature: `(${m[2].trim()})`, async: isAsync });
  }

  return entries;
}

// ── Ruby ──
// Top-level "def method_name" and "class ClassName"

function extractRuby(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  const classRe = /^class\s+(\w+)/gm;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "class", signature: "", async: false });
  }

  const defRe = /^\s{0,2}def\s+(?:self\.)?(\w+)(?:\(([^)]*)\))?/gm;
  while ((m = defRe.exec(content)) !== null) {
    if (m[1].startsWith("_")) continue;
    entries.push({ file, name: m[1], kind: "function", signature: m[2] ? `(${m[2].trim()})` : "()", async: false });
  }

  return entries;
}

// ── Swift ──
// "public func", "public class", "public struct", "public protocol"

function extractSwift(file: string, content: string): ExportEntry[] {
  const entries: ExportEntry[] = [];

  const funcRe = /(?:public|open)\s+func\s+(\w+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = funcRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "function", signature: `(${m[2].trim()})`, async: false });
  }

  const classRe = /(?:public|open)\s+(?:class|struct)\s+(\w+)/g;
  while ((m = classRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "class", signature: "", async: false });
  }

  const protoRe = /(?:public|open)\s+protocol\s+(\w+)/g;
  while ((m = protoRe.exec(content)) !== null) {
    entries.push({ file, name: m[1], kind: "interface", signature: "protocol", async: false });
  }

  return entries;
}

// ── Dependencies ──

export function readDependencies(targetDir: string, language: Language): Record<string, string> {
  switch (language) {
    case "typescript":
    case "javascript": {
      const pkgPath = join(targetDir, "package.json");
      if (!existsSync(pkgPath)) return {};
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return { ...pkg.dependencies, ...pkg.devDependencies };
      } catch { return {}; }
    }
    case "python": {
      // Read from pyproject.toml [project] dependencies (simplified)
      const pyproj = join(targetDir, "pyproject.toml");
      if (!existsSync(pyproj)) return {};
      try {
        const content = readFileSync(pyproj, "utf-8");
        const deps: Record<string, string> = {};
        const depBlock = content.match(/dependencies\s*=\s*\[([\s\S]*?)\]/);
        if (depBlock) {
          for (const m of depBlock[1].matchAll(/"([^"]+)"/g)) {
            const parts = m[1].split(/[><=~!]+/);
            deps[parts[0].trim()] = parts[1]?.trim() || "*";
          }
        }
        return deps;
      } catch { return {}; }
    }
    case "go": {
      const gomod = join(targetDir, "go.mod");
      if (!existsSync(gomod)) return {};
      try {
        const content = readFileSync(gomod, "utf-8");
        const deps: Record<string, string> = {};
        const reqBlock = content.match(/require\s*\(([\s\S]*?)\)/);
        if (reqBlock) {
          for (const line of reqBlock[1].split("\n")) {
            const m = line.trim().match(/^(\S+)\s+(\S+)/);
            if (m) deps[m[1]] = m[2];
          }
        }
        return deps;
      } catch { return {}; }
    }
    case "rust": {
      const cargo = join(targetDir, "Cargo.toml");
      if (!existsSync(cargo)) return {};
      try {
        const content = readFileSync(cargo, "utf-8");
        const deps: Record<string, string> = {};
        const depBlock = content.match(/\[dependencies\]([\s\S]*?)(?:\[|$)/);
        if (depBlock) {
          for (const line of depBlock[1].split("\n")) {
            const m = line.match(/^(\w[\w-]*)\s*=\s*"([^"]+)"/);
            if (m) deps[m[1]] = m[2];
          }
        }
        return deps;
      } catch { return {}; }
    }
    case "ruby": {
      const gemfile = join(targetDir, "Gemfile");
      if (!existsSync(gemfile)) return {};
      try {
        const content = readFileSync(gemfile, "utf-8");
        const deps: Record<string, string> = {};
        for (const m of content.matchAll(/gem\s+['"](\S+?)['"]/g)) {
          deps[m[1]] = "*";
        }
        return deps;
      } catch { return {}; }
    }
    case "java": {
      // Maven pom.xml
      const pom = join(targetDir, "pom.xml");
      if (existsSync(pom)) {
        try {
          const content = readFileSync(pom, "utf-8");
          const deps: Record<string, string> = {};
          const depRe = /<dependency>\s*<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>(?:\s*<version>([^<]+)<\/version>)?/g;
          let m: RegExpExecArray | null;
          while ((m = depRe.exec(content)) !== null) {
            deps[`${m[1]}:${m[2]}`] = m[3] || "*";
          }
          return deps;
        } catch { return {}; }
      }
      // Gradle build.gradle
      const gradle = join(targetDir, "build.gradle");
      const gradleKts = join(targetDir, "build.gradle.kts");
      const gradlePath = existsSync(gradle) ? gradle : existsSync(gradleKts) ? gradleKts : null;
      if (gradlePath) {
        try {
          const content = readFileSync(gradlePath, "utf-8");
          const deps: Record<string, string> = {};
          const depRe = /(?:implementation|api|testImplementation|compileOnly)\s*[\s(]['"]([^'"]+)['"]/g;
          let m: RegExpExecArray | null;
          while ((m = depRe.exec(content)) !== null) {
            const parts = m[1].split(":");
            if (parts.length >= 2) {
              deps[`${parts[0]}:${parts[1]}`] = parts[2] || "*";
            }
          }
          return deps;
        } catch { return {}; }
      }
      return {};
    }
    case "csharp": {
      // Scan for .csproj PackageReference entries
      try {
        const files = readdirSync(targetDir).filter((f) => f.endsWith(".csproj"));
        if (files.length === 0) return {};
        const content = readFileSync(join(targetDir, files[0]), "utf-8");
        const deps: Record<string, string> = {};
        const refRe = /<PackageReference\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/g;
        let m: RegExpExecArray | null;
        while ((m = refRe.exec(content)) !== null) {
          deps[m[1]] = m[2] || "*";
        }
        return deps;
      } catch { return {}; }
    }
    case "swift": {
      // Parse Package.swift .package(url:) dependencies
      const pkgPath = join(targetDir, "Package.swift");
      if (!existsSync(pkgPath)) return {};
      try {
        const content = readFileSync(pkgPath, "utf-8");
        const deps: Record<string, string> = {};
        const depRe = /\.package\s*\(\s*url\s*:\s*"([^"]+)"(?:.*?from\s*:\s*"([^"]+)")?/g;
        let m: RegExpExecArray | null;
        while ((m = depRe.exec(content)) !== null) {
          const name = m[1].split("/").pop()?.replace(".git", "") || m[1];
          deps[name] = m[2] || "*";
        }
        return deps;
      } catch { return {}; }
    }
    default:
      return {};
  }
}

// ── Full scan ──

export function scan(targetDir: string, explicitScope?: string): ScanResult {
  const language = detectLanguage(targetDir);
  const { scope, changedFiles, gitDiff } = detectScope(targetDir, explicitScope);

  const allSourceFiles = findSourceFiles(targetDir, language);
  const existingTests = findTestFiles(targetDir, language);

  // For non-full scopes, filter source files to changed + their imports
  let sourceFiles: string[];
  if (scope === "full" || changedFiles.length === 0) {
    sourceFiles = allSourceFiles;
  } else {
    // Include changed files + all source files (for import context)
    // The agent will focus on changed files, but needs to see imports
    const exts = extensionsForLanguage(language);
    const changedSourceFiles = changedFiles.filter((f) =>
      exts.some((ext) => f.endsWith(ext)),
    );
    sourceFiles = [...new Set([...changedSourceFiles, ...allSourceFiles])];
  }

  const apiSurface = extractApiSurface(targetDir, sourceFiles, language);
  const dependencies = readDependencies(targetDir, language);

  // Read all source file contents
  const sourceContents: Record<string, string> = {};
  for (const file of sourceFiles) {
    try {
      sourceContents[file] = readFileSync(join(targetDir, file), "utf-8");
    } catch {
      // skip unreadable
    }
  }

  return {
    language,
    scope,
    changedFiles,
    sourceFiles,
    sourceContents,
    apiSurface,
    dependencies,
    existingTests,
    gitDiff,
  };
}
