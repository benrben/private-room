import { useEffect, useMemo, useState } from "react";
import { Cue, parseCues, shortStamp, toSrt, toVtt } from "./subtitles";
import "./subtitle.css";

interface Props {
  text: string;
  name: string;
  /** Present in edit mode: saves the re-serialized file. */
  /** Resolves false when the write failed. */
  onSave?: (text: string) => Promise<boolean>;
}

/**
 * A subtitle file as a timed transcript.
 *
 * Before this a `.srt` had no viewer: it opened on the plain-text card with a
 * cue number and a timecode between every line of speech. Here the timing is a
 * column you read past, and in edit mode a line can be corrected without
 * anyone hand-editing `00:01:23,456 --> 00:01:25,780` — which is the operation
 * that actually breaks subtitle files.
 */
export default function SubtitleView({ text, name, onSave }: Props) {
  const parsed = useMemo(() => parseCues(text), [text]);
  const [cues, setCues] = useState<Cue[]>(parsed);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // A save elsewhere (the agent, a restore) replaces the file under us.
  useEffect(() => setCues(parsed), [parsed]);

  const dirty = useMemo(
    () => cues.length !== parsed.length || cues.some((c, i) => c.text !== parsed[i]?.text),
    [cues, parsed],
  );

  async function save() {
    if (!onSave) return;
    setSaving(true);
    setError("");
    try {
      // Written back in the dialect it arrived in — silently converting a
      // .vtt to SRT would break whatever player it belongs to.
      await onSave(/\.vtt$/i.test(name) ? toVtt(cues) : toSrt(cues));
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (cues.length === 0) {
    return (
      <div className="empty-hint">
        No subtitle cues could be read from this file. Its source is still
        stored safely — use <strong>Edit</strong> to inspect it.
      </div>
    );
  }

  return (
    <div className="srt-view">
      <div className="srt-bar">
        <span className="viewer-status">
          {cues.length.toLocaleString()} {cues.length === 1 ? "cue" : "cues"} ·{" "}
          {shortStamp(cues[cues.length - 1].endMs)} long
        </span>
        {onSave && (
          <button className="nb-btn" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : dirty ? "Save" : "Saved"}
          </button>
        )}
      </div>
      {error && <div className="gate-error">{error}</div>}
      <ol className="srt-list">
        {cues.map((c, i) => (
          <li key={i} className="srt-cue">
            <span className="srt-time" title={`${shortStamp(c.startMs)} → ${shortStamp(c.endMs)}`}>
              {shortStamp(c.startMs)}
            </span>
            {onSave ? (
              <textarea
                className="srt-text"
                dir="auto"
                rows={Math.max(1, c.text.split("\n").length)}
                value={c.text}
                aria-label={`Cue ${i + 1} at ${shortStamp(c.startMs)}`}
                onChange={(e) =>
                  setCues((prev) =>
                    prev.map((p, j) => (j === i ? { ...p, text: e.target.value } : p)),
                  )
                }
              />
            ) : (
              <span className="srt-text" dir="auto">
                {c.text}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
