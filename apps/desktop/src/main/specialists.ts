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

function asSpecialist(v: unknown): Specialist | null {
  if (!isRecord(v)) {
    return null;
  }
  const { key, tool, agent, label, area, description } = v;
  if (
    typeof key === "string" &&
    typeof tool === "string" &&
    typeof agent === "string" &&
    typeof label === "string" &&
    typeof area === "string" &&
    typeof description === "string"
  ) {
    const out: Specialist = { key, tool, agent, label, area, description };
    const capability = v.capability;
    if (capability === "full" || capability === "inspect-only" || capability === "unavailable") {
      out.capability = capability;
    }
    if (typeof v.capabilityReason === "string" && v.capabilityReason.trim() !== "") {
      out.capabilityReason = v.capabilityReason;
    }
    if (typeof v.localHandoff === "boolean") out.localHandoff = v.localHandoff;
    return out;
  }
  return null;
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
  const webEnabled = room.webEnabled();
  const explicit = room.explicitModel();
  const models = await deps.listModels().catch(() => []);
  const model = explicit ?? deps.bestDefault(models);
  const served = deps.servedToolNames(model, webEnabled);
  const value = await deps.fetchAgents({ web_enabled: webEnabled, served_names: served });
  const agents = isRecord(value) ? value.agents : undefined;
  const roster = parseSpecialists(agents);
  const effective = deps.effectiveServedToolNames?.(model, webEnabled);
  if (effective === undefined || deps.agentToolNames === undefined) return roster;

  const effectiveSet = new Set(effective);
  const removed = new Set(served.filter((name) => !effectiveSet.has(name)));
  if (removed.size === 0) return roster;

  // Ask the same registry a second time with the effective catalog. This is
  // important for agents such as App whose read and action tools are a paired
  // runtime requirement: merely seeing one read-like tool in the manifest
  // does not prove that an inspect-only worker can actually start.
  const effectiveValue = await deps.fetchAgents({
    web_enabled: webEnabled,
    served_names: effective,
  });
  const effectiveAgents = parseSpecialists(
    isRecord(effectiveValue) ? effectiveValue.agents : undefined,
  );
  const reachable = new Set(
    effectiveAgents
      .filter((specialist) => specialist.capability !== "unavailable")
      .map((specialist) => specialist.agent),
  );

  return roster.map((specialist) => {
    const affected = deps.agentToolNames!(specialist.agent).some((name) => removed.has(name));
    if (!affected) return specialist;
    if (!reachable.has(specialist.agent)) {
      return {
        ...specialist,
        capability: "unavailable" as const,
        capabilityReason: `Cloud Privacy blocks the action tools required by *${specialist.key}. Switch to On this Mac to use this specialist.`,
        localHandoff: true,
      };
    }
    return {
      ...specialist,
      capability: "inspect-only" as const,
      capabilityReason: `Cloud Privacy lets *${specialist.key} inspect, but blocks its direct action tools. Switch to On this Mac to use those actions.`,
      localHandoff: true,
    };
  });
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
