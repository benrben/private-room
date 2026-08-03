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
        <button type="button" className="subtle" onClick={() => setShowSource((s) => !s)}>
          {showSource ? "Picture" : "Source"}
        </button>
        {!showSource && (
          <button
            type="button"
            className="subtle"
            title="Most diagrams are drawn in black on nothing — flip the backdrop to see them"
            onClick={() => setDark((d) => !d)}
          >
            {dark ? "Light backdrop" : "Dark backdrop"}
          </button>
        )}
      </div>
      {showSource ? (
        <pre className="svg-source">{text}</pre>
      ) : (
        <div className={`svg-stage${dark ? " dark" : ""}`}>
          <img src={src} alt="" />
        </div>
      )}
    </div>
  );
}
