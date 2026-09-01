/** Shared JSON-object primitives used by the MCP configuration domains. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function asRecord(v: unknown): Record<string, unknown> {
  return isPlainObject(v) ? v : {};
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function hasOwn(map: Record<string, unknown>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, name);
}

export function ownEntry(map: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
  if (!hasOwn(map, name)) return undefined;
  const entry = map[name];
  return isPlainObject(entry) ? entry : undefined;
}

export function setOwn(map: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(map, name, { value, writable: true, enumerable: true, configurable: true });
}

export function ownMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
