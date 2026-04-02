/**
 * Sentinel Plugin — AI testing agent for OpenClaw
 *
 * Six-tool flow for four-perspective testing:
 *
 *   1. sentinel_scan   — Scan project, return context.
 *   2. sentinel_config — Confirm configuration before PM/test/hack phases.
 *   3. sentinel_pm     — PM defines UX acceptance criteria (T1-T4 island algorithm).
 *   4. sentinel_test   — Dual Tester:
 *        role="system" — System Tester validates code correctness (no PM input)
 *        role="user"   — User Tester translates PM criteria into runnable UX tests
 *   5. sentinel_hack   — Hacker sees both Tester plans + PM criteria (island algorithm).
 *   6. sentinel_report — Turn host-run failures into a final T-tier report input.
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
import { formatScanContext, formatTierReportInput } from "./lib/reporter.js";
import { proposeConfig, formatConfigProposal, setConfig } from "./lib/config.js";
import { syncSemaphores } from "./lib/concurrency.js";
import { IsolationVault, describeArtifact, formatIsolationCapsule } from "./lib/isolation.js";
import type { SentinelConfig } from "./lib/config.js";
import type { ScanResult } from "./lib/detect.js";

// ── State ──
const lastScanResults = new Map<string, ScanResult>();
const pendingScan = new Map<string, { result: ScanResult; target: string }>();
const lastIntent = new Map<string, string>();      // user's one-line project intent
const lastPMCriteria = new Map<string, string>();
const lastTesterPlan = new Map<string, string>();
const hackRound = new Map<string, number>(); // current round per session
const pmRound = new Map<string, number>();   // current PM round per session
const pmResearch = new Map<string, string>(); // market research results per session
const isolationVault = new IsolationVault();

function clearScanArtifacts(sessionKey: string): void {
  lastScanResults.delete(sessionKey);
  pendingScan.delete(sessionKey);
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
    ...tierArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
    ...crossArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
  ]);
}

function getAllPMResults(sessionKey: string): string {
  const research = isolationVault.latest(sessionKey, { kind: "pm_research" });
  const tierArtifacts = isolationVault.list(sessionKey, { kind: "pm_tier" });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "pm_cross" });
  return joinSections([
    research ? `### ${describeArtifact(research)}\n${research.content}` : "",
    ...tierArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
    ...crossArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
  ]);
}

function getHackRoundResults(sessionKey: string, round: number): string {
  const skillArtifacts = isolationVault.list(sessionKey, { kind: "hack_skill", round });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "hack_cross", round });
  return joinSections([
    ...skillArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
    ...crossArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
  ]);
}

function getAllHackResults(sessionKey: string): string {
  const skillArtifacts = isolationVault.list(sessionKey, { kind: "hack_skill" });
  const crossArtifacts = isolationVault.list(sessionKey, { kind: "hack_cross" });
  const mergeArtifact = isolationVault.latest(sessionKey, { kind: "hack_merge" });
  return joinSections([
    ...skillArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
    ...crossArtifacts.map((artifact) => `### ${describeArtifact(artifact)}\n${artifact.content}`),
    mergeArtifact ? `### ${describeArtifact(mergeArtifact)}\n${mergeArtifact.content}` : "",
  ]);
}

const FULL_REPO_GUIDANCE =
  "Context is FULL REPOSITORY. Read the full project structure, then focus your tests on the highest-risk contracts, boundaries, state transitions, and user-facing failure modes.";

const HOST_EXECUTION_GUIDANCE = [
  "Sentinel does not execute tests through the plugin.",
  "After you generate the final runnable test files, have the host coding agent write them into its own workspace and run them with its own terminal or sandbox.",
  "Execution belongs to the host agent that generated the code.",
  "After the host run completes, call sentinel_report with each failure item's test_name, failure_type, and error_message to produce the final T-tier report.",
].join(" ");

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
Individual analysts found issues within their tier. Your job is to find issues that SPAN tiers:

1. **Escalation**: A T4 issue (memory leak) that under load becomes a T1 issue (data loss). A T3 issue (slow response) that sometimes returns stale data = T2 issue (wrong answer).
2. **Compounding**: A T3 issue (extra workflow step) combined with a T2 issue (confusing error) = user gives up entirely (T1).
3. **Hidden T1s**: Issues classified as T3/T4 that are actually T1 in disguise under specific conditions.
4. **Indirect cost chains**: A T3 issue (per-interaction compute overhead) that injects content into LLM context = T1 issue (silent token cost to the caller on EVERY interaction). This pattern is especially common in AI plugins/middleware — the plugin "works" but makes every downstream call more expensive.
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

Present the test code to the host coding agent. After approval, the host agent should write the test files into its own workspace and run them directly.
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

Present the test code to the host coding agent. After approval, the host agent should write the test files into its own workspace and run them directly.
`;

// ── Hacker prompt components (Step 3) ──
// Architecture: Island Algorithm with convergent cross-pollination
//   Round 1: 6 isolated skill agents, each constrained to its own attack lane
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

## Coverage Ledger
- Components attacked: which modules/functions you actually pressured
- Input classes tried: the payload families you explored
- Suspicious but unbroken: what still feels too trusted, too quiet, or too lightly exercised

## Next Frontier
- List 2 follow-up attack leads the NEXT isolated pass should pursue because they may unlock a deeper chain or a wider blast radius

## Constraints:
- Walk through the API surface SYSTEMATICALLY. Every exported function must be considered.
- Produce at least 3 attacks the Tester missed for THIS skill.
- Each attack must have a CONCRETE payload.
- Prefer SILENT corruption over crashes.
- Cross-reference PM criteria: T1/T2 concerns get attacked harder.
- At least one attack should come from a surface that does NOT look obviously dangerous at first glance.
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
5. **Coverage gap exploitation**: Start from components that were barely attacked in the individual skill passes and ask how they could become the first step of a larger chain.

## Rules:
- Every chain must be ≥2 steps (single-function attacks were already found by individual agents)
- Show the COMPLETE chain: step 1 → step 2 → ... → impact
- Identify which agent's findings you're combining
- Produce at least 3 NEW chain attacks not covered by individual agents
- Prefer new blast radius and surprising entry points over "same bug, bigger payload".
- Report: "N new chain attacks found" (this determines if another round is needed — <2 = converge)

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
          intent: {
            type: "string",
            description: 'One sentence from the user: "What is this project for?" e.g. "A CLI tool that tests any codebase from four perspectives." If unknown, ASK the user first.',
          },
        },
        required: ["target"],
      },
      async handler(params: { target: string; intent?: string }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          clearScanArtifacts(sessionKey);

          log.info(`[sentinel] Scanning ${params.target} (full repository mode)`);

          const result = scan(params.target);
          lastScanDiffHash.set(sessionKey, getGitDiffFingerprint(params.target));

          // ── Gate: no intent → block pipeline, force calibration ──
          if (!params.intent) {
            pendingScan.set(sessionKey, { result, target: params.target });
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
                  `⛔ sentinel_pm, sentinel_test, and sentinel_hack will not work until calibration is complete.`,
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


          const output = parts.join("\n");

          log.info(
            `[sentinel] Scan complete: ${result.language}, ${result.sourceFiles.length} files, ${result.apiSurface.length} exports, intent=yes`,
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
  // Tool 2: sentinel_config — Confirm/modify Sentinel configuration
  // ════════════════════════════════════════════

  api.registerTool(
    (ctx: any) => ({
      name: "sentinel_config",
      description:
        "Confirm or modify the Sentinel configuration proposed by sentinel_scan. Call this AFTER scan, BEFORE pm. Pass overrides for any values you want to change, or call with no params to accept defaults.",
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
            `Context: ${FULL_REPO_GUIDANCE}`,
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
  //   tier=1-4   : isolated tier pass with stable structured context
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
        "Modes: tier=1-4 (focused tier pass with stable structured context),",
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
              const artifact = isolationVault.store(sessionKey, "pm_research", params.tierResults);
              pmResearch.set(sessionKey, params.tierResults);
              log.info(`[sentinel] PM research stored (${params.tierResults.length} chars) as ${artifact.id}`);
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# PM Research Stored`,
                    "",
                    `Category risk profile saved as ${describeArtifact(artifact)}.`,
                    `Now start the tier analysis:`,
                    `Call sentinel_pm with tier=1 to begin. Research context will be auto-injected.`,
                  ].join("\n"),
                }],
              };
            }

            // Return research prompt for the agent to execute
            const sourceContext = formatScanContext(scanResult);
            const capsule = formatIsolationCapsule("PM Research", [
              "Visible: scan context only.",
              "Hidden by Sentinel: tester plans, hacker findings, and PM criteria from later phases.",
            ]);
            const output = [
              `# PM Market Research Phase`,
              "",
              capsule,
              "",
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
            if (params.tierResults) {
              const artifact = isolationVault.store(sessionKey, "pm_tier", params.tierResults, { round, tier });
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# PM Tier Stored`,
                    "",
                    `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                    tier < 4
                      ? `Next: call sentinel_pm with tier=${tier + 1} to open the next isolated PM cabin.`
                      : `All 4 tiers for round ${round} are stored. Call sentinel_pm with tier="cross" to open the cross-tier cabin.`,
                  ].join("\n"),
                }],
              };
            }
            const t = PM_TIERS[tier - 1];
            const structuredContext = formatScanContext(scanResult);

            // Inject research context if available
            const researchArtifact = isolationVault.latest(sessionKey, { kind: "pm_research" });
            const research = researchArtifact?.content || pmResearch.get(sessionKey) || "(No competitive research done — consider running tier='research' first)";
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

            // Intent calibration — LLM-analyzed capability expectations
            const nextHint = tier < 4
              ? `\n\n---\nAfter generating this tier, store it by calling sentinel_pm with tier=${tier} and tierResults=<your output>. Then open tier=${tier + 1}.`
              : `\n\n---\nAfter generating this tier, store it by calling sentinel_pm with tier=4 and tierResults=<your output>. Then call sentinel_pm with tier="cross" to combine only the stored PM artifacts for this round.`;

            const output = [
              `# PM Island ${tier}/4 (Round ${round}) — ${t.name}`,
              "",
              capsule,
              "",
              structuredContext,
              "",
              prompt,
              "",
              tierSection,
              "",
              outputFmt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] PM tier ${tier}/4 (round ${round}), structured isolation active`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 2: Cross-tier escalation (tier="cross") ──
          if (tier === "cross") {
            const round = pmRound.get(sessionKey) || 1;
            if (params.tierResults) {
              const artifact = isolationVault.store(sessionKey, "pm_cross", params.tierResults, { round });
              pmRound.set(sessionKey, round + 1);
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# PM Cross-Tier Stored`,
                    "",
                    `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                    `If this cross-tier pass found enough new criteria, call sentinel_pm with tier=1 to open round ${round + 1}.`,
                    `If it converged, call sentinel_pm with tier="merge" to merge only the stored PM artifacts.`,
                  ].join("\n"),
                }],
              };
            }

            const tierResultsForRound = getPMRoundResults(sessionKey, round);
            if (!tierResultsForRound) {
              return {
                content: [{ type: "text" as const, text: `Error: No stored PM tier artifacts found for round ${round}. Store tier results first.` }],
              };
            }

            const capsule = formatIsolationCapsule(`PM Cross / Round ${round}`, [
              `Visible artifacts: only stored PM tier results from round ${round}.`,
              "Hidden by Sentinel: tester plans, hacker findings, and future PM rounds.",
            ]);
            const crossPrompt = PM_CROSS_PROMPT
              .replace("{ROUND}", String(round))
              .replace("{TIER_RESULTS}", tierResultsForRound);

            const nextHint = [
              "",
              "---",
              `After generating cross-tier findings, store them by calling sentinel_pm with tier="cross" and tierResults=<your output>.`,
              `- If the stored cross result found ≥ 2 new criteria: open round ${round + 1} with tier=1.`,
              `- If it converged: call sentinel_pm with tier="merge" to merge only the stored PM artifacts.`,
              round >= 3 ? `- **Round 3 reached — MUST converge after storing this pass.**` : "",
            ].join("\n");

            const output = [
              `# PM Cross-Tier Escalation — Round ${round}`,
              "",
              capsule,
              "",
              crossPrompt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] PM cross-tier round ${round}`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 3: Merge (tier="merge") ──
          if (tier === "merge") {
            if (params.tierResults) {
              const artifact = isolationVault.store(sessionKey, "pm_merge", params.tierResults);
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# PM Merge Stored`,
                    "",
                    `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                    `Next: call sentinel_pm with tier="done" to promote the latest merged PM criteria.`,
                  ].join("\n"),
                }],
              };
            }

            const allResults = getAllPMResults(sessionKey);
            if (!allResults) {
              return {
                content: [{ type: "text" as const, text: "Error: No stored PM artifacts found. Run and store PM phases first." }],
              };
            }

            const mergePrompt = PM_MERGE_PROMPT.replace("{ALL_RESULTS}", allResults);
            pmRound.delete(sessionKey);
            const capsule = formatIsolationCapsule("PM Merge", [
              "Visible artifacts: stored PM research, tier, and cross outputs only.",
              "Hidden by Sentinel: tester plans and hacker findings.",
            ]);

            const output = [
              `# PM Criteria Merge`,
              "",
              capsule,
              "",
              mergePrompt,
            ].join("\n");

            log.info(`[sentinel] PM merge prompt returned, stored-input=${allResults.length} chars`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 4: Done — store criteria, guide to dual Tester phase ──
          if (tier === "done") {
            const finalCriteria = params.tierResults || isolationVault.latest(sessionKey, { kind: "pm_merge" })?.content;
            if (!finalCriteria) {
              return {
                content: [{ type: "text" as const, text: "Error: No merged PM criteria found. Store a merge result first." }],
              };
            }

            lastPMCriteria.set(sessionKey, finalCriteria);

            const output = [
              `# PM Phase Complete — Proceed to Dual Tester Phase`,
              "",
              `PM criteria stored (${finalCriteria.length} chars).`,
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

            log.info(`[sentinel] PM criteria stored (${finalCriteria.length} chars), dual Tester phase ready`);
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
          plan: {
            type: "string",
            description: "Store the generated tester output inside Sentinel's isolation vault.",
          },
        },
        required: ["role"],
      },
      async handler(params: { role: "system" | "user"; plan?: string }) {
        try {
          const sessionKey = ctx.sessionKey || "default";
          const scanResult = lastScanResults.get(sessionKey);

          if (!scanResult) {
            return {
              content: [{ type: "text" as const, text: "Error: No scan result found. Call sentinel_scan first." }],
            };
          }

          if (params.plan) {
            const kind = params.role === "system" ? "tester_system" : "tester_user";
            const artifact = isolationVault.store(sessionKey, kind, params.plan);
            lastTesterPlan.set(sessionKey + `:${params.role}`, params.plan);
            return {
              content: [{
                type: "text" as const,
                text: [
                  `# Tester Plan Stored`,
                  "",
                  `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                  params.role === "system"
                    ? `Next: call sentinel_test with role="user" to open the UX tester cabin.`
                    : `Both tester cabins can now be consumed by sentinel_hack without re-pasting their contents.`,
                ].join("\n"),
              }],
            };
          }

          const sourceContext = formatScanContext(scanResult);
          const capsule = params.role === "system"
            ? formatIsolationCapsule("System Tester", [
              "Visible: scan context only.",
              "Hidden by Sentinel: PM criteria, user tester output, and hacker findings.",
            ])
            : formatIsolationCapsule("User Tester", [
              "Visible: scan context and the promoted PM criteria only.",
              "Hidden by Sentinel: system tester output and hacker findings.",
            ]);

          if (params.role === "system") {
            const output = [
              `# System Tester — Code Correctness`,
              "",
              capsule,
              "",
              sourceContext,
              "",
              FULL_REPO_GUIDANCE,
              "",
              SYSTEM_TESTER_PROMPT,
              "",
              `After generating the plan, store it by calling sentinel_test with role="system" and plan=<your output>.`,
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
            capsule,
            "",
            sourceContext,
            "",
            FULL_REPO_GUIDANCE,
            "",
            userPrompt,
            "",
            `After generating the plan, store it by calling sentinel_test with role="user" and plan=<your output>.`,
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
  //   skill=1-6 : isolated skill pass with stable structured context
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
        "Modes: skill=1-6 (focused attack pass, each with stable structured context),",
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
            isolationVault.store(sessionKey, "tester_system", params.systemPlan);
          }
          if (params.userPlan) {
            lastTesterPlan.set(sessionKey + ":user", params.userPlan);
            isolationVault.store(sessionKey, "tester_user", params.userPlan);
          }
          const testerPlans = getLatestTesterPlans(sessionKey);
          const systemPlan = testerPlans.system;
          const userPlan = testerPlans.user;
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
            if (params.skillResults) {
              const artifact = isolationVault.store(sessionKey, "hack_skill", params.skillResults, { round, skill });
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# Hacker Skill Stored`,
                    "",
                    `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                    skill < 6
                      ? `Next: call sentinel_hack with skill=${skill + 1} to open the next isolated hacker cabin.`
                      : `All 6 hacker skills for round ${round} are stored. Call sentinel_hack with skill="cross" to chain only the stored hacker artifacts.`,
                  ].join("\n"),
                }],
              };
            }
            const s = HACKER_SKILLS[skill - 1];
            const structuredContext = formatScanContext(scanResult);

            const prompt = HACKER_PREAMBLE
              .replace("{SKILL_NAME}", s.name)
              .replace("{SKILL_GOAL}", s.goal)
              .replace("{PM_CRITERIA}", pmCriteria)
              .replace("{SYSTEM_PLAN}", systemPlan)
              .replace("{USER_PLAN}", userPlan);
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

            const output = [
              `# Hacker Island ${skill}/6 (Round ${round}) — ${s.name}`,
              "",
              capsule,
              "",
              structuredContext,
              "",
              prompt,
              "",
              skillSection,
              "",
              outputFmt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] Hacker skill ${skill}/6 (round ${round}), structured isolation active`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 2: Cross-pollination (skill="cross") ──
          if (skill === "cross") {
            const round = hackRound.get(sessionKey) || 1;
            if (params.skillResults) {
              const artifact = isolationVault.store(sessionKey, "hack_cross", params.skillResults, { round });
              hackRound.set(sessionKey, round + 1);
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# Hacker Cross Stored`,
                    "",
                    `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                    `If this chaining pass found enough new attacks, call sentinel_hack with skill=1 to open round ${round + 1}.`,
                    `If it converged, call sentinel_hack with skill="merge" to merge only the stored hacker artifacts.`,
                  ].join("\n"),
                }],
              };
            }

            const skillResultsForRound = getHackRoundResults(sessionKey, round);
            if (!skillResultsForRound) {
              return {
                content: [{ type: "text" as const, text: `Error: No stored hacker skill artifacts found for round ${round}. Store skill results first.` }],
              };
            }

            const capsule = formatIsolationCapsule(`Hacker Cross / Round ${round}`, [
              `Visible artifacts: only stored hacker skill outputs from round ${round}, plus the latest tester plans.`,
              "Hidden by Sentinel: future hacker rounds and raw host conversation history.",
            ]);
            const crossPrompt = HACKER_CROSS_PROMPT
              .replace("{ROUND}", String(round))
              .replace("{SKILL_RESULTS}", skillResultsForRound);

            const nextHint = [
              "",
              "---",
              `After generating chain attacks, store them by calling sentinel_hack with skill="cross" and skillResults=<your output>.`,
              `- If the stored cross result found ≥ 2 new attacks: open round ${round + 1} with skill=1.`,
              `- If it converged: call sentinel_hack with skill="merge" to merge only the stored hacker artifacts.`,
              round >= 3 ? `- **Round 3 reached — MUST converge after storing this pass.**` : "",
            ].join("\n");

            const output = [
              `# Hacker Cross-Pollination — Round ${round}`,
              "",
              capsule,
              "",
              crossPrompt,
              nextHint,
            ].join("\n");

            log.info(`[sentinel] Hacker cross-pollination round ${round}, stored-input=${skillResultsForRound.length} chars`);
            return { content: [{ type: "text" as const, text: output }] };
          }

          // ── Branch 3: Final merge (skill="merge") ──
          if (skill === "merge") {
            if (params.skillResults) {
              const artifact = isolationVault.store(sessionKey, "hack_merge", params.skillResults);
              return {
                content: [{
                  type: "text" as const,
                  text: [
                    `# Hacker Merge Stored`,
                    "",
                    `Stored ${describeArtifact(artifact)} inside Sentinel's isolation vault.`,
                    `Next: have the host coding agent write the final merged test files and run them in its own terminal or sandbox.`,
                  ].join("\n"),
                }],
              };
            }

            const allResults = getAllHackResults(sessionKey);
            if (!allResults) {
              return {
                content: [{ type: "text" as const, text: "Error: No stored hacker artifacts found. Run and store hacker phases first." }],
              };
            }

            const mergePrompt = HACKER_MERGE_PROMPT
              .replace("{TESTER_PLAN}", combinedPlan)
              .replace("{ALL_RESULTS}", allResults);

            // Reset round counter
            hackRound.delete(sessionKey);
            const capsule = formatIsolationCapsule("Hacker Merge", [
              "Visible artifacts: latest stored tester plans plus stored hacker skill and cross outputs.",
              "Hidden by Sentinel: PM tier raw outputs that were not promoted into tester-visible artifacts.",
            ]);

            const output = [
              `# Hacker Final Merge`,
              "",
              capsule,
              "",
              mergePrompt,
            ].join("\n");

            log.info(`[sentinel] Hacker merge prompt returned, stored-input=${allResults.length} chars`);
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
              HOST_EXECUTION_GUIDANCE,
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
  // Tool 5: sentinel_report — Final T-tier report
  // ════════════════════════════════════════════

  api.registerTool(
    (_ctx: any) => ({
      name: "sentinel_report",
      description:
        "Turn host-run failure items into a final T-tier report. Pass only raw failure evidence from the host test run.",
      inputSchema: {
        type: "object",
        properties: {
          failures: {
            type: "array",
            description: "Failure items from the host coding agent's test run.",
            items: {
              type: "object",
              properties: {
                testName: { type: "string", description: "Test name from the host test run" },
                failureType: { type: "string", description: "Failure type such as test, setup, compile, collection, timeout, or runtime" },
                errorMessage: { type: "string", description: "Raw error message for this failure item" },
                testFile: { type: "string", description: "Optional test file path reported by the host" },
              },
              required: ["testName", "failureType", "errorMessage"],
            },
          },
          totalTests: { type: "number", description: "Optional total number of tests executed" },
          passed: { type: "number", description: "Optional number of passed tests" },
          failed: { type: "number", description: "Optional number of failed tests" },
          durationSeconds: { type: "number", description: "Optional execution duration in seconds" },
        },
        required: ["failures"],
      },
      async handler(params: {
        failures: Array<{ testName: string; failureType: string; errorMessage: string; testFile?: string }>;
        totalTests?: number;
        passed?: number;
        failed?: number;
        durationSeconds?: number;
      }) {
        try {
          if (params.failures.length === 0) {
            const lines = [
              `# Sentinel Final Report`,
              ``,
              `No failure items were provided.`,
            ];
            if (typeof params.totalTests === "number" || typeof params.passed === "number" || typeof params.failed === "number") {
              lines.push("", `Summary: total=${params.totalTests ?? 0}, passed=${params.passed ?? 0}, failed=${params.failed ?? 0}`);
            }
            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }

          const output = formatTierReportInput({
            failures: params.failures.map((failure) => ({
              testName: failure.testName,
              failureType: failure.failureType,
              errorMessage: failure.errorMessage,
              testFile: failure.testFile,
            })),
            totalTests: params.totalTests,
            passed: params.passed,
            failed: params.failed,
            durationSeconds: params.durationSeconds,
          });

          return { content: [{ type: "text" as const, text: output }] };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `sentinel report error: ${err?.message || err}` }],
          };
        }
      },
    }),
    { names: ["sentinel_report"], optional: true },
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
        `5. Have the host coding agent write and run the final test files`,
        `6. Call sentinel_report with raw failure items to produce the final T-tier report`,
        `</sentinel_hint>`,
      ].join("\n"),
    };
  });

  log.info("[sentinel] Plugin loaded — tools: sentinel_scan, sentinel_config, sentinel_pm, sentinel_test, sentinel_hack, sentinel_report");
}
