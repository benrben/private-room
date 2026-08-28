import { useMemo, useState } from "react";
import "./svg.css";

/**
 * An SVG, with its source one click away.
 *
 * An `.svg` used to be classified by MIME as a raster image, so it opened in
 * the picture viewer: you could zoom it and you could not see or change a
 * single line of the markup that IS the file. The registry now matches it by
 * extension before the image branch, which is what makes this view reachable.
 *
 * The drawing is rendered as an `<img>` from a data URL rather than injected
 * into the page. That is deliberate: an SVG is an untrusted room file and
 * inline SVG can carry `<script>` and external references. Inside an `<img>`
 * the browser refuses to run either.
 */
export default function SvgView({ text }: { text: string }) {
  const [showSource, setShowSource] = useState(false);
  const [dark, setDark] = useState(false);

  const src = useMemo(
    () => `data:image/svg+xml;utf8,${encodeURIComponent(text)}`,
    [text],
  );

  return (
    <div className="svg-view">
      <div className="svg-bar">
        {/* Picture and Source are two readings of one document, so they are
            drawn as the same `.rdr-modes` strip a saved article and a Word
            file already use — not a link labelled by where it takes you. */}
        <span className="rdr-modes" role="group" aria-label="How to read this file">
          <button
            type="button"
            className="rdr-mode"
            aria-pressed={!showSource}
            onClick={() => setShowSource(false)}
          >
            Picture
          </button>
          <button
            type="button"
            className="rdr-mode"
            aria-pressed={showSource}
            onClick={() => setShowSource(true)}
          >
            Source
          </button>
        </span>
        {/* A viewing condition rather than a reading, so it sits at the far
            end with the other actions and keeps its label-by-destination. */}
        {!showSource && (
          <span className="rdr-bar-end">
            <button
              type="button"
              className="subtle"
              title="Most diagrams are drawn in black on nothing — flip the backdrop to see them"
              onClick={() => setDark((d) => !d)}
            >
              {dark ? "Light backdrop" : "Dark backdrop"}
            </button>
          </span>
        )}
      </div>
      {showSource ? (
        <pre className="svg-source">{text}</pre>
      ) : (
        <div className={`svg-stage${dark ? " dark" : ""}`}>
          {/* Not `alt=""`: that says "this image carries no information",
              asserted about the file that IS the document — a screen reader
              landed in an empty main region with only a Source button to
              prove anything was there. The viewer is handed the markup and
              nothing else, so this names the kind of thing and claims
              nothing about the drawing. */}
          <img src={src} alt="SVG drawing" />
        </div>
      )}
    </div>
  );
}
