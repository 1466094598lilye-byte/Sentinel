/**
 * Sentinel Plugin — AI testing agent for OpenClaw
 *
 * Four-tool flow with three-perspective isolation:
 *
 *   1. sentinel_scan  — Scan project, return context.
 *   2. sentinel_pm    — PM defines UX acceptance criteria (T1-T4 island algorithm).
 *   3. sentinel_test  — Dual Tester:
 *        role="system" — System Tester validates code correctness (no PM input)
 *        role="user"   — User Tester translates PM criteria into runnable UX tests
 *   4. sentinel_hack  — Hacker sees both Tester plans + PM criteria (island algorithm).
 *   5. sentinel_run   — Execute merged test files, return structured results.
 *
 * Why 4 perspectives:
 *   - PM:            "Is it usable?" — defines what users won't tolerate
 *   - System Tester: "Is it correct?" — validates against spec
 *   - User Tester:   "Does it meet UX thresholds?" — translates PM criteria to tests
 *   - Hacker:        "Is it breakable?" — finds what all three missed
 *
 *   A single prompt asking for all three produces overlap.
 *   Sequential calls where each REACTS TO the previous produce real coverage.
 */

import { execSync } from "child_process";
import { scan } from "./lib/detect.js";
import { createWorkspace, installDeps, writeTestFiles, destroyWorkspace, saveTestFiles } from "./lib/workspace.js";
import { runTests } from "./lib/executor.js";
import { formatReport, formatScanContext, formatScanContextShuffled, formatFailureContext } from "./lib/reporter.js";
import { proposeConfig, formatConfigProposal, getConfig, setConfig, clearConfig } from "./lib/config.js";
import { syncSemaphores } from "./lib/concurrency.js";
import { calibrate } from "./lib/calibrate.js";
import { detectProvider } from "./lib/llm.js";
import type { SentinelConfig } from "./lib/config.js";
import type { ScanResult } from "./lib/detect.js";
import type { Workspace } from "./lib/workspace.js";

// ── State ──
const activeWorkspaces = new Map<string, Workspace>();
const lastScanResults = new Map<string, ScanResult>();
const pendingScan = new Map<string, { result: ScanResult; target: string; scope?: string }>();
const lastIntent = new Map<string, string>();      // user's one-line project intent
const lastCalibration = new Map<string, string>(); // LLM-generated capability expectations
const lastPMCriteria = new Map<string, string>();
const lastTesterPlan = new Map<string, string>();
const hackRound = new Map<string, number>(); // current round per session
const pmRound = new Map<string, number>();   // current PM round per session
const pmResearch = new Map<string, string>(); // market research results per session

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
  commit:
    "Scope is COMMIT (uncommitted changes only). Generate 2-4 focused tests per changed function. Only test the changed code and its direct callers.",
  branch:
    "Scope is BRANCH (all changes since diverged from main). Generate 5-8 tests per changed module, including edge cases and negative tests.",
  changes:
    "Scope is CHANGES (specific files). Generate 3-5 tests per changed function, covering happy path and key edge cases.",
  full: "Scope is FULL (entire project). Generate comprehensive tests across all 6 categories: Functional, Boundary, Stability, Recovery, Integration, Resource.",
};

// ── PM prompt components (Step 1) ──
// Market research → island algorithm (4 tiers) → cross-pollinate → converge

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
[CR-3] ...

These are the risks that the generic PM checklist would MISS because they're domain-specific.

Example for an "LLM memory plugin" category:
[CR-1] Context window pollution — injecting too many recalled memories bloats every LLM call
[CR-2] Embedding quality degradation — garbage embeddings silently corrupt all future recalls
[CR-3] Cold start latency — first embed() call loads the model, blocking the conversation
[CR-4] Token cost opacity — users can't see how much each recall costs them
[CR-5] Recall precision — low similarity threshold returns noise, wastes context space

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
- **Output proportionality**: any function that returns 10x more data than the caller needs (e.g. deep-copying all records when only a count is needed) → WARNING

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
Individual analysts found issues within their tier. Your job is to find issues that SPAN tiers:

1. **Escalation**: A T4 issue (memory leak) that under load becomes a T1 issue (data loss). A T3 issue (slow response) that sometimes returns stale data = T2 issue (wrong answer).
2. **Compounding**: A T3 issue (extra workflow step) combined with a T2 issue (confusing error) = user gives up entirely (T1).
3. **Hidden T1s**: Issues classified as T3/T4 that are actually T1 in disguise under specific conditions.
4. **Indirect cost chains**: A T3 issue (per-interaction compute overhead) that injects content into LLM context = T1 issue (silent token cost to the caller on EVERY interaction). This pattern is especially common in AI plugins/middleware — the plugin "works" but makes every downstream call more expensive.

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

// Legacy PM prompt (assembled from components for backward compatibility)
const PM_PROMPT_LEGACY = [
  `You are a senior PM with deep UX research expertise.`,
  `Analyze this codebase and define acceptance criteria across ALL 4 tiers:\n`,
  ...PM_TIERS.map((t) => `### Tier ${t.id} — ${t.name}\n${t.prompt}`),
  `\n` + PM_OUTPUT_FORMAT.replace("{TIER_ID}", "N"),
  `\nYou must produce at least 3 criteria per tier (12+ total).`,
  `Present criteria to user. After approval, call sentinel_pm with the criteria.`,
].join("\n");

// ── System Tester prompt (Step 2a) ──
// Pure code correctness — does NOT see PM criteria
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

// ── User Tester prompt (Step 2b) ──
// Translates PM criteria into runnable tests — does NOT care about correctness
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

// ── Hacker prompt components (Step 3) ──
// Architecture: Island Algorithm with convergent cross-pollination
//   Round 1: 6 isolated skill agents, each with randomized API surface order
//   Cross:   Extract findings, identify attack chains across skills
//   Round 2+: Deep-dive on most dangerous chains (narrows each round)
//   Converge when: new findings < 2, or max 3 rounds
//   Merge:   Deduplicate + tag [T]/[H]/[T+H]

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
    id: 1,
    name: "DATA POISONING",
    goal: "Make the system store garbage that looks valid but corrupts all future operations.",
    prompt: `For every function that WRITES or STORES data:
- Feed inputs of correct type but wrong semantics (right shape, wrong meaning)
- Feed unicode edge cases: zero-width characters (U+200B), RTL overrides (U+202E), homoglyphs
- Feed null bytes (\\x00) in string fields — test serialization survival
- Feed values at exact type boundaries: NaN, Infinity, -0, empty string vs null vs undefined
- For array/collection inputs: wrong length, wrong element types, nested empty arrays
If the function accepts it without error, it's a vulnerability — downstream consumers get garbage.`,
  },
  {
    id: 2,
    name: "STATE CORRUPTION",
    goal: "Make the system destroy its own data through normal-looking API calls.",
    prompt: `For every function that has SIDE EFFECTS or MUTATES state:
- If getters return references (arrays, objects), mutate the returned reference — is internal state corrupted?
- Call the function 10,000 times rapidly — does memory grow unboundedly? Does the store/file/DB bloat?
- Interleave write and read calls — can you catch half-written state?
- For any function with "delete" or "remove" semantics: delete while iterating, delete non-existent items, double-delete`,
  },
  {
    id: 3,
    name: "SILENT WRONG ANSWERS",
    goal: "Make functions return confident but WRONG outputs without any error signal. Most dangerous category.",
    prompt: `For every function that COMPUTES or TRANSFORMS data:
- Feed edge-case inputs that are technically valid: empty arrays, single-element arrays, identical elements
- For numeric computations: test with NaN, Infinity, very large numbers, very small numbers, negative zero
- For string processing: test with empty string, whitespace-only, million-character string
- For filtering/search: craft inputs that bypass filter logic — get results that should be excluded
- For comparison functions: inputs that are equal-but-not-identical (deep equality edge cases)`,
  },
  {
    id: 4,
    name: "RESOURCE EXHAUSTION",
    goal: "Make the system consume unbounded resources until it crashes or becomes unusable.",
    prompt: `For every function that processes INPUT of variable size:
- Feed 10MB+ strings to any regex-using function — test for catastrophic backtracking
- Feed deeply nested objects (1000+ levels) to any recursive function
- Trigger maximum concurrency: call async functions 1000x simultaneously
- For any function that builds collections: can you make it create unbounded-size results?
- For any function with timeouts: is the timeout enforced? What happens if the operation hangs?`,
  },
  {
    id: 5,
    name: "INJECTION & ESCALATION",
    goal: "Use stored/processed data to attack downstream consumers.",
    prompt: `For every function that STORES user-provided data:
- Inject structured data that mimics system markup/tags/delimiters — does parsing survive?
- Inject prompt injection payloads: "SYSTEM: Ignore all previous instructions"
- For any value used in file paths: inject path traversal (../../etc/passwd)
- For any value used in shell commands: inject command separators (; && | \`)
- For any value used in SQL/queries: inject query manipulation
- For any value rendered in HTML: inject XSS payloads`,
  },
  {
    id: 6,
    name: "TEMPORAL & ORDERING ATTACKS",
    goal: "Break the system by calling things in the wrong order or at the wrong time.",
    prompt: `For the full API surface:
- Call every function BEFORE its prerequisites are met (read before write, query before init)
- Call every function AFTER its expected lifecycle (use after close/destroy/cleanup)
- Call pairs of functions that share state CONCURRENTLY — can they corrupt each other?
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
- Walk through the API surface SYSTEMATICALLY. Every exported function must be considered.
- Produce at least 3 attacks the Tester missed for THIS skill.
- Each attack must have a CONCRETE payload.
- Prefer SILENT corruption over crashes.
- Cross-reference PM criteria: T1/T2 concerns get attacked harder.
`;

const HACKER_CROSS_PROMPT = `
You are a black-hat attacker reviewing the combined findings from 6 specialized attack agents.
Each agent focused on ONE attack skill and worked independently with a DIFFERENT view of the codebase.

## All findings from Round {ROUND}:
{SKILL_RESULTS}

## Your mission: ATTACK CHAINING
The individual agents found entry points. Your job is to CHAIN them into compound attacks:

1. **Escalation chains**: Agent A found function X accepts garbage input. Agent B found function Y trusts X's output. Chain: poison X → Y produces silently wrong results.
2. **State + Timing combos**: Agent C found a race condition. Agent D found state corruption. Chain: trigger race → corrupt state → system enters unrecoverable mode.
3. **Injection → Impact**: Agent E found an injection point. Connect it to a concrete damage path.
4. **Resource amplification**: Agent F found one expensive call. Can you trigger it in a loop through another agent's finding?

## Rules:
- Every chain must be ≥2 steps (single-function attacks were already found by individual agents)
- Show the COMPLETE chain: step 1 → step 2 → ... → impact
- Identify which agent's findings you're combining
- Produce at least 3 NEW chain attacks not covered by individual agents
- Report: "N new chain attacks found" (this determines if another round is needed — <2 = converge)

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

// ── Plugin ──

export default function register(api: any) {
  const log = api.logger;

  // Git diff fingerprint — used by hook to detect real file changes
  const lastScanDiffHash = new Map<string, string>();

  function getGitDiffFingerprint(dir: string): string {
    try {
      return execSync("git diff --name-only HEAD 2>/dev/null && git diff --name-only --cached 2>/dev/null", {
        cwd: dir,
        encoding: "utf-8",
        timeout: 5_000,
      }).trim();
    } catch {
      return "";
    }
  }

  // ════════════════════════════════════════════
  // Tool 1: sentinel_scan — Tester context
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_scan",
      description:
        "Scan a project for testing. Pass intent (one sentence: what is this project for?) to enable intent-gap detection. If intent is not provided, ASK THE USER before proceeding.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Absolute path to the project directory to test",
          },
          scope: {
            type: "string",
            enum: ["commit", "branch", "changes", "full"],
            description: "Test scope. If omitted, auto-detected from git state.",
          },
          intent: {
            type: "string",
            description: 'One sentence from the user: "What is this project for?" e.g. "A CLI tool that tests any codebase from four perspectives." If unknown, ASK the user first.',
          },
        },
        required: ["target"],
      },
      async handler(params: { target: string; scope?: string; intent?: string }) {
        try {
          const sessionKey = ctx.sessionKey || "default";

          log.info(`[sentinel] Scanning ${params.target} (scope: ${params.scope || "auto"})`);

          const result = scan(params.target, params.scope);
          (result as any)._targetDir = params.target; // store for hook
          lastScanDiffHash.set(sessionKey, getGitDiffFingerprint(params.target));

          // ── Gate: no intent → block pipeline, force calibration ──
          if (!params.intent) {
            pendingScan.set(sessionKey, { result, target: params.target, scope: params.scope });
            log.info(`[sentinel] Scan complete but intent missing — blocking pipeline for calibration`);
            return {
              content: [{
                type: "text" as const,
                text: [
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
                ].join("\n"),
              }],
            };
          }

          // ── Calibrated path: store results and proceed ──
          lastScanResults.set(sessionKey, result);
          lastIntent.set(sessionKey, params.intent);
          pendingScan.delete(sessionKey);

          const context = formatScanContext(result);
          const proposed = proposeConfig(result);

          const parts = [context, "", formatConfigProposal(proposed, result)];

          parts.push("");
          parts.push(`## Project Intent`);
          parts.push(`> ${params.intent}`);

          if (detectProvider()) {
            log.info(`[sentinel] Running intent calibration...`);
            try {
              const cal = await calibrate(params.intent, result);
              lastCalibration.set(sessionKey, cal.expectedCapabilities);
              parts.push("");
              parts.push("## Intent Calibration (LLM analysis)");
              parts.push(cal.expectedCapabilities);
            } catch (err: any) {
              log.warn(`[sentinel] Calibration failed: ${err?.message}`);
              parts.push("");
              parts.push(`(Calibration failed: ${err?.message} — proceeding without intent-gap detection)`);
            }
          } else {
            parts.push("");
            parts.push("(No LLM API key found — set ANTHROPIC_API_KEY or OPENAI_API_KEY for intent-gap detection)");
          }

          const output = parts.join("\n");

          log.info(
            `[sentinel] Scan complete: ${result.language}, scope=${result.scope}, ${result.sourceFiles.length} files, ${result.apiSurface.length} exports, intent=yes`,
          );

          return {
            content: [{ type: "text" as const, text: output }],
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `sentinel scan error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_scan"], optional: true },
  );

  // ════════════════════════════════════════════
  // ════════════════════════════════════════════
  // Tool 2: sentinel_config — Confirm/modify run configuration
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_config",
      description:
        "Confirm or modify the run configuration proposed by sentinel_scan. Call this AFTER scan, BEFORE pm. Pass overrides for any values you want to change, or call with no params to accept defaults.",
      inputSchema: {
        type: "object",
        properties: {
          installTimeout: { type: "number", description: "Dependency install timeout in ms" },
          testTimeout: { type: "number", description: "Test execution timeout in ms" },
          maxIslandRounds: { type: "number", description: "Max island algorithm rounds (1-3)" },
          hackerIslands: { type: "number", description: "How many Hacker skills to run (1-6)" },
          pmIslands: { type: "number", description: "How many PM tiers to run (1-4)" },
          maxConcurrentTests: { type: "number", description: "Max parallel test executions" },
          environment: { type: "string", enum: ["local", "server", "ci"], description: "Runtime environment" },
          sleepProtection: { type: "boolean", description: "Extend timeouts for machines that may sleep" },
          intent: { type: "string", description: 'User\'s one-line project intent, if not provided during scan. e.g. "A CLI tool that tests any codebase."' },
        },
        required: [],
      },
      async handler(params: Partial<SentinelConfig> & { intent?: string }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          const scanResult = lastScanResults.get(sessionKey);

          // Accept intent here if not provided during scan
          if (params.intent) {
            lastIntent.set(sessionKey, params.intent);
          }

          if (!scanResult) {
            return {
              content: [{ type: "text" as const, text: "Error: No scan result found. Call sentinel_scan first." }],
            };
          }

          // Start from proposed defaults, apply user overrides
          const proposed = proposeConfig(scanResult);
          const config = { ...proposed, ...params };
          setConfig(config);
          syncSemaphores();

          const scopeGuide = SCOPE_GUIDANCE[scanResult.scope] || SCOPE_GUIDANCE.full;

          // Time estimate based on island algorithm config
          const pmCalls = (config.pmIslands || 4) + 1 + 1; // tiers + cross + merge
          const hackerCalls = (config.hackerIslands || 6) + 1 + 1; // skills + cross + merge
          const testerCalls = 2; // system + user
          const totalCalls = 1 + pmCalls + testerCalls + hackerCalls; // research + PM + testers + hacker
          const rounds = config.maxIslandRounds || 2;
          const perCallSec = 30;
          const estMin = Math.ceil((totalCalls * rounds * perCallSec) / 60);
          const timeEstimate = `**Estimated time: ~${estMin} min** (${totalCalls} tool calls × ${rounds} max rounds, ~${perCallSec}s each)`;

          const output = [
            `## Configuration Confirmed`,
            "",
            formatConfigProposal(config, scanResult),
            "",
            timeEstimate,
            "",
            `---`,
            `Configuration locked. Proceed to the PM phase:`,
            ``,
            `Scope: ${scopeGuide}`,
            ``,
            `**Step 1**: Call sentinel_pm with tier="research" to do competitive analysis first.`,
            `**Step 2**: Then tier=1 through tier=4 for island exploration (research results auto-injected).`,
            `Or call sentinel_pm without tier for legacy single-pass mode.`,
          ].join("\n");

          log.info(`[sentinel] Config confirmed: rounds=${config.maxIslandRounds}, pm=${config.pmIslands}, hacker=${config.hackerIslands}, env=${config.environment}`);
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `sentinel config error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_config"], optional: true },
  );

  // ════════════════════════════════════════════
  // Tool 3: sentinel_pm — PM Island Algorithm
  //
  //   tier=1-4   : isolated tier pass with shuffled API surface
  //   tier="cross" : cross-tier escalation (T4 issue → T1 under load?)
  //   tier="merge" : deduplicate all criteria
  //   tier="done"  : store final criteria, return Tester prompt
  //   (no tier)    : legacy single-pass mode
  //
  //   Convergence: cross reports new cross-tier count.
  //     < 2 new → converge → merge
  //     ≥ 2 new → next round (max 3 rounds)
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_pm",
      description: [
        "PM phase with Island Algorithm for deep UX criteria generation.",
        "Modes: tier=1-4 (focused tier pass with randomized API order),",
        "tier='cross' (find cross-tier escalations),",
        "tier='merge' (deduplicate), tier='done' (store and proceed to Tester).",
        "Omit tier for legacy single-pass mode.",
        "",
        "Recommended: tier=1 through tier=4, then tier='cross'.",
        "If cross finds ≥2 new criteria, another round. Max 3 rounds. Then 'merge', then 'done'.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          tier: {
            type: ["integer", "string"],
            description: "1-4 for focused tier pass, 'cross' for cross-tier analysis, 'merge' for dedup, 'done' to store and proceed. Omit for legacy.",
          },
          tierResults: {
            type: "string",
            description: "Concatenated results from tier passes. Required for 'cross', 'merge', and 'done'.",
          },
          pmCriteria: {
            type: "string",
            description: "Legacy: the full PM criteria string. Used when tier is omitted.",
          },
        },
        required: [],
      },
      async handler(params: { tier?: number | string; tierResults?: string; pmCriteria?: string }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          const scanResult = lastScanResults.get(sessionKey);

          if (!scanResult) {
            return {
              content: [{ type: "text" as const, text: "Error: No scan result found. Call sentinel_scan first." }],
            };
          }

          const tier = params.tier;

          // ── Branch 0: Market research (tier="research") ──
          if (tier === "research") {
            // If research results are being submitted, store them
            if (params.tierResults) {
              pmResearch.set(sessionKey, params.tierResults);
              log.info(`[sentinel] PM research stored (${params.tierResults.length} chars)`);
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# PM Research Stored`,
                    "",
                    `Category risk profile saved. Now start the tier analysis:`,
                    `Call sentinel_pm with tier=1 to begin. Research context will be auto-injected.`,
                  ].join("\n"),
                }],
              };
            }

            // Return research prompt for the agent to execute
            const sourceContext = formatScanContext(scanResult);
            const calResult = lastCalibration.get(sessionKey);
            const intentBlock = calResult
              ? `## Intent Calibration\nThe following capability analysis was generated from the user's stated purpose. Use the [GAP] items to guide competitive research — these are things the project SHOULD have but doesn't.\n\n${calResult}\n`
              : "";
            const output = [
              `# PM Market Research Phase`,
              "",
              intentBlock,
              sourceContext,
              "",
              PM_RESEARCH_PROMPT,
            ].join("\n");

            log.info(`[sentinel] PM research prompt returned`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 1: Focused tier pass (tier=1-4) ──
          if (typeof tier === "number" && tier >= 1 && tier <= 4) {
            const round = pmRound.get(sessionKey) || 1;
            const t = PM_TIERS[tier - 1];
            const seed = djb2Hash(`${sessionKey}-pm-round${round}-tier${tier}`);
            const shuffledContext = formatScanContextShuffled(scanResult, seed);

            // Inject research context if available
            const research = pmResearch.get(sessionKey) || "(No competitive research done — consider running tier='research' first)";
            const prompt = PM_PREAMBLE
              .replace("{TIER_NAME}", t.name)
              .replace("{TIER_GOAL}", t.goal)
              .replace("{RESEARCH_CONTEXT}", research);

            const tierSection = `## Analysis focus: Tier ${t.id} — ${t.name}\n${t.prompt}`;
            const outputFmt = PM_OUTPUT_FORMAT.replace("{TIER_ID}", String(t.id));

            // Intent calibration — LLM-analyzed capability expectations
            const calResult = lastCalibration.get(sessionKey);
            const intentBlock = calResult
              ? `## Intent Calibration\nThe following capability analysis was generated from the user's stated purpose. Intent gaps ([GAP] items) are **T1 findings** — the most critical category.\n\n${calResult}\n`
              : "";

            const nextHint = tier < 4
              ? `\n\n---\nNext: call sentinel_pm with tier=${tier + 1} to continue.`
              : `\n\n---\nAll 4 tiers complete. Call sentinel_pm with tier="cross" and tierResults=<all 4 results concatenated>.`;

            const output = [
              `# PM Island ${tier}/4 (Round ${round}) — ${t.name}`,
              "",
              intentBlock,
              shuffledContext,
              "",
              prompt,
              "",
              tierSection,
              "",
              outputFmt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] PM tier ${tier}/4 (round ${round}), seed=${seed}`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 2: Cross-tier escalation (tier="cross") ──
          if (tier === "cross") {
            if (!params.tierResults) {
              return {
                content: [{ type: "text" as const, text: "Error: tier='cross' requires tierResults parameter." }],
              };
            }

            const round = pmRound.get(sessionKey) || 1;
            const crossPrompt = PM_CROSS_PROMPT
              .replace("{ROUND}", String(round))
              .replace("{TIER_RESULTS}", params.tierResults);

            const nextHint = [
              "",
              "---",
              `Count your NEW cross-tier findings.`,
              `- ≥ 2 new: call sentinel_pm with tier=1 for Round ${round + 1}.`,
              `- < 2 new: CONVERGE. Call sentinel_pm with tier="merge" and tierResults=<everything>.`,
              round >= 3 ? `- **Round 3 reached — MUST converge. Call tier="merge" next.**` : "",
            ].join("\n");

            pmRound.set(sessionKey, round + 1);

            const output = [
              `# PM Cross-Tier Escalation — Round ${round}`,
              "",
              crossPrompt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] PM cross-tier round ${round}`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 3: Merge (tier="merge") ──
          if (tier === "merge") {
            if (!params.tierResults) {
              return {
                content: [{ type: "text" as const, text: "Error: tier='merge' requires tierResults parameter." }],
              };
            }

            const mergePrompt = PM_MERGE_PROMPT.replace("{ALL_RESULTS}", params.tierResults);
            pmRound.delete(sessionKey);

            const output = [
              `# PM Criteria Merge`,
              "",
              mergePrompt,
            ].join("\n");

            log.info(`[sentinel] PM merge, results=${params.tierResults.length} chars`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 4: Done — store criteria, guide to dual Tester phase ──
          if (tier === "done") {
            if (!params.tierResults) {
              return {
                content: [{ type: "text" as const, text: "Error: tier='done' requires tierResults with the final merged PM criteria." }],
              };
            }

            lastPMCriteria.set(sessionKey, params.tierResults);

            const output = [
              `# PM Phase Complete — Proceed to Dual Tester Phase`,
              "",
              `PM criteria stored (${params.tierResults.length} chars).`,
              "",
              `## Next: Two independent Testers`,
              ``,
              `**System Tester** — tests code correctness (does NOT see PM criteria):`,
              `  Call sentinel_test with role="system" to get the System Tester prompt.`,
              ``,
              `**User Tester** — translates PM criteria into runnable UX tests:`,
              `  Call sentinel_test with role="user" to get the User Tester prompt.`,
              ``,
              `Run both, then pass BOTH plans to sentinel_hack.`,
            ].join("\n");

            log.info(`[sentinel] PM criteria stored (${params.tierResults.length} chars), dual Tester phase ready`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 5: Legacy mode (no tier param) ──
          {
            // If pmCriteria passed directly (old behavior), store and proceed to Tester
            if (params.pmCriteria) {
              lastPMCriteria.set(sessionKey, params.pmCriteria);

              const output = [
                `# PM Legacy — Criteria Stored`,
                "",
                `PM criteria stored. Call sentinel_test with role="system" and role="user" to generate test plans.`,
              ].join("\n");

              log.info(`[sentinel] PM legacy mode, criteria stored`);
              return { content: [{ type: "text" as const, text: output }] };
            }

            // No criteria and no tier — return legacy PM prompt
            const sourceContext = formatScanContext(scanResult);
            const output = [
              `# PM Phase (Legacy Mode)`,
              "",
              sourceContext,
              "",
              PM_PROMPT_LEGACY,
            ].join("\n");

            log.info(`[sentinel] PM legacy prompt returned`);
            return { content: [{ type: "text" as const, text: output }] };
          }
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `sentinel pm error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_pm"], optional: true },
  );

  // ════════════════════════════════════════════
  // Tool 3: sentinel_test — Dual Tester (System + User)
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_test",
      description: [
        "Generate test plans from two independent perspectives.",
        "role='system': System Tester — tests code correctness only, does NOT see PM criteria.",
        "role='user': User Tester — translates PM criteria into runnable UX/performance tests.",
        "Call both roles, then pass both plans to sentinel_hack.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: ["system", "user"],
            description: "Which tester perspective: 'system' for correctness, 'user' for UX criteria.",
          },
        },
        required: ["role"],
      },
      async handler(params: { role: "system" | "user" }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          const scanResult = lastScanResults.get(sessionKey);

          if (!scanResult) {
            return {
              content: [{ type: "text" as const, text: "Error: No scan result found. Call sentinel_scan first." }],
            };
          }

          const sourceContext = formatScanContext(scanResult);
          const scopeGuide = SCOPE_GUIDANCE[scanResult.scope] || SCOPE_GUIDANCE.full;

          if (params.role === "system") {
            const output = [
              `# System Tester — Code Correctness`,
              "",
              sourceContext,
              "",
              scopeGuide,
              "",
              SYSTEM_TESTER_PROMPT,
            ].join("\n");

            log.info(`[sentinel] System Tester prompt returned`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // role === "user"
          const pmCriteria = lastPMCriteria.get(sessionKey);
          if (!pmCriteria) {
            return {
              content: [{ type: "text" as const, text: "Error: No PM criteria found. Run sentinel_pm first." }],
            };
          }

          const userPrompt = USER_TESTER_PROMPT.replace("{PM_CRITERIA}", pmCriteria);

          const output = [
            `# User Tester — UX Criteria Validation`,
            "",
            sourceContext,
            "",
            scopeGuide,
            "",
            userPrompt,
          ].join("\n");

          log.info(`[sentinel] User Tester prompt returned, PM criteria=${pmCriteria.length} chars`);
          return { content: [{ type: "text" as const, text: output }] };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `sentinel test error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_test"], optional: true },
  );

  // ════════════════════════════════════════════
  // Tool 4: sentinel_hack — Island Algorithm Hacker
  //
  //   skill=1-6 : isolated skill pass with shuffled API surface
  //   skill="cross" : cross-pollination — chain attacks across skills
  //   skill="merge" : final dedup and merge with tester plan
  //   (no skill)    : legacy full-prompt mode
  //
  //   Convergence: cross reports new chain count.
  //     < 2 new chains → converge → merge
  //     ≥ 2 new chains → next round (max 3 rounds)
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_hack",
      description: [
        "Hacker phase with Island Algorithm for deep, diverse attack generation.",
        "Modes: skill=1-6 (focused attack pass, each with randomized API order),",
        "skill='cross' (chain attacks across skill findings),",
        "skill='merge' (final dedup with tester plan).",
        "Omit skill for legacy single-pass mode.",
        "",
        "Recommended flow: call skill=1 through skill=6, then skill='cross' with results.",
        "If cross finds ≥2 new chains, go another round. Max 3 rounds. Then skill='merge'.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          systemPlan: {
            type: "string",
            description: "System Tester plan (correctness). Required on first call; cached.",
          },
          userPlan: {
            type: "string",
            description: "User Tester plan (UX criteria). Required on first call; cached.",
          },
          skill: {
            type: ["integer", "string"],
            description: "1-6 for focused skill pass, 'cross' for chain attacks, 'merge' for final merge. Omit for legacy mode.",
          },
          skillResults: {
            type: "string",
            description: "Concatenated results from skill passes. Required for 'cross' and 'merge'.",
          },
        },
        required: [],
      },
      async handler(params: { systemPlan?: string; userPlan?: string; skill?: number | string; skillResults?: string }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          const scanResult = lastScanResults.get(sessionKey);

          if (!scanResult) {
            return {
              content: [{ type: "text" as const, text: "Error: No scan result found. Call sentinel_scan first." }],
            };
          }

          // Cache tester plans on first call
          if (params.systemPlan) {
            lastTesterPlan.set(sessionKey + ":system", params.systemPlan);
          }
          if (params.userPlan) {
            lastTesterPlan.set(sessionKey + ":user", params.userPlan);
          }
          const systemPlan = lastTesterPlan.get(sessionKey + ":system") || params.systemPlan || "";
          const userPlan = lastTesterPlan.get(sessionKey + ":user") || params.userPlan || "";
          const pmCriteria = lastPMCriteria.get(sessionKey) || "(PM phase skipped)";

          if (!systemPlan && !userPlan) {
            return {
              content: [{ type: "text" as const, text: "Error: No tester plans. Pass systemPlan and/or userPlan on the first sentinel_hack call." }],
            };
          }
          const combinedPlan = [
            systemPlan ? `### System Tester Plan\n${systemPlan}` : "",
            userPlan ? `### User Tester Plan\n${userPlan}` : "",
          ].filter(Boolean).join("\n\n");

          const skill = params.skill;

          // ── Branch 1: Focused skill pass (skill=1-6) ──
          if (typeof skill === "number" && skill >= 1 && skill <= 6) {
            const round = hackRound.get(sessionKey) || 1;
            const s = HACKER_SKILLS[skill - 1];
            const seed = djb2Hash(`${sessionKey}-round${round}-skill${skill}`);
            const shuffledContext = formatScanContextShuffled(scanResult, seed);

            const prompt = HACKER_PREAMBLE
              .replace("{SKILL_NAME}", s.name)
              .replace("{SKILL_GOAL}", s.goal)
              .replace("{PM_CRITERIA}", pmCriteria)
              .replace("{SYSTEM_PLAN}", systemPlan)
              .replace("{USER_PLAN}", userPlan);

            const skillSection = `## Attack methodology: ${s.name}\n${s.prompt}`;
            const outputFmt = HACKER_OUTPUT_FORMAT.replace("{SKILL_ID}", String(s.id));

            const nextHint = skill < 6
              ? `\n\n---\nNext: call sentinel_hack with skill=${skill + 1} to continue the island exploration.`
              : `\n\n---\nAll 6 skills complete. Now call sentinel_hack with skill="cross" and skillResults=<all 6 results concatenated> to find attack chains.`;

            const output = [
              `# Hacker Island ${skill}/6 (Round ${round}) — ${s.name}`,
              "",
              shuffledContext,
              "",
              prompt,
              "",
              skillSection,
              "",
              outputFmt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] Hacker skill ${skill}/6 (round ${round}), seed=${seed}`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 2: Cross-pollination (skill="cross") ──
          if (skill === "cross") {
            if (!params.skillResults) {
              return {
                content: [{ type: "text" as const, text: "Error: skill='cross' requires skillResults parameter with concatenated attack outputs." }],
              };
            }

            const round = hackRound.get(sessionKey) || 1;
            const crossPrompt = HACKER_CROSS_PROMPT
              .replace("{ROUND}", String(round))
              .replace("{SKILL_RESULTS}", params.skillResults);

            const nextHint = [
              "",
              "---",
              `After generating chain attacks, count your NEW findings.`,
              `- If you found ≥ 2 new chain attacks: call sentinel_hack with skill=1 again for Round ${round + 1} deeper exploration (max 3 rounds).`,
              `- If you found < 2 new chain attacks: CONVERGE. Call sentinel_hack with skill="merge" and skillResults=<everything from all rounds>.`,
              round >= 3 ? `- **Round 3 reached — you MUST converge. Call skill="merge" next.**` : "",
            ].join("\n");

            // Advance round counter
            hackRound.set(sessionKey, round + 1);

            const output = [
              `# Hacker Cross-Pollination — Round ${round}`,
              "",
              crossPrompt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] Hacker cross-pollination round ${round}, results=${params.skillResults.length} chars`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 3: Final merge (skill="merge") ──
          if (skill === "merge") {
            if (!params.skillResults) {
              return {
                content: [{ type: "text" as const, text: "Error: skill='merge' requires skillResults parameter with all attack outputs." }],
              };
            }

            const mergePrompt = HACKER_MERGE_PROMPT
              .replace("{TESTER_PLAN}", combinedPlan)
              .replace("{ALL_RESULTS}", params.skillResults);

            // Reset round counter
            hackRound.delete(sessionKey);

            const output = [
              `# Hacker Final Merge`,
              "",
              mergePrompt,
            ].join("\n");

            log.info(`[sentinel] Hacker merge, total results=${params.skillResults.length} chars`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 4: Legacy mode (no skill param) ──
          {
            const allSkills = HACKER_SKILLS.map((s) =>
              `### SKILL ${s.id}: ${s.name}\nGoal: ${s.goal}\n${s.prompt}`
            ).join("\n\n");

            const legacyPrompt = [
              `You are a black-hat attacker. BREAK this system.`,
              ``,
              `## PM criteria:\n${pmCriteria}`,
              `## Tester plans:\n${combinedPlan}`,
              ``,
              `## Attack surface`,
              `Walk through EVERY exported function. Apply all skills below.`,
              ``,
              allSkills,
              ``,
              HACKER_OUTPUT_FORMAT.replace("{SKILL_ID}", "N"),
              ``,
              `## After generating attacks, MERGE:`,
              `- Keep ALL Tester tests (tag [T])`,
              `- Add ALL Hacker attacks (tag [H])`,
              `- Overlap where Hacker is nastier: [T+H]`,
              `- Show coverage stats`,
              ``,
              `Present merged plan. After approval, call sentinel_run.`,
            ].join("\n");

            const sourceContext = formatScanContext(scanResult);
            const output = [
              `# Hacker Phase (Legacy Mode)`,
              "",
              sourceContext,
              "",
              legacyPrompt,
            ].join("\n");

            log.info(`[sentinel] Hacker legacy mode`);
            return { content: [{ type: "text" as const, text: output }] };
          }
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `sentinel hack error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_hack"], optional: true },
  );

  // ════════════════════════════════════════════
  // Tool 3: sentinel_run — Execute merged tests
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_run",
      description:
        "Execute test files in an isolated workspace. Pass test file contents as key-value pairs (filename -> content). Returns structured pass/fail results. Call this AFTER the merged test plan (PM + Tester + Hacker) is approved and test files are written.",
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Absolute path to the project directory (same as scan target)",
          },
          testFiles: {
            type: "object",
            description:
              'Map of filename -> file content. Example: {"functional.test.ts": "import { describe ... }"}',
            additionalProperties: { type: "string" },
          },
          save: {
            type: "boolean",
            description: "If true, save test files to the target project after execution",
          },
        },
        required: ["target", "testFiles"],
      },
      async handler(params: { target: string; testFiles: Record<string, string>; save?: boolean }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          const scanResult = lastScanResults.get(sessionKey);

          if (!scanResult) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: No scan result found. Call sentinel_scan first.",
                },
              ],
            };
          }

          const fileCount = Object.keys(params.testFiles).length;
          log.info(`[sentinel] Setting up workspace with ${fileCount} test files`);

          // 1. Create workspace
          const ws = createWorkspace(params.target, scanResult.language);
          activeWorkspaces.set(sessionKey, ws);

          // 2. Install deps
          log.info(`[sentinel] Installing dependencies...`);
          const installResult = await installDeps(ws);
          if (!installResult.success) {
            const output = `## Dependency installation failed\n\n\`\`\`\n${installResult.output.slice(0, 2000)}\n\`\`\`\n\nFix the dependency issue and try again.`;
            destroyWorkspace(ws);
            activeWorkspaces.delete(sessionKey);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // 3. Write test files
          writeTestFiles(ws, params.testFiles);

          // 4. Run tests
          log.info(`[sentinel] Running tests...`);
          const testResult = await runTests(ws);

          // 5. Format report
          const report = formatReport(scanResult, testResult);
          let output = report.summary + "\n" + report.details;

          // 6. If failures, add analysis context
          if (testResult.failures.length > 0) {
            output += "\n### Failure Analysis Context\n";
            output += formatFailureContext(testResult);
            output += "\nAnalyze the failures above. For each failure:\n";
            output += "1. Identify the root cause in the source code\n";
            output += "2. Determine if it's a bug in the code or a bug in the test\n";
            output += "3. If it's a code bug, suggest a specific fix\n";
          }

          // 7. Save if requested
          if (params.save) {
            const savedDir = saveTestFiles(ws, params.target);
            output += `\n\nTest files saved to: ${savedDir}`;
          }

          // 8. Cleanup
          destroyWorkspace(ws);
          activeWorkspaces.delete(sessionKey);

          log.info(
            `[sentinel] Done: ${testResult.passed}/${testResult.totalTests} passed, ${testResult.failed} failed`,
          );

          return { content: [{ type: "text" as const, text: output }] };
        } catch (err: any) {
          const sessionKey = ctx.sessionKey || "default";
          const ws = activeWorkspaces.get(sessionKey);
          if (ws) {
            destroyWorkspace(ws);
            activeWorkspaces.delete(sessionKey);
          }
          return {
            content: [{ type: "text" as const, text: `sentinel run error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_run"], optional: true },
  );

  // ════════════════════════════════════════════
  // Hook: detect code changes via git diff
  // ════════════════════════════════════════════

  api.on("before_prompt_build", async (_event: any, ctx: any) => {
    const sessionKey = ctx.sessionKey || "default";
    const scanResult = lastScanResults.get(sessionKey);
    if (!scanResult) return; // no scan yet — nothing to compare

    // Find the target dir from the scan result's source files
    // The scan was called with a target dir, but we don't store it directly.
    // Reconstruct from the first source file or just check all tracked dirs.
    // For simplicity: we stored the diff hash keyed by sessionKey at scan time.
    const lastHash = lastScanDiffHash.get(sessionKey);
    if (lastHash === undefined) return; // no baseline

    // We need the target dir — store it at scan time
    const targetDir = (scanResult as any)._targetDir;
    if (!targetDir) return;

    const currentHash = getGitDiffFingerprint(targetDir);
    if (currentHash === lastHash) return; // no new changes since last scan

    // Changes detected — nudge once, then update the hash so we don't spam
    lastScanDiffHash.set(sessionKey, currentHash);

    return {
      prependContext: [
        `<sentinel_hint>`,
        `New code changes detected since last Sentinel scan. Consider re-running:`,
        `1. Call sentinel_scan to analyze the new changes`,
        `2. Run PM island algorithm: sentinel_pm tier=1-4, cross, merge, done`,
        `3. Run dual testers: sentinel_test role=system, sentinel_test role=user`,
        `4. Run Hacker island algorithm: sentinel_hack skill=1-6, cross, merge`,
        `5. Call sentinel_run to execute tests`,
        `</sentinel_hint>`,
      ].join("\n"),
    };
  });

  log.info("[sentinel] Plugin loaded — tools: sentinel_scan, sentinel_config, sentinel_pm, sentinel_test, sentinel_hack, sentinel_run");
}
