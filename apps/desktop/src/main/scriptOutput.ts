import type Database from "better-sqlite3-multiple-ciphers";
import { getJobArtifact } from "./db-host/jobs.js";
import { clampBytes } from "./textClamp.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsedRecord(json: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(json);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function artifactResult(rawArtifact: string): string {
  const artifact = parsedRecord(rawArtifact);
  return artifact !== null && typeof artifact["result"] === "string"
    ? artifact["result"]
    : "";
}

function outputReport(result: string): Record<string, unknown> | null {
  const report = parsedRecord(result);
  return report !== null && typeof report["stdoutTail"] === "string"
    ? report
    : null;
}

function importedFileNames(report: Record<string, unknown>): string[] {
  const imported = report["imported"];
  if (!Array.isArray(imported)) return [];
  return imported
    .map((file) =>
      isPlainObject(file) && typeof file["name"] === "string"
        ? file["name"]
        : null,
    )
    .filter((name): name is string => name !== null);
}

function skippedNotes(report: Record<string, unknown>): string[] {
  const skipped = report["skipped"];
  if (!Array.isArray(skipped)) return [];
  return skipped
    .filter((note): note is string => typeof note === "string")
    .map((note) => `Note: ${note}`);
}

function exitCodeNote(report: Record<string, unknown>): string | null {
  const exitCode =
    typeof report["exitCode"] === "number" ? report["exitCode"] : 0;
  return exitCode === 0 ? null : `Exit code: ${exitCode}`;
}

/** Render one stored script-run artifact as the user-visible output. */
export function printedOutput(rawArtifact: string): string {
  const result = artifactResult(rawArtifact);
  const report = outputReport(result);
  if (report === null) return result;

  const parts: string[] = [];
  const tail = (report["stdoutTail"] as string).trim();
  if (tail !== "") parts.push(tail);

  const created = importedFileNames(report);
  if (created.length > 0) parts.push(`Created: ${created.join(", ")}`);
  parts.push(...skippedNotes(report));

  const exitNote = exitCodeNote(report);
  if (exitNote !== null) parts.push(exitNote);
  return parts.join("\n");
}

/** Read all consecutive stored script-step outputs for a job. */
export function scriptOutput(db: Database.Database, jobId: string): string {
  const parts: string[] = [];
  for (let step = 0; step < 4; step++) {
    const raw = getJobArtifact(db, jobId, step);
    if (raw === null) break;
    const text = printedOutput(raw).trim();
    if (text !== "") parts.push(text);
  }
  return parts.join("\n");
}

/** Bound script output by UTF-8 bytes before including it in a model turn. */
export function clampScriptOutput(name: string, out: string): string {
  const maxBytes = 4000;
  if (out.trim() === "") {
    return `Ran ${name}. It finished successfully and printed nothing.`;
  }
  let body = out;
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    body = `${clampBytes(body, maxBytes)}\n… (output truncated)`;
  }
  return (
    `Ran ${name}. It finished successfully. Its output — quote these values ` +
    `exactly, they are the answer:\n${body}`
  );
}
