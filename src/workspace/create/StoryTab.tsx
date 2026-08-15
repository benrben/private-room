import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type CastMember,
  type CreateModel,
  type RoomPicture,
  type CastFromFile,
  type ParsedMember,
  type ShotPlan,
  type StoryBoard,
  type StoryList,
  type StoryShot,
} from "../../api";
import { CheckIcon, CreateIcon, LockIcon } from "../../icons";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { PicturePicker } from "./PicturePicker";
import { DocumentPicker } from "./DocumentPicker";
import { FilmReview } from "./FilmReview";
import { clock } from "./clock";
import { legalSeconds, sharedValues, takesFirstFrame } from "./selectors";

export { clock };

/** The Story tab: a cast, a shot list, and the two passes that turn one into
 * the other.
 *
 * The idea the whole tab is built around: **a character is a picture, not a
 * description.** Asking a model twice for "a woman in a grey coat" produces
 * two different women — words are re-imagined on every call. Handing it the
 * same portrait twice produces the same woman. So the cast strip is a row of
 * FACES, and every shot those people appear in sends their portraits along.
 *
 * The two passes are separate on purpose, and both are billed:
 *
 *   1. **Draw the frames** — one still per shot, with the cast attached.
 *   2. **Film them** — each still becomes the literal first frame of a clip.
 *
 * Keeping the still means a re-film (longer, a different model, different
 * motion) never pays to draw the frame again. */
export function StoryTab({
  s,
  a,
  models,
  handoff,
  onHandoffUsed,
}: {
  s: WSState;
  a: WSActions;
  models: CreateModel[];
  /** A script carried over from the bench, so "take it to Story" does not mean
   *  "paste it again". Consumed once, then cleared. */
  handoff?: string | null;
  onHandoffUsed?: () => void;
}) {
  const [board, setBoard] = useState<StoryBoard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    async (listId?: string | null) => {
      try {
        setBoard(await api.storyBoard(listId ?? board?.selected ?? null));
        setError("");
      } catch (e) {
        setError(String(e));
      }
    },
    [board?.selected],
  );

  useEffect(() => {
    void load(null);
    // Once, on open. Every mutation below reloads explicitly, which keeps the
    // refresh where the change is rather than in a dependency chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const imageModels = useMemo(() => models.filter((m) => m.image), [models]);
  const videoModels = useMemo(() => models.filter((m) => m.video), [models]);

  async function run<T>(work: () => Promise<T>) {
    setBusy(true);
    try {
      await work();
      await load();
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  async function makeAll(kind: "image" | "video", continuous = true) {
    if (!board?.selected) return;
    setBusy(true);
    try {
      const run = await api.startShotListJob(board.selected, kind, continuous);
      // Refreshed BEFORE the message, and refreshed even on a short run: the
      // jobs that did start are real work being charged for, and a page that
      // reports a shortfall without showing what is running has told half the
      // story.
      await a.refreshJobs();
      const n = run.jobIds.length;
      if (run.shortfall) {
        s.pushToast("error", run.shortfall);
      } else {
        s.pushToast(
          "info",
          kind === "image"
            ? `Drawing ${n} shot${n === 1 ? "" : "s"} — one at a time, landing here as they finish.`
            : `Filming ${n} clip${n === 1 ? "" : "s"} — one at a time. The last one lands well after the first.`,
        );
      }
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return <div className="cr-note cr-note-bad">Could not read this room’s story: {error}</div>;
  }
  if (!board) return <div className="cr-note">Reading this room’s story…</div>;

  return (
    <div className="cr-story">
      <CastStrip
        cast={board.cast}
        busy={busy}
        onAdd={(name, description, story) =>
          run(() => api.storyAddCast(name, description, story))
        }
        onAddMany={(members) =>
          run(async () => {
            const n = await api.storyAddCastMany(members);
            s.pushToast(
              "info",
              `${n} added to the cast — give each one a picture so they keep their face.`,
            );
          })
        }
        onEdit={(id, name, description, story) =>
          run(() => api.storyUpdateCast(id, name, description, story))
        }
        onFace={(id, fileId) => run(() => api.storySetFace(id, fileId))}
        onRemove={(id) => run(() => api.storyRemoveCast(id))}
      />

      <ShotList
        board={board}
        cast={board.cast}
        imageModels={imageModels}
        videoModels={videoModels}
        busy={busy}
        onSelectList={(id) => void load(id)}
        onNewList={(title, logline) =>
          run(async () => {
            const id = await api.storyCreateList(title, logline);
            await load(id);
          })
        }
        onUpdateList={(id, title, logline) =>
          run(() => api.storyUpdateList(id, title, logline))
        }
        onSetShape={(id, aspectRatio, stillResolution, clipResolution) =>
          run(() =>
            api.storySetShape({ id, aspectRatio, stillResolution, clipResolution }),
          )
        }
        handoff={handoff ?? null}
        onHandoffUsed={onHandoffUsed}
        onAddShot={(listId, action) => run(() => api.storyAddShot(listId, action))}
        onUpdateShot={(shot) => run(() => api.storyUpdateShot(shot))}
        onRemoveShot={(id) => run(() => api.storyRemoveShot(id))}
        onMakeAll={makeAll}
        onApplySplit={(listId, plan, imageModel, videoModel) =>
          run(async () => {
            const n = await api.storyApplySplit({
              listId,
              shots: plan.shots,
              imageModel,
              videoModel,
            });
            s.pushToast("info", `${n} shots added — ${clock(plan.totalSeconds)} in all.`);
          })
        }
        onOpenFile={(id) => void a.viewFile(id)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ cast */

function CastStrip({
  cast,
  busy,
  onAdd,
  onAddMany,
  onEdit,
  onFace,
  onRemove,
}: {
  cast: CastMember[];
  busy: boolean;
  onAdd: (name: string, description: string, story: string) => void;
  onAddMany: (members: ParsedMember[]) => void;
  onEdit: (id: string, name: string, description: string, story: string) => void;
  onFace: (id: string, fileId: string | null) => void;
  onRemove: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [facing, setFacing] = useState<string | null>(null);
  const [pickingSheet, setPickingSheet] = useState(false);
  const [sheet, setSheet] = useState<CastFromFile | null>(null);
  const [sheetError, setSheetError] = useState("");
  // The room's model reads the file, which takes seconds rather than being
  // instant. Without this the button looks broken for the whole call.
  const [reading, setReading] = useState("");

  return (
    <section className="nb-panel cr-cast">
      <div className="cr-sec-head">
        <span className="nb-subtitle">the cast</span>
        <span className="nb-num cr-dim">
          {cast.length === 0 ? "nobody yet" : `${cast.length} ${cast.length === 1 ? "person" : "people"}`}
        </span>
      </div>

      <p className="cr-cast-why">
        Give each person a picture. That picture — not their description — is
        what keeps them looking like themselves in every shot they appear in.
      </p>

      {/* If the heroes are already written down — and they usually are —
          the room reads them rather than asking for them again. */}
      <div className="cr-from-file">
        <button
          type="button"
          className="nb-btn"
          disabled={busy}
          onClick={() => setPickingSheet(true)}
        >
          Read them from a file in this room
        </button>
      </div>

      <DocumentPicker
        open={pickingSheet}
        title="Which file describes them?"
        // Says the outbound seam BEFORE the file is picked, not after. Reading
        // is a model call: on a local model nothing leaves the Mac, on a cloud
        // one the file's text does — through the room's privacy door, but it
        // goes. That is worth knowing before choosing which file.
        hint="This room's AI model reads it, so pick the file that describes the people. If that model is a cloud one, the file's text leaves this Mac — the privacy door redacts it first. Nothing is added to the cast until you have seen who was found."
        onClose={() => setPickingSheet(false)}
        onPick={(doc) => {
          setReading(doc.name);
          setSheetError("");
          void api
            .storyReadCastFile(doc.fileId)
            .then((result) => setSheet(result))
            .catch((e) => setSheetError(String(e)))
            .finally(() => setReading(""));
        }}
      />

      {reading && (
        <div className="cr-note">
          Reading <b>{reading}</b> — the room’s model is working out who is in
          it. Nothing is added until you have seen them.
        </div>
      )}

      {sheetError && <div className="cr-note cr-note-bad">{sheetError}</div>}

      {sheet && (
        <CastFromFileReview
          sheet={sheet}
          busy={busy}
          onCancel={() => setSheet(null)}
          onKeep={(members) => {
            onAddMany(members);
            setSheet(null);
          }}
        />
      )}

      <div className="cr-cast-row">
        {cast.map((member) => (
          <div key={member.id} className={`nb-card cr-hero${member.faceFileId ? "" : " is-faceless"}`}>
            <button
              type="button"
              className="cr-hero-face"
              onClick={() => setFacing(member.id)}
              title={member.faceFileId ? "Change their picture" : "Give them a picture"}
            >
              {member.faceFileId ? (
                <HeroFace fileId={member.faceFileId} />
              ) : (
                <span className="cr-hero-noface">
                  <CreateIcon size={16} />
                  <span>no face yet</span>
                </span>
              )}
            </button>
            <div className="cr-hero-body">
              <span className="cr-hero-name">{member.name}</span>
              {member.description && (
                <span className="cr-hero-desc">{member.description}</span>
              )}
              {member.story && <span className="cr-hero-story">{member.story}</span>}
            </div>
            <div className="cr-hero-acts">
              <button type="button" onClick={() => setEditing(member.id)} disabled={busy}>
                Edit
              </button>
              {member.faceFileId && (
                <button type="button" onClick={() => onFace(member.id, null)} disabled={busy}>
                  Clear face
                </button>
              )}
              <button type="button" onClick={() => onRemove(member.id)} disabled={busy}>
                Remove
              </button>
            </div>

            {editing === member.id && (
              <HeroForm
                initial={member}
                onCancel={() => setEditing(null)}
                onSave={(name, description, story) => {
                  onEdit(member.id, name, description, story);
                  setEditing(null);
                }}
              />
            )}
          </div>
        ))}

        <button
          type="button"
          className="nb-card cr-hero cr-hero-add"
          onClick={() => setAdding(true)}
          disabled={busy}
        >
          <span aria-hidden>＋</span>
          <span>Add someone</span>
        </button>
      </div>

      {adding && (
        <HeroForm
          onCancel={() => setAdding(false)}
          onSave={(name, description, story) => {
            onAdd(name, description, story);
            setAdding(false);
          }}
        />
      )}

      <PicturePicker
        open={facing !== null}
        title="Which picture is them?"
        onClose={() => setFacing(null)}
        onPick={(picture: RoomPicture) => {
          if (facing) onFace(facing, picture.fileId);
        }}
      />
    </section>
  );
}

/** Who the file turned out to describe — seen and fixed before it is kept.
 *
 * Nothing is written until this is agreed to, and that is not politeness. This
 * reads someone else's document with a heuristic: it recognises the shapes
 * character sheets are actually written in, and on anything else it is
 * guessing. A guess that writes twelve rows into the cast unseen is one bad
 * file away from a mess to undo by hand, one hero at a time.
 *
 * Everything is editable here, because the fastest fix for a heading the
 * reader split wrong is the reader fixing it. */
function CastFromFileReview({
  sheet,
  busy,
  onCancel,
  onKeep,
}: {
  sheet: CastFromFile;
  busy: boolean;
  onCancel: () => void;
  onKeep: (members: ParsedMember[]) => void;
}) {
  const [members, setMembers] = useState<ParsedMember[]>(sheet.found);
  const [dropped, setDropped] = useState<Set<number>>(new Set());

  function edit(i: number, over: Partial<ParsedMember>) {
    setMembers((all) => all.map((m, j) => (j === i ? { ...m, ...over } : m)));
  }

  const keeping = members.filter((_, i) => !dropped.has(i));

  if (sheet.found.length === 0) {
    return (
      <div className="cr-sheet">
        <div className="cr-note cr-note-bad">
          <b>{sheet.readBy}</b> found nobody in <b>{sheet.name}</b>, and nothing
          has been added.
        </div>
        {sheet.fellBack ? (
          <div className="cr-note cr-note-bad">{sheet.fellBack}</div>
        ) : (
          <p className="cr-hint">
            It read the whole file and reports no characters described in it.
            That is an answer, not a failure — a screenplay or a set of notes
            genuinely has no cast sheet in it. Pick the file that describes the
            people themselves.
          </p>
        )}
        <div className="cr-form-acts">
          <button type="button" className="nb-btn" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="cr-sheet">
      <div className="cr-sec-head">
        <span className="nb-subtitle">
          {sheet.found.length} found in {sheet.name}
        </span>
        <button type="button" className="cr-pick-x" onClick={onCancel} aria-label="Close">
          ✕
        </button>
      </div>
      <p className="cr-hint">
        Read by <b>{sheet.readBy}</b> — nothing has been added to the cast yet.
        Fix anything that came out wrong, drop anyone who is not a person, then
        keep the rest.
      </p>
      {/* The fallback must never pass for the model's work: the two are not
          equally good on a messy sheet, and the user would otherwise judge
          their model by rows it never produced. */}
      {sheet.fellBack && <div className="cr-note cr-note-bad">{sheet.fellBack}</div>}

      <ol className="cr-sheet-rows">
        {members.map((member, i) => (
          <li key={i} className={`cr-sheet-row${dropped.has(i) ? " is-dropped" : ""}`}>
            <input
              className="cr-field cr-sheet-name"
              value={member.name}
              aria-label={`Name of person ${i + 1}`}
              onChange={(e) => edit(i, { name: e.target.value })}
            />
            <textarea
              className="cr-field"
              rows={2}
              value={member.description}
              placeholder="What they look like — goes into every prompt"
              aria-label={`What person ${i + 1} looks like`}
              onChange={(e) => edit(i, { description: e.target.value })}
            />
            <textarea
              className="cr-field"
              rows={2}
              value={member.story}
              placeholder="Their story — stays in this room"
              aria-label={`Story of person ${i + 1}`}
              onChange={(e) => edit(i, { story: e.target.value })}
            />
            <button
              type="button"
              className="cr-sheet-drop"
              onClick={() =>
                setDropped((d) => {
                  const next = new Set(d);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
            >
              {dropped.has(i) ? "Keep them" : "Not a person"}
            </button>
          </li>
        ))}
      </ol>

      <p className="cr-hint">
        A picture is a separate choice — add them first, then give each one a
        face from this room. Guessing a face from a filename would put the
        wrong person into every shot they appear in.
      </p>

      <div className="cr-form-acts">
        <button type="button" className="nb-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="nb-btn nb-btn-primary"
          disabled={busy || keeping.length === 0}
          onClick={() => onKeep(keeping)}
        >
          Add {keeping.length} {keeping.length === 1 ? "person" : "people"}
        </button>
      </div>
    </div>
  );
}

/** A hero's portrait, at cast-strip size.
 *
 * Reads the same pre-shrunk thumbnails the picker uses rather than streaming
 * the real file: this is a 64-pixel square, and the original is measured in
 * megabytes. */
function HeroFace({ fileId }: { fileId: string }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .storyPictures()
      .then((all) => {
        if (live) setThumb(all.find((p) => p.fileId === fileId)?.thumbB64 ?? null);
      })
      .catch(() => live && setThumb(null));
    return () => {
      live = false;
    };
  }, [fileId]);
  if (!thumb) return <span className="cr-hero-noface" aria-hidden />;
  return <img src={`data:image/jpeg;base64,${thumb}`} alt="" />;
}

function HeroForm({
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
function ScriptSplitter({
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
  const [plan, setPlan] = useState<ShotPlan | null>(null);
  const [error, setError] = useState("");
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
  const effective = lengths.length
    ? (lengths.includes(secondsEach) ? secondsEach : Math.max(...lengths))
    : secondsEach;

  useEffect(() => {
    if (!script.trim()) {
      setPlan(null);
      return;
    }
    let live = true;
    api
      .storyPlanSplit(script, minutes, effective)
      .then((next) => live && (setPlan(next), setError("")))
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [script, minutes, effective]);

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
    <div className="cr-split">
      <div className="cr-sec-head">
        <span className="nb-subtitle">break a script into shots</span>
        <button type="button" className="cr-pick-x" onClick={() => setOpen(false)} aria-label="Close">
          ✕
        </button>
      </div>

      <p className="cr-hint">
        No model will film more than 20 seconds at once, so an episode is many
        shots. Paste the whole thing — the split happens on this Mac, and every
        word you paste ends up in one shot or another. If your script already
        marks its own chunks (<code>**00:00–00:15**</code>), those are used
        exactly as written.
      </p>

      {/* The room is holding the script already. Asking for it to be pasted
          in is asking for a copy to be done by hand. */}
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
            Read from <b>{fromFile}</b> — every word of it, not a preview.
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
                setMinutes(Number.isFinite(next) && next > 0 ? next : 0);
              }}
            />
            {minutes <= 0 && (
              <span className="cr-hint">Say how long it should run.</span>
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

      {chosen && lengths.length > 0 && (
        <p className="cr-hint">
          {chosen.slug} films up to {Math.max(...lengths)}s at a time.
          {!chosen.limits?.frameImages?.includes("last_frame") && (
            <> It cannot take an ending picture, so these shots will not join.</>
          )}
        </p>
      )}

      {error && <div className="cr-note cr-note-bad">{error}</div>}

      {plan && (
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
                Using your script’s own chunks and their timings — nothing was
                re-cut.
              </div>
            )}
          </div>

          <ol className="cr-split-preview">
            {plan.shots.map((shot, i) => (
              <li key={i}>
                <span className="cr-shot-n">{i + 1}</span>
                <span>
                  {shot.action || <em>(nothing here — you can fill it in after)</em>}
                </span>
                <span className="nb-num cr-dim">{shot.seconds}s</span>
              </li>
            ))}
          </ol>

          <div className="cr-form-acts">
            <button type="button" className="nb-btn" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              disabled={busy || plan.parts === 0}
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
            These are added to the end of the list — nothing already here is
            replaced, so pictures you have already paid for stay.
          </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- shot list */


function ShotList({
  board,
  cast,
  imageModels,
  videoModels,
  busy,
  onSelectList,
  onNewList,
  onUpdateList,
  onSetShape,
  handoff,
  onHandoffUsed,
  onAddShot,
  onUpdateShot,
  onRemoveShot,
  onMakeAll,
  onApplySplit,
  onOpenFile,
}: {
  board: StoryBoard;
  cast: CastMember[];
  imageModels: CreateModel[];
  videoModels: CreateModel[];
  busy: boolean;
  onSelectList: (id: string) => void;
  onNewList: (title: string, logline: string) => void;
  onUpdateList: (id: string, title: string, logline: string) => void;
  onSetShape: (
    id: string,
    aspectRatio: string,
    stillResolution: string,
    clipResolution: string,
  ) => void;
  handoff: string | null;
  onHandoffUsed?: () => void;
  onAddShot: (listId: string, action: string) => void;
  onUpdateShot: (shot: {
    id: string;
    action: string;
    castIds: string[];
    seconds: number | null;
    imageModel: string;
    videoModel: string;
  }) => void;
  onRemoveShot: (id: string) => void;
  onMakeAll: (kind: "image" | "video", continuous?: boolean) => void;
  onApplySplit: (
    listId: string,
    plan: ShotPlan,
    imageModel: string,
    videoModel: string,
  ) => void;
  onOpenFile: (id: string) => void;
}) {
  const [newAction, setNewAction] = useState("");
  const [continuous, setContinuous] = useState(true);
  // Which pass is being reviewed. Nothing is sent until the sheet is read and
  // its own button pressed — this is the last place a twenty-part run can be
  // looked at as a whole, and the first place it costs anything.
  const [reviewing, setReviewing] = useState<null | "image" | "video">(null);
  const current = board.lists.find((l) => l.id === board.selected) ?? null;

  // What this list adds up to. Twenty rows is not obviously five minutes, and
  // the whole reason the list is twenty rows long is a runtime the user has
  // in mind — so the page does the arithmetic rather than leaving it to them.
  const runtime = board.shots.reduce((sum, shot) => {
    const model = videoModels.find((m) => m.model === shot.videoModel) ?? null;
    const lengths = legalSeconds(model);
    // An unset length becomes the model's shortest, which is exactly what the
    // job layer will send — so the total on screen is the total that runs.
    return sum + (shot.seconds ?? (lengths.length ? Math.min(...lengths) : 0));
  }, 0);
  const unpriced = board.shots.some(
    (shot) => !shot.seconds && !legalSeconds(videoModels.find((m) => m.model === shot.videoModel) ?? null).length,
  );
  // Chaining needs a model that takes a FIRST frame — 19 of the 21 do. The
  // join is made by capturing the finished clip's real end frame and opening
  // the next clip on it, so a last-frame slot is no longer required; it only
  // helps a clip aim its ending.
  // Receivers only: the first shot is never handed a frame, so its model's
  // first-frame support says nothing about whether this list can chain.
  const canChain = board.shots.some(
    (shot, i) =>
      i > 0 &&
      takesFirstFrame(videoModels.find((m) => m.model === shot.videoModel) ?? null),
  );

  if (board.lists.length === 0) {
    return (
      <section className="nb-panel cr-shots">
        <div className="cr-empty">
          <CreateIcon size={26} />
          <h2>No shot list yet</h2>
          <p>
            A shot list is the order things happen in — one line per shot. Each
            line becomes a picture, and each picture can become a clip.
          </p>
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            onClick={() => onNewList("Untitled", "")}
            disabled={busy}
          >
            Start one
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="nb-panel cr-shots">
      <div className="cr-sec-head">
        <span className="nb-subtitle">the shot list</span>
        <div className="cr-shots-pick">
          {board.lists.length > 1 && (
            <select
              className="cr-field cr-select"
              value={board.selected ?? ""}
              aria-label="Which shot list"
              onChange={(e) => onSelectList(e.target.value)}
            >
              {board.lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title} · {l.shotCount}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="nb-btn"
            onClick={() => onNewList("Untitled", "")}
            disabled={busy}
          >
            New list
          </button>
        </div>
      </div>

      {current && (
        <div className="cr-list-head">
          <input
            className="cr-field cr-list-title"
            value={current.title}
            aria-label="Shot list title"
            onChange={(e) => onUpdateList(current.id, e.target.value, current.logline)}
          />
          <input
            className="cr-field"
            value={current.logline}
            placeholder="One line about the whole thing — goes into every shot’s prompt"
            aria-label="Logline"
            onChange={(e) => onUpdateList(current.id, current.title, e.target.value)}
          />
        </div>
      )}

      {current && (
        <ShapeRow
          list={current}
          board={board}
          imageModels={imageModels}
          videoModels={videoModels}
          busy={busy}
          onSetShape={onSetShape}
        />
      )}

      {current && (
        <ScriptSplitter
          busy={busy}
          videoModels={videoModels}
          imageModels={imageModels}
          handoff={handoff}
          onHandoffUsed={onHandoffUsed}
          onApply={(plan, imageModel, videoModel) =>
            onApplySplit(current.id, plan, imageModel, videoModel)
          }
        />
      )}

      {board.shots.length > 0 && (
        <div className="cr-runtime">
          <b>{board.shots.length}</b> shot{board.shots.length === 1 ? "" : "s"}
          {runtime > 0 && (
            <>
              {" · "}
              <b>{clock(runtime)}</b> of video
            </>
          )}
          {unpriced && (
            <span className="cr-hint">
              {" "}
              — some shots have no clip model yet, so they are not in the total.
            </span>
          )}
        </div>
      )}

      <ol className="cr-shot-rows">
        {board.shots.map((shot, index) => (
          <ShotRow
            key={shot.id}
            n={index + 1}
            shot={shot}
            cast={cast}
            imageModels={imageModels}
            videoModels={videoModels}
            busy={busy}
            onSave={onUpdateShot}
            onRemove={() => onRemoveShot(shot.id)}
            onOpenFile={onOpenFile}
          />
        ))}
      </ol>

      <div className="cr-shot-new">
        <input
          className="cr-field"
          value={newAction}
          placeholder="What happens next…"
          aria-label="A new shot"
          onChange={(e) => setNewAction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newAction.trim() && board.selected) {
              onAddShot(board.selected, newAction.trim());
              setNewAction("");
            }
          }}
        />
        <button
          type="button"
          className="nb-btn"
          disabled={busy || !newAction.trim() || !board.selected}
          onClick={() => {
            if (!board.selected) return;
            onAddShot(board.selected, newAction.trim());
            setNewAction("");
          }}
        >
          Add shot
        </button>
      </div>

      {board.shots.length > 0 && (
        <div className="cr-make-all">
          <div className="cr-make-step">
            <span className="cr-step-n">1</span>
            <div>
              <b>Draw the frames</b>
              <span>
                One picture per shot, with everyone’s face attached so they look
                like themselves.
              </span>
            </div>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              disabled={busy}
              onClick={() => setReviewing("image")}
            >
              Draw them…
            </button>
          </div>
          <div className="cr-make-step">
            <span className="cr-step-n">2</span>
            <div>
              <b>Film them</b>
              <span>
                Each picture becomes the first frame of its clip. Shots with no
                picture yet are skipped.
              </span>
              {/* THE JOIN. Ending each clip on the next shot's opening picture
                  is what turns twenty separate clips into one continuous run —
                  the same frame closes one and opens the next, so the cut is
                  exact rather than a guess. */}
              <label className="cr-chain">
                <input
                  type="checkbox"
                  checked={continuous}
                  disabled={busy || !canChain}
                  onChange={(e) => setContinuous(e.target.checked)}
                />
                <span>
                  Make it continuous — when a clip finishes, its <b>exact final
                  frame</b> is captured and becomes the first frame of the next
                  clip, so each one picks up precisely where the last ended.
                </span>
              </label>
              {!canChain && board.shots.length > 0 && (
                <span className="cr-hint">
                  The clip model chosen here takes no starting picture at all,
                  so shots cannot be joined on it. Nearly every other video
                  model can.
                </span>
              )}
            </div>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              disabled={busy}
              onClick={() => setReviewing("video")}
            >
              Film them…
            </button>
          </div>
          {/* Said once, here, rather than left for someone to discover after
              paying for six clips: this room cannot join them. */}
          <p className="cr-hint cr-make-note">
            Each shot is still its own file. Continuous means clip two starts
            on the very frame clip one ends on, and so on down the list — but
            nothing in this room stitches them into a single video, so you
            will have {board.shots.length} clips to put end to end.
          </p>
        </div>
      )}

      {reviewing && board.selected && (
        <FilmReview
          listId={board.selected}
          kind={reviewing}
          continuous={continuous}
          busy={busy}
          onClose={() => setReviewing(null)}
          onSend={() => {
            onMakeAll(reviewing, continuous);
            setReviewing(null);
          }}
        />
      )}
    </section>
  );
}

/** The shape of every frame in this list, and how big it comes out.
 *
 * One aspect ratio for the whole list rather than one per shot, and that is a
 * claim about storytelling rather than a shortcut: an episode whose shots
 * change shape halfway through is a mistake, not an intention.
 *
 * It is also load-bearing. A shot's still becomes its clip's LITERAL first
 * frame, so the picture model and the clip model have to agree on the shape —
 * a 1:1 still pinned to the front of a 16:9 clip is pinned to a frame of the
 * wrong shape, and nothing downstream can repair that. So this offers only the
 * ratios BOTH sides accept, and says so when they disagree. */
function ShapeRow({
  list,
  board,
  imageModels,
  videoModels,
  busy,
  onSetShape,
}: {
  list: StoryList;
  board: StoryBoard;
  imageModels: CreateModel[];
  videoModels: CreateModel[];
  busy: boolean;
  onSetShape: (
    id: string,
    aspectRatio: string,
    stillResolution: string,
    clipResolution: string,
  ) => void;
}) {
  // The models this list actually uses, not the whole shelf. Offering "4K"
  // because SOME model in the catalogue does 4K would be offering a size this
  // list's own models will silently drop.
  const used = useMemo(() => {
    const stills = new Set(board.shots.map((s) => s.imageModel).filter(Boolean));
    const clips = new Set(board.shots.map((s) => s.videoModel).filter(Boolean));
    return {
      stills: [...stills].map((m) => imageModels.find((x) => x.model === m) ?? null),
      clips: [...clips].map((m) => videoModels.find((x) => x.model === m) ?? null),
    };
  }, [board.shots, imageModels, videoModels]);

  const stillSizes = sharedValues(used.stills, (l) => l.resolutions);
  const clipSizes = sharedValues(used.clips, (l) => l.resolutions);
  // Across BOTH mediums — see the note above about the first frame.
  const ratios = sharedValues([...used.stills, ...used.clips], (l) => l.aspectRatios);
  const stillRatios = sharedValues(used.stills, (l) => l.aspectRatios);
  const clipRatios = sharedValues(used.clips, (l) => l.aspectRatios);
  const disagree =
    stillRatios.length > 0 && clipRatios.length > 0 && ratios.length === 0;

  if (!stillSizes.length && !clipSizes.length && !ratios.length && !disagree) {
    return null;
  }

  function set(over: Partial<{ a: string; s: string; c: string }>) {
    onSetShape(
      list.id,
      over.a ?? list.aspectRatio,
      over.s ?? list.stillResolution,
      over.c ?? list.clipResolution,
    );
  }

  return (
    <div className="cr-shape">
      <span className="cr-field-label">Shape and size</span>
      <div className="cr-shape-knobs">
        {ratios.length > 0 && (
          <label className="cr-knob">
            <span>Frame shape</span>
            <select
              className="cr-field cr-select"
              value={list.aspectRatio}
              disabled={busy}
              onChange={(e) => set({ a: e.target.value })}
            >
              <option value="">model’s own</option>
              {ratios.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        {stillSizes.length > 0 && (
          <label className="cr-knob">
            <span>Picture size</span>
            <select
              className="cr-field cr-select"
              value={list.stillResolution}
              disabled={busy}
              onChange={(e) => set({ s: e.target.value })}
            >
              <option value="">model’s own</option>
              {stillSizes.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
        {clipSizes.length > 0 && (
          <label className="cr-knob">
            <span>Clip size</span>
            <select
              className="cr-field cr-select"
              value={list.clipResolution}
              disabled={busy}
              onChange={(e) => set({ c: e.target.value })}
            >
              <option value="">model’s own</option>
              {clipSizes.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {disagree ? (
        <p className="cr-hint">
          The picture model and the clip model share no frame shape ({stillRatios.join(", ")}{" "}
          against {clipRatios.join(", ")}). Each will use its own, so the still
          will not fill the clip’s first frame. Pick models that agree, or leave
          the shape alone.
        </p>
      ) : (
        <p className="cr-hint">
          Applies to every shot in this list. The picture and the clip share one
          shape on purpose — a shot’s picture becomes its clip’s first frame.
        </p>
      )}
    </div>
  );
}

function ShotRow({
  n,
  shot,
  cast,
  imageModels,
  videoModels,
  busy,
  onSave,
  onRemove,
  onOpenFile,
}: {
  n: number;
  shot: StoryShot;
  cast: CastMember[];
  imageModels: CreateModel[];
  videoModels: CreateModel[];
  busy: boolean;
  onSave: (shot: {
    id: string;
    action: string;
    castIds: string[];
    seconds: number | null;
    imageModel: string;
    videoModel: string;
  }) => void;
  onRemove: () => void;
  onOpenFile: (id: string) => void;
}) {
  const [action, setAction] = useState(shot.action);
  const [castIds, setCastIds] = useState(shot.castIds);
  const [seconds, setSeconds] = useState<number | null>(shot.seconds);
  const [imageModel, setImageModel] = useState(shot.imageModel);
  const [videoModel, setVideoModel] = useState(shot.videoModel);

  const chosenVideo = videoModels.find((m) => m.model === videoModel) ?? null;
  const lengths = legalSeconds(chosenVideo);

  function save(over: Partial<Parameters<typeof onSave>[0]> = {}) {
    onSave({
      id: shot.id,
      action,
      castIds,
      seconds,
      imageModel,
      videoModel,
      ...over,
    });
  }

  return (
    <li className="cr-shot">
      <span className="cr-shot-n">{n}</span>
      <div className="cr-shot-main">
        <input
          className="cr-field"
          value={action}
          placeholder="What happens in this shot"
          aria-label={`Shot ${n}`}
          onChange={(e) => setAction(e.target.value)}
          onBlur={() => action !== shot.action && save({ action })}
        />

        <div className="cr-shot-who">
          {cast.length === 0 ? (
            <span className="cr-hint">Add someone to the cast to put them in a shot.</span>
          ) : (
            cast.map((member) => {
              const on = castIds.includes(member.id);
              return (
                <button
                  key={member.id}
                  type="button"
                  aria-pressed={on}
                  className={`cr-who${on ? " is-on pick-on" : ""}`}
                  disabled={busy}
                  onClick={() => {
                    const next = on
                      ? castIds.filter((id) => id !== member.id)
                      : [...castIds, member.id];
                    setCastIds(next);
                    save({ castIds: next });
                  }}
                  title={
                    member.faceFileId
                      ? `${member.name} — their picture goes with this shot`
                      : `${member.name} has no picture yet, so only their description goes`
                  }
                >
                  {on && <CheckIcon size={12} />}
                  {member.name}
                  {!member.faceFileId && <span className="cr-who-noface"> ·no face</span>}
                </button>
              );
            })
          )}
        </div>

        <div className="cr-shot-knobs">
          <label className="cr-knob">
            <span>Picture</span>
            <select
              className="cr-field cr-select"
              value={imageModel}
              disabled={busy}
              onChange={(e) => {
                setImageModel(e.target.value);
                save({ imageModel: e.target.value });
              }}
            >
              <option value="">— pick —</option>
              {imageModels.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.slug}
                </option>
              ))}
            </select>
          </label>

          <label className="cr-knob">
            <span>Clip</span>
            <select
              className="cr-field cr-select"
              value={videoModel}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.value;
                setVideoModel(next);
                // A length legal for the old model may be illegal for the new
                // one — Veo takes 4/6/8, Kling takes 3–15. Clearing it here
                // means the job falls back to the cheapest legal length rather
                // than being refused for a number the user never chose.
                const allowed = legalSeconds(videoModels.find((m) => m.model === next) ?? null);
                const keep = seconds !== null && allowed.includes(seconds) ? seconds : null;
                setSeconds(keep);
                save({ videoModel: next, seconds: keep });
              }}
            >
              <option value="">— pick —</option>
              {videoModels.map((m) => (
                <option key={m.model} value={m.model}>
                  {m.slug}
                </option>
              ))}
            </select>
          </label>

          <label className="cr-knob">
            <span>Seconds</span>
            <select
              className="cr-field cr-select"
              value={seconds ?? ""}
              disabled={busy || lengths.length === 0}
              onChange={(e) => {
                const next = e.target.value ? Number(e.target.value) : null;
                setSeconds(next);
                save({ seconds: next });
              }}
            >
              <option value="">
                {lengths.length === 0 ? "model’s own" : "shortest"}
              </option>
              {lengths.map((v) => (
                <option key={v} value={v}>
                  {v}s
                </option>
              ))}
            </select>
          </label>
        </div>

        {(shot.stillFileId || shot.clipFileId) && (
          <div className="cr-shot-made">
            {shot.stillFileId && (
              <button type="button" onClick={() => onOpenFile(shot.stillFileId!)}>
                Open the picture
              </button>
            )}
            {shot.clipFileId && (
              <button type="button" onClick={() => onOpenFile(shot.clipFileId!)}>
                Open the clip
              </button>
            )}
          </div>
        )}
      </div>

      <button
        type="button"
        className="cr-shot-x"
        onClick={onRemove}
        disabled={busy}
        aria-label={`Remove shot ${n}`}
        title="Remove this shot"
      >
        ✕
      </button>
    </li>
  );
}

/** The seam line, said once for the whole tab. */
export function StorySeam() {
  return (
    <div className="cr-seam">
      <LockIcon size={14} />
      <p>
        Making a picture or a clip sends the prompt — and any face you attach —
        to the provider. Nothing else in the story leaves this Mac: a
        character’s written backstory is never sent.
      </p>
    </div>
  );
}
