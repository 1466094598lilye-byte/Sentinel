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

### As an OpenClaw plugin

```json
{
  "openclaw": {
    "extensions": ["sentinel"]
  }
}
```

Then use the tools: `sentinel_scan` → `sentinel_pm` → `sentinel_test` → `sentinel_hack` → `sentinel_run`

### As a library

```typescript
import { scan } from "sentinel/lib/detect";
import { proposeConfig } from "sentinel/lib/config";
import { createWorkspace, installDeps, writeTestFiles, destroyWorkspace } from "sentinel/lib/workspace";
import { runTests } from "sentinel/lib/executor";
import { formatReport } from "sentinel/lib/reporter";

// 1. Scan the target project
const result = scan("/path/to/any/project");
const config = proposeConfig(result);

// 2. Create isolated workspace + run tests
const ws = createWorkspace("/path/to/any/project", result.language);
await installDeps(ws);
writeTestFiles(ws, { "my.test.ts": testCode });
const testResult = await runTests(ws);

// 3. Get triaged report
const report = formatReport(result, testResult);
console.log(report.summary);  // RED/YLW/GRN classified
destroyWorkspace(ws);
```

### With any AI agent

Sentinel's prompts (PM, Tester, Hacker) are plain text templates. You can feed them to any LLM — Claude, GPT, Gemini, local models — and pipe the output back through `sentinel_run` to execute the generated tests. The island algorithm works with any model.

## Pipeline

```
sentinel_scan    →  Detect language, extract API surface, propose config
sentinel_config  →  User confirms timeouts, concurrency, island rounds
sentinel_pm      →  Market research → 4-tier island analysis → cross-pollinate → merge
sentinel_test    →  System Tester (correctness) + User Tester (PM thresholds → runnable tests)
sentinel_hack    →  6-skill island attack → cross-pollinate chains → merge
sentinel_run     →  Execute in isolated workspace, return triaged RED/YLW/GRN report
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
index.ts              — Tool registration, prompts, island algorithm orchestration
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
- Island algorithm concept drawn from [BugBot](https://cursor.com/bugbot) (multi-pass + majority voting) and [Strix](https://github.com/usestrix/strix) (skill injection)
- Hacker methodology informed by [Shannon](https://github.com/KeygraphHQ/shannon) (white-box CPG approach) and [PentAGI](https://github.com/vxcontrol/pentagi) (multi-agent + knowledge graph)

## License

MIT
