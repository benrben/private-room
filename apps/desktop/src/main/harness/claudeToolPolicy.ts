import { realpathSync } from "node:fs";
import path from "node:path";

const FILE_TOOLS = new Set([
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "NotebookEdit",
]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const NETWORK_COMMAND =
  /(^|[;&|()\s])(curl|wget|nc|ncat|ssh|scp|sftp|ftp|telnet)\b/i;
const EXECUTABLE_CHANGE =
  /(^|[;&|()\s])chmod\s+(?:-[^\s]+\s+)*[^\n]*(?:\+x|[157][0-7]{2})/i;

function within(root: string, candidate: string): boolean {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(path.resolve(root), absolute);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function canonicalPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function requestedPath(input: Record<string, unknown>): string | null {
  for (const key of ["file_path", "path", "notebook_path"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  return null;
}

function privateOrOutside(root: string, candidate: string): boolean {
  const absolute = path.resolve(root, candidate);
  const privateRoot = path.join(path.resolve(root), ".arcelle");
  return absolute === privateRoot
    || absolute.startsWith(`${privateRoot}${path.sep}`)
    || !within(root, absolute);
}

function isAllowedRoomPath(workspacePath: string, candidate: string | null): boolean {
  return candidate === null || !privateOrOutside(workspacePath, candidate);
}

export function mutatingTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
    || /(?:^|__)(?:workspace_(?:write|edit|move|rename|delete)|trash_files|organize_files|save_generated_file)$/i.test(
      toolName,
    );
}

function toolDecision(
  permissionDecision: "allow" | "ask" | "deny",
  permissionDecisionReason: string,
) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision,
      permissionDecisionReason,
    },
  };
}

function bashToolDecision(command: string) {
  if (NETWORK_COMMAND.test(command)) {
    return toolDecision("deny", "Shell network access is disabled; use Arcelle browser tools.");
  }
  if (EXECUTABLE_CHANGE.test(command)) {
    return toolDecision("deny", "Agents cannot make room files executable.");
  }
  return toolDecision("ask", "Shell commands require approval.");
}

function isReadOnlyWrite(toolName: string, writeEnabled: boolean): boolean {
  return WRITE_TOOLS.has(toolName) && !writeEnabled;
}

export function preToolDecision(
  toolName: string,
  toolInput: Record<string, unknown>,
  workspacePath: string,
  writeEnabled: boolean,
) {
  if (!isAllowedRoomPath(workspacePath, requestedPath(toolInput))) {
    return toolDecision("deny", "Arcelle only exposes normal files inside this room.");
  }
  if (isReadOnlyWrite(toolName, writeEnabled)) {
    return toolDecision("deny", "This run is read-only.");
  }
  if (toolName === "Bash") return bashToolDecision(String(toolInput.command ?? ""));
  if (FILE_TOOLS.has(toolName)) {
    return toolDecision("allow", "The operation stays inside the verified room exposure.");
  }
  return {};
}
