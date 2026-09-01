import { message } from "./platform";
import { api, writeRecoveryKey, type RoomInfo } from "./api";
import { MIN_PASSWORD, ROOM_TEMPLATES, type RoomRole, type RoomTemplate } from "./rooms/constants";

/** What the unlock gate says when an open fails.
 *
 * Every unlock path funnels through here — typed password, Touch ID, and the
 * recovery code — because they used to disagree: the typed path turned
 * `WRONG_PASSWORD` into a sentence while Touch ID printed that bare internal
 * code straight onto the lock screen, and anything the host had not classified
 * (a damaged room, a read-only disk, a file another copy of the app holds
 * open) arrived as raw SQLite text.
 *
 * The pass-through rule is deliberate: the host's own messages are written as
 * sentences ("File not found.", "This file is not an Arcelle project.", the
 * classified first-read failures), and engine text is not — it is lower-case
 * and unpunctuated. So a message that reads like one of ours is shown as-is,
 * and anything else becomes a calm fallback with the detail left in the
 * console. A new host sentence therefore needs no change here; a new engine
 * error cannot leak. */
function knownUnlockMessage(message: string): string | null {
  if (message.includes("WRONG_PASSWORD")) return "That password didn't work. Try again.";
  if (/readonly|read-only/i.test(message)) {
    return "This room is on a read-only disk, so it can't be opened. Copy it somewhere you can write to and try again.";
  }
  if (/malformed|not a database|corrupt/i.test(message)) {
    return "This room file looks damaged. Try a checkpoint or a backup copy of it.";
  }
  if (/database is locked|unable to open database/i.test(message)) {
    return "This room couldn't be opened. Check that it's on a connected drive and not already open in another copy of Arcelle.";
  }
  if (/PRAGMA|sqlcipher|rekey|ATTACH/i.test(message)) {
    return "This room couldn't be unlocked. Check the password and try again.";
  }
  return null;
}

function isHostUnlockMessage(message: string) {
  return /^[A-Z"“]/.test(message) && /[.!?]$/.test(message) && message.length < 300;
}

export function unlockMessage(raw: string): string {
  const msg = raw.replace(/^Error:\s*/, "").trim();
  return knownUnlockMessage(msg)
    ?? (isHostUnlockMessage(msg)
      ? msg
      : "This room couldn't be opened. Check that the file is on a connected drive and not damaged.");
}

export function createValidationError(password: string, confirmation: string): string | null {
  if (password.length < MIN_PASSWORD) return `Please use at least ${MIN_PASSWORD} characters.`;
  if (password !== confirmation) return "Passwords do not match.";
  return null;
}

export function suggestedRoomFolder(name: string) {
  return (name.trim() || "My Room").replace(/[/\\:]/g, "-");
}

export function selectedTemplate(templateKey: string) {
  return ROOM_TEMPLATES.find((template) => template.key === templateKey);
}

export function selectedRole(roles: RoomRole[], roleId: string) {
  return roles.find((role) => role.id === roleId);
}

function roomInstructions(template: RoomTemplate | undefined, role: RoomRole | undefined) {
  return [
    template?.customInstructions,
    role && role.id !== "default" ? role.instructions : "",
  ].filter(Boolean).join("\n\n");
}

async function saveTemplateContent(template: RoomTemplate) {
  for (const memory of template.memories) await api.addMemory(memory);
  if (template.welcome) await api.saveGeneratedFile("Welcome.md", template.welcome);
  for (const file of template.files ?? []) await api.saveGeneratedFile(file.name, file.content);
}

async function applyCreatedRoomSetup(template: RoomTemplate | undefined, role: RoomRole | undefined) {
  const instructions = roomInstructions(template, role);
  if (instructions) await api.setSetting("custom_instructions", instructions);
  if (role && role.id !== "default") await api.setSetting("room_role", role.id);
  if (template && template.key !== "blank") await saveTemplateContent(template);
}

async function tellRecoveryKeyFailed() {
  await message(
    "The room was created, but its recovery code could not be written. " +
      "As it stands, this room can only ever be opened with its " +
      "password. You can make a recovery key in Settings → " +
      "Privacy & recovery.",
    { title: "No recovery code was made", kind: "warning" },
  ).catch(() => {});
}

export function legacyDestinationName(path: string, suffix: string, fallback: string) {
  const name = path.split(/[\\/]/).pop()?.replace(/\.(?:arcelle|roomai)$/i, "") || fallback;
  return `${name} ${suffix}`;
}

function conversionDetails(report: Awaited<ReturnType<typeof api.convertLegacyRoom>>) {
  const converted = `${report.convertedFiles} file${report.convertedFiles === 1 ? "" : "s"} converted.`;
  const renamed = report.renamed.length === 0
    ? ""
    : `${report.renamed.length} path${report.renamed.length === 1 ? " was" : "s were"} safely renamed.`;
  const skipped = report.skipped.length === 0
    ? ""
    : `${report.skipped.length} legacy row${report.skipped.length === 1 ? " had" : "s had"} no current bytes and stayed in private state.`;
  return [converted, renamed, skipped].filter(Boolean).join("\n");
}

function needsConversionNotice(report: Awaited<ReturnType<typeof api.convertLegacyRoom>>) {
  return report.renamed.length > 0 || report.skipped.length > 0;
}

export async function showConversionNotice(report: Awaited<ReturnType<typeof api.convertLegacyRoom>>) {
  if (!needsConversionNotice(report)) return;
  await message(conversionDetails(report), { title: "Conversion complete", kind: "info" });
}

export async function chooseSealedDestination(
  options: { title: string; defaultPath: string },
  setError: (error: string) => void,
) {
  try {
    return await api.chooseSavePath(options);
  } catch (error) {
    setError(unlockMessage(String(error)));
    return null;
  }
}

function importedFilesMessage(fileCount: number) {
  return `Imported ${fileCount} file${fileCount === 1 ? "" : "s"} and private history into a new workspace.`;
}

type SealedImport = {
  packagePath: string;
  password: string;
  destinationPath: string;
  fileCount: number;
  isCurrent: () => boolean;
  enterRoom: (info: RoomInfo) => void;
};

export async function importSealedRoom({
  packagePath,
  password,
  destinationPath,
  fileCount,
  isCurrent,
  enterRoom,
}: SealedImport) {
  if (!isCurrent()) return;
  await api.importSealedPackage(packagePath, password, destinationPath);
  if (!isCurrent()) return;
  const info = await api.openRoom(destinationPath, password);
  if (!isCurrent()) return;
  await message(importedFilesMessage(fileCount), {
    title: "Sealed backup imported",
    kind: "info",
  }).catch(() => {});
  enterRoom(info);
}

async function applyCreatedRoomSetupSafely(
  template: RoomTemplate | undefined,
  role: RoomRole | undefined,
  setError: (error: string) => void,
) {
  try {
    await applyCreatedRoomSetup(template, role);
  } catch (error) {
    console.error("Failed to apply room template", error);
    setError("Room created, but its starter content could not be added.");
  }
}

type CreatedRoomRecovery = {
  info: RoomInfo;
  isCurrent: () => boolean;
  setPendingInfo: (info: RoomInfo | null) => void;
  setRecoveryCopied: (copied: boolean) => void;
  setRecoveryCode: (code: string | null) => void;
  enterRoom: (info: RoomInfo) => void;
};

async function prepareCreatedRoomRecovery({
  info,
  isCurrent,
  setPendingInfo,
  setRecoveryCopied,
  setRecoveryCode,
  enterRoom,
}: CreatedRoomRecovery) {
  try {
    const code = await writeRecoveryKey();
    if (!isCurrent()) return;
    setPendingInfo(info);
    setRecoveryCopied(false);
    setRecoveryCode(code);
  } catch (error) {
    console.error("Could not create a recovery code", error);
    if (!isCurrent()) return;
    await tellRecoveryKeyFailed();
    if (isCurrent()) enterRoom(info);
  }
}

export function usableCreatePath(path: string | string[] | null, isCurrent: () => boolean): path is string {
  return typeof path === "string" && isCurrent();
}

type RoomCreation = {
  path: string;
  password: string;
  roomName: string;
  template: RoomTemplate | undefined;
  role: RoomRole | undefined;
  isCurrent: () => boolean;
  setError: (error: string) => void;
  recovery: Omit<CreatedRoomRecovery, "info" | "isCurrent">;
};

export async function createAndPrepareRoom({
  path,
  password,
  roomName,
  template,
  role,
  isCurrent,
  setError,
  recovery,
}: RoomCreation) {
  const info = await api.createRoom(path, password, roomName.trim() || undefined, "workspace-folder");
  if (!isCurrent()) return;
  await applyCreatedRoomSetupSafely(template, role, setError);
  await prepareCreatedRoomRecovery({ info, isCurrent, ...recovery });
}
