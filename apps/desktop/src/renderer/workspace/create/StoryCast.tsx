import { useEffect, useState } from "react";
import { api, type CastMember, type RoomPicture, type CastFromFile, type ParsedMember } from "../../api";
import { CreateIcon } from "../../icons";
import { PicturePicker } from "./PicturePicker";
import { DocumentPicker } from "./DocumentPicker";
import { HeroFace, HeroForm } from "./StoryScript";

export function CastStrip({
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
  onEdit: (
    id: string,
    name: string,
    description: string,
    story: string,
  ) => void;
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

  // ONE fetch for the whole strip. Every portrait used to ask for the room's
  // thumbnails itself, and `story_pictures` builds the WHOLE list each time —
  // on a cold cache eight heroes meant eight concurrent decode-and-shrink
  // passes over every picture in the room before the first face appeared.
  // `null` means "not read yet", which is why the blank square below can tell
  // "still loading" apart from "not in the list we got".
  const [faces, setFaces] = useState<Record<string, string> | null>(null);
  const faceKey = cast.map((m) => m.faceFileId ?? "").join(",");
  useEffect(() => {
    // Nobody has a face yet: no portrait will be drawn, so building the room's
    // thumbnails would be work for a strip that shows none of it.
    if (!faceKey.split(",").some(Boolean)) return;
    let live = true;
    api
      .storyPictures()
      .then((all) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const p of all) next[p.fileId] = p.thumbB64;
        setFaces(next);
      })
      // A failed read is not evidence that a face is missing — stay at "not
      // read yet" rather than accusing every portrait of being out of range.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [faceKey]);

  return (
    <section className="nb-panel cr-cast">
      <div className="cr-sec-head">
        <span className="nb-subtitle">the cast</span>
        <span className="nb-num cr-dim">
          {cast.length === 0
            ? "nobody yet"
            : `${cast.length} ${cast.length === 1 ? "person" : "people"}`}
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

      <CastFileFeedback
        reading={reading}
        error={sheetError}
        sheet={sheet}
        busy={busy}
        onCancel={() => setSheet(null)}
        onKeep={(members) => {
          onAddMany(members);
          setSheet(null);
        }}
      />

      <div className="cr-cast-row">
        <CastMemberCards
          cast={cast}
          faces={faces}
          editing={editing}
          busy={busy}
          onFacePick={setFacing}
          onEditStart={setEditing}
          onEditCancel={() => setEditing(null)}
          onEdit={(id, name, description, story) => {
            onEdit(id, name, description, story);
            setEditing(null);
          }}
          onFace={onFace}
          onRemove={onRemove}
        />

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

      <AddHeroForm
        open={adding}
        onCancel={() => setAdding(false)}
        onSave={(name, description, story) => {
          onAdd(name, description, story);
          setAdding(false);
        }}
      />

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

export function CastFileFeedback({
  reading,
  error,
  sheet,
  busy,
  onCancel,
  onKeep,
}: {
  reading: string;
  error: string;
  sheet: CastFromFile | null;
  busy: boolean;
  onCancel: () => void;
  onKeep: (members: ParsedMember[]) => void;
}) {
  return (
    <>
      {reading ? (
        <div className="cr-note">
          Reading <b>{reading}</b> — the room’s model is working out who is in
          it. Nothing is added until you have seen them.
        </div>
      ) : null}
      {error ? <div className="cr-note cr-note-bad">{error}</div> : null}
      {sheet ? (
        <CastFromFileReview
          sheet={sheet}
          busy={busy}
          onCancel={onCancel}
          onKeep={onKeep}
        />
      ) : null}
    </>
  );
}

export function AddHeroForm({
  open,
  onCancel,
  onSave,
}: {
  open: boolean;
  onCancel: () => void;
  onSave: (name: string, description: string, story: string) => void;
}) {
  return open ? <HeroForm onCancel={onCancel} onSave={onSave} /> : null;
}

export function HeroFaceButton({
  member,
  thumbs,
  onPick,
}: {
  member: CastMember;
  thumbs: Record<string, string> | null;
  onPick: () => void;
}) {
  const face = member.faceFileId ? (
    <HeroFace fileId={member.faceFileId} thumbs={thumbs} />
  ) : (
    <span className="cr-hero-noface">
      <CreateIcon size={16} />
      <span>no face yet</span>
    </span>
  );
  return (
    <button
      type="button"
      className="cr-hero-face"
      onClick={onPick}
      title={member.faceFileId ? "Change their picture" : "Give them a picture"}
    >
      {face}
    </button>
  );
}

export function HeroDetails({ member }: { member: CastMember }) {
  return (
    <div className="cr-hero-body">
      <span className="cr-hero-name">{member.name}</span>
      {member.description ? (
        <span className="cr-hero-desc">{member.description}</span>
      ) : null}
      {member.story ? (
        <span className="cr-hero-story">{member.story}</span>
      ) : null}
    </div>
  );
}

export function HeroActions({
  member,
  busy,
  onEdit,
  onFace,
  onRemove,
}: {
  member: CastMember;
  busy: boolean;
  onEdit: () => void;
  onFace: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="cr-hero-acts">
      <button type="button" onClick={onEdit} disabled={busy}>
        Edit
      </button>
      {member.faceFileId ? (
        <button type="button" onClick={onFace} disabled={busy}>
          Clear face
        </button>
      ) : null}
      <button type="button" onClick={onRemove} disabled={busy}>
        Remove
      </button>
    </div>
  );
}

export function CastMemberCard({
  member,
  thumbs,
  editing,
  busy,
  onFacePick,
  onEditStart,
  onEditCancel,
  onEdit,
  onFace,
  onRemove,
}: {
  member: CastMember;
  thumbs: Record<string, string> | null;
  editing: boolean;
  busy: boolean;
  onFacePick: (id: string) => void;
  onEditStart: (id: string) => void;
  onEditCancel: () => void;
  onEdit: (
    id: string,
    name: string,
    description: string,
    story: string,
  ) => void;
  onFace: (id: string, fileId: string | null) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div
      className={`nb-card cr-hero${member.faceFileId ? "" : " is-faceless"}`}
    >
      <HeroFaceButton
        member={member}
        thumbs={thumbs}
        onPick={() => onFacePick(member.id)}
      />
      <HeroDetails member={member} />
      <HeroActions
        member={member}
        busy={busy}
        onEdit={() => onEditStart(member.id)}
        onFace={() => onFace(member.id, null)}
        onRemove={() => onRemove(member.id)}
      />
      {editing ? (
        <HeroForm
          initial={member}
          onCancel={onEditCancel}
          onSave={(name, description, story) =>
            onEdit(member.id, name, description, story)
          }
        />
      ) : null}
    </div>
  );
}

export function CastMemberCards({
  cast,
  faces,
  editing,
  busy,
  onFacePick,
  onEditStart,
  onEditCancel,
  onEdit,
  onFace,
  onRemove,
}: {
  cast: CastMember[];
  faces: Record<string, string> | null;
  editing: string | null;
  busy: boolean;
  onFacePick: (id: string) => void;
  onEditStart: (id: string) => void;
  onEditCancel: () => void;
  onEdit: (
    id: string,
    name: string,
    description: string,
    story: string,
  ) => void;
  onFace: (id: string, fileId: string | null) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <>
      {cast.map((member) => (
        <CastMemberCard
          key={member.id}
          member={member}
          thumbs={faces}
          editing={editing === member.id}
          busy={busy}
          onFacePick={onFacePick}
          onEditStart={onEditStart}
          onEditCancel={onEditCancel}
          onEdit={onEdit}
          onFace={onFace}
          onRemove={onRemove}
        />
      ))}
    </>
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
export function CastFromFileReview({
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
        <EmptyCastExplanation fellBack={sheet.fellBack} />
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
        <button
          type="button"
          className="cr-pick-x"
          onClick={onCancel}
          aria-label="Close"
        >
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
      {sheet.fellBack && (
        <div className="cr-note cr-note-bad">{sheet.fellBack}</div>
      )}

      <ol className="cr-sheet-rows">
        {members.map((member, i) => (
          <li
            key={i}
            className={`cr-sheet-row${dropped.has(i) ? " is-dropped" : ""}`}
          >
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
        face from this room. Guessing a face from a filename would put the wrong
        person into every shot they appear in.
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

export function EmptyCastExplanation({ fellBack }: { fellBack: string | null }) {
  if (fellBack) return <div className="cr-note cr-note-bad">{fellBack}</div>;
  return (
    <p className="cr-hint">
      It read the whole file and reports no characters described in it. That is
      an answer, not a failure — a screenplay or a set of notes genuinely has no
      cast sheet in it. Pick the file that describes the people themselves.
    </p>
  );
}

/** A hero's portrait, at cast-strip size.
 *
 * Reads the same pre-shrunk thumbnails the picker uses rather than streaming
 * the real file: this is a 64-pixel square, and the original is measured in
 * megabytes. The strip fetches them once and hands the map in — `null` while
 * that is still in flight.
 *
 * The picker's list is the newest 150 pictures, so a face pinned from an older
 * import is simply not in it. That used to draw as an empty square forever,
 * indistinguishable from loading; it says which now, because a face that is
 * still in the room is fine — shots read it by id, never through this list. */
