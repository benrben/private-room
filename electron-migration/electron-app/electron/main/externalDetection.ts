/** Installed local AI-tool detection for Electron hosts launched by macOS. */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface ShellProbeResult {
  ok: boolean;
  stdout: string;
}

export type ShellProbe = (command: string) => Promise<ShellProbeResult>;

/**
 * Finder-launched apps receive launchd's sparse PATH. An interactive login
 * zsh loads the same PATH the user's terminal has, including common CLI
 * installer additions from .zshrc. Commands passed here are module constants,
 * never renderer or user input.
 */
export function runInteractiveZsh(command: string): Promise<ShellProbeResult> {
  return new Promise((resolve) => {
    const child = spawn("zsh", ["-ilc", command], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (result: ShellProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    child.stdout.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once("error", () => finish({ ok: false, stdout: "" }));
    child.once("close", (code) => finish({ ok: code === 0, stdout: Buffer.concat(chunks).toString("utf8") }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout: "" });
    }, 5_000);
    timer.unref();
  });
}

export function parseExternalCliPaths(stdout: string): string[] {
  const found: string[] = [];
  for (const raw of stdout.split(/\r?\n/u)) {
    const line = raw.trim();
    if ((line === "claude" || line.endsWith("/claude")) && !found.includes("claude-cli")) {
      found.push("claude-cli");
    }
    if ((line === "codex" || line.endsWith("/codex")) && !found.includes("codex-cli")) {
      found.push("codex-cli");
    }
    if ((line === "agy" || line.endsWith("/agy")) && !found.includes("antigravity-cli")) {
      found.push("antigravity-cli");
    }
  }
  return found;
}

export async function detectExternalWith(
  probe: ShellProbe,
  pathExists: (candidate: string) => boolean = existsSync,
  homeDir = os.homedir(),
): Promise<string[]> {
  const result = await probe("command -v claude; command -v codex; command -v agy");
  const found = parseExternalCliPaths(result.stdout);
  const candidates: Array<[string, string[]]> = [
    ["claude-cli", [path.join(homeDir, ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]],
    ["codex-cli", [path.join(homeDir, ".local/bin/codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]],
    ["antigravity-cli", [path.join(homeDir, ".local/bin/agy"), "/opt/homebrew/bin/agy", "/usr/local/bin/agy"]],
  ];
  for (const [engine, paths] of candidates) {
    if (!found.includes(engine) && paths.some(pathExists)) found.push(engine);
  }
  return found;
}

let externalCache: Promise<string[]> | undefined;
let externalCacheAt = 0;
const EXTERNAL_CACHE_MS = 30_000;

/** Briefly cached, then re-probed so installing/signing in to a CLI is visible
 * when Settings is reopened without requiring an app restart. */
export function detectedExternal(): Promise<string[]> {
  if (externalCache === undefined || Date.now() - externalCacheAt >= EXTERNAL_CACHE_MS) {
    externalCacheAt = Date.now();
    externalCache = detectExternalWith(runInteractiveZsh).catch((error) => {
      externalCache = undefined;
      throw error;
    });
  }
  return externalCache;
}

export async function ollamaInstalledWith(
  probe: ShellProbe,
  pathExists: (path: string) => boolean,
): Promise<boolean> {
  if (pathExists("/Applications/Ollama.app")) return true;
  const result = await probe("command -v ollama");
  return result.ok && result.stdout.trim().length > 0;
}

export function ollamaInstalled(): Promise<boolean> {
  return ollamaInstalledWith(runInteractiveZsh, existsSync);
}
