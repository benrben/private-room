import { type MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cue, parseCues, shortStamp, toSrt, toVtt } from "./subtitles";
import "./subtitle.css";

interface Props {
  text: string;
  name: string;
  /** Present in edit mode: saves the re-serialized file. */
  /** Resolves false when the write failed. */
  onSave?: (text: string) => Promise<boolean>;
}

interface SaveState {
  saving: boolean;
  error: string;
  written: MutableRefObject<string | null>;
  clearError: () => void;
  save: () => Promise<void>;
}

function subtitleEnd(cues: Cue[]): number {
  return cues.reduce((latest, cue) => Math.max(latest, cue.endMs), 0);
}

function cuesChanged(cues: Cue[], parsed: Cue[]): boolean {
  if (cues.length !== parsed.length) return true;
  return cues.some((cue, index) => cue.text !== parsed[index]?.text);
}

function subtitleBody(name: string, cues: Cue[]): string {
  return /\.vtt$/i.test(name) ? toVtt(cues) : toSrt(cues);
}

function useSubtitleSave(cues: Cue[], name: string, onSave: Props["onSave"]): SaveState {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  // The exact bytes this panel last wrote. "Saved" is then a claim about the
  // file in front of you rather than a label the button wears on open — and it
  // lapses on its own when the file changes underneath us, because a write by
  // the agent or a restore is not a save this panel performed.
  const written = useRef<string | null>(null);

  async function save() {
    if (!onSave) return;
    setSaving(true);
    setError("");
    try {
      // Written back in the dialect it arrived in — silently converting a
      // .vtt to SRT would break whatever player it belongs to.
      const body = subtitleBody(name, cues);
      const ok = await onSave(body);
      // A refused write resolves false rather than throwing, and the toast it
      // raises can be missed or dismissed — the panel the edits are sitting in
      // has to say so too, next to the Save button that still reads "Save".
      if (ok) written.current = body;
      else setError("Could not save this subtitle file — your edits are still here.");
    } catch (error) {
      setError(String(error));
    } finally {
      setSaving(false);
    }
  }

  const clearError = useCallback(() => setError(""), []);
  return { saving, error, written, clearError, save };
}

function saveLabel(saving: boolean, dirty: boolean, written: string | null, text: string): string {
  if (saving) return "Saving…";
  return !dirty && written === text ? "Saved" : "Save";
}

function SubtitleStatus({ count, endMs }: { count: number; endMs: number }) {
  return (
    <span className="viewer-status">
      {count.toLocaleString()} {count === 1 ? "cue" : "cues"} · {shortStamp(endMs)} long
    </span>
  );
}

function SaveButton({
  onSave,
  dirty,
  saving,
  written,
  text,
  save,
}: {
  onSave: Props["onSave"];
  dirty: boolean;
  saving: boolean;
  written: string | null;
  text: string;
  save: () => Promise<void>;
}) {
  if (!onSave) return null;
  return (
    <button className="nb-btn" disabled={!dirty || saving} onClick={() => void save()}>
      {saveLabel(saving, dirty, written, text)}
    </button>
  );
}

function SubtitleToolbar({
  count,
  endMs,
  onSave,
  dirty,
  saving,
  written,
  text,
  save,
}: {
  count: number;
  endMs: number;
  onSave: Props["onSave"];
  dirty: boolean;
  saving: boolean;
  written: string | null;
  text: string;
  save: () => Promise<void>;
}) {
  return (
    <div className="srt-bar">
      <SubtitleStatus count={count} endMs={endMs} />
      <SaveButton onSave={onSave} dirty={dirty} saving={saving} written={written} text={text} save={save} />
    </div>
  );
}

function replaceCueText(cues: Cue[], index: number, text: string): Cue[] {
  return cues.map((cue, cueIndex) => (cueIndex === index ? { ...cue, text } : cue));
}

function SubtitleCue({
  cue,
  index,
  editable,
  onCueTextChange,
}: {
  cue: Cue;
  index: number;
  editable: boolean;
  onCueTextChange: (index: number, text: string) => void;
}) {
  const time = shortStamp(cue.startMs);
  return (
    <li className="srt-cue">
      <span className="srt-time" title={`${time} → ${shortStamp(cue.endMs)}`}>
        {time}
      </span>
      {editable ? (
        <textarea
          className="srt-text"
          dir="auto"
          rows={Math.max(1, cue.text.split("\n").length)}
          value={cue.text}
          aria-label={`Cue ${index + 1} at ${time}`}
          onChange={(event) => onCueTextChange(index, event.target.value)}
        />
      ) : (
        <span className="srt-text" dir="auto">
          {cue.text}
        </span>
      )}
    </li>
  );
}

function SubtitleCueList({
  cues,
  editable,
  onCueTextChange,
}: {
  cues: Cue[];
  editable: boolean;
  onCueTextChange: (index: number, text: string) => void;
}) {
  return (
    <ol className="srt-list">
      {cues.map((cue, index) => (
        <SubtitleCue key={index} cue={cue} index={index} editable={editable} onCueTextChange={onCueTextChange} />
      ))}
    </ol>
  );
}

function SaveError({ error }: { error: string }) {
  if (!error) return null;
  return <div className="gate-error" role="alert">{error}</div>;
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
  const { saving, error, written, clearError, save } = useSubtitleSave(cues, name, onSave);

  // A save elsewhere (the agent, a restore) replaces the file under us — and
  // takes the edits a failed save was still holding, so its banner ("your
  // edits are still here") stops being true the moment that happens.
  useEffect(() => {
    setCues(parsed);
    clearError();
  }, [parsed, clearError]);

  // The LATEST end time, not the last cue's. SRT does not require ascending
  // timecodes, and machine-merged or bilingual files routinely break that
  // order — reading the final block understated the length by minutes.
  const endMs = useMemo(() => subtitleEnd(cues), [cues]);

  const dirty = useMemo(
    () => cuesChanged(cues, parsed),
    [cues, parsed],
  );

  const updateCueText = (index: number, cueText: string) => {
    setCues((current) => replaceCueText(current, index, cueText));
  };

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
      <SubtitleToolbar
        count={cues.length}
        endMs={endMs}
        onSave={onSave}
        dirty={dirty}
        saving={saving}
        written={written.current}
        text={text}
        save={save}
      />
      <SaveError error={error} />
      <SubtitleCueList cues={cues} editable={Boolean(onSave)} onCueTextChange={updateCueText} />
    </div>
  );
}
