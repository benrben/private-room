import { asRecord, hasOwn, isPlainObject, ownEntry } from "./mcpConfigPrimitives.js";

export const AGENT_SECRET_KEYS: readonly string[] = [
  "headers",
  "env",
  "bearer_token_env_var",
  "authorization",
  "token",
  "oauth",
];

/** What the agent-facing views print where a credential would otherwise be.
 * Ported verbatim from `REDACTED_ARG`. */
export const REDACTED_ARG = "[redacted]";

/** Words that mark a command-line flag as carrying a credential, so the value
 * it introduces is masked too: `--api-key sk-…`, `--token=…`, `API_KEY=…`.
 * Ported verbatim from `CREDENTIAL_WORDS`. */
export const CREDENTIAL_WORDS: readonly string[] = [
  "key",
  "apikey",
  "token",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "auth",
  "bearer",
];

/** Does this flag name promise a credential value? Kebab, snake and camel all
 * spell the same words (`--api-key`, `API_KEY`, `--apiKey`, `--accessToken`).
 * Ported verbatim from `is_credential_flag`. */
export function isCredentialFlag(name: string): boolean {
  const n = name.replace(/^-+/, "").toLowerCase();
  if (n === "") return false;
  const words = n.split(/[^a-z0-9]+/).filter((w) => w !== "");
  if (words.some((w) => CREDENTIAL_WORDS.includes(w))) return true;
  return CREDENTIAL_WORDS.some((w) => n.endsWith(w));
}

export const SECRET_PREFIXES: readonly string[] = [
  "sk-",
  "sk_",
  "pk_",
  "rk_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "xoxb-",
  "xoxp-",
  "xoxa-",
  "xapp-",
  "AKIA",
  "ASIA",
  "AIza",
  "hf_",
  "shpat_",
  "glpat-",
  "npm_",
  "dop_v1_",
];

/** A bare value that reads like a credential even with nothing naming it: a
 * known vendor prefix, a JWT, or a long opaque run of token characters. Paths,
 * URLs and package specs are deliberately excluded — they carry no secret and
 * they are how the model recognises a connector. Ported verbatim from
 * `looks_like_secret`, byte-length like Rust's `.len()`. */
export function looksLikeSecret(value: string): boolean {
  const v = value.trim();
  const byteLen = Buffer.byteLength(v, "utf8");
  if (hasSecretPrefix(v, byteLen)) return true;
  if (isJwt(v)) return true;
  return isOpaqueSecret(v, byteLen);
}

export function hasSecretPrefix(value: string, byteLen: number): boolean {
  if (byteLen < 12) return false;
  return SECRET_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function isJwt(value: string): boolean {
  if (!value.startsWith("eyJ")) return false;
  return value.split(".").length === 3;
}

export function isOpaqueSecret(value: string, byteLen: number): boolean {
  if (byteLen < 24) return false;
  if (!/^[A-Za-z0-9_=-]+$/.test(value)) return false;
  if (!/[0-9]/.test(value)) return false;
  return /[A-Za-z]/.test(value);
}

/** Mask credentials typed straight into a local connector's command line. The
 * named secret FIELDS were covered, but a key given as `--api-key sk-…` went to
 * the model word for word — and in a cloud room that leaves the Mac. Ported
 * verbatim from `redact_cli_args`, arm order included (a `name=value` that
 * fails the credential check falls through to the flag check and then the
 * bare-secret check, exactly like Rust's `match` re-trying later arms against
 * the same `arg`). */
export function redactCliArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  let maskNext = false;
  for (const arg of args) {
    if (maskNext) {
      maskNext = false;
      out.push(REDACTED_ARG);
      continue;
    }
    const equalsRedaction = redactedEqualsArg(arg);
    if (equalsRedaction !== undefined) {
      out.push(equalsRedaction);
      continue;
    }
    if (masksFollowingArg(arg)) {
      maskNext = true;
      out.push(arg);
      continue;
    }
    if (looksLikeSecret(arg)) {
      out.push(REDACTED_ARG);
      continue;
    }
    out.push(arg);
  }
  return out;
}

export function redactedEqualsArg(arg: string): string | undefined {
  const equals = arg.indexOf("=");
  if (equals === -1) return undefined;
  const name = arg.slice(0, equals);
  const value = arg.slice(equals + 1);
  if (value === "") return undefined;
  if (!isCredentialFlag(name) && !looksLikeSecret(value)) return undefined;
  return `${name}=${REDACTED_ARG}`;
}

export function masksFollowingArg(arg: string): boolean {
  if (!arg.startsWith("-")) return false;
  if (arg.includes("=")) return false;
  return isCredentialFlag(arg);
}

/** The same masking over an `args` array as it sits in the config JSON.
 * Non-string entries (a config written elsewhere) pass through untouched.
 * Ported verbatim from `redact_json_args`. */
export function redactJsonArgs(args: readonly unknown[]): unknown[] {
  const flat = args.map((v) => (typeof v === "string" ? v : ""));
  const masked = redactCliArgs(flat);
  return masked.map((m, i) => (typeof args[i] === "string" ? m : args[i]));
}

/** What the agent-facing views print in place of a connector's config secrets.
 * A value that is not an object comes back unchanged, matching Rust's
 * `if let Some(map) = safe.as_object_mut()`. Ported verbatim from
 * `redact_agent_mcp_config`. */
export function redactAgentMcpConfig(config: unknown): unknown {
  if (!isPlainObject(config)) return config;
  const safe: Record<string, unknown> = { ...config };
  for (const key of AGENT_SECRET_KEYS) {
    // OWN keys only — Rust's `map.remove(key).is_some()` never sees an
    // inherited one, and this decides whether a credential is announced.
    if (hasOwn(safe, key)) safe[key] = REDACTED_ARG;
  }
  // A key typed into the command line is as much a credential as one in `env`,
  // and `args` is not one of the named fields.
  if (Array.isArray(safe["args"])) {
    safe["args"] = redactJsonArgs(safe["args"]);
  }
  return safe;
}

/** Strips every named secret field from a config object the model just handed
 * back, in place — matches Rust's `&mut Value`. Ported verbatim from
 * `remove_agent_mcp_secrets`. */
export function removeAgentMcpSecrets(config: Record<string, unknown>): void {
  for (const key of AGENT_SECRET_KEYS) {
    delete config[key];
  }
}

/**
 * Undo the read-side masking on a write, MUTATING `incoming` in place (matching
 * Rust's `&mut Value` — the caller passes a copy it owns): an argument the
 * model echoed back as `[redacted]` is restored from the stored connector, so
 * saving a connector the model merely read can never overwrite the user's real
 * key with the placeholder text (and the destination still compares equal, so
 * {@link sameDestination} keeps the sign-in).
 *
 * Paired by VALUE, not by position. `read_mcp` shows the masked args, so
 * read → tweak → save is the natural flow and the model may insert, drop or
 * reorder an argument on the way back; matching by index then either stored the
 * literal `[redacted]` (past the end of the old array) or substituted an
 * unrelated old argument. Re-masking the stored args reproduces exactly what
 * the model was shown, and each placeholder takes an as-yet-unused old argument
 * that masked to the same text — preferring the one whose PRECEDING argument
 * matches (`--api-key` vs `--token`), then the same index. A placeholder that
 * pairs with nothing is left alone for {@link rejectSurvivingPlaceholders}.
 * Ported verbatim from `restore_redacted_args`.
 */
export function restoreRedactedArgs(old: Record<string, unknown>, incoming: Record<string, unknown>): void {
  const previousRaw = old["args"];
  if (!Array.isArray(previousRaw)) return;
  const previous = previousRaw.slice();
  const masked = redactJsonArgs(previous);
  const args = incoming["args"];
  if (!Array.isArray(args)) return;
  // What the model handed back, before any restoring — the tie-break reads the
  // argument BEFORE a placeholder, which must be the incoming one.
  const handedBack = stringArgumentsOrNull(args);
  restoreKnownPlaceholders(args, previous, masked, handedBack);
}

export function stringArgumentsOrNull(args: readonly unknown[]): Array<string | null> {
  return args.map((arg) => (typeof arg === "string" ? arg : null));
}

export function restoreKnownPlaceholders(
  args: unknown[],
  previous: readonly unknown[],
  masked: readonly unknown[],
  handedBack: readonly (string | null)[]
): void {
  const used = new Array<boolean>(masked.length).fill(false);
  for (let i = 0; i < args.length; i++) {
    const cur = args[i];
    if (typeof cur !== "string") continue;
    if (!cur.endsWith(REDACTED_ARG)) continue;
    const pick = restoredArgIndex(masked, used, handedBack, i, cur);
    if (pick === undefined) continue;
    used[pick] = true;
    args[i] = previous[pick];
  }
}

export function restoredArgIndex(
  masked: readonly unknown[],
  used: readonly boolean[],
  handedBack: readonly (string | null)[],
  incomingIndex: number,
  placeholder: string
): number | undefined {
  const candidates = unusedMaskedIndexes(masked, used, placeholder);
  if (candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const afterSameArgument = candidateAfterSameArgument(candidates, masked, handedBack, incomingIndex);
  if (afterSameArgument !== undefined) return afterSameArgument;
  const sameIndex = candidates.find((index) => index === incomingIndex);
  return sameIndex ?? candidates[0];
}

export function unusedMaskedIndexes(masked: readonly unknown[], used: readonly boolean[], placeholder: string): number[] {
  const candidates: number[] = [];
  for (let index = 0; index < masked.length; index++) {
    if (used[index]) continue;
    if (masked[index] === placeholder) candidates.push(index);
  }
  return candidates;
}

export function candidateAfterSameArgument(
  candidates: readonly number[],
  masked: readonly unknown[],
  handedBack: readonly (string | null)[],
  incomingIndex: number
): number | undefined {
  const before = incomingIndex > 0 ? handedBack[incomingIndex - 1] : null;
  if (before === null) return undefined;
  for (const candidate of candidates) {
    if (candidate === 0) continue;
    if (masked[candidate - 1] === before) return candidate;
  }
  return undefined;
}

/** Refuse a save whose `args` still contain the masking placeholder. It stands
 * for a credential the room hides from the assistant, so storing it would erase
 * the user's real key — irrecoverably, and while also reading as a retarget
 * (which drops the connector's env/headers and its sign-in). Ported verbatim
 * from `reject_surviving_placeholders`. */
export function rejectSurvivingPlaceholders(incoming: Record<string, unknown>): void {
  const args = incoming["args"];
  if (!Array.isArray(args)) return;
  if (args.some((a) => typeof a === "string" && a.endsWith(REDACTED_ARG))) {
    throw new Error(
      `One argument is still "${REDACTED_ARG}" and no stored value matches it. That ` +
        `placeholder stands for a credential hidden from you, and saving it would erase the ` +
        `real one — re-read the connector and save it with its arguments in the same order, ` +
        `or ask the user to set the credential in Connectors.`
    );
  }
}

// ------------------------------------------------------ destination/retarget

/** Structural equality over plain JSON values — objects compared by key SET,
 * not key order, mirroring `serde_json::Value`'s own `PartialEq`. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  const arrays = matchingArrays(a, b);
  if (arrays !== undefined) return equalArrays(...arrays);
  const objects = matchingObjects(a, b);
  if (objects !== undefined) return equalPlainObjects(...objects);
  return false;
}

export function matchingArrays(a: unknown, b: unknown): [unknown[], unknown[]] | undefined {
  if (!Array.isArray(a)) return undefined;
  if (!Array.isArray(b)) return undefined;
  return [a, b];
}

export function equalArrays(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => deepEqual(value, b[index]));
}

export function matchingObjects(
  a: unknown,
  b: unknown
): [Record<string, unknown>, Record<string, unknown>] | undefined {
  if (!isPlainObject(a)) return undefined;
  if (!isPlainObject(b)) return undefined;
  return [a, b];
}

export function equalPlainObjects(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!hasOwn(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** Does an edited connector still reach the same place? Compares only the
 * fields that decide WHERE a call goes: the endpoint (`url`, and the `type`
 * that marks it remote) for a remote connector, the `command` and `args` for a
 * local one. Ported verbatim from `same_destination` (a private `fn` there,
 * exercised through its own `#[cfg(test)]` module; exported here so this port's
 * tests can state the same property as directly). */
export function sameDestination(oldEntry: Record<string, unknown>, newEntry: Record<string, unknown>): boolean {
  return (["url", "type", "command", "args"] as const).every((k) => deepEqual(oldEntry[k], newEntry[k]));
}

/**
 * Which connectors' stored sign-ins no longer belong to them: every server the
 * PREVIOUS config had that the next one drops, or points somewhere else, or
 * leaves unreadable. Names only — the caller decides what to do with them.
 *
 * A config that cannot be parsed at all yields nothing: this answers "which of
 * these entries moved", and with no readable previous config nothing is known
 * to have moved. The caller has already refused an unreadable NEW config.
 * Ported verbatim from `resigned_servers`.
 */
export function resignedServers(previous: string, next: string): string[] {
  const entries = (raw: string): Record<string, unknown> => {
    try {
      const v: unknown = JSON.parse(raw);
      const m = asRecord(v)["mcpServers"];
      return isPlainObject(m) ? m : {};
    } catch {
      return {};
    }
  };
  const old = entries(previous);
  const nw = entries(next);
  const out: string[] = [];
  for (const [name, cfg] of Object.entries(old)) {
    const now = ownEntry(nw, name);
    if (!isPlainObject(cfg) || now === undefined || !sameDestination(cfg, now)) {
      out.push(name);
    }
  }
  return out;
}
