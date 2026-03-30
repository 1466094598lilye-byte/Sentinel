# Sentinel

Four-perspective AI testing agent. Throw any codebase at it — TypeScript, Python, Go, Rust, Java, C#, Swift, Ruby — and it generates + runs tests from four independent viewpoints that catch what single-pass testing misses.

## The Problem

AI-generated tests have a blind spot problem. Ask one LLM to "test this code" and you get shallow, predictable tests that miss the bugs users actually hit. The same model has the same blind spots every time.

## How Sentinel Solves It

Four perspectives, each isolated from the others:

| Perspective | Role | Question It Answers |
|-------------|------|---------------------|
| **PM** | Product Manager | "Would a real user tolerate this?" — data loss, hidden token costs, UX friction |
| **System Tester** | QA Engineer | "Does the code work?" — functional correctness, edge cases, contracts |
| **User Tester** | UX Engineer | "Does it meet the PM's thresholds?" — response time >1s = FAIL, error quality, resource waste |
| **Hacker** | Attacker | "Can I break it?" — data poisoning, silent wrong answers, injection, resource exhaustion |

The PM doesn't know what the Hacker will attack. The Hacker can't see what it generated as the Tester. Each sees the code in a **different randomized order**. This breaks the "same LLM, same blind spots" collapse.

## Key Features

### Market Research
Before writing criteria, the PM **searches GitHub for competing projects**, reads their Issues/PRs, and extracts risks specific to this product category. Testing an LLM memory plugin? The PM finds mem0's token explosion bug (#2066) and checks if your code has the same problem. No generic checklists.

### Island Algorithm
PM and Hacker phases use isolated sub-agents (inspired by [BugBot](https://cursor.com/bugbot) + [Strix](https://github.com/usestrix/strix)):

```
Round 1:  6 sub-agents explore independently, each with randomized code order
    |
Cross:    Chain findings across sub-agents ("A found X accepts garbage + B found Y trusts X's output = chain attack")
    |
Round 2:  Dig deeper into the most dangerous chains (narrower focus each round)
    |
Converge: Stop when < 2 new findings (max 3 rounds)
```

### Traffic Light Triage
Failures auto-classified by severity:

| Light | Meaning | Triggers |
|-------|---------|----------|
| **RED** | Fix now | T1/T2 failures, silent wrong answers, injection vectors, critical competitive risks |
| **YLW** | Fix soon | T3 failures, state corruption, resource exhaustion |
| **GRN** | Fix later | T4 failures, warnings |

### Smart Config
Scan detects your project size, language build speed, machine specs, and environment (local/CI), then proposes timeouts, concurrency limits, and island rounds. You confirm before anything runs.

## Supported Languages

| Language | Detection | Test Runner | API Extraction |
|----------|-----------|-------------|----------------|
| TypeScript | `tsconfig.json` | vitest | `export function/class/const` |
| JavaScript | file extension count | vitest | `export function/class/const` |
| Python | `pyproject.toml` / `setup.py` | pytest | top-level `def`/`class` |
| Go | `go.mod` | `go test` | capitalized `func`/`type` |
| Rust | `Cargo.toml` | `cargo test` | `pub fn`/`struct`/`trait` |
| Java | `pom.xml` / `build.gradle` | Maven / Gradle | `public class`/`method` |
| C# | `.csproj` / `.sln` | `dotnet test` (xunit) | `public class`/`method` |
| Swift | `Package.swift` | `swift test` | `public func`/`class`/`protocol` |
| Ruby | `Gemfile` | rspec | top-level `class`/`def` |

## Usage

### MCP Server (recommended)

Sentinel works as an MCP server with any compatible AI coding tool. Install once, then use `sentinel_scan` → `sentinel_pm` → `sentinel_test` → `sentinel_hack` → `sentinel_run` from your editor.

#### Claude Code

Use `--scope user` so Sentinel is available across all projects (Claude Code's default local scope only works from the exact directory where the command was run):

```bash
claude mcp add --scope user sentinel -- npx tsx /path/to/sentinel/server.ts
```

> **Note:** `--scope local` (the default) registers the server under the current directory and only activates when Claude Code is opened in that exact path. Since Sentinel tests any project, `--scope user` is required.

#### Cursor

**Global** (works in all workspaces) — add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "npx",
      "args": ["tsx", "/path/to/sentinel/server.ts"]
    }
  }
}
```

**Per-project** (works only in that project) — add to `.cursor/mcp.json` at your project root. Unlike Claude Code, Cursor does not restrict by exact path; any workspace that contains the file will load the server.

#### Windsurf

Add to `~/.codeium/windsurf/mcp_config.json` (global — Windsurf has no project-level MCP scoping):

```json
{
  "mcpServers": {
    "sentinel": {
      "command": "npx",
      "args": ["tsx", "/path/to/sentinel/server.ts"]
    }
  }
}
```

#### VS Code Copilot

**Global** (works in all workspaces) — open the Command Palette → "MCP: Open User Configuration" and add:

```json
{
  "servers": {
    "sentinel": {
      "type": "stdio",
      "command": "npx",
      "args": ["tsx", "/path/to/sentinel/server.ts"]
    }
  }
}
```

**Per-workspace** — add to `.vscode/mcp.json` at your project root. Unlike Claude Code, VS Code does not restrict by exact path; any workspace containing the file will load the server.


| Command | What it does |
|---------|-------------|
| `sentinel <target>` | Auto: scan, then run if `__sentinel__/` exists |
| `sentinel scan <target>` | Print project context + proposed config |
| `sentinel run <target>` | Execute tests, write `sentinel-report.md` |
| `sentinel context <target>` | Print prompts for manual LLM use |

| Flag | Description |
|------|-------------|
| `--scope <commit\|branch\|changes\|full>` | Override auto-detected git scope |
| `--tests <dir>` | Custom test directory (default: `__sentinel__/`) |
| `--save` | Copy test files back to project after run |
| `--json` | JSON output for CI pipelines |
| `--timeout <ms>` | Test execution timeout (default: 300000) |

### As an OpenClaw plugin

```json
{
  "openclaw": {
    "extensions": ["sentinel"]
  }
}
```

Then use the tools: `sentinel_scan` → `sentinel_config` → `sentinel_pm` → `sentinel_test` → `sentinel_hack` → `sentinel_run`

### As a library

```typescript
import { scan } from "sentinel/lib/detect";
import { createWorkspace, installDeps, writeTestFiles, destroyWorkspace } from "sentinel/lib/workspace";
import { runTests } from "sentinel/lib/executor";
import { formatReport } from "sentinel/lib/reporter";

const result = scan("/path/to/project");
const ws = createWorkspace("/path/to/project", result.language);
await installDeps(ws);
writeTestFiles(ws, { "my.test.ts": testCode });
const report = formatReport(result, await runTests(ws));
console.log(report.summary);
destroyWorkspace(ws);
```

## Pipeline

```
MCP server                    OpenClaw plugin
──────────                    ──────────────
sentinel_scan           ←→    sentinel_scan
sentinel_config                sentinel_config
sentinel_pm → test → hack ←→  sentinel_pm → test → hack
sentinel_run            ←→    sentinel_run
      ↓                              ↓
(inline report)               (inline report)
```

## Demo

Tested on [memgraph-plugin](https://github.com/lilyhuang-github/memgraph-plugin) (LLM memory plugin, 6 files, 17 exports):

| Round | Bug | Found By |
|-------|-----|----------|
| 1 | `cosineSimilarity` silently returns wrong result for mismatched vectors | Hacker + UX Tester |
| 1 | `addMemos` Unicode zero-width chars bypass deduplication | Hacker |
| 2 | `checkContext` runs embed() on every prompt — hidden token waste | PM (after market research) |
| 2 | `stripRecallTags` nested tags bypass cleanup — injection vector | Research-driven test |
| 2 | `stripRecallTags` unclosed tags leak content | UX Tester |

53 tests, 5 bugs found and fixed. Round 2 bugs were only caught **after adding market research** — the PM found them by learning from mem0 and Langchain's GitHub Issues.

## Architecture

```
server.ts             — MCP server (Claude Code, Cursor, Windsurf, VS Code Copilot)
index.ts              — OpenClaw plugin (tool registration, prompts, island algorithm)
lib/detect.ts         — Language detection, git scope, API surface extraction (9 languages)
lib/runners.ts        — Per-language runner config table (install, test, cache isolation)
lib/config.ts         — Smart config proposal (project size × language × environment)
lib/workspace.ts      — Isolated workspace (copy, install, bootstrap C#/Swift, cleanup)
lib/executor.ts       — Test execution + output parsing (vitest/pytest/go/cargo/maven/gradle/dotnet/swift/rspec)
lib/reporter.ts       — Triage report (RED/YLW/GRN), shuffled context for island diversity
lib/concurrency.ts    — Semaphore-based concurrency, async exec, configurable limits
```

## Acknowledgments

- Git scope auto-detection (commit/branch/full) inspired by [expect-cli](https://github.com/anthropics/anthropic-cookbook/tree/main/misc/expect-cli)
- Island algorithm combines ideas from [BugBot](https://cursor.com/bugbot) (randomized parallel passes) and [Strix](https://github.com/usestrix/strix) (single-skill focused sub-agents), applied through an island model evolutionary framework
- Hacker methodology informed by [Shannon](https://github.com/KeygraphHQ/shannon) (white-box CPG approach) and [PentAGI](https://github.com/vxcontrol/pentagi) (multi-agent + knowledge graph)

## License

MIT
