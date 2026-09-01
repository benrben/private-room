import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export type AgentPermission = "read" | "write";

export interface SharedAgentDefinition {
  id: string;
  label: string;
  tag: string;
  graph: string;
  instructions: string;
  tools: string[];
  permission: AgentPermission;
  capability: string;
}
export interface SharedAgentManifest {
  version: number;
  defaults: {
    timeoutSeconds: number;
    maxRounds: number;
    privacy: string;
    outputSchema: string;
    permission: AgentPermission;
  };
  agents: SharedAgentDefinition[];
}

function manifestCandidates(): string[] {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.ARCELLE_AGENT_MANIFEST_PATH,
    // Packaged layout: dist_package/config beside dist_package/electron.
    path.resolve(here, "../../../config/agent-manifest.json"),
    // Source/test layout: repository-level config.
    path.resolve(here, "../../../../../config/agent-manifest.json"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Agent manifest ${field} is invalid.`);
  return value;
}

export function parseManifest(raw: unknown): SharedAgentManifest {
  const value = manifestRecord(raw);
  const entries = manifestAgentEntries(value);
  const defaults = manifestDefaults(value);
  const ids = new Set<string>();
  const agents = entries.map((entry, index) => parseAgent(entry, index, ids));
  validateAgentCatalog(agents);
  return {
    version: 1,
    defaults: parseDefaults(defaults),
    agents,
  };
}

function manifestRecord(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error("Agent manifest must be an object.");
  return raw;
}

function manifestAgentEntries(manifest: Record<string, unknown>): unknown[] {
  if (manifest.version !== 1 || !Array.isArray(manifest.agents)) {
    throw new Error("Unsupported agent manifest version.");
  }
  return manifest.agents;
}

function manifestDefaults(manifest: Record<string, unknown>): Record<string, unknown> {
  const defaults = manifest.defaults as Record<string, unknown> | undefined;
  if (defaults === undefined) throw new Error("Agent manifest defaults are missing.");
  return defaults;
}

function parseAgent(
  entry: unknown,
  index: number,
  ids: Set<string>,
): SharedAgentDefinition {
  const agent = manifestAgentEntry(entry, index);
  const id = nonEmptyString(agent.id, `agents[${index}].id`);
  reserveAgentId(id, ids);
  const tools = agentTools(agent.tools, id);
  const permission = agentPermission(agent.permission, id);
  return {
    id,
    label: nonEmptyString(agent.label, `${id}.label`),
    tag: typeof agent.tag === "string" ? agent.tag : "",
    graph: nonEmptyString(agent.graph, `${id}.graph`),
    instructions: nonEmptyString(agent.instructions, `${id}.instructions`),
    tools,
    permission,
    capability: nonEmptyString(agent.capability, `${id}.capability`),
  };
}

function manifestAgentEntry(entry: unknown, index: number): Record<string, unknown> {
  if (!isRecord(entry)) throw new Error(`Agent manifest entry ${index} is invalid.`);
  return entry;
}

function reserveAgentId(id: string, ids: Set<string>): void {
  if (ids.has(id)) throw new Error(`Agent manifest contains duplicate id ${id}.`);
  ids.add(id);
}

function agentTools(value: unknown, id: string): string[] {
  if (!Array.isArray(value) || !value.every(isNamedTool)) {
    throw new Error(`Agent manifest tools for ${id} are invalid.`);
  }
  return [...value];
}

function isNamedTool(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function agentPermission(value: unknown, id: string): AgentPermission {
  if (isAgentPermission(value)) return value;
  throw new Error(`Agent manifest permission for ${id} is invalid.`);
}

function validateAgentCatalog(agents: SharedAgentDefinition[]): void {
  if (agents.length !== 16 || new Set(agents.map((agent) => agent.graph)).size !== 8) {
    throw new Error("Agent manifest must contain the supported sixteen specialists and eight graph shapes.");
  }
}

function parseDefaults(defaults: Record<string, unknown>): SharedAgentManifest["defaults"] {
  const permission = defaults.permission;
  if (!isAgentPermission(permission)) throw new Error("Agent manifest default permission is invalid.");
  return {
    timeoutSeconds: Number(defaults.timeoutSeconds),
    maxRounds: Number(defaults.maxRounds),
    privacy: nonEmptyString(defaults.privacy, "defaults.privacy"),
    outputSchema: nonEmptyString(defaults.outputSchema, "defaults.outputSchema"),
    permission,
  };
}

function isAgentPermission(value: unknown): value is AgentPermission {
  return value === "read" || value === "write";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

let cached: SharedAgentManifest | null = null;

export function loadAgentManifest(): SharedAgentManifest {
  if (cached !== null) return cached;
  const failures: string[] = [];
  for (const candidate of manifestCandidates()) {
    try {
      cached = parseManifest(JSON.parse(readFileSync(candidate, "utf8")));
      return cached;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Arcelle could not load its shared agent manifest. ${failures.join("; ")}`);
}

function claudeAgentName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "-");
}

/** Generate Claude SDK subagents from the language-neutral source of truth. */
export function claudeAgentDefinitions(manifest = loadAgentManifest()): Record<string, AgentDefinition> {
  return Object.fromEntries(manifest.agents.map((agent) => {
    const nativeRead = ["Read", "Glob", "Grep"];
    const nativeWrite = agent.permission === "write" ? ["Write", "Edit", "NotebookEdit"] : [];
    const roomTools = agent.tools.map((tool) => `mcp__room__${tool}`);
    return [claudeAgentName(agent.id), {
      description: `${agent.label}: ${agent.instructions}`,
      prompt: [
        agent.instructions,
        `Arcelle specialist id: ${agent.id}. Graph policy: ${agent.graph}.`,
        `Privacy: ${manifest.defaults.privacy}. Output: ${manifest.defaults.outputSchema}.`,
        agent.permission === "write"
          ? "You may write only when the parent run has a completed rollback baseline."
          : "This specialist is read-only. Do not create, edit, move, or delete files.",
      ].join("\n"),
      tools: [...nativeRead, ...nativeWrite, ...roomTools],
      disallowedTools: agent.permission === "read" ? ["Write", "Edit", "NotebookEdit", "Bash"] : ["Bash"],
      model: "inherit",
    } satisfies AgentDefinition];
  }));
}

/**
 * Codex owns its collaboration tools. Give the installed app-server the same
 * specialist catalog without writing generated AGENTS.md files into the room.
 */
export function codexAgentInstructions(manifest = loadAgentManifest()): string {
  const catalog = manifest.agents.map((agent) =>
    `- ${agent.id} (${agent.label}; ${agent.permission}; graph=${agent.graph}; tools=${agent.tools.join(", ") || "none"}): ${agent.instructions}`,
  ).join("\n");
  return [
    "Arcelle specialist catalog (generated from config/agent-manifest.json):",
    catalog,
    "Use Codex collaboration/subagent tools for independent read-only specialists when useful.",
    "Serialize specialists that can write. Every child inherits the parent privacy, cancellation, workspace sandbox, and rollback policy.",
    "Report child activity through the normal collaboration events. Do not access .arcelle or paths outside the exposed workspace.",
  ].join("\n");
}
