import { useEffect, useState } from "react";
import { api, type CastMember, type CreateModel, type ShotPlan } from "../../api";
import { DocumentPicker } from "./DocumentPicker";
import { clock } from "./clock";
import { legalSeconds } from "./selectors";
import { RenderPart, RenderWhen, WithValue, effectiveShotSeconds, missingSplitModels, useScriptPlan } from "./StoryTab";

export function HeroFace({
  fileId,
  thumbs,
}: {
  fileId: string;
  thumbs: Record<string, string> | null;
}) {
  if (!thumbs) return <span className="cr-hero-noface" aria-hidden />;
  const thumb = thumbs[fileId];
  if (!thumb) {
    // Not a flat "it is still sent": a DELETED picture is missing from the
    // newest 150 too, and this square cannot tell that from an old import.
    return (
      <span
        className="cr-hero-noface"
        title="Their picture isn’t among the newest 150 pictures in this room, so it can’t be shown here. If it is still in the room it is still the face sent with every shot they appear in."
      >
        <span>picture not shown</span>
      </span>
    );
  }
  return <img src={`data:image/jpeg;base64,${thumb}`} alt="" />;
}

export function HeroForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: CastMember;
  onSave: (name: string, description: string, story: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [story, setStory] = useState(initial?.story ?? "");

  return (
    <div className="cr-hero-form">
      <label className="cr-field-label" htmlFor="hero-name">
        Name
      </label>
      <input
        id="hero-name"
        className="cr-field"
        value={name}
        placeholder="Mira"
        onChange={(e) => setName(e.target.value)}
      />

      <label className="cr-field-label" htmlFor="hero-desc">
        What they look like
      </label>
      <textarea
        id="hero-desc"
        className="cr-field"
        rows={2}
        value={description}
        placeholder="tall, grey wool coat, hair cut short, a burn scar on the left hand"
        onChange={(e) => setDescription(e.target.value)}
      />
      <p className="cr-hint">Goes into every prompt they appear in.</p>

      <label className="cr-field-label" htmlFor="hero-story">
        Their story
      </label>
      <textarea
        id="hero-story"
        className="cr-field"
        rows={3}
        value={story}
        placeholder="Lost her ship in the winter. Come back to the harbour to find out who sold it."
        onChange={(e) => setStory(e.target.value)}
      />
      <p className="cr-hint">
        Yours to keep — this stays in the room and is not sent to any model.
      </p>

      <div className="cr-form-acts">
        <button type="button" className="nb-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="nb-btn nb-btn-primary"
          disabled={!name.trim()}
          onClick={() => onSave(name.trim(), description.trim(), story.trim())}
        >
          {initial ? "Save" : "Add them"}
        </button>
      </div>
    </div>
  );
}

/** Paste an episode, get shots.
 *
 * The reason this exists: no model in the catalogue will make more than 20
 * seconds of video, and most stop at 15. A five-minute episode is therefore
 * twenty generations whether anyone likes it or not, and typing twenty shot
 * lines by hand to describe a script you have already written is busywork the
 * room should do.
 *
 * The split runs locally, in Rust, with no model involved — so it is instant,
 * costs nothing, never leaves this Mac, and cannot quietly drop a sentence it
 * judged unimportant. The preview is shown before anything is written because
 * turning one paste into twenty rows is a large edit to perform unseen. */
export function ScriptSplitter({
  busy,
  imageModels,
  videoModels,
  handoff,
  onHandoffUsed,
  onApply,
}: {
  busy: boolean;
  imageModels: CreateModel[];
  videoModels: CreateModel[];
  handoff: string | null;
  onHandoffUsed?: () => void;
  onApply: (plan: ShotPlan, imageModel: string, videoModel: string) => void;
}) {
  // Seeded from the handoff and opened on arrival: the bench has just told the
  // user this text is 21 parts and offered to bring it here, so landing on a
  // closed panel with an empty box would undo the whole gesture.
  const [open, setOpen] = useState(!!handoff);
  const [script, setScript] = useState(handoff ?? "");
  useEffect(() => {
    if (handoff) onHandoffUsed?.();
    // Once, for the value this component mounted with — re-running on every
    // change would fight the user's own typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [minutes, setMinutes] = useState(5);
  const [videoModel, setVideoModel] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [pickingScript, setPickingScript] = useState(false);
  /** The file the text came from, so the panel can say where it is from —
   *  cleared the moment it is edited, because it is then no longer that. */
  const [fromFile, setFromFile] = useState("");

  const chosen = videoModels.find((m) => m.model === videoModel) ?? null;
  const lengths = legalSeconds(chosen);
  // The LONGEST the model will make, because that is the fewest generations —
  // and every generation is a separate charge. Twenty 15-second clips beat
  // thirty-eight 8-second ones for the same five minutes.
  const [secondsEach, setSecondsEach] = useState(15);
  const effective = effectiveShotSeconds(lengths, secondsEach);
  const missingModels = missingSplitModels(imageModel, videoModel);
  const { plan, error, setError } = useScriptPlan(script, minutes, effective);

  if (!open) {
    return (
      <button
        type="button"
        className="nb-btn cr-split-open"
        onClick={() => setOpen(true)}
        disabled={busy}
      >
        Break a script into shots…
      </button>
    );
  }

  return (
    <RenderWhen when={open}>
      {() => (
        <div className="cr-split">
          <div className="cr-sec-head">
            <span className="nb-subtitle">break a script into shots</span>
            <button
              type="button"
              className="cr-pick-x"
              onClick={() => setOpen(false)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>

          <p className="cr-hint">
            No model will film more than 20 seconds at once, so an episode is
            many shots. Paste the whole thing — the split happens on this Mac,
            and every word you paste ends up in one shot or another. If your
            script already marks its own chunks (<code>**00:00–00:15**</code>),
            those are used exactly as written.
          </p>

          {/* The room is holding the script already. Asking for it to be pasted
          in is asking for a copy to be done by hand. */}
          <RenderPart>
            {() => (
              <>
                <div className="cr-from-file">
                  <button
                    type="button"
                    className="nb-btn"
                    disabled={busy}
                    onClick={() => setPickingScript(true)}
                  >
                    Use a file from this room
                  </button>
                  {fromFile && (
                    <span className="cr-hint">
                      Read from <b>{fromFile}</b> — every word of it, not a
                      preview.
                    </span>
                  )}
                </div>

                <textarea
                  className="cr-field"
                  rows={6}
                  value={script}
                  placeholder="…or paste the whole script here"
                  aria-label="The script"
                  onChange={(e) => {
                    setScript(e.target.value);
                    // Edited by hand, so it is no longer "what that file says".
                    if (fromFile) setFromFile("");
                  }}
                />

                <DocumentPicker
                  open={pickingScript}
                  title="Which file is the script?"
                  hint="Any file in this room with text in it. The whole thing is read — the split happens here, on this Mac."
                  onClose={() => setPickingScript(false)}
                  onPick={(doc) => {
                    void api
                      .storyTextFromFile(doc.fileId)
                      .then((text) => {
                        setScript(text);
                        setFromFile(doc.name);
                        setError("");
                      })
                      .catch((e) => setError(String(e)));
                  }}
                />
              </>
            )}
          </RenderPart>

          <RenderPart>
            {() => (
              <div className="cr-split-knobs">
                {/* Hidden when the script has already said where its shots begin and
            how long they run — asking for a runtime we are about to ignore
            would be a control that does nothing. */}
                {!plan?.fromScript && (
                  <label className="cr-knob">
                    <span>How long, in minutes</span>
                    <input
                      type="number"
                      className="cr-field"
                      min={0.25}
                      max={20}
                      step={0.25}
                      value={minutes}
                      onChange={(e) => {
                        // Blank is not "zero minutes" — it is half-typed. Treating it
                        // as zero produced ONE 15-second shot for a five-minute
                        // script, which is exactly how this went wrong.
                        const next = Number(e.target.value);
                        setMinutes(
                          Number.isFinite(next) && next > 0 ? next : 0,
                        );
                      }}
                    />
                    {minutes <= 0 && (
                      <span className="cr-hint">
                        Say how long it should run.
                      </span>
                    )}
                  </label>
                )}

                <label className="cr-knob">
                  <span>Clip model</span>
                  <select
                    className="cr-field cr-select"
                    value={videoModel}
                    onChange={(e) => setVideoModel(e.target.value)}
                  >
                    <option value="">— pick —</option>
                    {videoModels.map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.slug}
                      </option>
                    ))}
                  </select>
                </label>

                {!plan?.fromScript && (
                  <label className="cr-knob">
                    <span>Seconds each</span>
                    <select
                      className="cr-field cr-select"
                      value={effective}
                      disabled={lengths.length === 0}
                      onChange={(e) => setSecondsEach(Number(e.target.value))}
                    >
                      {lengths.length === 0 ? (
                        <option value={secondsEach}>{secondsEach}s</option>
                      ) : (
                        lengths.map((v) => (
                          <option key={v} value={v}>
                            {v}s
                          </option>
                        ))
                      )}
                    </select>
                  </label>
                )}

                <label className="cr-knob">
                  <span>Picture model</span>
                  <select
                    className="cr-field cr-select"
                    value={imageModel}
                    onChange={(e) => setImageModel(e.target.value)}
                  >
                    <option value="">— pick —</option>
                    {imageModels.map((m) => (
                      <option key={m.model} value={m.model}>
                        {m.slug}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </RenderPart>

          <RenderPart>
            {() => (
              <>
                {chosen && lengths.length > 0 && (
                  <p className="cr-hint">
                    {chosen.slug} films up to {Math.max(...lengths)}s at a time.
                    {!chosen.limits?.frameImages?.includes("last_frame") && (
                      <>
                        {" "}
                        It cannot take an ending picture, so these shots will
                        not join.
                      </>
                    )}
                  </p>
                )}

                {error && <div className="cr-note cr-note-bad">{error}</div>}
              </>
            )}
          </RenderPart>

          <WithValue value={plan}>
            {(plan) => (
              <>
                {/* The arithmetic said plainly, because it is the whole decision:
              how many paid generations this is about to become. */}
                <div className="cr-split-sum">
                  <b>{plan.parts}</b> shots · <b>{clock(plan.totalSeconds)}</b>
                  <span className="cr-hint">
                    {" "}
                    — {plan.parts} pictures and {plan.parts} clips to pay for.
                  </span>
                  {plan.fromScript && (
                    <div className="cr-hint">
                      Using your script’s own chunks and their timings — nothing
                      was re-cut.
                    </div>
                  )}
                </div>

                <ol className="cr-split-preview">
                  {plan.shots.map((shot, i) => (
                    <li key={i}>
                      <span className="cr-shot-n">{i + 1}</span>
                      <span>
                        {shot.action || (
                          <em>(nothing here — you can fill it in after)</em>
                        )}
                      </span>
                      <span className="nb-num cr-dim">{shot.seconds}s</span>
                    </li>
                  ))}
                </ol>

                {/* Both models are written onto every shot this makes, and a pass
              refuses a shot whose model is empty ("no picture model chosen" /
              "no clip model chosen") — after the shots are already in the
              list. Said before the click, naming which pass would not run.
              With ONE of the two chosen the shots are still worth adding: the
              other pass is a per-shot select away, and the row editor lets a
              shot sit with either half unset. Only "neither" is stopped. */}
                <RenderPart>
                  {() => (
                    <>
                      {missingModels.length > 0 && (
                        <p className="cr-hint">
                          {missingModels.length === 2 ? (
                            <>
                              Pick a picture model and a clip model above first
                              — every shot this adds carries them, and one added
                              with neither is a shot neither pass will make.
                            </>
                          ) : (
                            <>
                              No {missingModels[0]} is chosen, so every shot
                              this adds will be skipped by{" "}
                              {imageModel ? "“Film them”" : "“Draw the frames”"}{" "}
                              until one is set — here, or on the shots
                              themselves.
                            </>
                          )}
                        </p>
                      )}
                    </>
                  )}
                </RenderPart>

                <div className="cr-form-acts">
                  <button
                    type="button"
                    className="nb-btn"
                    onClick={() => setOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="nb-btn nb-btn-primary"
                    disabled={
                      busy || plan.parts === 0 || missingModels.length === 2
                    }
                    onClick={() => {
                      onApply(plan, imageModel, videoModel);
                      setOpen(false);
                      setScript("");
                    }}
                  >
                    Add {plan.parts} shots
                  </button>
                </div>
                <p className="cr-hint">
                  These are added to the end of the list — nothing already here
                  is replaced, so pictures you have already paid for stay.
                </p>
              </>
            )}
          </WithValue>
        </div>
      )}
    </RenderWhen>
  );
}

/* ------------------------------------------------------------- shot list */
