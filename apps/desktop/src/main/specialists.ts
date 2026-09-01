/**
 * The composer's `*` specialist menu, and `cancel_ask` — the tauri command
 * that stops a running answer.
 *
 * Ported from `src-tauri/src/commands/agent.rs`'s `Specialist`/`list_specialists`
 * (lines ~1575-1626) and `cancel_ask` (lines ~1644-1653).
 *
 * `list_specialists` is NOT pure in the Rust source — it locks the room for
 * its web-search setting and chat model, calls `ollama::list_models`, builds
 * the room MCP bridge's served-tool names via `room_mcp::room_tool_names`,
 * and POSTs to the Python sidecar's `/agents` endpoint. None of those
 * concrete dependencies (a room/settings host, an Ollama client, the
 * sidecar's HTTP surface) are wired together into one "AppState" in this
 * rewrite yet — same class of gap `mcpBridge.ts`'s module doc calls out for
 * `Bridge`/`start`/`prepare_advisor_runtime`. So this is split the same way
 * that file splits the wire protocol from the not-yet-buildable process
 * wiring: {@link parseSpecialists} is the pure, fully-tested half (the
 * sidecar response shape → the menu's data), and {@link listSpecialists} is
 * the orchestration, expressed against an injected {@link ListSpecialistsDeps}
 * seam so the call sequence itself (web setting + model → served tool names
 * → sidecar POST → parse) is exercised with a real fake rather than left
 * completely unported.
 */

import { cancelId, type CancelState } from "./cancel.js";
import type { StopReport } from "../shared/apiTypes.js";
import * as obs from "./obs.js";

// ------------------------------------------------------------------ Specialist

/** One specialist the composer's `*` menu may offer. Ported verbatim
 * (field-for-field) from the Rust `Specialist` struct — camelCase per this
 * workspace's JSON convention (see `turn.ts`'s note on `AskEnvelope`); the
 * sidecar's `/agents` response is expected to already use these names. */
export interface Specialist {
  /** The short key the user types after `*` ("browse"). */
  key: string;
  /** The `ask_*_agent` tool this specialist's domain hangs under. */
  tool: string;
  /** The WORKER this tag runs (`chat.browse`). */
  agent: string;
  /** The agent's own label ("Browser agent"). */
  label: string;
  /** One plain-words noun phrase: what this specialist's area is. */
  area: string;
  /** The full catalog sentence: what it can actually be asked for. */
  description: string;
  /** Effective ability after provider and privacy policy are applied. */
  capability?: "full" | "inspect-only" | "unavailable";
  /** Plain-language explanation shown before the user dispatches this tag. */
  capabilityReason?: string;
  /** True when changing to an on-device model restores the blocked actions. */
  localHandoff?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const REQUIRED_SPECIALIST_FIELDS = ["key", "tool", "agent", "label", "area", "description"] as const;

type RequiredSpecialistField = (typeof REQUIRED_SPECIALIST_FIELDS)[number];
type SpecialistRecord = Record<string, unknown> & Record<RequiredSpecialistField, string>;

function hasRequiredSpecialistFields(record: Record<string, unknown>): record is SpecialistRecord {
  return REQUIRED_SPECIALIST_FIELDS.every((field) => typeof record[field] === "string");
}

function requiredSpecialist(record: Record<string, unknown>): Specialist | null {
  if (!hasRequiredSpecialistFields(record)) return null;
  return {
    key: record.key,
    tool: record.tool,
    agent: record.agent,
    label: record.label,
    area: record.area,
    description: record.description,
  };
}

function optionalCapability(value: unknown): Specialist["capability"] | undefined {
  if (value === "full" || value === "inspect-only" || value === "unavailable") return value;
  return undefined;
}

function optionalReason(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

function optionalLocalHandoff(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function decorateSpecialist(specialist: Specialist, record: Record<string, unknown>): Specialist {
  const capability = optionalCapability(record.capability);
  if (capability !== undefined) specialist.capability = capability;
  const reason = optionalReason(record.capabilityReason);
  if (reason !== undefined) specialist.capabilityReason = reason;
  const localHandoff = optionalLocalHandoff(record.localHandoff);
  if (localHandoff !== undefined) specialist.localHandoff = localHandoff;
  return specialist;
}

function asSpecialist(v: unknown): Specialist | null {
  if (!isRecord(v)) return null;
  const specialist = requiredSpecialist(v);
  return specialist === null ? null : decorateSpecialist(specialist, v);
}

/**
 * Parse the sidecar `/agents` response's `agents` array into
 * {@link Specialist} records, dropping (never throwing on) any entry missing
 * a field — the same "a bad specialist record cannot break the whole menu"
 * posture `serde_json::from_value` gave the Rust source for free (a schema
 * mismatch there fails the WHOLE list with an error the user sees instead;
 * dropping the one bad entry here is a deliberate, documented judgment call
 * for a menu that would otherwise vanish over one malformed row — see the
 * report for detail).
 */
export function parseSpecialists(agents: unknown): Specialist[] {
  if (!Array.isArray(agents)) {
    return [];
  }
  const out: Specialist[] = [];
  for (const entry of agents) {
    const s = asSpecialist(entry);
    if (s !== null) {
      out.push(s);
    }
  }
  return out;
}

// -------------------------------------------------------------- the seam

/** What {@link listSpecialists} needs from the currently open room. Mirrors
 * reading `web_access_enabled(&room.conn)`/`model_setting(&room.conn)` under
 * one lock in the Rust source. */
export interface ListSpecialistsRoomSource {
  webEnabled(): boolean;
  /** The room's explicit chat-model setting, or `undefined` when unset
   * (mirrors `model_setting`'s `Option<String>`). */
  explicitModel(): string | undefined;
}

/** Everything {@link listSpecialists} needs beyond the room, all genuinely
 * out of scope for this batch (a not-yet-ported Ollama client, room-MCP-bridge
 * tool-name resolution, and the sidecar's `/agents` HTTP surface) — injected
 * so the ORCHESTRATION (the order these are called in, and how their results
 * feed each other) is real and tested even though each dependency's own
 * internals are not. */
export interface ListSpecialistsDeps {
  /** `ollama::list_models` — the installed models this Mac can see. */
  listModels(): Promise<string[]>;
  /** `best_default` — the fallback model when the room has none set. */
  bestDefault(models: readonly string[]): string;
  /** `room_mcp::room_tool_names` (scoped by `sidecar::bridge_scope_for(model)`)
   * — the tool names this room's bridge would serve right now. */
  servedToolNames(model: string, webEnabled: boolean): string[];
  /** The catalog after provider/privacy policy is applied. Optional for legacy
   * callers; production supplies it so list and call expose the same tools. */
  effectiveServedToolNames?(model: string, webEnabled: boolean): string[];
  /** Tool ownership from the shared agent manifest. */
  agentToolNames?(agentId: string): readonly string[];
  /** `sidecar_json("/agents", body)` — POSTs `{web_enabled, served_names}`
   * and resolves with the parsed JSON body's `agents` field (or throws/rejects
   * on a transport failure, mirroring `.map_err(|e| e.sentinel(None))`). */
  fetchAgents(body: { web_enabled: boolean; served_names: string[] }): Promise<unknown>;
}

interface SpecialistRoster {
  webEnabled: boolean;
  model: string;
  served: string[];
  specialists: Specialist[];
}

async function initialRoster(
  room: ListSpecialistsRoomSource,
  deps: ListSpecialistsDeps,
): Promise<SpecialistRoster> {
  const webEnabled = room.webEnabled();
  const explicit = room.explicitModel();
  const models = await deps.listModels().catch(() => []);
  const model = explicit ?? deps.bestDefault(models);
  const served = deps.servedToolNames(model, webEnabled);
  const value = await deps.fetchAgents({ web_enabled: webEnabled, served_names: served });
  return {
    webEnabled,
    model,
    served,
    specialists: parseSpecialists(isRecord(value) ? value.agents : undefined),
  };
}

function removedTools(served: readonly string[], effective: readonly string[]): Set<string> {
  const effectiveSet = new Set(effective);
  return new Set(served.filter((name) => !effectiveSet.has(name)));
}

async function reachableSpecialists(
  roster: SpecialistRoster,
  effective: string[],
  deps: ListSpecialistsDeps,
): Promise<Set<string>> {
  const value = await deps.fetchAgents({ web_enabled: roster.webEnabled, served_names: effective });
  return new Set(
    parseSpecialists(isRecord(value) ? value.agents : undefined)
      .filter((specialist) => specialist.capability !== "unavailable")
      .map((specialist) => specialist.agent),
  );
}

function restrictedSpecialist(
  specialist: Specialist,
  removed: ReadonlySet<string>,
  reachable: ReadonlySet<string>,
  agentToolNames: NonNullable<ListSpecialistsDeps["agentToolNames"]>,
): Specialist {
  const affected = agentToolNames(specialist.agent).some((name) => removed.has(name));
  if (!affected) return specialist;
  if (reachable.has(specialist.agent)) {
    return {
      ...specialist,
      capability: "inspect-only",
      capabilityReason: `Cloud Privacy lets *${specialist.key} inspect, but blocks its direct action tools. Switch to On this Mac to use those actions.`,
      localHandoff: true,
    };
  }
  return {
    ...specialist,
    capability: "unavailable",
    capabilityReason: `Cloud Privacy blocks the action tools required by *${specialist.key}. Switch to On this Mac to use this specialist.`,
    localHandoff: true,
  };
}

async function restrictRoster(
  roster: SpecialistRoster,
  effective: string[],
  deps: ListSpecialistsDeps,
  agentToolNames: NonNullable<ListSpecialistsDeps["agentToolNames"]>,
): Promise<Specialist[]> {
  const removed = removedTools(roster.served, effective);
  if (removed.size === 0) return roster.specialists;
  const reachable = await reachableSpecialists(roster, effective, deps);
  return roster.specialists.map((specialist) => restrictedSpecialist(specialist, removed, reachable, agentToolNames));
}

/**
 * The specialists THIS room can dispatch to. Ported from `list_specialists`.
 * Errors (rather than resolving to `[]`) when the sidecar cannot be reached —
 * "this room has no specialists" and "we could not find out" are different
 * answers, and the caller is entitled to know which one this is.
 */
export async function listSpecialists(
  room: ListSpecialistsRoomSource,
  deps: ListSpecialistsDeps
): Promise<Specialist[]> {
  const roster = await initialRoster(room, deps);
  const effective = deps.effectiveServedToolNames?.(roster.model, roster.webEnabled);
  const agentToolNames = deps.agentToolNames;
  if (effective === undefined || agentToolNames === undefined) return roster.specialists;
  return restrictRoster(roster, effective, deps, agentToolNames);
}

// -------------------------------------------------------------------- cancel

/**
 * ADD-7: stop a running answer. Ported verbatim from `cancel_ask` — thin by
 * design: it is entirely a call into the already-ported cancel tree
 * (`cancel.ts`) plus the same two observability events the Rust source
 * records. Not an error for an unknown id: the ask may have already finished.
 */
export function cancelAsk(state: CancelState, askId: string): StopReport {
  const report = cancelId(state, askId);
  obs.info("cancel.requested", [
    ["run", obs.id(askId)],
    ["known", obs.flag(report.known)],
  ]);
  obs.info("cancel.subtree", [
    ["run", obs.id(askId)],
    ["stopped", obs.count(report.stopped.length)],
  ]);
  return report;
}
