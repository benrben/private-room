import { useEffect, useMemo, useRef, useState } from "react";
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
  // The exact bytes this panel last wrote. "Saved" is then a claim about the
  // file in front of you rather than a label the button wears on open — and it
  // lapses on its own when the file changes underneath us, because a write by
  // the agent or a restore is not a save this panel performed.
  const written = useRef<string | null>(null);

  // A save elsewhere (the agent, a restore) replaces the file under us — and
  // takes the edits a failed save was still holding, so its banner ("your
  // edits are still here") stops being true the moment that happens.
  useEffect(() => {
    setCues(parsed);
    setError("");
  }, [parsed]);

  // The LATEST end time, not the last cue's. SRT does not require ascending
  // timecodes, and machine-merged or bilingual files routinely break that
  // order — reading the final block understated the length by minutes.
  const endMs = useMemo(() => cues.reduce((m, c) => Math.max(m, c.endMs), 0), [cues]);

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
      const body = /\.vtt$/i.test(name) ? toVtt(cues) : toSrt(cues);
      const ok = await onSave(body);
      // A refused write resolves false rather than throwing, and the toast it
      // raises can be missed or dismissed — the panel the edits are sitting in
      // has to say so too, next to the Save button that still reads "Save".
      if (ok) {
        written.current = body;
      } else {
        setError("Could not save this subtitle file — your edits are still here.");
      }
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
          {shortStamp(endMs)} long
        </span>
        {onSave && (
          <button className="nb-btn" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? "Saving…" : !dirty && written.current === text ? "Saved" : "Save"}
          </button>
        )}
      </div>
      {error && (
        <div className="gate-error" role="alert">
          {error}
        </div>
      )}
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
