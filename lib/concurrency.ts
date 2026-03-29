/**
 * Concurrency primitives for parallel workspace operations.
 * Reads limits from config — no hardcoded values.
 */

import { exec } from "child_process";
import { getConfig } from "./config.js";

// ── Semaphore ──

export class Semaphore {
  private queue: (() => void)[] = [];
  private running = 0;

  constructor(private max: number) {}

  /** Update the concurrency limit (e.g. after config change) */
  setMax(n: number): void {
    this.max = n;
    // drain queue if new limit allows more
    while (this.running < this.max && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) { this.running++; next(); }
    }
  }

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

// Lazy-initialized semaphores that read from config
export const installSemaphore = new Semaphore(4);
export const testSemaphore = new Semaphore(1);

/** Sync semaphore limits with current config */
export function syncSemaphores(): void {
  const cfg = getConfig();
  if (!cfg) return;
  installSemaphore.setMax(cfg.maxConcurrentInstalls);
  testSemaphore.setMax(cfg.maxConcurrentTests);
}

// ── Async exec ──

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

export function execAsync(
  cmd: string,
  opts: { cwd: string; timeout?: number; env?: Record<string, string | undefined> },
): Promise<ExecResult> {
  const cfg = getConfig();
  const maxBuffer = cfg?.maxOutputBuffer || 10 * 1024 * 1024;

  return new Promise((resolve) => {
    const env = opts.env ? { ...process.env, ...opts.env } : process.env;

    exec(
      cmd,
      {
        cwd: opts.cwd,
        encoding: "utf-8",
        timeout: opts.timeout || 120_000,
        shell: "/bin/bash",
        env,
        maxBuffer,
      },
      (err, stdout, stderr) => {
        const output = (stdout || "") + (stderr || "");
        const exitCode = err ? (err as any).code || 1 : 0;
        resolve({ stdout: output, exitCode });
      },
    );
  });
}
