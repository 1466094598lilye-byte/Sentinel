/**
 * Runtime configuration — proposed by scan based on project analysis,
 * confirmed/modified by user before pipeline starts.
 */

import { cpus, totalmem } from "os";
import type { ScanResult } from "./detect.js";

export interface SentinelConfig {
  // ── Timeouts (ms) ──
  installTimeout: number;
  testRunnerInstallTimeout: number;
  testTimeout: number;
  gitTimeout: number;

  // ── Concurrency ──
  maxConcurrentInstalls: number;
  maxConcurrentTests: number;

  // ── Island algorithm ──
  maxIslandRounds: number;
  convergenceThreshold: number;
  pmIslands: number;       // how many PM tiers to run (1-4)
  hackerIslands: number;   // how many Hacker skills to run (1-6)

  // ── Runtime environment ──
  environment: "local" | "server" | "ci";
  sleepProtection: boolean; // extend timeouts for local machines that may sleep

  // ── Resource budget ──
  maxOutputBuffer: number;  // bytes
}

/** Propose a config based on scan results + detected environment */
export function proposeConfig(scan: ScanResult): SentinelConfig {
  const fileCount = scan.sourceFiles.length;
  const apiCount = scan.apiSurface.length;
  const cores = cpus().length;
  const memGB = Math.round(totalmem() / (1024 ** 3));

  // ── Detect environment ──
  const isCI = !!(process.env.CI || process.env.GITHUB_ACTIONS || process.env.GITLAB_CI || process.env.JENKINS_URL);
  const environment: SentinelConfig["environment"] = isCI ? "ci" : "local";

  // ── Scale timeouts by project size ──
  const isLargeProject = fileCount > 50 || apiCount > 30;
  const isMediumProject = fileCount > 15 || apiCount > 10;

  // Rust and Java tend to have slow builds
  const slowBuildLanguages = ["rust", "java", "csharp", "swift"];
  const isSlow = slowBuildLanguages.includes(scan.language);

  const installTimeout = isSlow ? 180_000 : 120_000;
  const testRunnerInstallTimeout = 60_000;
  const baseTestTimeout = isSlow ? 600_000 : 300_000;
  const testTimeout = isLargeProject ? baseTestTimeout * 1.5 : baseTestTimeout;

  // ── Scale island algorithm by complexity ──
  let pmIslands = 4;  // always all 4 tiers
  let hackerIslands = 6; // always all 6 skills
  let maxIslandRounds = isLargeProject ? 3 : isMediumProject ? 2 : 1;

  // Small projects don't need multi-round — one round is enough
  if (fileCount <= 5 && apiCount <= 5) {
    maxIslandRounds = 1;
  }

  // ── Sleep protection for laptops ──
  const sleepProtection = environment === "local";

  return {
    installTimeout: sleepProtection ? installTimeout * 1.5 : installTimeout,
    testRunnerInstallTimeout,
    testTimeout: sleepProtection ? testTimeout * 1.5 : testTimeout,
    gitTimeout: 10_000,
    maxConcurrentInstalls: Math.min(4, cores),
    maxConcurrentTests: Math.max(1, Math.floor(cores / 2)),
    maxIslandRounds,
    convergenceThreshold: 2,
    pmIslands,
    hackerIslands,
    environment,
    sleepProtection,
    maxOutputBuffer: 10 * 1024 * 1024,
  };
}

/** Format config as readable summary for user confirmation */
export function formatConfigProposal(config: SentinelConfig, scan: ScanResult): string {
  const lines: string[] = [];
  const cores = cpus().length;
  const memGB = Math.round(totalmem() / (1024 ** 3));
  lines.push(`## Proposed Sentinel Configuration`);
  lines.push(``);
  lines.push(`### Detected Environment`);
  lines.push(`| Setting | Value |`);
  lines.push(`|---------|-------|`);
  lines.push(`| Machine | ${config.environment} (${cores} cores, ${memGB}GB RAM) |`);
  lines.push(`| Language | ${scan.language} |`);
  lines.push(`| Source files | ${scan.sourceFiles.length} |`);
  lines.push(`| API surface | ${scan.apiSurface.length} exports |`);
  lines.push(`| Sleep protection | ${config.sleepProtection ? "ON (timeouts extended 1.5x for local machine)" : "OFF"} |`);
  lines.push(``);

  lines.push(`### Timeouts`);
  lines.push(`| Phase | Timeout |`);
  lines.push(`|-------|---------|`);
  lines.push(`| Dependency install | ${(config.installTimeout / 1000).toFixed(0)}s |`);
  lines.push(`| Test runner install | ${(config.testRunnerInstallTimeout / 1000).toFixed(0)}s |`);
  lines.push(`| Test execution | ${(config.testTimeout / 1000).toFixed(0)}s |`);
  lines.push(``);

  lines.push(`### Concurrency`);
  lines.push(`| Setting | Value |`);
  lines.push(`|---------|-------|`);
  lines.push(`| Max parallel installs | ${config.maxConcurrentInstalls} |`);
  lines.push(`| Max parallel tests | ${config.maxConcurrentTests} |`);
  lines.push(``);

  lines.push(`### Island Algorithm`);
  lines.push(`| Setting | Value |`);
  lines.push(`|---------|-------|`);
  lines.push(`| PM islands | ${config.pmIslands} tiers |`);
  lines.push(`| Hacker islands | ${config.hackerIslands} skills |`);
  lines.push(`| Max rounds | ${config.maxIslandRounds} |`);
  lines.push(`| Convergence | stop if < ${config.convergenceThreshold} new findings |`);
  lines.push(``);

  // Estimate total LLM calls
  const pmCalls = config.pmIslands * config.maxIslandRounds + config.maxIslandRounds + 2; // islands + crosses + merge + done
  const testerCalls = 2; // system + user
  const hackerCalls = config.hackerIslands * config.maxIslandRounds + config.maxIslandRounds + 1; // islands + crosses + merge
  const total = pmCalls + testerCalls + hackerCalls;

  lines.push(`### Estimated LLM Calls`);
  lines.push(`| Phase | Calls (max) |`);
  lines.push(`|-------|-------------|`);
  lines.push(`| PM | ~${pmCalls} (${config.pmIslands} tiers × ${config.maxIslandRounds} rounds + cross + merge) |`);
  lines.push(`| Testers | ${testerCalls} (system + user) |`);
  lines.push(`| Hacker | ~${hackerCalls} (${config.hackerIslands} skills × ${config.maxIslandRounds} rounds + cross + merge) |`);
  lines.push(`| **Total** | **~${total} calls max** |`);
  lines.push(``);

  lines.push(`Review the configuration above. To proceed with these settings, call sentinel_config to confirm.`);
  lines.push(`To modify, call sentinel_config with the values you want to change.`);

  return lines.join("\n");
}

// ── Runtime state ──

let activeConfig: SentinelConfig | null = null;

export function getConfig(): SentinelConfig | null {
  return activeConfig;
}

export function setConfig(config: SentinelConfig): void {
  activeConfig = config;
}

export function clearConfig(): void {
  activeConfig = null;
}
