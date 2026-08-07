import { useMemo, useState } from "react";
import "./json.css";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** How many children a node shows before it is collapsed by default. A 40,000
 * entry array must not expand into 40,000 DOM rows because someone clicked it. */
const AUTO_EXPAND_DEPTH = 2;
const PAGE = 200;

function typeOf(v: Json): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function summary(v: Json): string {
  if (Array.isArray(v)) return `[] ${v.length} ${v.length === 1 ? "item" : "items"}`;
  if (v && typeof v === "object") {
    const n = Object.keys(v).length;
    return `{} ${n} ${n === 1 ? "key" : "keys"}`;
  }
  return "";
}

function Leaf({ value }: { value: Json }) {
  const t = typeOf(value);
  const shown = t === "string" ? `"${value as string}"` : String(value);
  return <span className={`json-leaf json-${t}`}>{shown}</span>;
}

function Node({
  name,
  value,
  depth,
}: {
  name: string | null;
  value: Json;
  depth: number;
}) {
  const branch = value !== null && typeof value === "object";
  const [open, setOpen] = useState(depth < AUTO_EXPAND_DEPTH);
  const [shown, setShown] = useState(PAGE);

  if (!branch) {
    return (
      <div className="json-row" style={{ paddingLeft: depth * 14 }}>
        {name !== null && <span className="json-key">{name}</span>}
        <Leaf value={value} />
      </div>
    );
  }

  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value);
  const visible = entries.slice(0, shown);

  return (
    <div className="json-branch">
      <button
        type="button"
        className="json-row json-toggle"
        style={{ paddingLeft: depth * 14 }}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="json-caret" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        {name !== null && <span className="json-key">{name}</span>}
        <span className="json-summary">{summary(value)}</span>
      </button>
      {open && (
        <>
          {visible.map(([k, v]) => (
            <Node key={k} name={k} value={v} depth={depth + 1} />
          ))}
          {/* Never a silent cut: say how many are hidden and offer the rest.
              Drawn as a real outlined control, not as a coloured link — it is
              the only thing standing between the reader and the rest of the
              data, and a link-coloured sentence reads as a footnote. */}
          {entries.length > shown && (
            <button
              type="button"
              className="json-more nb-btn"
              style={{ marginLeft: (depth + 1) * 14 }}
              onClick={() => setShown((n) => n + PAGE * 5)}
            >
              Show more — {(entries.length - shown).toLocaleString()} of{" "}
              {entries.length.toLocaleString()} still hidden
            </button>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Structured JSON, as a collapsible tree.
 *
 * A `.json` file used to open in the code editor, which is the right tool for
 * a config file and the wrong one for a 5 MB API dump — the shape of the data
 * is the thing you need, and it is exactly what a wall of source hides.
 * JSON Lines (`.jsonl` / `.ndjson`) is read as one record per line.
 */
export default function JsonView({ text, name }: { text: string; name: string }) {
  const lines = /\.(jsonl|ndjson)$/i.test(name);
  const [raw, setRaw] = useState(false);

  const parsed = useMemo(() => {
    try {
      if (!lines) return { ok: true as const, value: JSON.parse(text) as Json };
      const records = text
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Json);
      return { ok: true as const, value: records as Json };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [text, lines]);

  if (!parsed.ok) {
    return (
      <div className="json-view">
        <div className="viewer-status">
          This file isn't valid JSON ({parsed.error}) — showing its source instead.
        </div>
        {/* The source is code, so it gets a drawn frame rather than sitting
            loose in the pane: this is a quotation of the file, not the app's
            own prose. */}
        <pre className="json-raw nb-frame-soft">{text}</pre>
      </div>
    );
  }

  return (
    <div className="json-view">
      {/* The file's header: what this data IS, before the toggle that changes
          how it is drawn. `summary` is the same shape line every branch row in
          the tree carries, so the header and the tree agree word for word. */}
      <div className="json-bar">
        <span className="json-summary">{summary(parsed.value)}</span>
        {lines && <span className="viewer-status">JSON Lines — one record per line</span>}
        {/* One outlined control instead of a flat link. The label is the
            destination — "Raw" takes you to the source — which is why it is a
            button and not an aria-pressed toggle. */}
        <button
          type="button"
          className="nb-btn"
          style={{ marginLeft: "auto" }}
          title={raw ? "Show the structure as a collapsible tree" : "Show the file's own source"}
          onClick={() => setRaw((r) => !r)}
        >
          {raw ? "Tree" : "Raw"}
        </button>
      </div>
      {raw ? (
        <pre className="json-raw nb-frame-soft">{text}</pre>
      ) : (
        <div className="json-tree">
          <Node name={null} value={parsed.value} depth={0} />
        </div>
      )}
    </div>
  );
}
