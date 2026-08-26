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

  return {
    async call(operation, args) {
      try {
        if (operation.startsWith("standard_") && !writeEnabled) {
          return { error: "This workspace bridge is read-only." };
        }

        if (operation === "standard_create") {
          const relative = virtualPath(args.name);
          try {
            file(relative);
            return { error: "A workspace file already exists at that path." };
          } catch (error) {
            if (error instanceof Error && error.message !== "Workspace file not found.") throw error;
          }
          const content = String(args.content ?? "");
          const created = await room().workspace!.createFile(
            relative,
            Readable.from([Buffer.from(content)]),
            "agent",
          );
          setFileExtractedText(room().conn, created.fileId, content);
          return { path: `/${relative}`, created: true };
        }

        if (operation === "standard_write" || operation === "standard_edit") {
          const row = fileLike(args.name);
          if (!isText(row)) return { error: "This workspace tool edits text files only." };
          const current = (await readAll(room().workspace!.readStream(row.id))).toString("utf8");
          let next: string;
          let occurrences = 1;
          if (operation === "standard_write") {
            next = String(args.content ?? "");
          } else {
            const oldText = String(args.old_text ?? "");
            const newText = String(args.new_text ?? "");
            if (oldText === "" || oldText === newText) return { error: "The edit needs different old and new text." };
            occurrences = current.split(oldText).length - 1;
            if (occurrences === 0) return { error: "The old text was not found." };
            if (occurrences > 1 && args.all !== true) return { error: "The old text is not unique." };
            next = args.all === true ? current.split(oldText).join(newText) : current.replace(oldText, newText);
          }
          if (args.dry_run === true) return { path: `/${row.relative_path}`, occurrences, dry_run: true };
          await room().workspace!.writeAtomic(
            row.id,
            Readable.from([Buffer.from(next)]),
            row.content_sha256 ?? undefined,
          );
          setFileExtractedText(room().conn, row.id, next);
          return { path: `/${row.relative_path}`, occurrences };
        }

        if (operation === "standard_rename" || operation === "standard_move") {
          const row = fileLike(args.name);
          const parent = path.posix.dirname(row.relative_path);
          let destination: string;
          if (operation === "standard_rename") {
            let newName = path.posix.basename(String(args.new_name ?? "").trim());
            if (newName === "") return { error: "The new file name is empty." };
            if (path.extname(newName) === "" && path.extname(row.relative_path) !== "") {
              newName += path.extname(row.relative_path);
            }
            destination = parent === "." ? newName : path.posix.join(parent, newName);
          } else {
            const folder = String(args.folder ?? "").trim().replace(/^\/+|\/+$/g, "");
            destination = folder === "" ? path.posix.basename(row.relative_path) : path.posix.join(folder, path.posix.basename(row.relative_path));
          }
          await room().workspace!.move(row.id, destination, row.content_sha256 ?? undefined);
          return { old_path: `/${row.relative_path}`, path: `/${destination}` };
        }

        if (operation === "standard_trash") {
          const names = Array.isArray(args.names) ? args.names : [];
          const targets = names.map(fileLike);
          for (const row of targets) {
            await room().workspace!.trash(row.id, row.content_sha256 ?? undefined);
          }
          return { trashed: targets.map((row) => `/${row.relative_path}`) };
        }

        if (operation === "standard_unsupported") {
          return { error: "This multi-file or structured edit is not available for workspace rooms yet." };
        }

        if (operation === "list") {
          const base = virtualPath(args.path, true);
          const prefix = base === "" ? "" : `${base}/`;
          const entries = new Map<string, { path: string; is_dir: boolean; size: number; modified_at: string }>();
          for (const row of rows()) {
            if (!row.relative_path.startsWith(prefix)) continue;
            const rest = row.relative_path.slice(prefix.length);
            const [first, ...tail] = rest.split("/");
            if (!first) continue;
            const relative = prefix + first;
            const displayed = `/${relative}${tail.length > 0 ? "/" : ""}`;
            entries.set(displayed, {
              path: displayed,
              is_dir: tail.length > 0,
              size: tail.length > 0 ? 0 : row.size_bytes,
              modified_at: row.created_at,
            });
          }
          return { entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
        }

        if (operation === "read") {
          const relative = virtualPath(args.path);
          const row = file(relative);
          if (!isText(row)) return { error: "This workspace tool reads text files only." };
          const text = (await readAll(room().workspace!.readStream(row.id))).toString("utf8");
          const lines = text.split(/\r?\n/);
          const offset = Math.max(0, Number(args.offset) || 0);
          const limit = Math.max(0, Math.min(2_000, Number(args.limit) || 2_000));
          const end = Math.min(lines.length, offset + limit);
          return {
            file_data: {
              content: lines.slice(offset, end).join("\n"),
              encoding: "utf-8",
              created_at: row.created_at,
              modified_at: row.created_at,
            },
            total_lines: lines.length,
            start_line: offset + 1,
            end_line: end,
            next_offset: end < lines.length ? end : null,
          };
        }

        if (["write", "edit", "delete"].includes(operation) && !writeEnabled) {
          return { error: "This workspace bridge is read-only." };
        }

        if (operation === "write") {
          const relative = virtualPath(args.path);
          const content = String(args.content ?? "");
          let row: FileRow | undefined;
          try { row = file(relative); } catch { row = undefined; }
          if (row === undefined) {
            const created = await room().workspace!.createFile(
              relative,
              Readable.from([Buffer.from(content)]),
              "agent",
            );
            setFileExtractedText(room().conn, created.fileId, content);
          } else {
            await room().workspace!.writeAtomic(
              row.id,
              Readable.from([Buffer.from(content)]),
              row.content_sha256 ?? undefined,
            );
            setFileExtractedText(room().conn, row.id, content);
          }
          return { path: `/${relative}` };
        }

        if (operation === "edit") {
          const relative = virtualPath(args.path);
          const row = file(relative);
          if (!isText(row)) return { error: "This workspace tool edits text files only." };
          const current = (await readAll(room().workspace!.readStream(row.id))).toString("utf8");
          const oldText = String(args.old_string ?? "");
          const newText = String(args.new_string ?? "");
          if (oldText === "" || oldText === newText) return { error: "The edit needs different old and new text." };
          const occurrences = current.split(oldText).length - 1;
          if (occurrences === 0) return { error: "The old text was not found." };
          if (occurrences > 1 && args.replace_all !== true) return { error: "The old text is not unique." };
          const next = args.replace_all === true ? current.split(oldText).join(newText) : current.replace(oldText, newText);
          await room().workspace!.writeAtomic(
            row.id,
            Readable.from([Buffer.from(next)]),
            row.content_sha256 ?? undefined,
          );
          setFileExtractedText(room().conn, row.id, next);
          return { path: `/${relative}`, occurrences: args.replace_all === true ? occurrences : 1 };
        }

        if (operation === "delete") {
          const relative = virtualPath(args.path);
          const row = file(relative);
          await room().workspace!.trash(row.id, row.content_sha256 ?? undefined);
          return { path: `/${relative}` };
        }

        if (operation === "glob") {
          const base = virtualPath(args.path, true);
          const pattern = String(args.pattern ?? "*");
          const matches = rows()
            .filter((row) => base === "" || row.relative_path === base || row.relative_path.startsWith(`${base}/`))
            .filter((row) => path.matchesGlob(row.relative_path.slice(base === "" ? 0 : base.length + 1), pattern))
            .map((row) => ({ path: `/${row.relative_path}`, is_dir: false, size: row.size_bytes, modified_at: row.created_at }));
          return { matches, truncated: false };
        }

        if (operation === "grep") {
          const base = virtualPath(args.path, true);
          const needle = String(args.pattern ?? "");
          const maxCount = Math.max(1, Math.min(1_000, Number(args.max_count) || 1_000));
          const matches: Array<{ path: string; line: number; text: string }> = [];
          for (const row of rows()) {
            if (!isText(row) || (base !== "" && !row.relative_path.startsWith(`${base}/`))) continue;
            const text = (await readAll(room().workspace!.readStream(row.id))).toString("utf8");
            for (const [index, line] of text.split(/\r?\n/).entries()) {
              if (line.includes(needle)) matches.push({ path: `/${row.relative_path}`, line: index + 1, text: line });
              if (matches.length >= maxCount) return { matches, truncated: true };
            }
          }
          return { matches, truncated: false };
        }

        return { error: `Unknown workspace operation: ${operation}` };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
