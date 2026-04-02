# Sentinel

Host-model-powered four-perspective testing workflow for small-to-mid codebases. Sentinel scans the full current checkout, isolates PM/System/User/Hacker phases with strict artifact boundaries, helps the host coding agent generate runnable tests, and packages host-run failures into a structured T-tier reporting pass.

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

The PM doesn't know what the Hacker will attack. The Hacker can't see what it generated as the Tester. Sentinel's isolation comes from strict artifact boundaries and phase-specific visibility, not from scrambling the code context.

## Key Features

### Host-Executed Tests
Sentinel does not execute tests through MCP or the OpenClaw plugin. The host coding agent writes the generated test files into its own workspace, runs them with its own terminal or sandbox, and passes raw failure evidence back to Sentinel.

### Final T-Tier Report Input
After the host run finishes, call `sentinel_report` with raw failure items:

- `test_name`
- `failure_type`
- `error_message`

Sentinel formats a strict T-tier reporting input so the host model can judge each failure item one at a time from concrete evidence instead of vague summaries.

### Market Research
When the host model has GitHub or web tools available, the PM phase can do market research before writing criteria: compare competing projects, read their Issues/PRs, and surface risks that are specific to this product category instead of falling back to a generic checklist.

### Island Algorithm
PM and Hacker phases use isolated cabins (inspired by [BugBot](https://cursor.com/bugbot) + [Strix](https://github.com/usestrix/strix)):

```
Round 1:  6 focused cabins explore independently, each within its own constrained attack lane
    |
Cross:    Chain findings across cabins ("A found X accepts garbage + B found Y trusts X's output = chain attack")
    |
Round 2:  Dig deeper into the most dangerous chains (narrower focus each round)
    |
Converge: Stop when < 2 new findings (max 3 rounds)
```

### Configuration
Sentinel proposes timeouts, concurrency limits, and island rounds from language, file count, API surface, and machine characteristics. You confirm before the PM/test/hack phases begin.

### Mainstream Ecosystem Coverage
Sentinel targets mainstream stacks rather than every niche toolchain:

- TypeScript / JavaScript: `npm`, `pnpm`, `yarn`, `bun` + vitest
- Python: `pip`, `poetry`, `pdm`, `uv` + pytest
- Java: Maven / Gradle, including `mvnw` / `gradlew`
- Go, Rust, C#, Swift, Ruby: native mainstream test runners

## Supported Languages

| Language | Detection | Mainstream Runner Path | API Extraction |
|----------|-----------|------------------------|----------------|
| TypeScript | `tsconfig.json` | vitest via `npm` / `pnpm` / `yarn` / `bun` | regex-based `export function/class/const` |
| JavaScript | file extension count | vitest via `npm` / `pnpm` / `yarn` / `bun` | regex-based `export function/class/const` |
| Python | `pyproject.toml` / `setup.py` | pytest via `pip` / `poetry` / `pdm` / `uv` | regex-based top-level `def`/`class` |
| Go | `go.mod` | `go test` | regex-based capitalized `func`/`type` |
| Rust | `Cargo.toml` | `cargo test` | regex-based `pub fn`/`struct`/`trait` |
| Java | `pom.xml` / `build.gradle` | Maven / Gradle, including `mvnw` / `gradlew` | regex-based `public class`/`method` |
| C# | `.csproj` / `.sln` | `dotnet test` (xunit) | regex-based `public class`/`method` |
| Swift | `Package.swift` | `swift test` | regex-based `public func`/`class`/`protocol` |
| Ruby | `Gemfile` | rspec | regex-based top-level `class`/`def` |

## Usage

### MCP Server (recommended)

Sentinel works as an MCP server with any compatible AI coding tool. Install once, then use:

`sentinel_scan` → `sentinel_config` → `sentinel_pm` → `sentinel_test` → `sentinel_hack` → host coding agent writes + runs tests → `sentinel_report`

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
      "type": "stdio",
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


### As an OpenClaw plugin

```json
{
  "openclaw": {
    "extensions": ["sentinel"]
  }
}
```

Then use the tools: `sentinel_scan` → `sentinel_config` → `sentinel_pm` → `sentinel_test` → `sentinel_hack`

### As a library (advanced)

```typescript
import { scan } from "sentinel/lib/detect";
import { formatScanContext, formatTierReportInput } from "sentinel/lib/reporter";

const scanResult = scan("/path/to/project");
console.log(formatScanContext(scanResult));

const tierReportInput = formatTierReportInput({
  failures: [
    {
      testName: "should reject invalid session tokens",
      failureType: "runtime",
      errorMessage: "Expected 401 but received 500"
    }
  ]
});

console.log(tierReportInput);
```

The low-level workspace and executor helpers still exist for advanced embedding, but the MCP server and OpenClaw plugin do not execute tests for you.

## Pipeline

```
MCP server                                OpenClaw plugin
──────────                                ──────────────
sentinel_scan                       ←→    sentinel_scan
sentinel_config                            sentinel_config
sentinel_pm → test → hack           ←→    sentinel_pm → test → hack
      ↓                                          ↓
host coding agent writes + runs tests    host coding agent writes + runs tests
      ↓                                          ↓
sentinel_report                     ←→    sentinel_report
      ↓                                          ↓
host model produces final T-tier report    host model produces final T-tier report
```

Sentinel does not expose a standalone CLI. The supported entry points are the MCP server and the OpenClaw plugin.

## Demo

Tested on [memgraph-plugin](https://github.com/lilyhuang-github/memgraph-plugin) (LLM memory plugin, 6 files, 17 exports):

| Round | Bug | Found By |
|-------|-----|----------|
| 1 | `cosineSimilarity` silently returns wrong result for mismatched vectors | Hacker + UX Tester |
| 1 | `addMemos` Unicode zero-width chars bypass deduplication | Hacker |
| 2 | `checkContext` runs embed() on every prompt — hidden token waste | PM (after market research) |
| 2 | `stripRecallTags` nested tags bypass cleanup — injection vector | Research-driven test |
| 2 | `stripRecallTags` unclosed tags leak content | UX Tester |

53 tests, 5 bugs found and fixed. Round 2 bugs were only caught after host-assisted market research surfaced category-specific failure modes.

## Architecture

```
server.ts             — MCP server (Claude Code, Cursor, Windsurf, VS Code Copilot)
index.ts              — OpenClaw plugin (tool registration, prompts, island algorithm)
lib/detect.ts         — Language detection, full-repo scan, API surface extraction (9 languages, regex-based)
lib/runners.ts        — Mainstream runner resolution (`npm/pnpm/yarn/bun`, `pip/poetry/pdm/uv`, Maven/Gradle + wrappers)
lib/config.ts         — Configuration proposal (project size × language × environment)
lib/workspace.ts      — Isolated full-copy workspace, safe filtering, safe test-file writes
lib/executor.ts       — Test execution + deterministic failure extraction
lib/reporter.ts       — Scan context formatting + final T-tier report input builder
lib/isolation.ts      — Artifact vault for PM / tester / hacker cabin boundaries
lib/process_env.ts    — Minimized process environment for installs and test runs
lib/concurrency.ts    — Semaphore-based concurrency and async exec
```

## Acknowledgments

- Island algorithm combines parallel passes with strict artifact isolation and single-skill focused sub-agents
- Hacker methodology informed by [Shannon](https://github.com/KeygraphHQ/shannon) (white-box CPG approach) and [PentAGI](https://github.com/vxcontrol/pentagi) (multi-agent + knowledge graph)

## License

MIT
