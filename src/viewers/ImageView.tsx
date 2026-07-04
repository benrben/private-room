import { useRef, useState } from "react";
import { api, ImageBox } from "../api";
import { BOX_COLORS } from "./util";

interface Props {
  fileId: string;
  name: string;
  mime: string;
  dataB64: string;
}

export default function ImageView({ fileId, name, mime, dataB64 }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [query, setQuery] = useState("");
  const [boxes, setBoxes] = useState<ImageBox[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function locate(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    const img = imgRef.current;
    if (!q || busy || !img) return;
    setBusy(true);
    setStatus("Looking…");
    setBoxes([]);
    try {
      const found = await api.locateInImage(
        fileId,
        q,
        img.naturalWidth,
        img.naturalHeight,
      );
      setBoxes(found);
      setStatus(
        found.length === 0
          ? "The AI could not locate that in this image."
          : `Found ${found.length} match${found.length === 1 ? "" : "es"}.`,
      );
    } catch (err) {
      setStatus(String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="image-view">
      <form className="locate-bar" onSubmit={locate}>
        <input
          placeholder='Ask AI to mark something… e.g. "the red button", "faces", "the total price"'
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="primary" disabled={busy || !query.trim()}>
          {busy ? "…" : "🎯 Find"}
        </button>
        {boxes.length > 0 && (
          <button type="button" className="subtle" onClick={() => setBoxes([])}>
            Clear
          </button>
        )}
      </form>
      {status && <div className="viewer-status">{status}</div>}
      <div className="img-wrap">
        <img ref={imgRef} src={`data:${mime};base64,${dataB64}`} alt={name} />
        {boxes.map((b, i) => {
          const color = BOX_COLORS[i % BOX_COLORS.length];
          return (
            <div
              key={i}
              className="img-box"
              style={{
                left: `${b.x1 * 100}%`,
                top: `${b.y1 * 100}%`,
                width: `${(b.x2 - b.x1) * 100}%`,
                height: `${(b.y2 - b.y1) * 100}%`,
                borderColor: color,
              }}
            >
              <span className="img-box-label" style={{ background: color }}>
                {b.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
