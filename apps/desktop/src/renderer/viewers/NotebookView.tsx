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

/** The fence a code cell has to be wrapped in: one backtick longer than the
 * longest run of backticks the source itself contains (three at minimum).
 *
 * A cell whose source holds a line of ``` — a docstring carrying Markdown, a
 * cell that writes README text, a prompt string — closed the block early with
 * a plain three-backtick fence, and the rest of the cell was then rendered as
 * prose: headings became `<h1>`s, pipe tables became real tables, `*args`
 * became italics. CommonMark closes a fence only on a run at least as long as
 * the one that opened it, so a longer opener puts the whole cell back inside. */
function codeFence(source: string): string {
  const longest = Math.max(
    0,
    ...Array.from(source.matchAll(/`+/g), (m) => m[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/** A rendered output: an image, a table, or text. */
function Output({ out }: { out: RawOutput }) {
  if (out.output_type === "error" || out.ename)
    return <ErrorOutput out={out} />;
  const data = out.data ?? {};
  const image = imageSource(data);
  if (image) return <img className="nb-out nb-img" src={image} alt="" />;
  return <TextOutput data={data} text={out.text} />;
}

function ErrorOutput({ out }: { out: RawOutput }) {
  const trace = (out.traceback ?? []).join("\n");
  return (
    <pre className="nb-out nb-error">
      {trace || `${out.ename ?? "Error"}: ${out.evalue ?? ""}`}
    </pre>
  );
}

function TextOutput({
  data,
  text,
}: {
  data: Record<string, string | string[]>;
  text: RawOutput["text"];
}) {
  const plain = joined(text) || joined(data["text/plain"]);
  if (plain) return <pre className="nb-out">{plain}</pre>;
  // HTML output (a pandas table) is deliberately shown as its text
  // representation instead of being rendered — see the SVG note above.
  if (data["text/html"]) {
    return <pre className="nb-out nb-muted">[HTML output — not rendered]</pre>;
  }
  return null;
}

function imageSource(data: Record<string, string | string[]>): string | null {
  const png = data["image/png"];
  if (typeof png === "string") return `data:image/png;base64,${png}`;
  const jpeg = data["image/jpeg"];
  if (typeof jpeg === "string") return `data:image/jpeg;base64,${jpeg}`;
  const svg = data["image/svg+xml"];
  if (svg !== undefined)
    return `data:image/svg+xml;utf8,${encodeURIComponent(joined(svg))}`;
  return null;
}

function NotebookCell({ cell, index }: { cell: RawCell; index: number }) {
  const source = joined(cell.source);
  if (cell.cell_type === "markdown")
    return (
      <div className="nb-cell nb-md">
        <MarkdownView text={source} />
      </div>
    );
  if (cell.cell_type === "raw")
    return <pre className="nb-cell nb-raw">{source}</pre>;
  return (
    <div className="nb-cell nb-code" key={index}>
      <div className="nb-gutter" aria-hidden>
        {cell.execution_count == null ? "[ ]" : `[${cell.execution_count}]`}
      </div>
      <div className="nb-body">
        <CodeSource source={source} />
        {(cell.outputs ?? []).map((out, outputIndex) => (
          <Output key={outputIndex} out={out} />
        ))}
      </div>
    </div>
  );
}

function CodeSource({ source }: { source: string }) {
  if (!source) return null;
  const fence = codeFence(source);
  return <MarkdownView text={`${fence}python\n${source}\n${fence}`} />;
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
        Its source is still stored safely; use <strong>Edit</strong> to inspect
        it.
      </div>
    );
  }
  if (parsed.length === 0) {
    return <div className="empty-hint">This notebook has no cells.</div>;
  }

  return (
    <div className="nb-view">
      {parsed.map((cell, index) => (
        <NotebookCell key={index} cell={cell} index={index} />
      ))}
    </div>
  );
}
