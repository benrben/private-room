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

function buildTree(entries: Entry[]): Node {
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
  mediaToken,
  dataB64,
}: {
  mediaToken?: string | null;
  dataB64?: string | null;
}) {
  const { bytes, error: readError, loading } = useFileBytes(mediaToken, dataB64);
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    setError("");
    setEntries(null);
    // The filter runs once per central-directory record and reports the name
    // and the unpacked size before anything is inflated. Returning false for
    // every entry means a multi-gigabyte archive is listed without a single
    // byte of it ever being decompressed into this renderer.
    const listed: Entry[] = [];
    unzip(
      bytes,
      {
        filter: (f) => {
          if (!f.name.endsWith("/")) {
            listed.push({ path: f.name, size: f.originalSize });
          }
          return false;
        },
      },
      (err) => {
        if (!alive) return;
        if (err) {
          setError(`This archive could not be read: ${err.message}`);
          return;
        }
        setEntries(listed);
      },
    );
    return () => {
      alive = false;
    };
  }, [bytes]);

  const tree = useMemo(() => (entries ? buildTree(entries) : null), [entries]);
  const total = useMemo(
    () => (entries ?? []).reduce((sum, e) => sum + e.size, 0),
    [entries],
  );

  if (loading) return <div className="empty-hint">Opening archive…</div>;
  if (readError) return <div className="empty-hint">{readError}</div>;
  if (error) return <div className="empty-hint">{error}</div>;
  if (!tree || !entries) return <div className="empty-hint">Reading archive…</div>;
  if (entries.length === 0) return <div className="empty-hint">This archive is empty.</div>;

  return (
    <div className="zip-view">
      <div className="viewer-status">
        {entries.length.toLocaleString()} {entries.length === 1 ? "file" : "files"} ·{" "}
        {formatSize(total)} unpacked
      </div>
      <div className="zip-tree">
        <Branch node={tree} depth={0} />
      </div>
    </div>
  );
}
