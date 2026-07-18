import { useEffect, useRef } from "react";
import monaco from "./monacoSetup";

interface Props {
  before: string;
  after: string;
  /** True when the backend clipped the preview to its size ceiling. */
  clipped?: boolean;
  language?: string;
}

/** Wave 2 (Idea 6): a read-only Monaco diff of one file's before/after, shown in
 * the approval card. Side-by-side when the card is wide enough (the user's stated
 * preference in Idea 11 — "easier than reading diffs"), inline on a narrow card so
 * it still fits. Models are disposed on unmount. */
export default function DiffPreview({ before, after, clipped, language }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const wide = hostRef.current.clientWidth >= 720;
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      theme: "vs-dark",
      readOnly: true,
      renderSideBySide: wide,
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
    });
    const original = monaco.editor.createModel(before, language);
    const modified = monaco.editor.createModel(after, language);
    editor.setModel({ original, modified });
    return () => {
      editor.dispose();
      original.dispose();
      modified.dispose();
    };
    // Mount-once: the parent keys each card by request id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="diff-preview">
      <div className="diff-preview-host" ref={hostRef} />
      {clipped && (
        <div className="diff-preview-note">
          Preview truncated — the full change is still applied.
        </div>
      )}
    </div>
  );
}
