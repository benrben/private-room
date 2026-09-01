import type Database from "better-sqlite3-multiple-ciphers";
import { getFileFull } from "./db-host/files.js";
import {
  MAX_ATTACHED_IMAGES,
  isImage,
  type PreparedImage,
} from "./turnContext.js";

export interface FirstImage {
  fileId: string;
  name: string;
  bytes: Buffer;
  width: number;
  height: number;
}

export interface AttachmentResult {
  images: string[];
  attachedNotes: string[];
  sources: string[];
  firstImage: FirstImage | null;
  carried: number;
}

type AttachmentRow = [string, string | null, Buffer | null, string | null];

function emptyAttachmentResult(): AttachmentResult {
  return { images: [], attachedNotes: [], sources: [], firstImage: null, carried: 0 };
}

function attachmentBytes(
  fileId: string,
  blobBytes: Buffer | null,
  workspaceAttachmentBytes?: ReadonlyMap<string, Buffer | null>,
): Buffer | null {
  if (workspaceAttachmentBytes?.has(fileId)) {
    return workspaceAttachmentBytes.get(fileId) ?? null;
  }
  return blobBytes;
}

function attachImage(
  result: AttachmentResult,
  fileId: string,
  name: string,
  bytes: Buffer | null,
  prepareImage: (bytes: Buffer) => PreparedImage,
): void {
  if (bytes === null) {
    result.attachedNotes.push(
      `(Attached image: ${name} — NOT sent: the room has no image data stored for it. Say so rather than describing it.)`,
    );
    return;
  }
  if (result.images.length >= MAX_ATTACHED_IMAGES) {
    result.attachedNotes.push(
      `(Attached image: ${name} — NOT sent: this turn carries at most ${MAX_ATTACHED_IMAGES} images. Say so rather than describing it.)`,
    );
    return;
  }
  const prepared = prepareImage(bytes);
  if (result.firstImage === null) {
    result.firstImage = {
      fileId,
      name,
      bytes: prepared.bytes,
      width: prepared.width,
      height: prepared.height,
    };
  }
  result.images.push(prepared.bytes.toString("base64"));
  result.attachedNotes.push(`(Attached image: ${name})`);
  result.sources.push(name);
  result.carried += 1;
}

function attachText(result: AttachmentResult, name: string, text: string | null): void {
  if (text !== null && text.trim() !== "") {
    result.attachedNotes.push(`[attached file: ${name}]\n${text}`);
    result.sources.push(name);
    result.carried += 1;
    return;
  }
  result.attachedNotes.push(
    `(Attached file: ${name} — no readable text has been extracted from it yet (a scan still to be read, a recording still to be transcribed), so its content is NOT in this turn. Say so rather than guessing at it.)`,
  );
}

function attachmentRow(db: Database.Database, fileId: string): AttachmentRow | null {
  try {
    return getFileFull(db, fileId);
  } catch {
    return null;
  }
}

function attachFile(
  db: Database.Database,
  fileId: string,
  result: AttachmentResult,
  prepareImage: (bytes: Buffer) => PreparedImage,
  workspaceAttachmentBytes?: ReadonlyMap<string, Buffer | null>,
): void {
  const row = attachmentRow(db, fileId);
  if (row === null) return;
  const [name, mimeRaw, blobBytes, text] = row;
  if (isImage(mimeRaw ?? "")) {
    attachImage(
      result,
      fileId,
      name,
      attachmentBytes(fileId, blobBytes, workspaceAttachmentBytes),
      prepareImage,
    );
    return;
  }
  attachText(result, name, text);
}

export function processAttachments(
  db: Database.Database,
  attachments: readonly string[],
  prepareImage: (bytes: Buffer) => PreparedImage,
  workspaceAttachmentBytes?: ReadonlyMap<string, Buffer | null>,
): AttachmentResult {
  const result = emptyAttachmentResult();
  for (const fileId of attachments) {
    attachFile(db, fileId, result, prepareImage, workspaceAttachmentBytes);
  }
  return result;
}
