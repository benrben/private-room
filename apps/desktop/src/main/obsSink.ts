import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LOG_ENV,
  MAX_LOG_BYTES,
  bytes,
  model,
  state,
  type CheckedFields,
  type Literal,
  type PlainFields,
} from "./obs.js";

const TARGET = "arcelle";
const DEFAULT_FILTER = "arcelle=info";

export function logPath(): string {
  return path.join(os.tmpdir(), "arcelle-host.log");
}

export function previousLogPath(): string {
  return path.join(os.tmpdir(), "arcelle-host.prev.log");
}

export function logDir(): string {
  return os.tmpdir();
}

function renameQuiet(from: string, to: string): void {
  try {
    fs.renameSync(from, to);
  } catch {
    // Rotation failures never fail the app.
  }
}

function openFreshQuiet(filePath: string): number | null {
  try {
    return fs.openSync(filePath, "w");
  } catch {
    return null;
  }
}

export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

const LOG_LEVELS = new Set<LogLevel>(["off", "error", "warn", "info", "debug", "trace"]);
const LEVEL_RANK: Record<LogLevel, number> = {
  off: -1,
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

export class Sink {
  private readonly filePath: string;
  private readonly prevPath: string;
  private fd: number | null;
  private written = 0;
  private level: LogLevel = "info";

  constructor(filePath: string, prevPath: string) {
    this.filePath = filePath;
    this.prevPath = prevPath;
    renameQuiet(this.filePath, this.prevPath);
    this.fd = openFreshQuiet(this.filePath);
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  private enabled(msgLevel: "info" | "warn" | "debug"): boolean {
    return LEVEL_RANK[this.level] >= LEVEL_RANK[msgLevel];
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // A failing close must not fail the app.
      }
      this.fd = null;
    }
    renameQuiet(this.filePath, this.prevPath);
    this.fd = openFreshQuiet(this.filePath);
    this.written = 0;
  }

  writeRaw(data: string): void {
    const buf = Buffer.from(data, "utf8");
    if (this.written + buf.length > MAX_LOG_BYTES) this.rotate();
    if (this.fd !== null) {
      try {
        fs.writeSync(this.fd, buf);
        this.written += buf.length;
      } catch {
        // Logging failures never fail the app.
      }
    }
  }

  info<E extends string, const F extends PlainFields>(event: Literal<E>, fields: CheckedFields<F>): void {
    if (this.enabled("info")) this.writeRaw(formatLine("INFO", event as string, fields as unknown as PlainFields));
  }

  warn<E extends string, const F extends PlainFields>(event: Literal<E>, fields: CheckedFields<F>): void {
    if (this.enabled("warn")) this.writeRaw(formatLine("WARN", event as string, fields as unknown as PlainFields));
  }

  debug<E extends string, const F extends PlainFields>(event: Literal<E>, fields: CheckedFields<F>): void {
    if (this.enabled("debug")) this.writeRaw(formatLine("DEBUG", event as string, fields as unknown as PlainFields));
  }

  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Closing a log is best effort.
      }
      this.fd = null;
    }
  }
}

function formatLine(level: string, event: string, fields: PlainFields): string {
  return `${new Date().toISOString()} ${level} ${renderLine(event, fields)}\n`;
}

function renderLine(event: string, fields: PlainFields): string {
  let line = event;
  for (const [key, value] of fields) line += ` ${key}=${value.toString()}`;
  return line;
}

function parseLevelWord(word: string): LogLevel | null {
  const normalized = word.trim().toLowerCase();
  return LOG_LEVELS.has(normalized as LogLevel) ? normalized as LogLevel : null;
}

interface ParsedDirectives {
  defaultLevel: LogLevel | null;
  targets: Map<string, LogLevel>;
}

function tryParseDirectives(value: string): ParsedDirectives | null {
  const parts = value.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const result: ParsedDirectives = { defaultLevel: null, targets: new Map() };
  for (const part of parts) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      const level = parseLevelWord(part);
      if (level !== null) result.defaultLevel = level;
      else result.targets.set(part, "trace");
    } else {
      const level = parseLevelWord(part.slice(separator + 1));
      if (level === null) return null;
      result.targets.set(part.slice(0, separator), level);
    }
  }
  return result;
}

function resolveLevel(parsed: ParsedDirectives): LogLevel {
  return parsed.targets.get(TARGET) ?? parsed.defaultLevel ?? "info";
}

export interface FilterResult {
  understood: boolean;
  level: LogLevel;
}

export function filterFrom(requested: string | undefined | null): FilterResult {
  const defaultParsed = tryParseDirectives(DEFAULT_FILTER) as ParsedDirectives;
  if (requested === undefined || requested === null) {
    return { understood: true, level: resolveLevel(defaultParsed) };
  }
  const parsed = tryParseDirectives(requested);
  if (parsed !== null) {
    const namesTarget = parsed.targets.has(TARGET);
    const hasDefault = parsed.defaultLevel !== null;
    if (namesTarget || hasDefault) return { understood: true, level: resolveLevel(parsed) };
  }
  return { understood: false, level: resolveLevel(defaultParsed) };
}

let defaultSink: Sink | null = null;
let started = false;

export function init(appVersion: string): void {
  if (started) return;
  started = true;
  const requested = process.env[LOG_ENV];
  const { understood, level } = filterFrom(requested);
  const sink = new Sink(logPath(), previousLogPath());
  sink.setLevel(level);
  defaultSink = sink;
  sink.info("host.start", [
    ["version", model(appVersion)],
    ["log", state("arcelle-host.log")],
    ["filter", state(understood ? "as asked" : "default")],
  ]);
  if (!understood) {
    sink.warn("host.log_filter_ignored", [
      ["env", state(LOG_ENV)],
      ["bytes", bytes(requested === undefined ? 0 : Buffer.byteLength(requested, "utf8"))],
    ]);
  }
}

export function info<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): void {
  defaultSink?.info<E, F>(event, fields);
}

export function warn<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): void {
  defaultSink?.warn<E, F>(event, fields);
}

export function debug<E extends string, const F extends PlainFields>(
  event: Literal<E>,
  fields: CheckedFields<F>,
): void {
  defaultSink?.debug<E, F>(event, fields);
}
