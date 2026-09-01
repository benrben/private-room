import { useEffect, useRef } from "react";
import monaco, {
  EDITOR_FONT,
  monacoTheme,
  remeasureWhenFontReady,
  watchMonacoTheme,
} from "./monacoSetup";
import { languageForFile } from "./monacoSetup";

/** Idea 11: is this text Hebrew/Arabic-dominant? Monaco renders bidi runs
 * correctly per line but its layout is LTR-only, so the CompareModal offers a
 * "Plain view" that swaps to `dir="auto"` panes for right-to-left documents.
 * Counts strong RTL letters against all letters; ~30% is enough because a
 * mostly-Hebrew doc still has Latin numbers/punctuation. */
function inRange(codePoint: number, first: number, last: number): boolean {
  return codePoint >= first && codePoint <= last;
}

function isRtlLetter(codePoint: number): boolean {
  return inRange(codePoint, 0x0590, 0x05ff) || inRange(codePoint, 0x0600, 0x06ff);
}

function isCountedLetter(character: string, rtl: boolean): boolean {
  return rtl || /[A-Za-zÀ-ɏ]/.test(character);
}

function rtlLetterCounts(text: string): [rtl: number, letters: number] {
  let rtl = 0;
  let letters = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    const isRtl = isRtlLetter(c);
    // Rough "is a letter": RTL blocks above, or ASCII/Latin letters.
    if (isCountedLetter(ch, isRtl)) {
      letters++;
      if (isRtl) rtl++;
    }
  }
  return [rtl, letters];
}

export function isRtlDominant(text: string): boolean {
  const [rtl, letters] = rtlLetterCounts(text);
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
      fontFamily: EDITOR_FONT,
      fontSize: 13,
      theme: monacoTheme(),
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

  // Follow the app's light/dark switch instead of staying black in light mode.
  useEffect(watchMonacoTheme, []);

  // Same bundled-webfont race as the code editor: monaco measures its glyph
  // box at construction, and IBM Plex Mono can arrive after that. A diff has
  // no scroll position worth preserving, so it only needs the remeasure.
  useEffect(() => {
    void remeasureWhenFontReady();
  }, []);

  return <div className="compare-diff-host" ref={hostRef} />;
}
