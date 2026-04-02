/**
 * Build a minimal process environment for dependency install and test execution.
 * Keeps tool discovery working while withholding host credentials and user config.
 */

import { mkdirSync } from "fs";
import { join } from "path";

export function buildIsolatedEnv(rootDir: string, extraEnv?: Record<string, string | undefined>): Record<string, string | undefined> {
  const homeDir = join(rootDir, ".sentinel-home");
  const tmpDir = join(rootDir, ".sentinel-tmp");
  const xdgConfig = join(homeDir, ".config");
  const xdgCache = join(homeDir, ".cache");
  const xdgData = join(homeDir, ".local", "share");

  for (const dir of [homeDir, tmpDir, xdgConfig, xdgCache, xdgData]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    PATH: process.env.PATH || "",
    LANG: process.env.LANG || "C.UTF-8",
    LC_ALL: process.env.LC_ALL,
    TERM: process.env.TERM,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    XDG_DATA_HOME: xdgData,
    TMPDIR: tmpDir,
    TMP: tmpDir,
    TEMP: tmpDir,
    CI: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
    SSH_AUTH_SOCK: undefined,
    GITHUB_TOKEN: undefined,
    GH_TOKEN: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    ...extraEnv,
  };
}
