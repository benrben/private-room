import { useState } from "react";
import { type CastMember, type CreateModel, type StoryShot } from "../../api";
import { CheckIcon } from "../../icons";
import { legalSeconds } from "./selectors";

export function ShotRow({
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

  const toggleCast = (member: CastMember) => {
    const next = castIds.includes(member.id)
      ? castIds.filter((id) => id !== member.id)
      : [...castIds, member.id];
    setCastIds(next);
    save({ castIds: next });
  };
  const chooseImage = (next: string) => {
    setImageModel(next);
    save({ imageModel: next });
  };
  const chooseVideo = (next: string) => {
    const allowed = legalSeconds(
      videoModels.find((model) => model.model === next) ?? null,
    );
    const keep = seconds !== null && allowed.includes(seconds) ? seconds : null;
    setVideoModel(next);
    setSeconds(keep);
    save({ videoModel: next, seconds: keep });
  };
  const chooseSeconds = (value: string) => {
    const next = value ? Number(value) : null;
    setSeconds(next);
    save({ seconds: next });
  };
  return (
    <ShotEditor
      n={n}
      shot={shot}
      action={action}
      cast={cast}
      castIds={castIds}
      imageModels={imageModels}
      videoModels={videoModels}
      imageModel={imageModel}
      videoModel={videoModel}
      seconds={seconds}
      lengths={lengths}
      busy={busy}
      onAction={setAction}
      onBlur={() => action !== shot.action && save({ action })}
      onToggleCast={toggleCast}
      onImage={chooseImage}
      onVideo={chooseVideo}
      onSeconds={chooseSeconds}
      onOpenFile={onOpenFile}
      onRemove={onRemove}
    />
  );
}

export function CastChoice({
  member,
  selected,
  busy,
  onToggle,
}: {
  member: CastMember;
  selected: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const title = member.faceFileId
    ? `${member.name} — their picture goes with this shot`
    : `${member.name} has no picture yet, so only their description goes`;
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`cr-who${selected ? " is-on pick-on" : ""}`}
      disabled={busy}
      onClick={onToggle}
      title={title}
    >
      {selected ? <CheckIcon size={12} /> : null}
      {member.name}
      {member.faceFileId ? null : (
        <span className="cr-who-noface"> ·no face</span>
      )}
    </button>
  );
}

export function CastChoices({
  cast,
  selected,
  busy,
  onToggle,
}: {
  cast: CastMember[];
  selected: string[];
  busy: boolean;
  onToggle: (member: CastMember) => void;
}) {
  if (cast.length === 0)
    return (
      <div className="cr-shot-who">
        <span className="cr-hint">
          Add someone to the cast to put them in a shot.
        </span>
      </div>
    );
  return (
    <div className="cr-shot-who">
      {cast.map((member) => (
        <CastChoice
          key={member.id}
          member={member}
          selected={selected.includes(member.id)}
          busy={busy}
          onToggle={() => onToggle(member)}
        />
      ))}
    </div>
  );
}

export function ModelOptions({ models }: { models: CreateModel[] }) {
  return (
    <>
      <option value="">— pick —</option>
      {models.map((model) => (
        <option key={model.model} value={model.model}>
          {model.slug}
        </option>
      ))}
    </>
  );
}

export function ShotModelKnobs({
  imageModels,
  videoModels,
  imageModel,
  videoModel,
  seconds,
  lengths,
  busy,
  onImage,
  onVideo,
  onSeconds,
}: {
  imageModels: CreateModel[];
  videoModels: CreateModel[];
  imageModel: string;
  videoModel: string;
  seconds: number | null;
  lengths: number[];
  busy: boolean;
  onImage: (value: string) => void;
  onVideo: (value: string) => void;
  onSeconds: (value: string) => void;
}) {
  const secondsLabel = lengths.length === 0 ? "model’s own" : "shortest";
  return (
    <div className="cr-shot-knobs">
      <label className="cr-knob">
        <span>Picture</span>
        <select
          className="cr-field cr-select"
          value={imageModel}
          disabled={busy}
          onChange={(event) => onImage(event.target.value)}
        >
          <ModelOptions models={imageModels} />
        </select>
      </label>
      <label className="cr-knob">
        <span>Clip</span>
        <select
          className="cr-field cr-select"
          value={videoModel}
          disabled={busy}
          onChange={(event) => onVideo(event.target.value)}
        >
          <ModelOptions models={videoModels} />
        </select>
      </label>
      <label className="cr-knob">
        <span>Seconds</span>
        <select
          className="cr-field cr-select"
          value={seconds ?? ""}
          disabled={busy || lengths.length === 0}
          onChange={(event) => onSeconds(event.target.value)}
        >
          <option value="">{secondsLabel}</option>
          {lengths.map((length) => (
            <option key={length} value={length}>
              {length}s
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function ShotFiles({
  shot,
  onOpenFile,
}: {
  shot: StoryShot;
  onOpenFile: (id: string) => void;
}) {
  if (!shot.stillFileId && !shot.clipFileId) return null;
  return (
    <div className="cr-shot-made">
      {shot.stillFileId ? (
        <button type="button" onClick={() => onOpenFile(shot.stillFileId!)}>
          Open the picture
        </button>
      ) : null}
      {shot.clipFileId ? (
        <button type="button" onClick={() => onOpenFile(shot.clipFileId!)}>
          Open the clip
        </button>
      ) : null}
    </div>
  );
}

export function ShotEditor({
  n,
  shot,
  action,
  cast,
  castIds,
  imageModels,
  videoModels,
  imageModel,
  videoModel,
  seconds,
  lengths,
  busy,
  onAction,
  onBlur,
  onToggleCast,
  onImage,
  onVideo,
  onSeconds,
  onOpenFile,
  onRemove,
}: {
  n: number;
  shot: StoryShot;
  action: string;
  cast: CastMember[];
  castIds: string[];
  imageModels: CreateModel[];
  videoModels: CreateModel[];
  imageModel: string;
  videoModel: string;
  seconds: number | null;
  lengths: number[];
  busy: boolean;
  onAction: (value: string) => void;
  onBlur: () => void;
  onToggleCast: (member: CastMember) => void;
  onImage: (value: string) => void;
  onVideo: (value: string) => void;
  onSeconds: (value: string) => void;
  onOpenFile: (id: string) => void;
  onRemove: () => void;
}) {
  return (
    <li className="cr-shot">
      <span className="cr-shot-n">{n}</span>
      <div className="cr-shot-main">
        <input
          className="cr-field"
          value={action}
          placeholder="What happens in this shot"
          aria-label={`Shot ${n}`}
          onChange={(event) => onAction(event.target.value)}
          onBlur={onBlur}
        />
        <CastChoices
          cast={cast}
          selected={castIds}
          busy={busy}
          onToggle={onToggleCast}
        />
        <ShotModelKnobs
          imageModels={imageModels}
          videoModels={videoModels}
          imageModel={imageModel}
          videoModel={videoModel}
          seconds={seconds}
          lengths={lengths}
          busy={busy}
          onImage={onImage}
          onVideo={onVideo}
          onSeconds={onSeconds}
        />
        <ShotFiles shot={shot} onOpenFile={onOpenFile} />
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
