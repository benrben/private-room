import { useEffect, useMemo, useState } from "react";
import { unzip } from "fflate";
import { formatSize } from "../api";
import { useFileBytes } from "./useFileBytes";
import "./archive.css";

interface Entry {
  path: string;
  size: number;
}

/** A folder node in the rendered tree. */
interface Node {
  name: string;
  children: Map<string, Node>;
  files: Entry[];
}

export function buildTree(entries: Entry[]): Node {
  const root: Node = { name: "", children: new Map(), files: [] };
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    const file = parts.pop();
    if (!file) continue;
    let node = root;
    for (const part of parts) {
      let next = node.children.get(part);
      if (!next) {
        next = { name: part, children: new Map(), files: [] };
        node.children.set(part, next);
      }
      node = next;
    }
    node.files.push({ path: file, size: e.size });
  }
  return root;
}

function Branch({ node, depth }: { node: Node; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const folders = Array.from(node.children.values()).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const files = [...node.files].sort((a, b) => a.path.localeCompare(b.path));
  return (
    <>
      {depth > 0 && (
        <button
          type="button"
          className="zip-row zip-folder"
          style={{ paddingLeft: depth * 14 }}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="zip-caret" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          <span className="zip-name">{node.name}/</span>
        </button>
      )}
      {(open || depth === 0) && (
        <>
          {folders.map((f) => (
            <Branch key={f.name} node={f} depth={depth + 1} />
          ))}
          {files.map((f) => (
            <div
              key={f.path}
              className="zip-row zip-file"
              style={{ paddingLeft: (depth + 1) * 14 }}
            >
              <span className="zip-name">{f.path}</span>
              <span className="zip-size">{formatSize(f.size)}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

type ArchiveListing = {
  setEntries: (entries: Entry[]) => void;
  setError: (message: string) => void;
  stop: () => void;
};

type ArchiveReader = {
  close(): Promise<void>;
  hasEncryptedData(): Promise<boolean | null>;
  getFilesArray(): Promise<Array<{ file?: { name?: string; size?: number }; path?: string }>>;
};

function archiveListing(bytes: Uint8Array, name: string | undefined, setEntries: (entries: Entry[] | null) => void, setError: (message: string) => void): () => void {
  const listing = guardedListing(setEntries, setError);
  setError("");
  setEntries(null);
  const close = isZip(name) ? listZip(bytes, listing) : listOtherArchive(bytes, name, listing);
  return () => {
    listing.stop();
    close();
  };
}

function guardedListing(setEntries: (entries: Entry[] | null) => void, setError: (message: string) => void): ArchiveListing {
  let alive = true;
  return {
    setEntries: (entries) => { if (alive) setEntries(entries); },
    setError: (message) => { if (alive) setError(message); },
    stop: () => { alive = false; },
  };
}

function isZip(name: string | undefined): boolean {
  return (name?.toLocaleLowerCase() ?? "").endsWith(".zip");
}

function listZip(bytes: Uint8Array, listing: ArchiveListing): () => void {
  const entries: Entry[] = [];
  unzip(bytes, { filter: (file) => addZipEntry(entries, file.name, file.originalSize) }, (error) => {
    if (error) return listing.setError(`This archive could not be read: ${error.message}`);
    listing.setEntries(entries);
  });
  return () => {};
}

function addZipEntry(entries: Entry[], name: string, size: number): false {
  if (!name.endsWith("/")) entries.push({ path: name, size });
  return false;
}

function listOtherArchive(bytes: Uint8Array, name: string | undefined, listing: ArchiveListing): () => void {
  let reader: ArchiveReader | null = null;
  void readOtherArchive(bytes, name, listing, (next) => { reader = next; });
  return () => { if (reader) void closeArchiveReader(reader); };
}

async function readOtherArchive(bytes: Uint8Array, name: string | undefined, listing: ArchiveListing, setReader: (reader: ArchiveReader) => void) {
  let reader: ArchiveReader | null = null;
  try {
    const { Archive } = await import("libarchive.js");
    Archive.init({ workerUrl: new URL("./libarchive/worker-bundle.js", window.location.href).toString() });
    const archive = await Archive.open(new File([bytes], name || "archive"));
    reader = archive;
    setReader(archive);
    if (await archive.hasEncryptedData()) throw new Error("This archive is password-protected. Arcelle does not ask for archive passwords.");
    listing.setEntries(archiveEntries(await archive.getFilesArray()));
  } catch (reason) {
    listing.setError(archiveReadError(reason));
  } finally {
    if (reader) await closeArchiveReader(reader);
  }
}

function archiveEntries(files: Array<{ file?: { name?: string; size?: number }; path?: string }>): Entry[] {
  return files.map(({ file, path: folder }) => ({ path: `${folder ?? ""}${file?.name ?? ""}`.replace(/^\/+/, ""), size: Number(file?.size ?? 0) })).filter((entry) => entry.path && !entry.path.endsWith("/"));
}

function archiveReadError(reason: unknown): string {
  if (reason instanceof Error && reason.message.startsWith("This archive")) return reason.message;
  return `This archive could not be read: ${reason instanceof Error ? reason.message : String(reason)}`;
}

async function closeArchiveReader(reader: Pick<ArchiveReader, "close">) {
  await reader.close().catch(() => {});
}

/**
 * What is inside a `.zip`, without unpacking it.
 *
 * An archive used to be the app's most opaque row: no preview, no text, just
 * "No preview available for this file type yet." Reading the central directory
 * costs almost nothing and answers the only question anyone has about a
 * downloaded bundle — what did I actually get?
 *
 * Nothing is extracted to disk. Names come from the directory listing, which
 * is also what the Rust extractor indexes, so a search for a file inside the
 * archive finds the archive.
 */
export default function ArchiveView({
  name,
  mediaToken,
  dataB64,
}: {
  name?: string;
  mediaToken?: string | null;
  dataB64?: string | null;
}) {
  const { bytes, error: readError, loading } = useFileBytes(mediaToken, dataB64);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => bytes ? archiveListing(bytes, name, setEntries, setError) : undefined, [bytes, name]);

  const tree = useMemo(() => (entries ? buildTree(entries) : null), [entries]);
  const total = useMemo(
    () => (entries ?? []).reduce((sum, e) => sum + e.size, 0),
    [entries],
  );

  return archiveContent({ loading, readError, error, tree, entries, total });
}

function archiveContent({
  loading,
  readError,
  error,
  tree,
  entries,
  total,
}: {
  loading: boolean;
  readError: string | null;
  error: string;
  tree: Node | null;
  entries: Entry[] | null;
  total: number;
}) {
  const status = archiveStatus(loading, readError, error);
  if (status) return status;
  const unavailable = archiveUnavailable(tree, entries);
  if (unavailable) return unavailable;
  const listed = entries as Entry[];
  const archiveTree = tree as Node;
  if (listed.length === 0) {
    // A zero-entry result from libarchive is not proof that the container is
    // empty. Several damaged 7z/RAR files return an empty listing instead of
    // an error, and calling those empty sends someone looking for lost files
    // in the wrong direction. State exactly what the reader established, then
    // name the two possibilities it cannot distinguish without extraction.
    return (
      <div className="empty-hint">
        No files could be listed from this archive. It may be empty, damaged,
        or use an archive variant this Mac cannot read. The original is still
        stored unchanged; export it to try a dedicated archive app.
      </div>
    );
  }

  return (
    <div className="zip-view">
      <ArchiveSummary entries={listed} total={total} />
      <div className="zip-tree">
        <Branch node={archiveTree} depth={0} />
      </div>
    </div>
  );
}

function archiveStatus(loading: boolean, readError: string | null, error: string) {
  if (loading) return <div className="empty-hint">Opening archive…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (error) return <div className="empty-hint">{error}</div>;
  return null;
}

function archiveUnavailable(tree: Node | null, entries: Entry[] | null) {
  if (!tree || !entries) return <div className="empty-hint">Reading archive…</div>;
  return null;
}

function ArchiveSummary({ entries, total }: { entries: Entry[]; total: number }) {
  return <div className="viewer-status">{entries.length.toLocaleString()} {entries.length === 1 ? "file" : "files"} · {formatSize(total)} unpacked</div>;
}
