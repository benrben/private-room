import type Database from "better-sqlite3-multiple-ciphers";
import { getFileExtractedText, getFileName, listFiles } from "./db-host/files.js";
import { titleFromName } from "./docsHtml.js";
import { isSummaryFile } from "./summarizeTools.js";
import { clampBytes } from "./textClamp.js";

const SCOPE_TEXT_CAP = 12_000;
const WHOLE_ROOM_PER_FILE_CAP = 1_500;
const REFS_PER_FILE_CAP = 3_000;

export function gatherScopeText(
  db: Database.Database,
  scope: string | null,
  roomName: string,
): [string, string] {
  if (scope !== null) return gatheredFileScope(db, scope);
  const text = gatheredRoomScope(db);
  if (text.trim() === "") throw new Error("This room has no readable text to work with yet.");
  return [roomName, text];
}

function gatheredFileScope(db: Database.Database, fileId: string): [string, string] {
  const name = getFileName(db, fileId);
  const text = getFileExtractedText(db, fileId) ?? "";
  if (text.trim() === "") throw new Error(`"${name}" has no readable text to work with.`);
  return [titleFromName(name), clampBytes(text, SCOPE_TEXT_CAP)];
}

function gatheredRoomScope(db: Database.Database): string {
  let blob = "";
  for (const file of listFiles(db)) {
    if (isSummaryFile(file.name, file.source)) continue;
    if (Buffer.byteLength(blob, "utf8") >= SCOPE_TEXT_CAP) break;
    const text = getFileExtractedText(db, file.id);
    if (text === null || text.trim() === "") continue;
    blob += `## ${file.name}\n${clampBytes(text, WHOLE_ROOM_PER_FILE_CAP)}\n\n`;
  }
  return blob;
}

export function gatherFilesText(db: Database.Database, fileIds: readonly string[]): [string, string] {
  let blob = "";
  const names: string[] = [];
  for (const id of fileIds) {
    const file = gatheredNamedFile(db, id);
    if (file === null) continue;
    if (Buffer.byteLength(blob, "utf8") >= SCOPE_TEXT_CAP) break;
    blob += `## ${file.name}\n${clampBytes(file.text, REFS_PER_FILE_CAP)}\n\n`;
    names.push(titleFromName(file.name));
  }
  if (blob.trim() === "") throw new Error("The files you mentioned have no readable text to work with.");
  const label = names.length === 1 ? names[0]! : `${names.length} files`;
  return [label, blob];
}

function gatheredNamedFile(db: Database.Database, fileId: string): { name: string; text: string } | null {
  let name: string;
  try {
    name = getFileName(db, fileId);
  } catch {
    return null;
  }
  const text = getFileExtractedText(db, fileId);
  if (text === null || text.trim() === "") return null;
  return { name, text };
}

const SCOPE_NAME_FORBIDDEN = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|", "\n", "\r", "\t"]);

export function safeScopeName(label: string): string {
  let folded = "";
  for (const ch of label) folded += SCOPE_NAME_FORBIDDEN.has(ch) ? " " : ch;
  const cleaned = folded.split(/\p{White_Space}+/u).filter((word) => word !== "").join(" ");
  const name = [...cleaned].slice(0, 60).join("").trim();
  return name === "" ? "room" : name;
}

export function studioInstruction(supplied: string | null, defaultPrompt: string): string {
  const trimmed = supplied?.trim();
  return trimmed !== undefined && trimmed !== "" ? trimmed : defaultPrompt;
}
