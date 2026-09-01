/**
 * Defensive readers for the MCP registry's untrusted JSON payloads.
 *
 * Keys are always literals chosen by the caller. Object reads still use
 * `hasOwnProperty` so inherited properties never masquerade as registry data.
 */

export function jsonRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function arrayIndex(value: unknown, key: number): unknown {
  if (!Array.isArray(value)) return null;
  return key >= 0 && key < value.length ? value[key] : null;
}

function recordField(value: unknown, key: string): unknown {
  const record = jsonRecord(value);
  if (record === null || !Object.prototype.hasOwnProperty.call(record, key)) return null;
  return record[key];
}

export function idx(value: unknown, key: string | number): unknown {
  return typeof key === "number" ? arrayIndex(value, key) : recordField(value, key);
}

/** Chained {@link idx}, for example `at(server, "repository", "url")`. */
export function at(value: unknown, ...keys: Array<string | number>): unknown {
  let current = value;
  for (const key of keys) current = idx(current, key);
  return current;
}

export function asStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Return the value at the first present camelCase or legacy snake_case key. */
export function field(value: unknown, keys: readonly string[]): unknown {
  for (const key of keys) {
    const candidate = idx(value, key);
    if (candidate !== null) return candidate;
  }
  return null;
}
