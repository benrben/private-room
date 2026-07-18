import { useEffect, useRef } from "react";
import monaco from "./monacoSetup";
import { languageForFile } from "./monacoSetup";

/** Idea 11: is this text Hebrew/Arabic-dominant? Monaco renders bidi runs
 * correctly per line but its layout is LTR-only, so the CompareModal offers a
 * "Plain view" that swaps to `dir="auto"` panes for right-to-left documents.
 * Counts strong RTL letters against all letters; ~30% is enough because a
 * mostly-Hebrew doc still has Latin numbers/punctuation. */
export function isRtlDominant(text: string): boolean {
  let rtl = 0;
  let letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const isRtl =
      (c >= 0x0590 && c <= 0x05ff) || (c >= 0x0600 && c <= 0x06ff);
    // Rough "is a letter": RTL blocks above, or ASCII/Latin letters.
    if (isRtl || /[A-Za-zÀ-ɏ]/.test(ch)) {
      letters++;
      if (isRtl) rtl++;
    }
  }
  return letters > 0 && rtl / letters >= 0.3;
}

interface Props {
  original: string;
  modified: string;
  fileName: string;
}

/** A read-only Monaco side-by-side diff of two texts. Modeled on CodeEditor:
 * mount-once, automaticLayout, dispose the editor AND both models on unmount.
 * The diff is computed in Monaco's bundled editor worker (monacoSetup routes
 * unknown labels there), so no CDN/worker fetch happens. */
export default function DiffView({ original, modified, fileName }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const editor = monaco.editor.createDiffEditor(hostRef.current, {
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: true,
      wordWrap: "on",
      minimap: { enabled: false },
      fontSize: 13,
      theme: "vs-dark",
      scrollBeyondLastLine: false,
    });
    const lang = languageForFile(fileName);
    const originalModel = monaco.editor.createModel(original, lang);
    const modifiedModel = monaco.editor.createModel(modified, lang);
    editor.setModel({ original: originalModel, modified: modifiedModel });
    return () => {
      editor.dispose();
      originalModel.dispose();
      modifiedModel.dispose();
    };
    // Keyed by version id in the parent, so mount-once is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="compare-diff-host" ref={hostRef} />;
}
