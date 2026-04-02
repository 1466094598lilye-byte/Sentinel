/**
 * Sentinel MCP Server — AI testing agent.
 *
 * Works with any MCP-compatible host: Claude Code, Cursor, Windsurf, VS Code Copilot.
 *
 * Six-tool MCP flow for four-perspective testing:
 *   1. sentinel_scan  — Scan project, return context + source code
 *   2. sentinel_config — Confirm execution config before PM/test/hack phases
 *   3. sentinel_pm    — PM defines UX acceptance criteria (island algorithm, 4 tiers)
 *   4. sentinel_test  — Dual Tester: system (correctness) + user (UX criteria)
 *   5. sentinel_hack  — Hacker finds what everyone missed (island algorithm, 6 skills)
 *   6. sentinel_report — Turn host-run failures into a final T-tier report
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "child_process";
import packageJson from "./package.json" with { type: "json" };
import { scan } from "./lib/detect.js";
import { formatScanContext, formatTierReportInput } from "./lib/reporter.js";
import { proposeConfig, formatConfigProposal, setConfig } from "./lib/config.js";
import { syncSemaphores } from "./lib/concurrency.js";
import { IsolationVault, describeArtifact, formatIsolationCapsule } from "./lib/isolation.js";
import type { SentinelConfig } from "./lib/config.js";
import type { ScanResult } from "./lib/detect.js";

// ── State ──
const lastScanResults = new Map<string, ScanResult>();
const pendingScan = new Map<string, { result: ScanResult }>();
const lastIntent = new Map<string, string>();
const lastPMCriteria = new Map<string, string>();
const lastTesterPlan = new Map<string, string>();
const hackRound = new Map<string, number>();
const pmRound = new Map<string, number>();
const pmResearch = new Map<string, string>();

const SESSION = "default"; // MCP is single-session via stdio
const isolationVault = new IsolationVault();

const FULL_REPO_GUIDANCE =
  "Context is FULL REPOSITORY. Read the full project structure, then focus your tests on the highest-risk contracts, boundaries, state transitions, and user-facing failure modes.";

const HOST_EXECUTION_GUIDANCE = [
  "Sentinel does not execute tests through MCP.",
  "After you generate the final runnable test files, have the host coding agent write them into its own workspace and run them with its own terminal or sandbox.",
  "Do not ask Sentinel to execute them. Execution belongs to the host agent that generated the code.",
  "After the host run completes, call sentinel_report with each failure item's test_name, failure_type, and error_message to produce the final T-tier report.",
].join(" ");

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

## Coverage Ledger
- Components examined: which modules/functions you actually reasoned about
- Weak spots: components you did NOT fully understand or only touched lightly
- Surprise: one non-obvious risk or user failure mode you did not expect at first glance

## Next Frontier
- List 2 surfaces the NEXT isolated pass should pressure-test because they still feel under-explored, over-trusted, or deceptively harmless

## Constraints:
- Walk through the API surface SYSTEMATICALLY for this tier.
- Produce at least 3 criteria for THIS tier.
- Every criterion MUST have a concrete, testable threshold.
- Think about the REAL user — who are they? What are they trying to do?
- Prefer one genuinely non-obvious criterion over several obvious rewrites of the same concern.
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
5. **Coverage recovery**: Find important components that appeared weakly covered or not covered at all in the tier outputs, then ask what catastrophic UX failure could originate there.

## Rules:
- Every cross-tier finding must reference ≥2 original tier findings
- Show the escalation chain: "T4 finding X + T3 finding Y = T1 scenario Z"
- Produce at least 3 NEW cross-tier criteria
- Prefer compound failures, second-order effects, and under-explored surfaces over restating obvious issues.
- Report: "N new cross-tier criteria found" (< 2 = converge, ≥ 2 = another round, max 3 rounds)

## Output format:
[PM][Cross T{A}→T{B}] component — criterion name
- Escalation chain: T{A} finding + T{B} finding → combined impact
- Threshold: concrete pass/fail condition for the combined scenario
- Why this is worse than either alone: one sentence

## Next Frontier
- List 2 components or user journeys that still feel under-explored after this cross pass
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
- Preserve surprising, high-leverage criteria even if they are fewer; do not collapse everything into generic boilerplate.

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

Present the test code to the host coding agent. After approval, the host agent should write the test files into its own workspace and run them directly.
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

Present the test code to the host coding agent. After approval, the host agent should write the test files into its own workspace and run them directly.
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

## Coverage Ledger
- Components attacked: which modules/functions you actually pressured
- Input classes tried: the payload families you explored
- Suspicious but unbroken: what still feels too trusted, too quiet, or too lightly exercised

## Next Frontier
- List 2 follow-up attack leads the NEXT isolated pass should pursue because they may unlock a deeper chain or a wider blast radius

## Constraints:
- Walk through the API surface SYSTEMATICALLY.
- Produce at least 3 attacks the Tester missed for THIS skill.
- Each attack must have a CONCRETE payload.
- Prefer SILENT corruption over crashes.
- Cross-reference PM criteria: T1/T2 concerns get attacked harder.
- At least one attack should come from a surface that does NOT look obviously dangerous at first glance.
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
5. **Coverage gap exploitation**: Start from components that were barely attacked in the individual skill passes and ask how they could become the first step of a larger chain.

## Rules:
- Every chain must be ≥2 steps
- Show the COMPLETE chain with concrete payloads
- Produce at least 3 NEW chain attacks
- Prefer new blast radius and surprising entry points over "same bug, bigger payload".
- Report: "N new chain attacks found" (<2 = converge)

## Output format
Output **runnable test code** for each chain attack using the project's test runner.
Each test must assert the EXPECTED DEFENSE — test FAILS if the chain vulnerability exists.
Include describe blocks with [H][Chain] prefix.

## Next Frontier
- List 2 attack leads that still look promising after this chaining pass
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
- Preserve attacks that open new surfaces or new blast radii even if they are fewer than the obvious repeated attacks.

## CRITICAL — Assertion Direction Check
Before outputting, review EVERY expect() call. Ask: "Does this test FAIL when the bug exists?"
- If the test would PASS on broken code → flip the assertion
- If the test is a placeholder (expect(true).toBe(true)) → replace with a real assertion or remove

Output the final merged test file(s) as COMPLETE, RUNNABLE code ready for the host coding agent to execute directly.
Tell the host agent to write these test files and run them in its own terminal or sandbox.
`;

// ══════════════════════════════════════════
// MCP Server Setup
// ══════════════════════════════════════════

const server = new McpServer({
  name: "sentinel",
  version: packageJson.version,
}, {
  capabilities: { tools: {} },
});

// Helper
function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function clearScanArtifacts(sessionKey: string): void {
  lastScanResults.delete(sessionKey);
  pendingScan.delete(sessionKey);
}

function getGitDiffFingerprint(dir: string): string {
  try {
    return execSync("git diff --name-only HEAD 2>/dev/null && git diff --name-only --cached 2>/dev/null", {
      cwd: dir, encoding: "utf-8", timeout: 5_000,
    }).trim();
  } catch { return ""; }
}

function joinSections(sections: string[]): string {
  return sections.filter(Boolean).join("\n\n");
}

function getLatestTesterPlans(sessionKey: string): { system: string; user: string } {
  const systemArtifact = isolationVault.latest(sessionKey, { kind: "tester_system" });
  const userArtifact = isolationVault.latest(sessionKey, { kind: "tester_user" });
  return {
    system: systemArtifact?.content || lastTesterPlan.get(sessionKey + ":system") || "",
    user: userArtifact?.content || lastTesterPlan.get(sessionKey + ":user") || "",
  };
}

function getPMRoundResults(sessionKey: string, round: number): string {
  const tierArtifacts = isolationVault.list(sessionKey, { kind: "pm_tier", round });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "pm_cross", round });

  return joinSections([
    ...tierArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
    ...crossArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
  ]);
}

function getAllPMResults(sessionKey: string): string {
  const research = isolationVault.latest(sessionKey, { kind: "pm_research" });
  const tierArtifacts = isolationVault.list(sessionKey, { kind: "pm_tier" });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "pm_cross" });

  return joinSections([
    research ? `### ${describeArtifact(research)}\n${research.content}` : "",
    ...tierArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
    ...crossArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
  ]);
}

function getHackRoundResults(sessionKey: string, round: number): string {
  const skillArtifacts = isolationVault.list(sessionKey, { kind: "hack_skill", round });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "hack_cross", round });

  return joinSections([
    ...skillArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
    ...crossArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
  ]);
}

function getAllHackResults(sessionKey: string): string {
  const skillArtifacts = isolationVault.list(sessionKey, { kind: "hack_skill" });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "hack_cross" });
  const mergeArtifact = isolationVault.latest(sessionKey, { kind: "hack_merge" });

  return joinSections([
    ...skillArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
    ...crossArtifacts.map((artifact) =>
      `### ${describeArtifact(artifact)}\n${artifact.content}`,
    ),
    mergeArtifact ? `### ${describeArtifact(mergeArtifact)}\n${mergeArtifact.content}` : "",
  ]);
}

// ══════════════════════════════════════════
// Tool 1: sentinel_scan
// ══════════════════════════════════════════

server.tool(
  "sentinel_scan",
  "Scan a project for testing. Pass intent (one sentence: what is this project for?) to enable intent-gap detection. If intent is not provided, ASK THE USER before proceeding.",
  {
    target: z.string().describe("Absolute path to the project directory to test"),
    intent: z.string().optional().describe('One sentence: "What is this project for?" If unknown, ASK the user first.'),
  },
  async ({ target, intent }) => {
    clearScanArtifacts(SESSION);
    const result = scan(target);

    // ── Gate: no intent → block pipeline, force calibration ──
    if (!intent) {
      // Store scan internally but do NOT expose results to host LLM
      pendingScan.set(SESSION, { result });
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
        `⛔ sentinel_pm, sentinel_test, and sentinel_hack will not work until calibration is complete.`,
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
  "Confirm or modify the Sentinel configuration proposed by sentinel_scan. Call AFTER scan, BEFORE pm.",
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
      `Context: ${FULL_REPO_GUIDANCE}`, "",
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
        const artifact = isolationVault.store(SESSION, "pm_research", tierResults);
        pmResearch.set(SESSION, tierResults);
        return text(`# PM Research Stored\n\nCategory risk profile saved as ${describeArtifact(artifact)}.\nNow call sentinel_pm with tier=1 to begin.`);
      }
      const sourceContext = formatScanContext(scanResult);
      const capsule = formatIsolationCapsule("PM Research", [
        "Visible: scan context only.",
        "Hidden by Sentinel: tester plans, hacker findings, and PM criteria from later phases.",
      ]);
      return text([`# PM Market Research Phase`, "", capsule, "", sourceContext, "", PM_RESEARCH_PROMPT].join("\n"));
    }

    // Branch 1: Focused tier pass (1-4)
    if (typeof tier === "number" && tier >= 1 && tier <= 4) {
      const round = pmRound.get(SESSION) || 1;
      if (tierResults) {
        const artifact = isolationVault.store(SESSION, "pm_tier", tierResults, { round, tier });
        return text([
          `# PM Tier Stored`,
          "",
          `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
          tier < 4
            ? `Next: call sentinel_pm with tier=${tier + 1} to open the next isolated PM cabin.`
            : `All 4 tiers for round ${round} are stored. Call sentinel_pm with tier="cross" to open the cross-tier cabin.`,
        ].join("\n"));
      }
      const t = PM_TIERS[tier - 1];
      const structuredContext = formatScanContext(scanResult);
      const researchArtifact = isolationVault.latest(SESSION, { kind: "pm_research" });
      const research = researchArtifact?.content || pmResearch.get(SESSION) || "(No competitive research done — consider running tier='research' first)";
      const prompt = PM_PREAMBLE
        .replace("{TIER_NAME}", t.name)
        .replace("{TIER_GOAL}", t.goal)
        .replace("{RESEARCH_CONTEXT}", research);
      const capsule = formatIsolationCapsule(`PM Tier ${tier} / Round ${round}`, [
        researchArtifact
          ? `Visible research artifact: ${describeArtifact(researchArtifact)}.`
          : "Visible research artifact: none.",
        "Hidden by Sentinel: tester plans, hacker findings, and sibling PM tier outputs.",
        "Exploration rule: keep the source structure stable and focus only on this tier's concern.",
      ]);
      const tierSection = `## Analysis focus: Tier ${t.id} — ${t.name}\n${t.prompt}`;
      const outputFmt = PM_OUTPUT_FORMAT.replace("{TIER_ID}", String(t.id));
      const nextHint = tier < 4
        ? `\n\n---\nAfter generating this tier, store it by calling sentinel_pm with tier=${tier} and tierResults=<your output>. Then open tier=${tier + 1}.`
        : `\n\n---\nAfter generating this tier, store it by calling sentinel_pm with tier=4 and tierResults=<your output>. Then call sentinel_pm with tier="cross" to combine only the stored PM artifacts for this round.`;

      return text([
        `# PM Island ${tier}/4 (Round ${round}) — ${t.name}`, "",
        capsule, "", structuredContext, "", prompt, "", tierSection, "", outputFmt, nextHint,
      ].join("\n"));
    }

    // Branch 2: Cross-tier escalation
    if (tier === "cross") {
      const round = pmRound.get(SESSION) || 1;
      if (tierResults) {
        const artifact = isolationVault.store(SESSION, "pm_cross", tierResults, { round });
        pmRound.set(SESSION, round + 1);
        return text([
          `# PM Cross-Tier Stored`,
          "",
          `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
          `If this cross-tier pass found enough new criteria, call sentinel_pm with tier=1 to open round ${round + 1}.`,
          `If it converged, call sentinel_pm with tier="merge" to merge only the stored PM artifacts.`,
        ].join("\n"));
      }
      const tierResultsForRound = getPMRoundResults(SESSION, round);
      if (!tierResultsForRound) {
        return text(`Error: No stored PM tier artifacts found for round ${round}. Store tier results first.`);
      }
      const capsule = formatIsolationCapsule(`PM Cross / Round ${round}`, [
        `Visible artifacts: only stored PM tier results from round ${round}.`,
        "Hidden by Sentinel: tester plans, hacker findings, and future PM rounds.",
      ]);
      const crossPrompt = PM_CROSS_PROMPT.replace("{ROUND}", String(round)).replace("{TIER_RESULTS}", tierResultsForRound);
      const nextHint = [
        "", "---",
        `After generating cross-tier findings, store them by calling sentinel_pm with tier="cross" and tierResults=<your output>.`,
        `- If the stored cross result found ≥ 2 new criteria: open round ${round + 1} with tier=1.`,
        `- If it converged: call sentinel_pm with tier="merge" to merge only the stored PM artifacts.`,
        round >= 3 ? `- **Round 3 reached — MUST converge after storing this pass.**` : "",
      ].join("\n");
      return text([`# PM Cross-Tier Escalation — Round ${round}`, "", capsule, "", crossPrompt, nextHint].join("\n"));
    }

    // Branch 3: Merge
    if (tier === "merge") {
      if (tierResults) {
        const artifact = isolationVault.store(SESSION, "pm_merge", tierResults);
        return text([
          `# PM Merge Stored`,
          "",
          `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
          `Next: call sentinel_pm with tier="done" to promote the latest merged PM criteria.`,
        ].join("\n"));
      }
      const allResults = getAllPMResults(SESSION);
      if (!allResults) return text("Error: No stored PM artifacts found. Run and store PM phases first.");
      pmRound.delete(SESSION);
      const capsule = formatIsolationCapsule("PM Merge", [
        "Visible artifacts: stored PM research, tier, and cross outputs only.",
        "Hidden by Sentinel: tester plans and hacker findings.",
      ]);
      return text([`# PM Criteria Merge`, "", capsule, "", PM_MERGE_PROMPT.replace("{ALL_RESULTS}", allResults)].join("\n"));
    }

    // Branch 4: Done
    if (tier === "done") {
      const finalCriteria = tierResults || isolationVault.latest(SESSION, { kind: "pm_merge" })?.content;
      if (!finalCriteria) return text("Error: No merged PM criteria found. Store a merge result first.");
      lastPMCriteria.set(SESSION, finalCriteria);
      return text([
        `# PM Phase Complete — Proceed to Dual Tester Phase`, "",
        `PM criteria stored (${finalCriteria.length} chars).`, "",
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
    plan: z.string().optional().describe("Store the generated tester output inside Sentinel's isolation vault."),
  },
  async ({ role, plan }) => {
    const scanResult = lastScanResults.get(SESSION);
    if (!scanResult) return text("Error: No scan result found. Call sentinel_scan first.");

    if (plan) {
      const kind = role === "system" ? "tester_system" : "tester_user";
      const artifact = isolationVault.store(SESSION, kind, plan);
      lastTesterPlan.set(SESSION + `:${role}`, plan);
      return text([
        `# Tester Plan Stored`,
        "",
        `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
        role === "system"
          ? `Next: call sentinel_test with role="user" to open the UX tester cabin.`
          : `Both tester cabins can now be consumed by sentinel_hack without re-pasting their contents.`,
      ].join("\n"));
    }

    const sourceContext = formatScanContext(scanResult);
    const capsule = role === "system"
      ? formatIsolationCapsule("System Tester", [
        "Visible: scan context only.",
        "Hidden by Sentinel: PM criteria, user tester output, and hacker findings.",
      ])
      : formatIsolationCapsule("User Tester", [
        "Visible: scan context and the promoted PM criteria only.",
        "Hidden by Sentinel: system tester output and hacker findings.",
      ]);

    if (role === "system") {
      return text([
        `# System Tester — Code Correctness`, "",
        capsule, "", sourceContext, "", FULL_REPO_GUIDANCE, "", SYSTEM_TESTER_PROMPT,
        "",
        `After generating the plan, store it by calling sentinel_test with role="system" and plan=<your output>.`,
      ].join("\n"));
    }

    const pmCriteria = lastPMCriteria.get(SESSION);
    if (!pmCriteria) return text("Error: No PM criteria found. Run sentinel_pm first.");

    return text([
      `# User Tester — UX Criteria Validation`, "",
      capsule, "", sourceContext, "", FULL_REPO_GUIDANCE, "",
      USER_TESTER_PROMPT.replace("{PM_CRITERIA}", pmCriteria),
      "",
      `After generating the plan, store it by calling sentinel_test with role="user" and plan=<your output>.`,
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

    if (systemPlan) {
      lastTesterPlan.set(SESSION + ":system", systemPlan);
      isolationVault.store(SESSION, "tester_system", systemPlan);
    }
    if (userPlan) {
      lastTesterPlan.set(SESSION + ":user", userPlan);
      isolationVault.store(SESSION, "tester_user", userPlan);
    }
    const testerPlans = getLatestTesterPlans(SESSION);
    const sp = testerPlans.system;
    const up = testerPlans.user;
    const pmCriteria = lastPMCriteria.get(SESSION) || "(PM phase skipped)";

    if (!sp && !up) return text("Error: No tester plans. Pass systemPlan and/or userPlan on the first sentinel_hack call.");

    const combinedPlan = [
      sp ? `### System Tester Plan\n${sp}` : "",
      up ? `### User Tester Plan\n${up}` : "",
    ].filter(Boolean).join("\n\n");

    // Branch 1: Focused skill pass (1-6)
    if (typeof skill === "number" && skill >= 1 && skill <= 6) {
      const round = hackRound.get(SESSION) || 1;
      if (skillResults) {
        const artifact = isolationVault.store(SESSION, "hack_skill", skillResults, { round, skill });
        return text([
          `# Hacker Skill Stored`,
          "",
          `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
          skill < 6
            ? `Next: call sentinel_hack with skill=${skill + 1} to open the next isolated hacker cabin.`
            : `All 6 hacker skills for round ${round} are stored. Call sentinel_hack with skill="cross" to chain only the stored hacker artifacts.`,
        ].join("\n"));
      }
      const s = HACKER_SKILLS[skill - 1];
      const structuredContext = formatScanContext(scanResult);
      const prompt = HACKER_PREAMBLE
        .replace("{SKILL_NAME}", s.name)
        .replace("{SKILL_GOAL}", s.goal)
        .replace("{PM_CRITERIA}", pmCriteria)
        .replace("{SYSTEM_PLAN}", sp)
        .replace("{USER_PLAN}", up);
      const capsule = formatIsolationCapsule(`Hacker Skill ${skill} / Round ${round}`, [
        "Visible: scan context, promoted PM criteria, and the latest stored tester plans.",
        "Hidden by Sentinel: sibling hacker skill outputs and future hacker rounds.",
        "Exploration rule: keep the source structure stable and push deeper only within this skill's attack lane.",
      ]);
      const skillSection = `## Attack methodology: ${s.name}\n${s.prompt}`;
      const outputFmt = HACKER_OUTPUT_FORMAT.replace("{SKILL_ID}", String(s.id));
      const nextHint = skill < 6
        ? `\n\n---\nAfter generating this hacker pass, store it by calling sentinel_hack with skill=${skill} and skillResults=<your output>. Then open skill=${skill + 1}.`
        : `\n\n---\nAfter generating this hacker pass, store it by calling sentinel_hack with skill=6 and skillResults=<your output>. Then call sentinel_hack with skill="cross" to chain only the stored hacker artifacts from this round.`;

      return text([
        `# Hacker Island ${skill}/6 (Round ${round}) — ${s.name}`, "",
        capsule, "", structuredContext, "", prompt, "", skillSection, "", outputFmt, nextHint,
      ].join("\n"));
    }

    // Branch 2: Cross-pollination
    if (skill === "cross") {
      const round = hackRound.get(SESSION) || 1;
      if (skillResults) {
        const artifact = isolationVault.store(SESSION, "hack_cross", skillResults, { round });
        hackRound.set(SESSION, round + 1);
        return text([
          `# Hacker Cross Stored`,
          "",
          `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
          `If this chaining pass found enough new attacks, call sentinel_hack with skill=1 to open round ${round + 1}.`,
          `If it converged, call sentinel_hack with skill="merge" to merge only the stored hacker artifacts.`,
        ].join("\n"));
      }
      const skillResultsForRound = getHackRoundResults(SESSION, round);
      if (!skillResultsForRound) {
        return text(`Error: No stored hacker skill artifacts found for round ${round}. Store skill results first.`);
      }
      const capsule = formatIsolationCapsule(`Hacker Cross / Round ${round}`, [
        `Visible artifacts: only stored hacker skill outputs from round ${round}, plus the latest tester plans.`,
        "Hidden by Sentinel: future hacker rounds and raw host conversation history.",
      ]);
      const crossPrompt = HACKER_CROSS_PROMPT.replace("{ROUND}", String(round)).replace("{SKILL_RESULTS}", skillResultsForRound);
      const nextHint = [
        "", "---",
        `After generating chain attacks, store them by calling sentinel_hack with skill="cross" and skillResults=<your output>.`,
        `- If the stored cross result found ≥ 2 new attacks: open round ${round + 1} with skill=1.`,
        `- If it converged: call sentinel_hack with skill="merge" to merge only the stored hacker artifacts.`,
        round >= 3 ? `- **Round 3 reached — MUST converge after storing this pass.**` : "",
      ].join("\n");
      return text([`# Hacker Cross-Pollination — Round ${round}`, "", capsule, "", crossPrompt, nextHint].join("\n"));
    }

    // Branch 3: Final merge
    if (skill === "merge") {
      if (skillResults) {
        const artifact = isolationVault.store(SESSION, "hack_merge", skillResults);
        return text([
          `# Hacker Merge Stored`,
          "",
          `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
          `Next: have the host coding agent write the final merged test files and run them in its own terminal or sandbox.`,
        ].join("\n"));
      }
      hackRound.delete(SESSION);
      const allResults = getAllHackResults(SESSION);
      if (!allResults) return text("Error: No stored hacker artifacts found. Run and store hacker phases first.");
      const capsule = formatIsolationCapsule("Hacker Merge", [
        "Visible artifacts: latest stored tester plans plus stored hacker skill and cross outputs.",
        "Hidden by Sentinel: PM tier raw outputs that were not promoted into tester-visible artifacts.",
      ]);
      const mergePrompt = HACKER_MERGE_PROMPT.replace("{TESTER_PLAN}", combinedPlan).replace("{ALL_RESULTS}", allResults);
      return text([`# Hacker Final Merge`, "", capsule, "", mergePrompt].join("\n"));
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
      HOST_EXECUTION_GUIDANCE,
    ].join("\n"));
  },
);

// ══════════════════════════════════════════
// Tool 6: sentinel_report — Final T-tier report
// ══════════════════════════════════════════

server.tool(
  "sentinel_report",
  "Turn host-run failure items into a final T-tier report. Pass only raw failure evidence from the host test run.",
  {
    failures: z.array(z.object({
      testName: z.string().describe("Test name from the host test run"),
      failureType: z.string().describe("Failure type such as test, setup, compile, collection, timeout, or runtime"),
      errorMessage: z.string().describe("Raw error message for this failure item"),
      testFile: z.string().optional().describe("Optional test file path reported by the host"),
    })).describe("Failure items from the host coding agent's test run"),
    totalTests: z.number().optional().describe("Optional total number of tests executed"),
    passed: z.number().optional().describe("Optional number of passed tests"),
    failed: z.number().optional().describe("Optional number of failed tests"),
    durationSeconds: z.number().optional().describe("Optional execution duration in seconds"),
  },
  async ({ failures, totalTests, passed, failed, durationSeconds }) => {
    if (failures.length === 0) {
      const lines = [
        `# Sentinel Final Report`,
        "",
        `No failure items were provided.`,
      ];
      if (typeof totalTests === "number" || typeof passed === "number" || typeof failed === "number") {
        lines.push("", `Summary: total=${totalTests ?? 0}, passed=${passed ?? 0}, failed=${failed ?? 0}`);
      }
      return text(lines.join("\n"));
    }

    return text(formatTierReportInput({
      failures: failures.map((failure) => ({
        testName: failure.testName,
        failureType: failure.failureType,
        errorMessage: failure.errorMessage,
        testFile: failure.testFile,
      })),
      totalTests,
      passed,
      failed,
      durationSeconds,
    }));
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
