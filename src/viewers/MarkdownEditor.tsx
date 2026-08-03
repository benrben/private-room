import { useCallback, useRef, useState, type ReactNode } from "react";
import CodeEditor, { type EditorFormatApi } from "./CodeEditor";
import MarkdownView from "./MarkdownView";
import "./markdowneditor.css";

/**
 * A note editor that shows the note.
 *
 * WHAT THIS REPLACED: Edit on a `.md` file swapped the rendered page for a bare
 * monospace Monaco buffer and that was the whole feature. You could not see
 * what you were writing while you wrote it, there was no way to apply so much
 * as bold without knowing the syntax, and — because preview and edit were two
 * states of the same pane — the only way to check a heading had come out right
 * was to leave the editor. Live QA's summary of the whole area was "hard to see
 * what's edit".
 *
 * So: source and result side by side, and a toolbar for the marks people
 * actually use. The preview is the SAME `MarkdownView` the reader uses, not a
 * second renderer that could disagree with it.
 */

type Layout = "split" | "source" | "preview";

interface Props {
  value: string;
  onSave: (value: string) => void | Promise<boolean | void>;
  registerSave?: (save: (() => Promise<boolean>) | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  find?: string;
  banner?: ReactNode;
}

/** The toolbar. `mark` is what the button does to the buffer. */
const TOOLS: {
  label: string;
  tip: string;
  run: (f: EditorFormatApi) => void;
}[] = [
  { label: "B", tip: "Bold", run: (f) => f.wrap("**", "**") },
  { label: "I", tip: "Italic", run: (f) => f.wrap("_", "_") },
  { label: "H1", tip: "Title", run: (f) => f.linePrefix("# ") },
  { label: "H2", tip: "Heading", run: (f) => f.linePrefix("## ") },
  { label: "H3", tip: "Subheading", run: (f) => f.linePrefix("### ") },
  { label: "•", tip: "Bulleted list", run: (f) => f.linePrefix("- ") },
  { label: "1.", tip: "Numbered list", run: (f) => f.linePrefix("1. ") },
  { label: "☐", tip: "Checklist", run: (f) => f.linePrefix("- [ ] ") },
  { label: "❝", tip: "Quote", run: (f) => f.linePrefix("> ") },
  { label: "‹›", tip: "Code", run: (f) => f.wrap("`", "`") },
  { label: "🔗", tip: "Link", run: (f) => f.wrap("[", "](https://)") },
  { label: "—", tip: "Divider", run: (f) => f.insert("\n\n---\n\n") },
  {
    label: "⊞",
    tip: "Table",
    run: (f) =>
      f.insert("\n| Column | Column |\n| --- | --- |\n|  |  |\n|  |  |\n"),
  },
];

export default function MarkdownEditor({
  value,
  onSave,
  registerSave,
  onDirtyChange,
  find,
  banner,
}: Props) {
  const [layout, setLayout] = useState<Layout>("split");
  // The preview follows the buffer, not the saved file — that is the point.
  const [live, setLive] = useState(value);
  const formatRef = useRef<EditorFormatApi | null>(null);

  const registerFormat = useCallback((api: EditorFormatApi | null) => {
    formatRef.current = api;
  }, []);

  return (
    <div className="mde" data-layout={layout}>
      <div className="mde-bar">
        <div className="mde-tools" role="toolbar" aria-label="Formatting">
          {TOOLS.map((t) => (
            <button
              key={t.tip}
              className="mde-tool"
              title={t.tip}
              aria-label={t.tip}
              // The editor keeps the caret: a toolbar button that stole focus
              // would apply its mark to a selection that no longer exists.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => formatRef.current && t.run(formatRef.current)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="mde-layout" role="group" aria-label="Editor layout">
          {(["source", "split", "preview"] as Layout[]).map((l) => (
            <button
              key={l}
              className={`mde-layout-btn${layout === l ? " active" : ""}`}
              aria-pressed={layout === l}
              title={
                l === "source"
                  ? "Just the Markdown"
                  : l === "split"
                    ? "Markdown and the page, side by side"
                    : "Just the page"
              }
              onClick={() => setLayout(l)}
            >
              {l === "source" ? "Source" : l === "split" ? "Split" : "Preview"}
            </button>
          ))}
        </div>
      </div>
      <div className="mde-panes">
        {layout !== "preview" && (
          <div className="mde-source">
            <CodeEditor
              value={value}
              language="markdown"
              onSave={onSave}
              onChange={setLive}
              registerSave={registerSave}
              registerFormat={registerFormat}
              onDirtyChange={onDirtyChange}
              find={find}
              banner={banner}
            />
          </div>
        )}
        {layout !== "source" && (
          <div className="mde-preview">
            {/* Same renderer as the reader — a preview that could disagree
                with the page it is previewing would be worse than none. */}
            <MarkdownView text={live} />
          </div>
        )}
      </div>
    </div>
  );
}
