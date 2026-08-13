import { useCallback, useEffect, useState } from "react";
import { api, type FileMeta } from "../../api";

/**
 * The Sketch area: every drawing in the room, and the button that starts one.
 *
 * Deliberately thin. A sketch is an ordinary room file, so the Library pane on
 * the left already lists them, opening one already mints a tab, and the editor
 * is the file's VIEWER rather than a mode of this page. What is left is the
 * one thing the file list cannot offer — somewhere to start a drawing from,
 * and the reminder that the room's AI can draw one for you.
 */
export default function SketchGallery({
  onOpen,
}: {
  onOpen: (fileId: string) => void;
}) {
  const [sketches, setSketches] = useState<FileMeta[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const files = await api.listFiles();
      setSketches(files.filter((f) => f.name.toLowerCase().endsWith(".sketch")));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSketches([]);
    }
  }, []);

  useEffect(() => {
    void load();
    let stop: (() => void) | undefined;
    void api.onRoomFilesChanged(() => void load()).then((un) => {
      stop = un;
    });
    return () => stop?.();
  }, [load]);

  const start = async () => {
    setBusy(true);
    try {
      const meta = await api.createSketch(newName(sketches ?? []));
      await load();
      onOpen(meta.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sk-gallery">
      <header className="sk-gallery-head">
        <div>
          <h1>Sketches</h1>
          <p>
            Drawings live in this room like any other file — they are versioned, searchable by
            their labels, and the room&rsquo;s AI can draw on them beside you.
          </p>
        </div>
        <button type="button" className="nb-btn nb-btn-primary" onClick={start} disabled={busy}>
          {busy ? "Starting…" : "New sketch"}
        </button>
      </header>

      {error ? (
        <p className="sk-card-meta" role="status">
          {error}
        </p>
      ) : null}

      {sketches === null ? null : sketches.length === 0 ? (
        <div className="sk-empty">
          <p>Nothing sketched yet</p>
          <span>
            Press <strong>New sketch</strong> to start one, or ask the room&rsquo;s AI — &ldquo;draw
            my login flow&rdquo; — and it will.
          </span>
        </div>
      ) : (
        <div className="sk-grid">
          {sketches.map((s) => (
            <button
              key={s.id}
              type="button"
              className="sk-card"
              onClick={() => onOpen(s.id)}
              aria-label={`Open ${s.name}`}
            >
              <span className="sk-card-name">{s.name.replace(/\.sketch$/i, "")}</span>
              <span className="sk-card-meta">{s.aiSummary ?? "a drawing"}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** "Sketch", then "Sketch 2", … — the name the file itself will make unique. */
function newName(existing: FileMeta[]): string {
  const taken = new Set(existing.map((f) => f.name.toLowerCase()));
  if (!taken.has("sketch.sketch")) return "Sketch";
  for (let n = 2; n < 500; n++) {
    if (!taken.has(`sketch ${n}.sketch`)) return `Sketch ${n}`;
  }
  return "Sketch";
}
