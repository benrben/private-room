import path from "node:path";
import { Readable } from "node:stream";
import type { RoomManagerState } from "../roomManager.js";
import { setFileExtractedText } from "../db-host/files.js";
import { normalizeRelativePath, pathKey } from "./pathSafety.js";

interface FileRow {
  id: string;
  relative_path: string;
  mime_type: string | null;
  size_bytes: number;
  content_sha256: string | null;
  created_at: string;
}

async function readAll(stream: NodeJS.ReadableStream, maxBytes = 8 * 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) throw new Error("This file is too large for the text workspace tool.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function virtualPath(value: unknown, allowRoot = false): string {
  const raw = typeof value === "string" ? value : "";
  if (allowRoot && (raw === "" || raw === "/")) return "";
  return normalizeRelativePath(raw.replace(/^\/+/, ""));
}

function isText(row: FileRow): boolean {
  if (row.mime_type?.startsWith("text/")) return true;
  return [".json", ".csv", ".tsv", ".xml", ".yaml", ".yml", ".js", ".ts", ".tsx", ".py", ".rs"]
    .includes(path.extname(row.relative_path).toLocaleLowerCase("en-US"));
}

/** Virtual-path MCP projection consumed by the Python Deep Harness backend. */
export function createWorkspaceMcpBridge(
  state: RoomManagerState,
  writeEnabled = false,
): { call(operation: string, args: Record<string, unknown>): Promise<Record<string, unknown>> } {
  const room = () => {
    const open = state.room;
    if (open?.workspace === undefined) throw new Error("This room does not expose normal workspace files.");
    return open;
  };
  const rows = (): FileRow[] => room().conn.prepare(
    `SELECT id, relative_path, mime_type, size_bytes, content_sha256, created_at
     FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND relative_path IS NOT NULL`,
  ).all() as FileRow[];
  const file = (relativePath: string): FileRow => {
    const found = room().conn.prepare(
      `SELECT id, relative_path, mime_type, size_bytes, content_sha256, created_at
       FROM files WHERE storage_kind = 'workspace' AND trashed_at IS NULL AND path_key = ?`,
    ).get(pathKey(relativePath)) as FileRow | undefined;
    if (found === undefined) throw new Error("Workspace file not found.");
    return found;
  };
  const fileLike = (value: unknown): FileRow => {
    const query = virtualPath(value);
    try { return file(query); } catch { /* fall through to unique fuzzy name */ }
    const lower = query.toLocaleLowerCase("en-US");
    const matches = rows().filter((row) => {
      const candidate = row.relative_path.toLocaleLowerCase("en-US");
      return path.posix.basename(candidate) === lower || candidate.includes(lower);
    });
    if (matches.length === 0) throw new Error("Workspace file not found.");
    if (matches.length > 1) throw new Error("That name matches more than one workspace file. Use its full path.");
    return matches[0]!;
  };

  type Result = Record<string, unknown>;
  type Handler = (args: Record<string, unknown>) => Promise<Result>;
  type EditPlan = { error: string } | { next: string; occurrences: number };

  const readText = async (row: FileRow): Promise<string> =>
    (await readAll(room().workspace!.readStream(row.id))).toString("utf8");
  const saveText = async (row: FileRow, text: string, cause: string): Promise<void> => {
    await room().workspace!.snapshotVersion(row.id, cause);
    await room().workspace!.writeAtomic(
      row.id,
      Readable.from([Buffer.from(text)]),
      row.content_sha256 ?? undefined,
    );
    setFileExtractedText(room().conn, row.id, text);
  };
  const createText = async (relative: string, content: string): Promise<void> => {
    const created = await room().workspace!.createFile(
      relative,
      Readable.from([Buffer.from(content)]),
      "agent",
    );
    setFileExtractedText(room().conn, created.fileId, content);
  };
  const fileExists = (relative: string): boolean => {
    try {
      file(relative);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === "Workspace file not found.") return false;
      throw error;
    }
  };
  const existingForWrite = (relative: string): FileRow | undefined => {
    try {
      return file(relative);
    } catch {
      return undefined;
    }
  };
  const parentPath = (parent: string, name: string): string => {
    if (parent === ".") return name;
    return path.posix.join(parent, name);
  };
  const editError = (oldText: string, newText: string): string | null => {
    if (oldText === "") return "The edit needs different old and new text.";
    if (oldText === newText) return "The edit needs different old and new text.";
    return null;
  };
  const replacement = (current: string, oldText: string, newText: string, all: boolean): string => {
    if (all) return current.split(oldText).join(newText);
    return current.replace(oldText, newText);
  };
  const editInputs = (args: Record<string, unknown>, oldKey: string, newKey: string): [string, string] => [
    String(args[oldKey] ?? ""),
    String(args[newKey] ?? ""),
  ];
  const editPlan = (current: string, oldText: string, newText: string, all: boolean): EditPlan => {
    const error = editError(oldText, newText);
    if (error !== null) return { error };
    const occurrences = current.split(oldText).length - 1;
    if (occurrences === 0) return { error: "The old text was not found." };
    if (occurrences > 1) {
      if (!all) return { error: "The old text is not unique." };
    }
    return { next: replacement(current, oldText, newText, all), occurrences };
  };
  const standardRenameDestination = (row: FileRow, value: unknown): string | null => {
    let newName = path.posix.basename(String(value ?? "").trim());
    if (newName === "") return null;
    if (path.extname(newName) === "" && path.extname(row.relative_path) !== "") {
      newName += path.extname(row.relative_path);
    }
    return parentPath(path.posix.dirname(row.relative_path), newName);
  };
  const standardMoveDestination = (row: FileRow, value: unknown): string => {
    const folder = String(value ?? "").trim().replace(/^\/+|\/+$/g, "");
    const name = path.posix.basename(row.relative_path);
    if (folder === "") return name;
    return path.posix.join(folder, name);
  };
  const moveRow = async (row: FileRow, destination: string): Promise<Result> => {
    await room().workspace!.move(row.id, destination, row.content_sha256 ?? undefined);
    return { old_path: `/${row.relative_path}`, path: `/${destination}` };
  };
  const standardCreate: Handler = async (args) => {
    const relative = virtualPath(args.name);
    if (fileExists(relative)) return { error: "A workspace file already exists at that path." };
    await createText(relative, String(args.content ?? ""));
    return { path: `/${relative}`, created: true };
  };
  const standardWrite: Handler = async (args) => {
    const row = fileLike(args.name);
    if (!isText(row)) return { error: "This workspace tool edits text files only." };
    await readText(row);
    if (args.dry_run === true) return { path: `/${row.relative_path}`, occurrences: 1, dry_run: true };
    await saveText(row, String(args.content ?? ""), "AI rewrite");
    return { path: `/${row.relative_path}`, occurrences: 1 };
  };
  const standardEdit: Handler = async (args) => {
    const row = fileLike(args.name);
    if (!isText(row)) return { error: "This workspace tool edits text files only." };
    const [oldText, newText] = editInputs(args, "old_text", "new_text");
    const plan = editPlan(
      await readText(row),
      oldText,
      newText,
      args.all === true,
    );
    if ("error" in plan) return plan;
    if (args.dry_run === true) return { path: `/${row.relative_path}`, occurrences: plan.occurrences, dry_run: true };
    await saveText(row, plan.next, "AI edit");
    return { path: `/${row.relative_path}`, occurrences: plan.occurrences };
  };
  const standardRename: Handler = async (args) => {
    const row = fileLike(args.name);
    const destination = standardRenameDestination(row, args.new_name);
    if (destination === null) return { error: "The new file name is empty." };
    return moveRow(row, destination);
  };
  const standardMove: Handler = async (args) => {
    const row = fileLike(args.name);
    return moveRow(row, standardMoveDestination(row, args.folder));
  };
  const standardTrash: Handler = async (args) => {
    const names = Array.isArray(args.names) ? args.names : [];
    const targets = names.map(fileLike);
    for (const row of targets) {
      await room().workspace!.trash(row.id, row.content_sha256 ?? undefined);
    }
    return { trashed: targets.map((row) => `/${row.relative_path}`) };
  };
  const listEntry = (row: FileRow, prefix: string): Result | null => {
    if (!row.relative_path.startsWith(prefix)) return null;
    const rest = row.relative_path.slice(prefix.length);
    const [first, ...tail] = rest.split("/");
    if (!first) return null;
    const relative = prefix + first;
    if (tail.length > 0) {
      return { path: `/${relative}/`, is_dir: true, size: 0, modified_at: row.created_at };
    }
    return { path: `/${relative}`, is_dir: false, size: row.size_bytes, modified_at: row.created_at };
  };
  const list: Handler = async (args) => {
    const base = virtualPath(args.path, true);
    const prefix = base === "" ? "" : `${base}/`;
    const entries = new Map<string, Result>();
    for (const row of rows()) {
      const entry = listEntry(row, prefix);
      if (entry !== null) entries.set(String(entry.path), entry);
    }
    return { entries: [...entries.values()].sort((a, b) => String(a.path).localeCompare(String(b.path))) };
  };
  const read: Handler = async (args) => {
    const row = file(virtualPath(args.path));
    if (!isText(row)) return { error: "This workspace tool reads text files only." };
    const lines = (await readText(row)).split(/\r?\n/);
    const offset = Math.max(0, Number(args.offset) || 0);
    const limit = Math.max(0, Math.min(2_000, Number(args.limit) || 2_000));
    const end = Math.min(lines.length, offset + limit);
    return {
      file_data: { content: lines.slice(offset, end).join("\n"), encoding: "utf-8", created_at: row.created_at, modified_at: row.created_at },
      total_lines: lines.length,
      start_line: offset + 1,
      end_line: end,
      next_offset: end < lines.length ? end : null,
    };
  };
  const requestedName = (value: unknown): string => typeof value === "string" ? value.trim() : "";
  const safeRename = (value: unknown): string | null => {
    const requested = requestedName(value);
    if (["", ".", ".."].includes(requested)) return null;
    if (requested.includes("/")) return null;
    if (requested.includes("\\")) return null;
    if (requested.toLocaleLowerCase("en-US") === ".arcelle") return null;
    return requested;
  };
  const move: Handler = async (args) => moveRow(
    file(virtualPath(args.source_path)), virtualPath(args.destination_path),
  );
  const rename: Handler = async (args) => {
    const row = file(virtualPath(args.source_path));
    const requested = safeRename(args.new_name);
    if (requested === null) return { error: "The new name must be one safe file name." };
    return moveRow(row, parentPath(path.posix.dirname(row.relative_path), requested));
  };
  const write: Handler = async (args) => {
    const relative = virtualPath(args.path);
    const content = String(args.content ?? "");
    const row = existingForWrite(relative);
    if (row === undefined) await createText(relative, content);
    else await saveText(row, content, "Agent workspace rewrite");
    return { path: `/${relative}` };
  };
  const edit: Handler = async (args) => {
    const relative = virtualPath(args.path);
    const row = file(relative);
    if (!isText(row)) return { error: "This workspace tool edits text files only." };
    const all = args.replace_all === true;
    const [oldText, newText] = editInputs(args, "old_string", "new_string");
    const plan = editPlan(await readText(row), oldText, newText, all);
    if ("error" in plan) return plan;
    await saveText(row, plan.next, "Agent workspace edit");
    return { path: `/${relative}`, occurrences: all ? plan.occurrences : 1 };
  };
  const remove: Handler = async (args) => {
    const relative = virtualPath(args.path);
    const row = file(relative);
    await room().workspace!.trash(row.id, row.content_sha256 ?? undefined);
    return { path: `/${relative}` };
  };
  const globRelative = (row: FileRow, base: string): string | null => {
    if (base === "") return row.relative_path;
    if (row.relative_path === base) return "";
    if (row.relative_path.startsWith(`${base}/`)) return row.relative_path.slice(base.length + 1);
    return null;
  };
  const glob: Handler = async (args) => {
    const base = virtualPath(args.path, true);
    const pattern = String(args.pattern ?? "*");
    const matches: Result[] = [];
    for (const row of rows()) {
      const relative = globRelative(row, base);
      if (relative !== null && path.matchesGlob(relative, pattern)) {
        matches.push({ path: `/${row.relative_path}`, is_dir: false, size: row.size_bytes, modified_at: row.created_at });
      }
    }
    return { matches, truncated: false };
  };
  const isUnderGrepBase = (row: FileRow, base: string): boolean => {
    if (base === "") return true;
    return row.relative_path.startsWith(`${base}/`);
  };
  const grepFile = async (
    row: FileRow, needle: string, maxCount: number, matches: Result[],
  ): Promise<boolean> => {
    for (const [index, line] of (await readText(row)).split(/\r?\n/).entries()) {
      if (line.includes(needle)) matches.push({ path: `/${row.relative_path}`, line: index + 1, text: line });
      if (matches.length >= maxCount) return true;
    }
    return false;
  };
  const grepInputs = (args: Record<string, unknown>): [string, string, number] => [
    virtualPath(args.path, true),
    String(args.pattern ?? ""),
    Math.max(1, Math.min(1_000, Number(args.max_count) || 1_000)),
  ];
  const grep: Handler = async (args) => {
    const [base, needle, maxCount] = grepInputs(args);
    const matches: Result[] = [];
    for (const row of rows()) {
      if (!isText(row)) continue;
      if (!isUnderGrepBase(row, base)) continue;
      if (await grepFile(row, needle, maxCount, matches)) return { matches, truncated: true };
    }
    return { matches, truncated: false };
  };
  const standardHandlers: Record<string, Handler> = {
    standard_create: standardCreate,
    standard_write: standardWrite,
    standard_edit: standardEdit,
    standard_rename: standardRename,
    standard_move: standardMove,
    standard_trash: standardTrash,
    standard_unsupported: async () => ({ error: "This multi-file or structured edit is not available for workspace rooms yet." }),
  };
  const regularHandlers: Record<string, Handler> = { list, read, move, rename, write, edit, delete: remove, glob, grep };
  const writeOperations = new Set(["write", "edit", "delete", "move", "rename"]);
  const dispatchStandard = async (operation: string, args: Record<string, unknown>): Promise<Result> => {
    if (!writeEnabled) return { error: "This workspace bridge is read-only." };
    const handler = standardHandlers[operation];
    if (handler === undefined) return { error: `Unknown workspace operation: ${operation}` };
    return handler(args);
  };
  const dispatchRegular = async (operation: string, args: Record<string, unknown>): Promise<Result> => {
    const handler = regularHandlers[operation];
    if (handler === undefined) return { error: `Unknown workspace operation: ${operation}` };
    if (writeOperations.has(operation) && !writeEnabled) return { error: "This workspace bridge is read-only." };
    return handler(args);
  };
  const dispatch = (operation: string, args: Record<string, unknown>): Promise<Result> =>
    operation.startsWith("standard_") ? dispatchStandard(operation, args) : dispatchRegular(operation, args);

  return {
    async call(operation, args) {
      try {
        return await dispatch(operation, args);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
