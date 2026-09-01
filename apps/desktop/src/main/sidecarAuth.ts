/** Cohesive extraction from sidecar.ts; its public API remains on that module. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeSync, closeSync, openSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Agent as UndiciAgent } from "undici";
import { TurnId, type EventSender } from "./turn.js";
import { ensureUp } from "./sidecarLifecycle.js";
// Node's global fetch (undici) applies a 300s default `bodyTimeout` measured as
// inactivity *between* body chunks. Rust's `stream_run` builds its client with
// `reqwest::Client::builder().build()` -- no timeout, so it waits indefinitely
// between NDJSON lines. A `/run` stream can legitimately go quiet for minutes
// (a long bridge tool call, a sectioned full-pass compose at ~30min/book on a
// local 4B) with the sidecar still alive and working; without this, that
// stream is torn down mid-run with only the partial answer, and `/cancel` is
// never sent for it since the transport-failure path doesn't call it -- the
// Python run keeps burning the single local-model slot with nothing listening.
export const RUN_STREAM_DISPATCHER = new UndiciAgent({ bodyTimeout: 0, headersTimeout: 0 });

// --------------------------------------------------------------- token

/** The environment variable the sidecar reads its shared secret from. */
export const TOKEN_ENV = "ARCELLE_SIDECAR_TOKEN";
export const VISUAL_INDEX_DIR_ENV = "ARCELLE_VISUAL_INDEX_DIR";

export let cachedToken: string | null = null;
export let configuredVisualIndexDir: string | null = null;

/** Pin the derived visual cache under Electron's trusted app-data root. The
 * sidecar API deliberately accepts no caller-selected cache path; only this
 * launch-time environment value can choose it. */
export function configureVisualIndexDir(userDataDir: string): void {
  configuredVisualIndexDir = path.join(path.resolve(userDataDir), "visual-index-v1");
}

/**
 * The shared secret every sidecar this app process spawns is given, and
 * that every request of ours carries.
 *
 * The port is loopback-only, but on a Mac loopback is not a boundary:
 * without this, any other program running as the user could drive the
 * agent — start runs, generate text, search the web, delete downloaded
 * models. Minted once per app process (two v4 UUIDs = 244 random bits),
 * handed over in the child's ENVIRONMENT so it never reaches stdout, the
 * stderr log or disk, and never logged here either.
 */
export function authToken(): string {
  if (cachedToken === null) {
    cachedToken = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  }
  return cachedToken;
}

/**
 * Stamp our token on a sidecar request. EVERY request to the sidecar goes
 * through here — a call site that forgets it gets a 401 instead of an
 * answer, so this is the one place the header is spelled. Node's `fetch`
 * takes a headers object rather than reqwest's request-builder pattern, so
 * this is the idiomatic TS shape of the Rust `authed()` helper rather than
 * a literal port of its signature.
 */
export function authedHeaders(): Record<string, string> {
  return { authorization: `Bearer ${authToken()}` };
}

// ------------------------------------------------------------- busy guard

export let inflight = 0;

/**
 * RAII marker for ONE request we have in flight on the sidecar, mirroring
 * the Rust `Busy` guard. Every caller of {@link ensureUp} takes one and
 * holds it for the whole duration of its HTTP call — a streaming answer, a
 * ten-hour file pass — so {@link ensureUp} on another task cannot SIGTERM
 * the process that is serving it.
 *
 * TypeScript has no `Drop`, so callers MUST release it themselves —
 * always in a `finally` block:
 *
 * ```ts
 * const guard = busy();
 * try {
 *   await doSidecarRequest();
 * } finally {
 *   guard.release();
 * }
 * ```
 *
 * (A `Symbol.dispose`-based "using" declaration would read closer to the
 * Rust RAII shape, but is skipped deliberately: it needs `esnext.disposable`
 * lib support this tsconfig does not opt into, and plain try/finally is
 * unambiguous everywhere Node >=22 runs.)
 */
export function busy(): { release: () => void } {
  inflight += 1;
  let released = false;
  return {
    release: () => {
      // Idempotent: a caller calling release() twice (e.g. a bug in a
      // retry path) must not double-decrement and desync the counter from
      // reality. The Rust Drop impl is inherently single-fire; this guard
      // is the TS equivalent safety net.
      if (released) return;
      released = true;
      inflight -= 1;
    },
  };
}

/** Exported for testing only. */
export function inflightCount(): number {
  return inflight;
}

// ------------------------------------------------------------- port line

/** Parse the `SIDECAR_PORT=NNNN` handshake line the sidecar prints on startup. */
export function parsePortLine(line: string): number | null {
  const prefix = "SIDECAR_PORT=";
  const trimmed = line.trim();
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const rest = trimmed.slice(prefix.length).trim();
  if (!/^\d+$/.test(rest)) {
    return null;
  }
  const port = Number(rest);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return null;
  }
  return port;
}

// ------------------------------------------------------------- probing

/** What one `/health` probe of a recorded sidecar found. */
export type Probe = "healthy" | "busy" | "gone";

/** How long one probe waits for `/health`. */
export const HEALTH_TIMEOUT_MS = 1500;
/** How many probes a recorded sidecar gets before we act on the answer, and
 * the gap between them. One missed probe is not evidence of anything; only
 * the healthy path is hot, and it returns on the first attempt. */
export const PROBE_ATTEMPTS = 3;
export const PROBE_GAP_MS = 300;
/** How long to wait for a freshly spawned sidecar to announce its port and
 * pass a health check before giving up (Python import of langgraph is not
 * instant). */
export const START_TIMEOUT_MS = 30_000;
/** How often to poll `/health` while waiting for a freshly spawned sidecar. */
export const HEALTH_POLL_INTERVAL_MS = 200;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Walk an error's `.cause` chain looking for a POSIX `ECONNREFUSED`. Node's
 * `fetch` (undici) wraps a refused loopback connection as
 * `TypeError: fetch failed` with `.cause` set to the underlying
 * `Error: connect ECONNREFUSED ...`; this is the TS equivalent of reqwest's
 * `Error::is_connect()`.
 */
export function isConnectionRefused(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur != null; i++) {
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") {
      return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Should a recorded sidecar be SIGTERMed and replaced? Pure, so the policy
 * is testable without a process: a live-but-busy sidecar is replaced only
 * when nothing of ours is riding on it (otherwise the kill takes down a
 * streaming answer or a running job), while one that is gone has nothing
 * to protect.
 */
export function shouldReplace(verdict: Probe, inflightNow: number): boolean {
  switch (verdict) {
    case "healthy":
      return false;
    case "busy":
      return inflightNow === 0;
    case "gone":
      return true;
  }
}

/**
 * One `/health` probe, classified. Anything that is NOT a refused
 * connection counts as ALIVE: an answer we could not parse, a non-2xx
 * status and a timeout all came from a process that is still there.
 */
export async function probeOnce(baseUrl: string, timeoutMs: number): Promise<Probe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await probeHealth(baseUrl, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeHealth(baseUrl: string, signal: AbortSignal): Promise<Probe> {
  const response = await requestHealth(baseUrl, signal);
  return typeof response === "string" ? response : healthVerdict(response);
}

export async function requestHealth(baseUrl: string, signal: AbortSignal): Promise<Response | Probe> {
  try {
    return await fetch(`${baseUrl}/health`, { signal });
  } catch (err) {
    return isConnectionRefused(err) ? "gone" : "busy";
  }
}

export async function healthVerdict(response: Response): Promise<Probe> {
  if (!response.ok) {
    return "busy";
  }
  try {
    return healthBodyVerdict(await response.json());
  } catch {
    return "busy";
  }
}

export function healthBodyVerdict(body: unknown): Probe {
  const healthy =
    typeof body === "object" && body !== null && (body as Record<string, unknown>).ok === true;
  return healthy ? "healthy" : "busy";
}

/** Injectable transport/timer boundary for recorded-sidecar probes. */
export interface RecordedProbeDeps {
  probeOnce(baseUrl: string, timeoutMs: number): Promise<Probe>;
  sleep(ms: number): Promise<void>;
}

export const nativeRecordedProbeDeps: RecordedProbeDeps = { probeOnce, sleep };

/**
 * Probe a recorded sidecar up to {@link PROBE_ATTEMPTS} times. Any healthy
 * answer wins immediately. Otherwise the result is a FOLD, not a majority
 * vote: the verdict starts at "gone" and is raised to "busy" the moment any
 * attempt sees a live-but-unconfirmed answer, and nothing brings it back
 * down — a single accepted-but-silent attempt is enough to rule out "the
 * process is gone" for good, because a dead port refuses instantly and
 * would never have produced that "busy" reading in the first place.
 */
export async function probeRecorded(baseUrl: string, deps: RecordedProbeDeps = nativeRecordedProbeDeps): Promise<Probe> {
  let verdict: Probe = "gone";
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    const result = await deps.probeOnce(baseUrl, HEALTH_TIMEOUT_MS);
    if (result === "healthy") {
      return "healthy";
    }
    if (result === "busy") {
      verdict = "busy";
    }
    if (attempt + 1 < PROBE_ATTEMPTS) {
      await deps.sleep(PROBE_GAP_MS);
    }
  }
  return verdict;
}
