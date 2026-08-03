import { useMemo } from "react";
import MarkdownView from "./MarkdownView";
import "./notebook.css";

/** The subset of nbformat this viewer reads. Everything is optional because
 * real notebooks in the wild omit half of it, and a missing field must degrade
 * to "show what's there" rather than to an error. */
interface RawCell {
  cell_type?: string;
  source?: string | string[];
  execution_count?: number | null;
  outputs?: RawOutput[];
}
interface RawOutput {
  output_type?: string;
  name?: string;
  text?: string | string[];
  data?: Record<string, string | string[]>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

/** nbformat stores multi-line strings as either a string or an array of lines,
 * and both shapes appear inside the same file. */
function joined(v: string | string[] | undefined): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join("");
  return "";
}

/** A rendered output: an image, a table, or text. */
function Output({ out }: { out: RawOutput }) {
  if (out.output_type === "error" || out.ename) {
    const trace = (out.traceback ?? []).join("\n");
    return (
      <pre className="nb-out nb-error">
        {trace || `${out.ename ?? "Error"}: ${out.evalue ?? ""}`}
      </pre>
    );
  }
  const data = out.data ?? {};
  // Prefer the richest representation the viewer can actually show, in the
  // order Jupyter itself prefers them.
  const png = data["image/png"];
  if (typeof png === "string") {
    return <img className="nb-out nb-img" src={`data:image/png;base64,${png}`} alt="" />;
  }
  const jpeg = data["image/jpeg"];
  if (typeof jpeg === "string") {
    return <img className="nb-out nb-img" src={`data:image/jpeg;base64,${jpeg}`} alt="" />;
  }
  const svg = data["image/svg+xml"];
  if (svg !== undefined) {
    // Rendered as an image rather than injected as markup: a notebook is an
    // untrusted file like any other, and inline SVG can carry script.
    const body = joined(svg);
    return (
      <img
        className="nb-out nb-img"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(body)}`}
        alt=""
      />
    );
  }
  const plain = joined(out.text) || joined(data["text/plain"]);
  if (plain) return <pre className="nb-out">{plain}</pre>;
  // HTML output (a pandas table) is deliberately shown as its text
  // representation instead of being rendered — see the SVG note above.
  if (data["text/html"]) {
    return <pre className="nb-out nb-muted">[HTML output — not rendered]</pre>;
  }
  return null;
}

/**
 * A Jupyter notebook, rendered the way JupyterLab renders it.
 *
 * Before this a `.ipynb` had no viewer at all: it is JSON, so it landed in the
 * code editor as a wall of escaped source — `"cell_type": "markdown"` and
 * `\n`-riddled string arrays instead of the analysis someone wrote. In an app
 * that already runs `.py` scripts from the same pane, that was the obvious gap.
 */
export default function NotebookView({ text }: { text: string }) {
  const parsed = useMemo(() => {
    try {
      const nb = JSON.parse(text) as { cells?: RawCell[] };
      return Array.isArray(nb.cells) ? nb.cells : null;
    } catch {
      return null;
    }
  }, [text]);

  if (!parsed) {
    return (
      <div className="empty-hint">
        This notebook could not be read — the file isn't valid notebook JSON.
        Its source is still stored safely; use <strong>Edit</strong> to inspect it.
      </div>
    );
  }
  if (parsed.length === 0) {
    return <div className="empty-hint">This notebook has no cells.</div>;
  }

  return (
    <div className="nb-view">
      {parsed.map((cell, i) => {
        const source = joined(cell.source);
        const kind = cell.cell_type ?? "code";
        if (kind === "markdown") {
          return (
            <div className="nb-cell nb-md" key={i}>
              <MarkdownView text={source} />
            </div>
          );
        }
        if (kind === "raw") {
          return (
            <pre className="nb-cell nb-raw" key={i}>
              {source}
            </pre>
          );
        }
        return (
          <div className="nb-cell nb-code" key={i}>
            <div className="nb-gutter" aria-hidden>
              {cell.execution_count == null ? "[ ]" : `[${cell.execution_count}]`}
            </div>
            <div className="nb-body">
              {source && (
                // Reuse the markdown renderer's highlighter by handing it a
                // fenced block — one code style across the whole app, and no
                // second syntax-highlighting dependency.
                <MarkdownView text={"```python\n" + source + "\n```"} />
              )}
              {(cell.outputs ?? []).map((out, j) => (
                <Output key={j} out={out} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
