



// ---------------------------------------------------------------- usage/parsers

/**
 * `ExternalUsage` (external.rs lines 926-930) — real usage for one
 * external-CLI turn, when the CLI's own JSON envelope parsed. `inputTokens`
 * is the round's real PROMPT/context token count (Claude: `input_tokens +
 * cache_creation_input_tokens + cache_read_input_tokens`, all three count
 * toward context; Codex: `input_tokens`, already inclusive of any cached
 * subset).
 */
export interface ExternalUsage {
  inputTokens: number | null;
  outputTokens: number | null;
}
export const NO_USAGE: ExternalUsage = { inputTokens: null, outputTokens: null };
export function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}
export

/** `serde_json::Value::as_u64` — a JSON number that is a non-negative integer,
 * and nothing else. A float or a negative reads as absent, exactly as it does
 * in Rust, rather than as a fractional token count. */
function u64Field(obj: Record<string, unknown> | null, key: string): number | null {
  if (obj === null) return null;
  const v = obj[key];
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}
export

/**
 * `parse_claude_json_result` (external.rs lines 940-964) — `claude -p
 * --output-format json`'s single JSON result object. Falls back to treating
 * the whole stdout as plain answer text (no usage) if the envelope doesn't
 * parse as expected.
 *
 * A present-but-unreadable `usage` still reports a total (`0`), matching
 * Rust's `usage_obj.map(...)`: the difference between "the CLI reported no
 * usage field at all" (`null`) and "it reported one we could not read" (`0`)
 * is preserved rather than flattened.
 *
 * NOTE: `modelUsage[*].contextWindow` also rides this envelope — the real
 * window, per model. The CHAT path reads it in the sidecar's twin of this
 * parser (`external_llm.parse_claude_json_result`); nothing here consumes it.
 */
function stdoutText(stdout: Buffer | string): string {
  return typeof stdout === "string" ? stdout : stdout.toString("utf8");
}
export function jsonValue(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
export function claudeStreamResult(raw: string): unknown | undefined {
  let result: unknown | undefined;
  for (const line of raw.split("\n")) {
    const event = jsonValue(line);
    if (asRecord(event)?.type === "result") result = event;
  }
  return result;
}
export function claudeEnvelope(raw: string): unknown | undefined {
  const fullResult = jsonValue(raw);
  return fullResult === undefined ? claudeStreamResult(raw) : fullResult;
}
export function claudeUsage(obj: Record<string, unknown>): ExternalUsage {
  const usageObj = asRecord(obj.usage);
  const inputTokens =
    (u64Field(usageObj, "input_tokens") ?? 0) +
    (u64Field(usageObj, "cache_creation_input_tokens") ?? 0) +
    (u64Field(usageObj, "cache_read_input_tokens") ?? 0);
  return { inputTokens, outputTokens: u64Field(usageObj, "output_tokens") };
}


export function parseClaudeJsonResult(stdout: Buffer | string): { text: string; usage: ExternalUsage } {
  const raw = stdoutText(stdout);
  const fallbackText = raw.trim();
  const obj = asRecord(claudeEnvelope(raw));
  if (obj === null) return { text: fallbackText, usage: NO_USAGE };
  const text = typeof obj.result === "string" ? obj.result : fallbackText;
  if (!Object.prototype.hasOwnProperty.call(obj, "usage")) return { text, usage: NO_USAGE };
  return { text, usage: claudeUsage(obj) };
}
export

/**
 * `parse_codex_json_stream` (external.rs lines 974-1013) — `codex exec
 * --json`'s JSONL event stream. The answer rides the LAST
 * `item.completed`/`agent_message` event; usage rides the final
 * `turn.completed` event, and a `turn.completed` carrying no `usage` object
 * leaves whatever an earlier one reported intact. Falls back to the raw
 * stdout as plain text only if NOT ONE line parsed as JSON (a genuine
 * schema-drift case) — an answer that's merely empty is trusted as-is.
 */
interface StreamParseState {
  text: string;
  inputTokens: number | null;
  outputTokens: number | null;
  parsedAny: boolean;
}
export function initialStreamParseState(): StreamParseState {
  return { text: "", inputTokens: null, outputTokens: null, parsedAny: false };
}
export function completedAgentMessage(obj: Record<string, unknown>): string | undefined {
  const item = asRecord(obj.item);
  if (item === null) return undefined;
  if (item.type !== "agent_message") return undefined;
  if (typeof item.text !== "string") return undefined;
  return item.text;
}
export function applyCodexEvent(state: StreamParseState, obj: Record<string, unknown>): void {
  if (obj.type === "item.completed") {
    const message = completedAgentMessage(obj);
    if (message !== undefined) state.text = message;
    return;
  }
  if (obj.type !== "turn.completed") return;
  const usage = asRecord(obj.usage);
  if (usage === null) return;
  state.inputTokens = u64Field(usage, "input_tokens");
  state.outputTokens = u64Field(usage, "output_tokens");
}
export function parseCodexLine(state: StreamParseState, line: string): void {
  if (line.length === 0) return;
  const event = jsonValue(line);
  if (event === undefined) return;
  state.parsedAny = true;
  const obj = asRecord(event);
  if (obj !== null) applyCodexEvent(state, obj);
}


export function parseCodexJsonStream(stdout: Buffer | string): { text: string; usage: ExternalUsage } {
  const raw = stdoutText(stdout);
  const state = initialStreamParseState();
  for (const line of raw.split("\n")) parseCodexLine(state, line);
  if (!state.parsedAny) state.text = raw.trim();
  return { text: state.text, usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens } };
}
export

/** Antigravity CLI's `--output-format stream-json` JSONL stream. The terminal
 * result carries the final response and aggregate token stats. */
function applyAntigravityStep(state: StreamParseState, obj: Record<string, unknown>): void {
  const update = asRecord(obj.step_update);
  if (update === null) return;
  if (update.step_type !== "agent_response") return;
  if (typeof update.text_delta !== "string") return;
  state.text += update.text_delta;
}
export function applyAntigravityResult(state: StreamParseState, obj: Record<string, unknown>): void {
  const result = asRecord(obj.result);
  if (result === null) return;
  if (typeof result.response === "string") state.text = result.response;
  const usage = asRecord(result.usage);
  state.inputTokens = u64Field(usage, "input_tokens");
  state.outputTokens = u64Field(usage, "output_tokens");
}
export function applyAntigravityEvent(state: StreamParseState, obj: Record<string, unknown>): void {
  if (obj.event === "step_update") {
    applyAntigravityStep(state, obj);
    return;
  }
  if (obj.event === "result") applyAntigravityResult(state, obj);
}
export function parseAntigravityLine(state: StreamParseState, line: string): void {
  if (!line.trim()) return;
  const event = jsonValue(line);
  if (event === undefined) return;
  state.parsedAny = true;
  const obj = asRecord(event);
  if (obj !== null) applyAntigravityEvent(state, obj);
}


export function parseAntigravityJsonStream(stdout: Buffer | string): { text: string; usage: ExternalUsage } {
  const raw = stdoutText(stdout);
  const state = initialStreamParseState();
  for (const line of raw.split("\n")) parseAntigravityLine(state, line);
  if (!state.parsedAny) state.text = raw.trim();
  return { text: state.text, usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens } };
}
