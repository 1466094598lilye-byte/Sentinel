/**
 * LLM abstraction — Anthropic (primary), OpenAI (fallback).
 *
 * Key resolution order:
 *   1. Environment variable (ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   2. .env file in cwd or home dir
 *   3. Interactive prompt — ask user to paste key (cached for session)
 */

import Anthropic from "@anthropic-ai/sdk";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createInterface } from "readline";

// ── Provider detection ──

export type Provider = "anthropic" | "openai";

interface ProviderInfo {
  provider: Provider;
  key: string;
}

// Session cache — once we have a key (from any source), keep it
let cachedProvider: ProviderInfo | null = null;

/**
 * Try to extract a key from a .env file.
 * Handles KEY=value and KEY="value" formats.
 */
function readDotEnv(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const vars: Record<string, string> = {};
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
  } catch {
    // unreadable — skip
  }
  return vars;
}

/**
 * Search for API key in this order:
 *   1. process.env
 *   2. .env in cwd
 *   3. .env in home dir
 *   4. ~/.sentinel/.env
 */
function findKeyFromEnv(): ProviderInfo | null {
  // 1. process.env
  if (process.env.ANTHROPIC_API_KEY) return { provider: "anthropic", key: process.env.ANTHROPIC_API_KEY };
  if (process.env.OPENAI_API_KEY) return { provider: "openai", key: process.env.OPENAI_API_KEY };

  // 2-4. .env files
  const dotEnvPaths = [
    join(process.cwd(), ".env"),
    join(homedir(), ".env"),
    join(homedir(), ".sentinel", ".env"),
  ];

  for (const p of dotEnvPaths) {
    const vars = readDotEnv(p);
    if (vars.ANTHROPIC_API_KEY) return { provider: "anthropic", key: vars.ANTHROPIC_API_KEY };
    if (vars.OPENAI_API_KEY) return { provider: "openai", key: vars.OPENAI_API_KEY };
  }

  return null;
}

/**
 * Interactive prompt — ask user to paste their API key.
 */
async function askForKey(): Promise<ProviderInfo> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });

  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, (answer) => resolve(answer.trim())));

  console.error("\n[sentinel] No API key found in environment or .env files.");
  console.error("[sentinel] Sentinel needs an LLM to generate tests.\n");

  const key = await ask("Paste your ANTHROPIC_API_KEY or OPENAI_API_KEY: ");
  rl.close();

  if (!key) {
    throw new Error("No API key provided. Cannot proceed without LLM.");
  }

  // Detect provider from key format
  const provider: Provider = key.startsWith("sk-ant-") ? "anthropic" : "openai";
  return { provider, key };
}

/**
 * Detect provider — returns cached result, or searches env/files.
 * Does NOT prompt interactively. Returns null if not found.
 */
export function detectProvider(): ProviderInfo | null {
  if (cachedProvider) return cachedProvider;
  const found = findKeyFromEnv();
  if (found) {
    cachedProvider = found;
  }
  return found;
}

/**
 * Require a provider — searches env/files, then prompts interactively if needed.
 * Caches the result for the session.
 */
export async function requireProvider(): Promise<ProviderInfo> {
  if (cachedProvider) return cachedProvider;

  const found = findKeyFromEnv();
  if (found) {
    cachedProvider = found;
    return found;
  }

  // Last resort: ask user
  const fromUser = await askForKey();
  // Set it in process.env so Anthropic SDK picks it up
  if (fromUser.provider === "anthropic") {
    process.env.ANTHROPIC_API_KEY = fromUser.key;
  } else {
    process.env.OPENAI_API_KEY = fromUser.key;
  }
  cachedProvider = fromUser;
  return fromUser;
}

// ── Anthropic ──

let anthropicClient: Anthropic | null = null;

function getAnthropic(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

// ── Unified call ──

export interface LLMOptions {
  system?: string;
  maxTokens?: number;
  model?: string;
}

/**
 * Call the LLM and return the text response.
 * Automatically resolves API key on first call.
 */
export async function llm(prompt: string, opts: LLMOptions = {}): Promise<string> {
  const { provider, key } = await requireProvider();
  const maxTokens = opts.maxTokens || 4096;

  if (provider === "anthropic") {
    const model = opts.model || "claude-sonnet-4-20250514";
    const client = getAnthropic();
    const msg = await client.messages.create({
      model,
      max_tokens: maxTokens,
      ...(opts.system ? { system: opts.system } : {}),
      messages: [{ role: "user", content: prompt }],
    });
    return msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
  }

  // OpenAI fallback — raw fetch
  const model = opts.model || "gpt-4o";
  const body: any = {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: prompt },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${text.slice(0, 500)}`);
  }

  const json = await res.json();
  return json.choices?.[0]?.message?.content || "";
}
