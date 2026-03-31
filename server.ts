#!/usr/bin/env npx tsx
/**
 * Sentinel MCP Server — AI testing agent.
 *
 * Works with any MCP-compatible host: Claude Code, Cursor, Windsurf, VS Code Copilot.
 *
 * Four-perspective testing with Island Algorithm:
 *   1. sentinel_scan  — Scan project, return context + source code
 *   2. sentinel_pm    — PM defines UX acceptance criteria (island algorithm, 4 tiers)
 *   3. sentinel_test  — Dual Tester: system (correctness) + user (UX criteria)
 *   4. sentinel_hack  — Hacker finds what everyone missed (island algorithm, 6 skills)
 *   5. sentinel_run   — Execute merged test files, return structured results
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import { scan } from "./lib/detect.js";
import { createWorkspace, installDeps, writeTestFiles, destroyWorkspace, saveTestFiles } from "./lib/workspace.js";
import { runTests } from "./lib/executor.js";
import { formatReport, formatScanContext, formatScanContextShuffled, formatFailureContext } from "./lib/reporter.js";
import { proposeConfig, formatConfigProposal, setConfig, clearConfig } from "./lib/config.js";
import { syncSemaphores } from "./lib/concurrency.js";
import { detectProvider } from "./lib/llm.js";
import type { SentinelConfig } from "./lib/config.js";
import type { ScanResult } from "./lib/detect.js";
import type { Workspace } from "./lib/workspace.js";

// ── State ──
const activeWorkspaces = new Map<string, Workspace>();
const lastScanResults = new Map<string, ScanResult>();
const pendingScan = new Map<string, { result: ScanResult; scope?: string }>();
const lastIntent = new Map<string, string>();
const lastPMCriteria = new Map<string, string>();
const lastTesterPlan = new Map<string, string>();
const hackRound = new Map<string, number>();
const pmRound = new Map<string, number>();
const pmResearch = new Map<string, string>();

const SESSION = "default"; // MCP is single-session via stdio

// djb2 hash for seeded shuffle
function djb2Hash(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

// ── Scope guidance ──
const SCOPE_GUIDANCE: Record<string, string> = {
  commit: "Scope is COMMIT (uncommitted changes only). Generate 2-4 focused tests per changed function. Only test the changed code and its direct callers.",
  branch: "Scope is BRANCH (all changes since diverged from main). Generate 5-8 tests per changed module, including edge cases and negative tests.",
  changes: "Scope is CHANGES (specific files). Generate 3-5 tests per changed function, covering happy path and key edge cases.",
  full: "Scope is FULL (entire project). Generate comprehensive tests across all 6 categories: Functional, Boundary, Stability, Recovery, Integration, Resource.",
};

// ══════════════════════════════════════════
// PM Prompt Components
// ══════════════════════════════════════════

const PM_RESEARCH_PROMPT = `
You are a senior Product Manager doing competitive research BEFORE defining acceptance criteria.

## Your task
1. Read the project description, README, dependencies, and API surface below.
2. Determine WHAT KIND of product this is (e.g. "LLM memory plugin", "REST framework", "CLI tool", "ORM").
3. Search GitHub for 3-5 similar/competing projects in this category.
4. For each competitor, look at their GitHub Issues and Pull Requests — focus on:
   - Bug reports with the most reactions/comments (= real user pain)
   - Issues tagged "bug", "performance", "breaking", "data-loss"
   - PRs that fix critical bugs (what was the bug?)
   - Discussions about architectural decisions and their tradeoffs
5. Extract a **Category Risk Profile** — the pain points that are SPECIFIC to this type of product.

## Output format

### Product Category
One sentence: "This is a [category] that [does what]."

### Competitors Analyzed
For each competitor:
- Name + GitHub URL
- Stars / activity level
- Top 3 pain points from their Issues/PRs (with issue numbers if possible)

### Category Risk Profile
A ranked list of risks that are SPECIFIC to this product category:
[CR-1] Risk name — description, which competitor(s) hit this, severity
[CR-2] ...

These are the risks that the generic PM checklist would MISS because they're domain-specific.

## Rules
- You MUST actually search GitHub — don't guess what competitors exist.
- Focus on Issues/PRs, not feature lists — we want to know what BROKE, not what was promised.
- The Category Risk Profile is the most important output — it feeds into all subsequent PM tiers.
- Minimum 5 category-specific risks.

After generating, call sentinel_pm with tier="research" and tierResults=<your full research output>.
`;

const PM_PREAMBLE = `
You are a senior Product Manager specializing in **{TIER_NAME}**.
You have deep UX research expertise — Nielsen's thresholds, the Doherty 400ms threshold,
Hertzum 2023 (84% of frustrations are recurring), Gloria Mark's 23-minute flow cost.

Your SOLE focus this round: {TIER_GOAL}

## Category-Specific Risks (from competitive research)
The following risks are SPECIFIC to this type of product. Check for ALL of them in addition
to the standard tier checklist:
{RESEARCH_CONTEXT}

Analyze the API surface below. Walk through EVERY exported function and ask:
"Would a real user tolerate this?"
`;

interface PMTier {
  id: number;
  name: string;
  goal: string;
  prompt: string;
}

const PM_TIERS: PMTier[] = [
  {
    id: 1,
    name: "IMMEDIATE ABANDONMENT",
    goal: "Find anything that makes a user leave forever after ONE incident.",
    prompt: `Check every function for:
- **Data loss paths**: can user work be destroyed? Can a crash/error lose unsaved state?
- **Silent financial cost**: does anything consume paid resources (API tokens, credits, bandwidth) without user awareness? Estimate cost per operation.
- **Context window pollution**: does anything inject content into an LLM's context/prompt? If so: how many tokens per injection? Is it always relevant, or does it fire indiscriminately? Unnecessary context injection = the CALLER pays for wasted tokens on every single interaction.
- **Hot-path compute waste**: are there expensive operations (ML inference, embedding, API calls) that run on EVERY interaction regardless of whether their output is needed? Look for: hooks/middleware that fire unconditionally, lazy patterns that should be conditional.
- **Dead ends**: are there error states with no recovery path? Can the user get permanently stuck?
- **Trust betrayal**: does the code promise something (in docs, names, types) it doesn't deliver?
- **Security exposure**: can user credentials, tokens, or PII leak through any code path?

For each risk, write a FAIL criterion with a concrete threshold:
Example: "If a single call consumes >$0.01 in tokens without user confirmation → FAIL"
Example: "If any error state requires restart to recover → FAIL"
Example: "If a hook injects >500 tokens into context without checking relevance first → FAIL"
Example: "If embed() is called on every prompt regardless of whether recall is needed → FAIL"`,
  },
  {
    id: 2,
    name: "RAPID TRUST EROSION",
    goal: "Find anything that breaks user trust within 1-3 incidents.",
    prompt: `Check every function for:
- **Implementation leakage**: do error messages expose stack traces, DB errors, internal IDs, file paths?
- **Behavioral inconsistency**: can the same input produce different outputs across calls?
- **Documentation mismatch**: does the function signature/comments promise something the code doesn't do?
- **Silent wrong answers**: can the function return confident but incorrect results?
- **Mode confusion**: does the same action mean different things depending on hidden state?

For each risk, write a FAIL criterion:
Example: "If any user-facing error contains a file path or line number → FAIL"
Example: "If function X returns different results for identical inputs → FAIL"`,
  },
  {
    id: 3,
    name: "CUMULATIVE FRUSTRATION",
    goal: "Find anything that slowly drains user patience — apply quantitative thresholds.",
    prompt: `Check every function against these QUANTITATIVE thresholds:
- **Response time**: any user-initiated operation >1s without progress feedback → FAIL
- **Response time**: any operation >400ms that could be cached/optimized → WARNING
- **Cognitive load**: any function requiring >7 parameters → FAIL
- **Cognitive load**: any function where parameter names don't explain their purpose → WARNING
- **Workflow steps**: any task requiring >5 steps that could be fewer → WARNING
- **Error quality**: any error message that isn't (specific + actionable + non-blaming) → FAIL
- **Retry behavior**: any operation that silently fails without retry or clear error → FAIL
- **Flow interruption**: any forced modal/prompt/confirmation that could be avoided → WARNING
- **Per-interaction overhead**: any hook/middleware that adds >50ms of compute to EVERY interaction even when its output is unused → FAIL
- **Output proportionality**: any function that returns 10x more data than the caller needs → WARNING

Measure concretely. Not "should be fast" but ">1s = FAIL".`,
  },
  {
    id: 4,
    name: "BACKGROUND DISSATISFACTION",
    goal: "Find anything that silently drives users away over time.",
    prompt: `Check every function for:
- **Resource trends**: does memory/file-handle/connection usage grow unboundedly over time? Test with 1000 repeated calls.
- **Resource proportionality**: is consumption proportional to input size? Can small inputs trigger disproportionate resource use?
- **Documentation rot**: do function signatures, comments, and README match actual behavior?
- **Accessibility assumptions**: hardcoded locale, encoding, timezone, screen size assumptions?
- **Dependency health**: are dependencies up-to-date? Are there known CVEs?
- **Graceful degradation**: when external services are slow/down, does the system degrade gracefully or crash?

For each risk, write a WARNING or FAIL criterion:
Example: "If memory grows >10MB after 1000 calls with small inputs → FAIL"
Example: "If any function assumes UTF-8 without handling other encodings → WARNING"`,
  },
];

const PM_OUTPUT_FORMAT = `
## Output format:
[PM][Tier {TIER_ID}] target_function_or_component — criterion name
- What to check: specific condition to test
- Threshold: concrete pass/fail number or condition
- Why users care: one sentence connecting to real user behavior
- Severity: FAIL (must fix) or WARNING (should fix)

## Constraints:
- Walk through the API surface SYSTEMATICALLY for this tier.
- Produce at least 3 criteria for THIS tier.
- Every criterion MUST have a concrete, testable threshold.
- Think about the REAL user — who are they? What are they trying to do?
`;

const PM_CROSS_PROMPT = `
You are a senior PM reviewing findings from 4 specialized UX analysts.
Each analyst focused on ONE frustration tier and worked independently.

## All findings from Round {ROUND}:
{TIER_RESULTS}

## Your mission: CROSS-TIER ESCALATION
1. **Escalation**: A T4 issue that under load becomes a T1 issue.
2. **Compounding**: A T3 issue combined with a T2 issue = user gives up entirely (T1).
3. **Hidden T1s**: Issues classified as T3/T4 that are actually T1 under specific conditions.
4. **Indirect cost chains**: A T3 per-interaction overhead that injects content into LLM context = T1 silent token cost.

## Rules:
- Every cross-tier finding must reference ≥2 original tier findings
- Show the escalation chain: "T4 finding X + T3 finding Y = T1 scenario Z"
- Produce at least 3 NEW cross-tier criteria
- Report: "N new cross-tier criteria found" (< 2 = converge, ≥ 2 = another round, max 3 rounds)

## Output format:
[PM][Cross T{A}→T{B}] component — criterion name
- Escalation chain: T{A} finding + T{B} finding → combined impact
- Threshold: concrete pass/fail condition for the combined scenario
- Why this is worse than either alone: one sentence
`;

const PM_MERGE_PROMPT = `
You are merging the complete PM criteria from all rounds.

## All PM criteria (individual tiers + cross-tier):
{ALL_RESULTS}

## Merge rules:
- Deduplicate criteria that test the same thing
- If a cross-tier finding supersedes individual tier findings, keep the cross-tier version
- Ensure every tier has at least 3 criteria
- Tag each: [PM][Tier N] or [PM][Cross]
- Show stats: "X criteria total: T1=a, T2=b, T3=c, T4=d, Cross=e"

Present the merged PM criteria. After approval, call sentinel_pm with tier="done" and the full criteria to proceed to the Tester phase.
`;

const PM_PROMPT_LEGACY = [
  `You are a senior PM with deep UX research expertise.`,
  `Analyze this codebase and define acceptance criteria across ALL 4 tiers:\n`,
  ...PM_TIERS.map((t) => `### Tier ${t.id} — ${t.name}\n${t.prompt}`),
  `\n` + PM_OUTPUT_FORMAT.replace("{TIER_ID}", "N"),
  `\nYou must produce at least 3 criteria per tier (12+ total).`,
  `Present criteria to user. After approval, call sentinel_pm with the criteria.`,
].join("\n");

// ══════════════════════════════════════════
// System Tester Prompt
// ══════════════════════════════════════════

const SYSTEM_TESTER_PROMPT = `
You are a senior QA engineer focused on **code correctness**.
You see ONLY the source code and API surface. You do NOT see UX criteria — that's another tester's job.

Your job: generate **runnable test code** that validates whether this code is **functionally correct**.

## Focus areas:
- Does each function do what its signature/name promises?
- Are all documented behaviors correct?
- Do components integrate correctly?
- Are edge cases at documented boundaries handled?
- Are error paths handled gracefully?
- Are type contracts honored?

Categories: Functional, Boundary, Stability, Recovery, Integration, Resource

## CRITICAL — Assertion Direction Rules
Every test MUST assert the CORRECT/DESIRED behavior, NOT the current (possibly broken) behavior.

✅ CORRECT — assert what SHOULD happen:
  expect(() => fn(NaN)).toThrow()           // dangerous input SHOULD be rejected
  expect(result).not.toContain('injected')  // injection SHOULD be blocked
  expect(Number.isNaN(result)).toBe(false)  // NaN SHOULD NOT propagate silently

❌ WRONG — asserts that the bug exists (test passes on broken code):
  expect(() => fn(NaN)).not.toThrow()       // "it doesn't throw" — that's the bug!
  expect(result).toContain('injected')      // "injection works" — that's the vulnerability!
  expect(Number.isNaN(result)).toBe(true)   // "it returns NaN" — that's the corruption!

If the code currently has a bug, the test MUST FAIL. A passing test suite with known bugs is worthless.

## Output format
Output a COMPLETE, RUNNABLE test file. Use the test runner detected for this project.
- Use real imports from the target source code
- Each test must be independent (no shared mutable state)
- Include describe blocks with [T-Sys] prefix for traceability
- Do NOT output a plan or description — output ONLY executable test code

Present the test code to the user. After approval, it will be passed to sentinel_run.
`;

// ══════════════════════════════════════════
// User Tester Prompt
// ══════════════════════════════════════════

const USER_TESTER_PROMPT = `
You are a UX test engineer. Your job is to translate PM acceptance criteria into **runnable test code**.

You do NOT test correctness — the System Tester handles that.
You ONLY test whether the code meets the PM's quantitative UX thresholds.

## PM Acceptance Criteria (you MUST write a test for EVERY criterion below):
{PM_CRITERIA}

## How to translate each criterion into a test:
- PM says ">1s = FAIL" → write a test that times the operation and asserts elapsed < 1000ms
- PM says "error must not contain file path" → write a test that triggers an error and asserts the message matches no path pattern
- PM says "memory must not grow >10MB after 1000 calls" → write a test that calls 1000 times and measures heap delta

## CRITICAL — Assertion Direction Rules
Every test MUST assert the DESIRED behavior. If the code violates the PM criterion, the test MUST FAIL.

✅ CORRECT — test fails when PM criterion is violated:
  expect(recallOutput.length).toBeLessThan(5000)  // PM says "no silent token cost >5000"
  expect(elapsed).toBeLessThan(1000)               // PM says ">1s = FAIL"
  expect(defaultEndpoint).not.toContain('deepseek') // PM says "no external API for local plugin"

❌ WRONG — test passes even though PM criterion is violated:
  expect(recallOutput.length).toBeGreaterThan(0)   // "it returns something" — doesn't check the limit!
  expect(true).toBe(true)                          // placeholder — tests nothing!
  expect(defaultEndpoint).toContain('deepseek')    // "it IS deepseek" — confirms the bug exists!

A test that passes on a known violation is worse than no test at all.

## Output format
Output a COMPLETE, RUNNABLE test file. Use the test runner detected for this project.
- Use real imports from the target source code
- Each test must be independent
- Include describe blocks with [T-UX][Tier N] prefix for traceability
- Do NOT output a plan or description — output ONLY executable test code
- Every PM criterion tagged FAIL is MANDATORY
- Every PM criterion tagged WARNING should be covered if feasible

Present the test code to the user. After approval, it will be passed to sentinel_run.
`;

// ══════════════════════════════════════════
// Hacker Prompt Components
// ══════════════════════════════════════════

const HACKER_PREAMBLE = `
You are a black-hat attacker specializing in **{SKILL_NAME}**.
You have the full source code and API surface of a target system.
Your SOLE focus this round: {SKILL_GOAL}

A PM defined acceptance criteria and a QA engineer tested this system.
Find what they BOTH missed — in your specific domain.

## PM criteria (attack T1/T2 concerns harder):
{PM_CRITERIA}

## System Tester plan (correctness tests — find what they didn't cover):
{SYSTEM_PLAN}

## User Tester plan (UX tests — find gaps in their threshold coverage):
{USER_PLAN}

## Your attack surface
The API surface below is your target list. Walk through EVERY function systematically.
`;

interface HackerSkill {
  id: number;
  name: string;
  goal: string;
  prompt: string;
}

const HACKER_SKILLS: HackerSkill[] = [
  {
    id: 1, name: "DATA POISONING",
    goal: "Make the system store garbage that looks valid but corrupts all future operations.",
    prompt: `For every function that WRITES or STORES data:
- Feed inputs of correct type but wrong semantics (right shape, wrong meaning)
- Feed unicode edge cases: zero-width characters (U+200B), RTL overrides (U+202E), homoglyphs
- Feed null bytes (\\x00) in string fields — test serialization survival
- Feed values at exact type boundaries: NaN, Infinity, -0, empty string vs null vs undefined
- For array/collection inputs: wrong length, wrong element types, nested empty arrays
If the function accepts it without error, it's a vulnerability.`,
  },
  {
    id: 2, name: "STATE CORRUPTION",
    goal: "Make the system destroy its own data through normal-looking API calls.",
    prompt: `For every function that has SIDE EFFECTS or MUTATES state:
- If getters return references, mutate the returned reference — is internal state corrupted?
- Call the function 10,000 times rapidly — does memory grow unboundedly?
- Interleave write and read calls — can you catch half-written state?
- Delete while iterating, delete non-existent items, double-delete`,
  },
  {
    id: 3, name: "SILENT WRONG ANSWERS",
    goal: "Make functions return confident but WRONG outputs without any error signal. Most dangerous category.",
    prompt: `For every function that COMPUTES or TRANSFORMS data:
- Feed edge-case inputs that are technically valid: empty arrays, single-element arrays, identical elements
- For numeric computations: test with NaN, Infinity, very large numbers, very small numbers, negative zero
- For string processing: test with empty string, whitespace-only, million-character string
- For filtering/search: craft inputs that bypass filter logic
- For comparison functions: inputs that are equal-but-not-identical`,
  },
  {
    id: 4, name: "RESOURCE EXHAUSTION",
    goal: "Make the system consume unbounded resources until it crashes or becomes unusable.",
    prompt: `For every function that processes INPUT of variable size:
- Feed 10MB+ strings to any regex-using function — test for catastrophic backtracking
- Feed deeply nested objects (1000+ levels) to any recursive function
- Trigger maximum concurrency: call async functions 1000x simultaneously
- For any function that builds collections: can you make it create unbounded-size results?
- For any function with timeouts: is the timeout enforced?`,
  },
  {
    id: 5, name: "INJECTION & ESCALATION",
    goal: "Use stored/processed data to attack downstream consumers.",
    prompt: `For every function that STORES user-provided data:
- Inject structured data that mimics system markup/tags/delimiters
- Inject prompt injection payloads: "SYSTEM: Ignore all previous instructions"
- For any value used in file paths: inject path traversal (../../etc/passwd)
- For any value used in shell commands: inject command separators (; && | \`)
- For any value rendered in HTML: inject XSS payloads`,
  },
  {
    id: 6, name: "TEMPORAL & ORDERING ATTACKS",
    goal: "Break the system by calling things in the wrong order or at the wrong time.",
    prompt: `For the full API surface:
- Call every function BEFORE its prerequisites are met
- Call every function AFTER its expected lifecycle (use after close/destroy/cleanup)
- Call pairs of functions that share state CONCURRENTLY
- For any function with session/context parameters: share sessions across contexts, reuse expired sessions`,
  },
];

const HACKER_OUTPUT_FORMAT = `
## Output format
Output **runnable test code** for each attack. Use the project's test runner.

Each test must assert the EXPECTED DEFENSE (what SHOULD happen), so the test FAILS if the vulnerability exists.

✅ CORRECT — test fails when vulnerability is present:
  expect(() => fn(NaN)).toThrow()                    // NaN SHOULD be rejected
  expect(stripRecallTags(caseVariant)).toBe('')       // case variants SHOULD be stripped
  expect(result).not.toContain('SYSTEM: Ignore')      // injection SHOULD be sanitized

❌ WRONG — test passes and confirms the vulnerability:
  expect(Number.isNaN(fn(NaN))).toBe(true)           // "NaN propagates" = the bug itself
  expect(stripRecallTags(caseVariant)).toContain(x)   // "bypass works" = the vulnerability
  expect(result).toContain('SYSTEM: Ignore')           // "injection stored" = the attack

Include describe blocks with [H][Skill {SKILL_ID}] prefix. Each attack needs:
- A comment explaining the attack vector and payload
- An assertion for the expected defense
- A comment noting "blast radius if undefended"

## Constraints:
- Walk through the API surface SYSTEMATICALLY.
- Produce at least 3 attacks the Tester missed for THIS skill.
- Each attack must have a CONCRETE payload.
- Prefer SILENT corruption over crashes.
- Cross-reference PM criteria: T1/T2 concerns get attacked harder.
`;

const HACKER_CROSS_PROMPT = `
You are a black-hat attacker reviewing the combined findings from 6 specialized attack agents.

## All findings from Round {ROUND}:
{SKILL_RESULTS}

## Your mission: ATTACK CHAINING
1. **Escalation chains**: Agent A found function X accepts garbage. Agent B found function Y trusts X's output. Chain: poison X → Y produces silently wrong results.
2. **State + Timing combos**: Race condition + state corruption = unrecoverable mode.
3. **Injection → Impact**: Connect injection points to concrete damage paths.
4. **Resource amplification**: One expensive call triggered in a loop through another finding.

## Rules:
- Every chain must be ≥2 steps
- Show the COMPLETE chain with concrete payloads
- Produce at least 3 NEW chain attacks
- Report: "N new chain attacks found" (<2 = converge)

## Output format
Output **runnable test code** for each chain attack using the project's test runner.
Each test must assert the EXPECTED DEFENSE — test FAILS if the chain vulnerability exists.
Include describe blocks with [H][Chain] prefix.
`;

const HACKER_MERGE_PROMPT = `
You are merging test code from the Tester phase and the Hacker phase into final test files.

## Tester test code:
{TESTER_PLAN}

## All Hacker test code (individual skills + chain attacks):
{ALL_RESULTS}

## Merge rules:
- Keep ALL Tester tests (tag [T])
- Add ALL Hacker attacks as tests (tag [H])
- If a Tester test overlaps with a Hacker attack but the Hacker version is nastier, replace it (tag [T+H])
- Deduplicate tests that assert the same thing
- Show coverage stats: "X from Tester, Y unique from Hacker, Z upgraded, C chain attacks"

## CRITICAL — Assertion Direction Check
Before outputting, review EVERY expect() call. Ask: "Does this test FAIL when the bug exists?"
- If the test would PASS on broken code → flip the assertion
- If the test is a placeholder (expect(true).toBe(true)) → replace with a real assertion or remove

Output the final merged test file(s) as COMPLETE, RUNNABLE code ready for sentinel_run.
Call sentinel_run with the test file contents.
`;

// ══════════════════════════════════════════
// MCP Server Setup
// ══════════════════════════════════════════

const server = new McpServer({
  name: "sentinel",
  version: "0.2.0",
}, {
  capabilities: { tools: {} },
});

// Helper
function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function getGitDiffFingerprint(dir: string): string {
  try {
    return execSync("git diff --name-only HEAD 2>/dev/null && git diff --name-only --cached 2>/dev/null", {
      cwd: dir, encoding: "utf-8", timeout: 5_000,
    }).trim();
  } catch { return ""; }
}

// ══════════════════════════════════════════
// Tool 1: sentinel_scan
// ══════════════════════════════════════════

server.tool(
  "sentinel_scan",
  "Scan a project for testing. Pass intent (one sentence: what is this project for?) to enable intent-gap detection. If intent is not provided, ASK THE USER before proceeding.",
  {
    target: z.string().describe("Absolute path to the project directory to test"),
    scope: z.enum(["commit", "branch", "changes", "full"]).optional().describe("Test scope. If omitted, auto-detected from git state."),
    intent: z.string().optional().describe('One sentence: "What is this project for?" If unknown, ASK the user first.'),
  },
  async ({ target, scope, intent }) => {
    const result = scan(target, scope);

    // ── Gate: no intent → block pipeline, force calibration ──
    if (!intent) {
      // Store scan internally but do NOT expose results to host LLM
      pendingScan.set(SESSION, { result, scope });
      return text([
        `# Calibration Required`,
        "",
        `Sentinel scanned **${result.language}** project (${result.apiSurface.length} exports, ${result.sourceFiles.length} files).`,
        "",
        `Before I can proceed, I need to understand your intent.`,
        "",
        `**Ask the user:** "What is this project for, and why are you testing it?"`,
        "",
        `Then call sentinel_scan again with the same target and \`intent\` set to the user's answer.`,
        "",
        `⛔ sentinel_pm, sentinel_test, sentinel_hack, and sentinel_run will not work until calibration is complete.`,
      ].join("\n"));
    }

    // ── Calibrated path: store results and proceed ──
    lastScanResults.set(SESSION, result);
    lastIntent.set(SESSION, intent);
    pendingScan.delete(SESSION);

    const context = formatScanContext(result);
    const proposed = proposeConfig(result);
    const parts = [context, "", formatConfigProposal(proposed, result)];

    parts.push("", `## Project Intent`, `> ${intent}`);

    return text(parts.join("\n"));
  },
);

// ══════════════════════════════════════════
// Tool 2: sentinel_config
// ══════════════════════════════════════════

server.tool(
  "sentinel_config",
  "Confirm or modify the run configuration proposed by sentinel_scan. Call AFTER scan, BEFORE pm.",
  {
    installTimeout: z.number().optional(),
    testTimeout: z.number().optional(),
    maxIslandRounds: z.number().optional(),
    hackerIslands: z.number().optional(),
    pmIslands: z.number().optional(),
    maxConcurrentTests: z.number().optional(),
    environment: z.enum(["local", "server", "ci"]).optional(),
    sleepProtection: z.boolean().optional(),
    intent: z.string().optional().describe("User's one-line project intent, if not provided during scan."),
  },
  async (params) => {
    if (params.intent) lastIntent.set(SESSION, params.intent);

    const scanResult = lastScanResults.get(SESSION);
    if (!scanResult) return text("Error: No scan result found. Call sentinel_scan first.");

    const proposed = proposeConfig(scanResult);
    const config = { ...proposed, ...params } as SentinelConfig;
    setConfig(config);
    syncSemaphores();

    const scopeGuide = SCOPE_GUIDANCE[scanResult.scope] || SCOPE_GUIDANCE.full;

    // Time estimate based on island algorithm config
    const pmCalls = (config.pmIslands || 4) + 1 + 1; // tiers + cross + merge
    const hackerCalls = (config.hackerIslands || 6) + 1 + 1; // skills + cross + merge
    const testerCalls = 2; // system + user
    const totalCalls = 1 + pmCalls + testerCalls + hackerCalls; // research + PM + testers + hacker
    const rounds = config.maxIslandRounds || 2;
    const perCallSec = 30; // ~30s per LLM call by the host
    const estMin = Math.ceil((totalCalls * rounds * perCallSec) / 60);
    const timeEstimate = `**Estimated time: ~${estMin} min** (${totalCalls} tool calls × ${rounds} max rounds, ~${perCallSec}s each)`;

    return text([
      `## Configuration Confirmed`, "",
      formatConfigProposal(config, scanResult), "",
      timeEstimate, "",
      `---`,
      `Configuration locked. Proceed to the PM phase:`, "",
      `Scope: ${scopeGuide}`, "",
      `**Step 1**: Call sentinel_pm with tier="research" to do competitive analysis first.`,
      `**Step 2**: Then tier=1 through tier=4 for island exploration.`,
      `Or call sentinel_pm without tier for legacy single-pass mode.`,
    ].join("\n"));
  },
);

// ══════════════════════════════════════════
// Tool 3: sentinel_pm — PM Island Algorithm
// ══════════════════════════════════════════

server.tool(
  "sentinel_pm",
  'PM phase with Island Algorithm. Modes: tier=1-4 (focused tier), tier="research" (competitive analysis), tier="cross" (cross-tier escalation), tier="merge" (deduplicate), tier="done" (store and proceed). Omit tier for legacy single-pass.',
  {
    tier: z.string().optional().describe("Tier number (1-4) or mode: research, cross, merge, done"),
    tierResults: z.string().optional().describe("Results from tier passes. Required for cross, merge, done."),
    pmCriteria: z.string().optional().describe("Legacy: the full PM criteria string."),
  },
  async ({ tier: tierRaw, tierResults, pmCriteria }) => {
    const scanResult = lastScanResults.get(SESSION);
    if (!scanResult) return text("Error: No scan result found. Call sentinel_scan first.");

    // Parse tier: could be numeric string "1"-"4" or mode string
    const tierNum = tierRaw ? parseInt(tierRaw, 10) : NaN;
    const tier: number | string | undefined = !tierRaw ? undefined : isNaN(tierNum) ? tierRaw : tierNum;

    // Branch 0: Market research
    if (tier === "research") {
      if (tierResults) {
        pmResearch.set(SESSION, tierResults);
        return text(`# PM Research Stored\n\nCategory risk profile saved. Now call sentinel_pm with tier=1 to begin.`);
      }
      const sourceContext = formatScanContext(scanResult);
      return text([`# PM Market Research Phase`, "", sourceContext, "", PM_RESEARCH_PROMPT].join("\n"));
    }

    // Branch 1: Focused tier pass (1-4)
    if (typeof tier === "number" && tier >= 1 && tier <= 4) {
      const round = pmRound.get(SESSION) || 1;
      const t = PM_TIERS[tier - 1];
      const seed = djb2Hash(`${SESSION}-pm-round${round}-tier${tier}`);
      const shuffledContext = formatScanContextShuffled(scanResult, seed);
      const research = pmResearch.get(SESSION) || "(No competitive research done — consider running tier='research' first)";
      const prompt = PM_PREAMBLE
        .replace("{TIER_NAME}", t.name)
        .replace("{TIER_GOAL}", t.goal)
        .replace("{RESEARCH_CONTEXT}", research);
      const tierSection = `## Analysis focus: Tier ${t.id} — ${t.name}\n${t.prompt}`;
      const outputFmt = PM_OUTPUT_FORMAT.replace("{TIER_ID}", String(t.id));
      const nextHint = tier < 4
        ? `\n\n---\nNext: call sentinel_pm with tier=${tier + 1}.`
        : `\n\n---\nAll 4 tiers complete. Call sentinel_pm with tier="cross" and tierResults=<all 4 results concatenated>.`;

      return text([
        `# PM Island ${tier}/4 (Round ${round}) — ${t.name}`, "",
        shuffledContext, "", prompt, "", tierSection, "", outputFmt, nextHint,
      ].join("\n"));
    }

    // Branch 2: Cross-tier escalation
    if (tier === "cross") {
      if (!tierResults) return text("Error: tier='cross' requires tierResults parameter.");
      const round = pmRound.get(SESSION) || 1;
      const crossPrompt = PM_CROSS_PROMPT.replace("{ROUND}", String(round)).replace("{TIER_RESULTS}", tierResults);
      const nextHint = [
        "", "---",
        `Count your NEW cross-tier findings.`,
        `- ≥ 2 new: call sentinel_pm with tier=1 for Round ${round + 1}.`,
        `- < 2 new: CONVERGE. Call sentinel_pm with tier="merge" and tierResults=<everything>.`,
        round >= 3 ? `- **Round 3 reached — MUST converge. Call tier="merge" next.**` : "",
      ].join("\n");
      pmRound.set(SESSION, round + 1);
      return text([`# PM Cross-Tier Escalation — Round ${round}`, "", crossPrompt, nextHint].join("\n"));
    }

    // Branch 3: Merge
    if (tier === "merge") {
      if (!tierResults) return text("Error: tier='merge' requires tierResults parameter.");
      pmRound.delete(SESSION);
      return text([`# PM Criteria Merge`, "", PM_MERGE_PROMPT.replace("{ALL_RESULTS}", tierResults)].join("\n"));
    }

    // Branch 4: Done
    if (tier === "done") {
      if (!tierResults) return text("Error: tier='done' requires tierResults with the final merged PM criteria.");
      lastPMCriteria.set(SESSION, tierResults);
      return text([
        `# PM Phase Complete — Proceed to Dual Tester Phase`, "",
        `PM criteria stored (${tierResults.length} chars).`, "",
        `**System Tester**: Call sentinel_test with role="system".`,
        `**User Tester**: Call sentinel_test with role="user".`,
        `Run both, then pass BOTH plans to sentinel_hack.`,
      ].join("\n"));
    }

    // Branch 5: Legacy mode
    if (pmCriteria) {
      lastPMCriteria.set(SESSION, pmCriteria);
      return text(`# PM Legacy — Criteria Stored\n\nCall sentinel_test with role="system" and role="user".`);
    }

    return text([`# PM Phase (Legacy Mode)`, "", formatScanContext(scanResult), "", PM_PROMPT_LEGACY].join("\n"));
  },
);

// ══════════════════════════════════════════
// Tool 4: sentinel_test — Dual Tester
// ══════════════════════════════════════════

server.tool(
  "sentinel_test",
  "Generate test plans. role='system': correctness only. role='user': translates PM criteria into UX tests.",
  {
    role: z.enum(["system", "user"]).describe("Which tester perspective"),
  },
  async ({ role }) => {
    const scanResult = lastScanResults.get(SESSION);
    if (!scanResult) return text("Error: No scan result found. Call sentinel_scan first.");

    const sourceContext = formatScanContext(scanResult);
    const scopeGuide = SCOPE_GUIDANCE[scanResult.scope] || SCOPE_GUIDANCE.full;

    if (role === "system") {
      return text([`# System Tester — Code Correctness`, "", sourceContext, "", scopeGuide, "", SYSTEM_TESTER_PROMPT].join("\n"));
    }

    const pmCriteria = lastPMCriteria.get(SESSION);
    if (!pmCriteria) return text("Error: No PM criteria found. Run sentinel_pm first.");

    return text([
      `# User Tester — UX Criteria Validation`, "",
      sourceContext, "", scopeGuide, "",
      USER_TESTER_PROMPT.replace("{PM_CRITERIA}", pmCriteria),
    ].join("\n"));
  },
);

// ══════════════════════════════════════════
// Tool 5: sentinel_hack — Hacker Island Algorithm
// ══════════════════════════════════════════

server.tool(
  "sentinel_hack",
  'Hacker phase with Island Algorithm. skill=1-6 (focused attack), skill="cross" (chain attacks), skill="merge" (final merge). Omit for legacy mode.',
  {
    systemPlan: z.string().optional().describe("System Tester plan. Required on first call."),
    userPlan: z.string().optional().describe("User Tester plan. Required on first call."),
    skill: z.string().optional().describe("Skill number (1-6) or mode: cross, merge"),
    skillResults: z.string().optional().describe("Results from skill passes. Required for cross and merge."),
  },
  async ({ systemPlan, userPlan, skill: skillRaw, skillResults }) => {
    // Parse skill: could be numeric string "1"-"6" or mode string
    const skillNum = skillRaw ? parseInt(skillRaw, 10) : NaN;
    const skill: number | string | undefined = !skillRaw ? undefined : isNaN(skillNum) ? skillRaw : skillNum;
    const scanResult = lastScanResults.get(SESSION);
    if (!scanResult) return text("Error: No scan result found. Call sentinel_scan first.");

    if (systemPlan) lastTesterPlan.set(SESSION + ":system", systemPlan);
    if (userPlan) lastTesterPlan.set(SESSION + ":user", userPlan);
    const sp = lastTesterPlan.get(SESSION + ":system") || systemPlan || "";
    const up = lastTesterPlan.get(SESSION + ":user") || userPlan || "";
    const pmCriteria = lastPMCriteria.get(SESSION) || "(PM phase skipped)";

    if (!sp && !up) return text("Error: No tester plans. Pass systemPlan and/or userPlan on the first sentinel_hack call.");

    const combinedPlan = [
      sp ? `### System Tester Plan\n${sp}` : "",
      up ? `### User Tester Plan\n${up}` : "",
    ].filter(Boolean).join("\n\n");

    // Branch 1: Focused skill pass (1-6)
    if (typeof skill === "number" && skill >= 1 && skill <= 6) {
      const round = hackRound.get(SESSION) || 1;
      const s = HACKER_SKILLS[skill - 1];
      const seed = djb2Hash(`${SESSION}-round${round}-skill${skill}`);
      const shuffledContext = formatScanContextShuffled(scanResult, seed);
      const prompt = HACKER_PREAMBLE
        .replace("{SKILL_NAME}", s.name)
        .replace("{SKILL_GOAL}", s.goal)
        .replace("{PM_CRITERIA}", pmCriteria)
        .replace("{SYSTEM_PLAN}", sp)
        .replace("{USER_PLAN}", up);
      const skillSection = `## Attack methodology: ${s.name}\n${s.prompt}`;
      const outputFmt = HACKER_OUTPUT_FORMAT.replace("{SKILL_ID}", String(s.id));
      const nextHint = skill < 6
        ? `\n\n---\nNext: call sentinel_hack with skill=${skill + 1}.`
        : `\n\n---\nAll 6 skills complete. Call sentinel_hack with skill="cross" and skillResults=<all 6 results concatenated>.`;

      return text([
        `# Hacker Island ${skill}/6 (Round ${round}) — ${s.name}`, "",
        shuffledContext, "", prompt, "", skillSection, "", outputFmt, nextHint,
      ].join("\n"));
    }

    // Branch 2: Cross-pollination
    if (skill === "cross") {
      if (!skillResults) return text("Error: skill='cross' requires skillResults parameter.");
      const round = hackRound.get(SESSION) || 1;
      const crossPrompt = HACKER_CROSS_PROMPT.replace("{ROUND}", String(round)).replace("{SKILL_RESULTS}", skillResults);
      const nextHint = [
        "", "---",
        `Count your NEW chain attacks.`,
        `- ≥ 2 new: call sentinel_hack with skill=1 for Round ${round + 1}.`,
        `- < 2 new: CONVERGE. Call sentinel_hack with skill="merge" and skillResults=<everything>.`,
        round >= 3 ? `- **Round 3 reached — MUST converge. Call skill="merge" next.**` : "",
      ].join("\n");
      hackRound.set(SESSION, round + 1);
      return text([`# Hacker Cross-Pollination — Round ${round}`, "", crossPrompt, nextHint].join("\n"));
    }

    // Branch 3: Final merge
    if (skill === "merge") {
      if (!skillResults) return text("Error: skill='merge' requires skillResults parameter.");
      hackRound.delete(SESSION);
      const mergePrompt = HACKER_MERGE_PROMPT.replace("{TESTER_PLAN}", combinedPlan).replace("{ALL_RESULTS}", skillResults);
      return text([`# Hacker Final Merge`, "", mergePrompt].join("\n"));
    }

    // Branch 4: Legacy mode
    const allSkills = HACKER_SKILLS.map((s) => `### SKILL ${s.id}: ${s.name}\nGoal: ${s.goal}\n${s.prompt}`).join("\n\n");
    return text([
      `# Hacker Phase (Legacy Mode)`, "",
      formatScanContext(scanResult), "",
      `You are a black-hat attacker. BREAK this system.`, "",
      `## PM criteria:\n${pmCriteria}`,
      `## Tester plans:\n${combinedPlan}`, "",
      allSkills, "",
      HACKER_OUTPUT_FORMAT.replace("{SKILL_ID}", "N"), "",
      `Merge: keep ALL Tester tests [T], add Hacker attacks [H], upgrade overlaps [T+H].`,
      `Present merged plan. After approval, call sentinel_run.`,
    ].join("\n"));
  },
);

// ══════════════════════════════════════════
// Tool 6: sentinel_run — Execute tests
// ══════════════════════════════════════════

server.tool(
  "sentinel_run",
  "Execute test files in an isolated workspace. Pass test file contents as key-value pairs. Call AFTER the merged test plan is approved.",
  {
    target: z.string().describe("Absolute path to the project directory"),
    testFiles: z.record(z.string()).describe('Map of filename -> file content. Example: {"functional.test.ts": "import { describe ... }"}'),
    save: z.boolean().optional().describe("If true, save test files to the target project after execution"),
  },
  async ({ target, testFiles, save }) => {
    const scanResult = lastScanResults.get(SESSION);
    if (!scanResult) return text("Error: No scan result found. Call sentinel_scan first.");

    const ws = createWorkspace(target, scanResult.language);
    activeWorkspaces.set(SESSION, ws);

    try {
      const installResult = await installDeps(ws);
      if (!installResult.success) {
        destroyWorkspace(ws);
        activeWorkspaces.delete(SESSION);
        return text(`## Dependency installation failed\n\n\`\`\`\n${installResult.output.slice(0, 2000)}\n\`\`\`\n\nFix the dependency issue and try again.`);
      }

      writeTestFiles(ws, testFiles);
      const testResult = await runTests(ws);
      const report = formatReport(scanResult, testResult);
      let output = report.summary + "\n" + report.details;

      if (testResult.failures.length > 0) {
        output += "\n### Failure Analysis Context\n";
        output += formatFailureContext(testResult);
        output += "\nAnalyze the failures above. For each failure:\n";
        output += "1. Identify the root cause in the source code\n";
        output += "2. Determine if it's a bug in the code or a bug in the test\n";
        output += "3. If it's a code bug, suggest a specific fix\n";
      }

      if (save) {
        const savedDir = saveTestFiles(ws, target);
        output += `\n\nTest files saved to: ${savedDir}`;
      }

      destroyWorkspace(ws);
      activeWorkspaces.delete(SESSION);
      return text(output);
    } catch (err: any) {
      destroyWorkspace(ws);
      activeWorkspaces.delete(SESSION);
      return text(`sentinel run error: ${err?.message || err}`);
    }
  },
);

// ══════════════════════════════════════════
// Start
// ══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[sentinel] MCP server running on stdio");
}

main().catch((err) => {
  console.error(`[sentinel] Fatal: ${err?.message || err}`);
  process.exit(1);
});
