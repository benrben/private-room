import { useEffect, useState } from "react";
import { api } from "../api";
import "./quicklook.css";

type State =
  | { phase: "loading" }
  | { phase: "ready"; src: string }
  | { phase: "none" }
  | { phase: "error"; message: string };

/**
 * The last resort in the viewer chain: ask macOS to draw the file.
 *
 * QuickLook is the machinery behind pressing space in Finder, so every format
 * with a Quick Look extension on this Mac renders here — `.key`, `.pages`,
 * `.numbers`, legacy `.doc` and `.ppt`, RAW photos, PSD and AI artwork, 3D
 * models. One integration covers a long tail that would otherwise need a
 * parser each, and all of it used to show the same sentence: "No preview
 * available for this file type yet."
 *
 * It is a picture of the file, not the file: no selection, no search, no
 * editing. The caption says so rather than letting the page imply otherwise.
 */
export default function QuickLookView({
  fileId,
  /** Shown above the preview when the app DID manage to read the text. */
  children,
}: {
  fileId: string;
  children?: React.ReactNode;
}) {
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let alive = true;
    setState({ phase: "loading" });
    api
      .quicklookPreview(fileId)
      .then((preview) => {
        if (!alive) return;
        setState(
          preview
            ? { phase: "ready", src: `data:image/png;base64,${preview.pngB64}` }
            : { phase: "none" },
        );
      })
      .catch((e) => {
        if (alive) setState({ phase: "error", message: String(e) });
      });
    return () => {
      alive = false;
    };
  }, [fileId]);

  return (
    <div className="ql-view">
      {children}
      {state.phase === "loading" && (
        <div className="empty-hint">Asking macOS to draw a preview…</div>
      )}
      {state.phase === "ready" && (
        <figure className="ql-figure">
          <img src={state.src} alt="" />
          <figcaption className="viewer-status">
            Drawn by macOS Quick Look — a picture of the file, so text here
            can't be selected or searched. <strong>Export</strong> saves the
            original out unchanged.
          </figcaption>
        </figure>
      )}
      {state.phase === "none" && !children && (
        <div className="empty-hint">
          No preview available for this file type — this Mac has nothing
          installed that can draw it either. Its content is still stored safely
          inside the room, and <strong>Export</strong> saves the original out
          unchanged.
        </div>
      )}
      {state.phase === "error" && !children && (
        <div className="empty-hint">
          The preview couldn't be drawn ({state.message}). The file itself is
          unaffected.
        </div>
      )}
    </div>
  );
}
