import type Database from "better-sqlite3-multiple-ciphers";
import { getSetting, setSetting } from "./db-host/settings.js";
import { resolvedBaseUrl, setBaseUrlOverride } from "./engineRouting.js";
import { authedHeaders, busy, ensureUp } from "./sidecar.js";

const OLLAMA_URL_SHAPE = "use something like http://192.168.1.20:11434";
const OLLAMA_SCHEMES = new Set(["http", "https"]);

function splitOllamaScheme(value: string): {
  readonly scheme: string;
  readonly rest: string;
} {
  const separator = value.indexOf("://");
  if (separator === -1) return { scheme: "http", rest: value };
  return {
    scheme: value.slice(0, separator).toLowerCase(),
    rest: value.slice(separator + 3),
  };
}

function authorityHostPort(rest: string): {
  readonly host: string;
  readonly port: string | null;
} {
  const authority = rest.split(/[/?#]/)[0] ?? "";
  const colon = authority.lastIndexOf(":");
  if (colon === -1 || authority.slice(colon + 1).includes("]")) {
    return { host: authority, port: null };
  }
  return {
    host: authority.slice(0, colon),
    port: authority.slice(colon + 1),
  };
}

function isOllamaPort(port: string | null): boolean {
  if (port === null) return true;
  if (!/^\d+$/.test(port)) return false;
  const number = Number(port);
  return number > 0 && number <= 65535;
}

/** Normalize a configured remote Ollama endpoint or reject it explicitly. */
export function normalizeOllamaUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  if (/\s/u.test(trimmed)) {
    throw new Error(
      `A server address cannot contain spaces — ${OLLAMA_URL_SHAPE}.`,
    );
  }
  const { scheme, rest } = splitOllamaScheme(trimmed);
  if (!OLLAMA_SCHEMES.has(scheme)) {
    throw new Error(
      `The address must start with http:// or https:// — ${OLLAMA_URL_SHAPE}.`,
    );
  }
  const { host, port } = authorityHostPort(rest);
  if (!/^[a-zA-Z0-9._\-\[\]:]+$/.test(host) || !isOllamaPort(port)) {
    throw new Error(
      `"${trimmed}" is not a server address — ${OLLAMA_URL_SHAPE}.`,
    );
  }
  return `${scheme}://${rest.replace(/\/+$/, "")}`;
}

export function setOllamaUrl(
  db: Database.Database | null,
  url: string,
): void {
  const normalized = normalizeOllamaUrl(url);
  setBaseUrlOverride(normalized === "" ? null : normalized);
  if (db !== null) setSetting(db, "remote_ollama_url", normalized);
}

async function rawListModels(): Promise<string[]> {
  const base = await ensureUp();
  const guard = busy();
  try {
    const response = await fetch(`${base}/models`, {
      method: "POST",
      headers: { ...authedHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ base_url: resolvedBaseUrl() }),
    });
    if (!response.ok) {
      throw new Error(`sidecar /models status ${response.status}`);
    }
    const value: unknown = await response.json();
    const models =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).models
        : undefined;
    return Array.isArray(models)
      ? models.filter((model): model is string => typeof model === "string")
      : [];
  } finally {
    guard.release();
  }
}

export async function testOllamaUrl(
  db: Database.Database | null,
  url: string,
): Promise<string> {
  setOllamaUrl(db, url);
  const where = resolvedBaseUrl();
  let models: string[];
  try {
    models = await rawListModels();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach ${where}: ${message}`);
  }
  if (models.length === 0) {
    return `Reached ${where}, but it has no models installed — nothing there can answer yet.`;
  }
  return `✓ Reached ${where} — ${models.length} model${models.length === 1 ? "" : "s"} available.`;
}

export function getOllamaUrl(db: Database.Database | null): string {
  return db === null ? "" : (getSetting(db, "remote_ollama_url") ?? "");
}
