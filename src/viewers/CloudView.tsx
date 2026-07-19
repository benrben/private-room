import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { PrivacyPreview } from "../apiTypes";

/** PRIV-1 — the reader's "blocked version": this file's text exactly as a
 * non-local model receives it, placeholders and all. Seeing the door's output
 * with your own eyes is the trust mechanism — no AI judgment to believe, just
 * text to read. */
export default function CloudView({ fileId }: { fileId: string }) {
  const [preview, setPreview] = useState<PrivacyPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPreview(null);
    setError(null);
    api
      .privacyPreview(fileId)
      .then((p) => {
        if (live) setPreview(p);
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [fileId]);

  /** Split the redacted text on the placeholders present so each shows as a
   * blackout chip. Longest-first so "[Person AB]" never splits on "[Person A]". */
  const parts = useMemo(() => {
    if (!preview) return [];
    const placeholders = [...preview.present].sort((a, b) => b.length - a.length);
    if (placeholders.length === 0) return [{ text: preview.text, mark: false }];
    const escaped = placeholders.map((p) =>
      p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const re = new RegExp(`(${escaped.join("|")})`, "g");
    return preview.text
      .split(re)
      .filter((seg) => seg !== "")
      .map((seg) => ({ text: seg, mark: preview.present.includes(seg) }));
  }, [preview]);

  if (error) {
    return <div className="cloudview-empty">Could not build the cloud view: {error}</div>;
  }
  if (!preview) {
    return <div className="cloudview-empty">Preparing the cloud view…</div>;
  }
  return (
    <div className="cloudview">
      <div className="cloudview-ribbon" role="status">
        {preview.replacements > 0 ? (
          <>
            This is exactly what a cloud model receives —{" "}
            <b>
              {preview.replacements} mention
              {preview.replacements === 1 ? "" : "s"} of{" "}
              {preview.entitiesHidden} private detail
              {preview.entitiesHidden === 1 ? "" : "s"}
            </b>{" "}
            {preview.replacements === 1 ? "stays" : "stay"} on this Mac.
          </>
        ) : (
          <>This is exactly what a cloud model receives — nothing here is marked private.</>
        )}
      </div>
      <pre className="cloudview-text">
        {parts.map((p, i) =>
          p.mark ? (
            <mark key={i} className="cloudview-mark">
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </pre>
    </div>
  );
}
