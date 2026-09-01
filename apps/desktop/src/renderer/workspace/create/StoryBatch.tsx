import { useMemo, useState } from "react";
import { type CreateModel, type StoryBoard, type StoryList } from "../../api";
import { sharedValues } from "./selectors";

export function MakeAllPanel({
  shotCount,
  busy,
  continuous,
  canChain,
  noFirstFrame,
  onSetContinuous,
  onReview,
}: {
  shotCount: number;
  busy: boolean;
  continuous: boolean;
  canChain: boolean;
  noFirstFrame: string[];
  onSetContinuous: (continuous: boolean) => void;
  onReview: (kind: "image" | "video") => void;
}) {
  if (shotCount === 0) return null;
  return (
    <div className="cr-make-all">
      <MakeAllImageStep busy={busy} onReview={onReview} />
      <MakeAllVideoStep
        busy={busy}
        continuous={continuous}
        canChain={canChain}
        noFirstFrame={noFirstFrame}
        onSetContinuous={onSetContinuous}
        onReview={onReview}
      />
      <p className="cr-hint cr-make-note">
        Each shot is still its own file. Continuous means clip two starts on the
        very frame clip one ends on, and so on down the list — but nothing in
        this room stitches them into a single video, so you will have{" "}
        {shotCount}
        clips to put end to end.
      </p>
    </div>
  );
}

export function MakeAllImageStep({
  busy,
  onReview,
}: {
  busy: boolean;
  onReview: (kind: "image" | "video") => void;
}) {
  return (
    <div className="cr-make-step">
      <span className="cr-step-n">1</span>
      <div>
        <b>Draw the frames</b>
        <span>
          One picture per shot, with everyone’s face attached so they look like
          themselves.
        </span>
      </div>
      <button
        type="button"
        className="nb-btn nb-btn-primary"
        disabled={busy}
        onClick={() => onReview("image")}
      >
        Draw them…
      </button>
    </div>
  );
}

export function MakeAllVideoStep({
  busy,
  continuous,
  canChain,
  noFirstFrame,
  onSetContinuous,
  onReview,
}: {
  busy: boolean;
  continuous: boolean;
  canChain: boolean;
  noFirstFrame: string[];
  onSetContinuous: (continuous: boolean) => void;
  onReview: (kind: "image" | "video") => void;
}) {
  return (
    <div className="cr-make-step">
      <span className="cr-step-n">2</span>
      <div>
        <b>Film them</b>
        <span>
          Each picture becomes the first frame of its clip. Shots with no
          picture yet are skipped.
        </span>
        <label className="cr-chain">
          <input
            type="checkbox"
            checked={continuous}
            disabled={busy || !canChain}
            onChange={(e) => onSetContinuous(e.target.checked)}
          />
          <span>
            Make it continuous — when a clip finishes, its{" "}
            <b>exact final frame</b> is captured and becomes the first frame of
            the next clip, so each one picks up precisely where the last ended.
          </span>
        </label>
        <ChainWarning canChain={canChain} noFirstFrame={noFirstFrame} />
      </div>
      <button
        type="button"
        className="nb-btn nb-btn-primary"
        disabled={busy}
        onClick={() => onReview("video")}
      >
        Film them…
      </button>
    </div>
  );
}

export function ChainWarning({
  canChain,
  noFirstFrame,
}: {
  canChain: boolean;
  noFirstFrame: string[];
}) {
  if (canChain || noFirstFrame.length === 0) return null;
  const singleModel = noFirstFrame.length === 1;
  return (
    <span className="cr-hint">
      {noFirstFrame.join(" and ")} {singleModel ? "takes" : "take"} no starting
      picture at all, so shots cannot be joined on {singleModel ? "it" : "them"}
      . Nearly every other video model can.
    </span>
  );
}

/** This list's title and logline.
 *
 * Typed locally, written on blur — the same shape the shot's action row uses.
 * Bound straight to the board, every keystroke was a write plus a full board
 * reload, and the reload re-rendered the input with the value the DB had
 * answered a keystroke ago, so anything typed in between was lost. It also
 * flipped the tab-wide busy flag on each character.
 *
 * `key={list.id}` at the call site reseeds this when another list is selected;
 * a reload of the SAME list must not, or it would fight the typing again. */
export function ListHead({
  list,
  onCommit,
}: {
  list: StoryList;
  onCommit: (title: string, logline: string) => void;
}) {
  const [title, setTitle] = useState(list.title);
  const [logline, setLogline] = useState(list.logline);
  return (
    <div className="cr-list-head">
      <input
        className="cr-field cr-list-title"
        value={title}
        aria-label="Shot list title"
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => {
          if (title !== list.title) onCommit(title, logline);
        }}
      />
      <input
        className="cr-field"
        value={logline}
        placeholder="One line about the whole thing — goes into every shot’s prompt"
        aria-label="Logline"
        onChange={(e) => setLogline(e.target.value)}
        onBlur={() => {
          if (logline !== list.logline) onCommit(title, logline);
        }}
      />
    </div>
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
export function ShapeRow({
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
    const stills = new Set(
      board.shots.map((s) => s.imageModel).filter(Boolean),
    );
    const clips = new Set(board.shots.map((s) => s.videoModel).filter(Boolean));
    return {
      stills: [...stills].map(
        (m) => imageModels.find((x) => x.model === m) ?? null,
      ),
      clips: [...clips].map(
        (m) => videoModels.find((x) => x.model === m) ?? null,
      ),
    };
  }, [board.shots, imageModels, videoModels]);

  const stillSizes = sharedValues(used.stills, (l) => l.resolutions);
  const clipSizes = sharedValues(used.clips, (l) => l.resolutions);
  // Across BOTH mediums — see the note above about the first frame.
  const ratios = sharedValues(
    [...used.stills, ...used.clips],
    (l) => l.aspectRatios,
  );
  const stillRatios = sharedValues(used.stills, (l) => l.aspectRatios);
  const clipRatios = sharedValues(used.clips, (l) => l.aspectRatios);
  const disagree = shapeDisagrees(stillRatios, clipRatios, ratios);

  if (!hasShapeOptions(stillSizes, clipSizes, ratios, disagree)) {
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
    <ShapeControls
      list={list}
      busy={busy}
      ratios={ratios}
      stillSizes={stillSizes}
      clipSizes={clipSizes}
      disagree={disagree}
      stillRatios={stillRatios}
      clipRatios={clipRatios}
      onSet={set}
    />
  );
}

export function shapeDisagrees(
  stillRatios: string[],
  clipRatios: string[],
  ratios: string[],
): boolean {
  return stillRatios.length > 0 && clipRatios.length > 0 && ratios.length === 0;
}

export function hasShapeOptions(
  stillSizes: string[],
  clipSizes: string[],
  ratios: string[],
  disagree: boolean,
): boolean {
  return Boolean(
    stillSizes.length || clipSizes.length || ratios.length || disagree,
  );
}

export function ShapeSelect({
  label,
  value,
  values,
  busy,
  onChange,
}: {
  label: string;
  value: string;
  values: string[];
  busy: boolean;
  onChange: (value: string) => void;
}) {
  if (values.length === 0) return null;
  return (
    <label className="cr-knob">
      <span>{label}</span>
      <select
        className="cr-field cr-select"
        value={value}
        disabled={busy}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">model’s own</option>
        {values.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ShapeHint({
  disagree,
  stillRatios,
  clipRatios,
}: {
  disagree: boolean;
  stillRatios: string[];
  clipRatios: string[];
}) {
  if (disagree)
    return (
      <p className="cr-hint">
        The picture model and the clip model share no frame shape (
        {stillRatios.join(", ")} against {clipRatios.join(", ")}). Each will use
        its own, so the still will not fill the clip’s first frame. Pick models
        that agree, or leave the shape alone.
      </p>
    );
  return (
    <p className="cr-hint">
      Applies to every shot in this list. The picture and the clip share one
      shape on purpose — a shot’s picture becomes its clip’s first frame.
    </p>
  );
}

export function ShapeControls({
  list,
  busy,
  ratios,
  stillSizes,
  clipSizes,
  disagree,
  stillRatios,
  clipRatios,
  onSet,
}: {
  list: StoryList;
  busy: boolean;
  ratios: string[];
  stillSizes: string[];
  clipSizes: string[];
  disagree: boolean;
  stillRatios: string[];
  clipRatios: string[];
  onSet: (over: Partial<{ a: string; s: string; c: string }>) => void;
}) {
  return (
    <div className="cr-shape">
      <span className="cr-field-label">Shape and size</span>
      <div className="cr-shape-knobs">
        <ShapeSelect
          label="Frame shape"
          value={list.aspectRatio}
          values={ratios}
          busy={busy}
          onChange={(value) => onSet({ a: value })}
        />
        <ShapeSelect
          label="Picture size"
          value={list.stillResolution}
          values={stillSizes}
          busy={busy}
          onChange={(value) => onSet({ s: value })}
        />
        <ShapeSelect
          label="Clip size"
          value={list.clipResolution}
          values={clipSizes}
          busy={busy}
          onChange={(value) => onSet({ c: value })}
        />
      </div>
      <ShapeHint
        disagree={disagree}
        stillRatios={stillRatios}
        clipRatios={clipRatios}
      />
    </div>
  );
}
