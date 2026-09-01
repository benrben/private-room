import { type CreateModel, type RoomPicture } from "../../api";
import { CheckIcon, LockIcon } from "../../icons";
import { Attached } from "./PicturePicker";
import { emptyShelfLine, legalSeconds, takesFirstFrame, type CreateKind } from "./selectors";
import { WholeScriptNotice } from "./CreateNotices";

export type ModelPickerProps = {
  models: CreateModel[];
  selected: CreateModel | null;
  onPick: (model: string) => void;
  query: string;
  onQuery: (v: string) => void;
  kind: CreateKind;
  /** How many this tab has BEFORE the filter — the difference between "your
   *  filter matched nothing" and "the catalogue served nothing", which have
   *  different fixes and must not share a sentence. */
  total: number;
};

export function ModelPicker({ models, selected, onPick, query, onQuery, kind, total }: ModelPickerProps) {
  return (
    <div className="cr-picker">
      <ModelSelect models={models} selected={selected} onPick={onPick} />
      <ModelFilter total={total} query={query} onQuery={onQuery} />
      {models.length === 0 && <p className="cr-hint">{emptyShelfLine(kind, query)}</p>}
      {selected && <ModelFacts model={selected} />}
    </div>
  );
}

export function ModelSelect({
  models,
  selected,
  onPick,
}: Pick<ModelPickerProps, "models" | "selected" | "onPick">) {
  return (
    <>
      <label className="cr-field-label" htmlFor="cr-model">
        Which model
      </label>
      <select
        id="cr-model"
        className="cr-field cr-select cr-model-select"
        value={selected?.model ?? ""}
        onChange={(event) => onPick(event.target.value)}
      >
        {models.length === 0 && <option value="">no model available</option>}
        {models.map((model) => (
          <option key={model.model} value={model.model}>
            {model.label}
          </option>
        ))}
      </select>
    </>
  );
}

export function ModelFilter({ total, query, onQuery }: Pick<ModelPickerProps, "total" | "query" | "onQuery">) {
  if (total <= 8 && !query.trim()) return null;
  return (
    <input
      type="search"
      className="cr-field cr-model-filter"
      value={query}
      placeholder={`Filter ${total} models…`}
      aria-label="Filter models by name"
      onChange={(event) => onQuery(event.target.value)}
    />
  );
}

export function ModelFacts({ model }: { model: CreateModel }) {
  const limits = model.limits ?? null;
  return (
    <div className="cr-picker-facts">
      <span className="cr-bench-slug">{model.slug}</span>
      <span className="cr-picker-tags">
        <span className="nb-tape" style={{ "--mk": "var(--mk-blue)" } as React.CSSProperties}>
          {model.engineLabel}
        </span>
        {!model.local && <ModelTag mark="var(--mk-yellow)" label="Leaves room" />}
        {limits?.generateAudio && <ModelTag mark="var(--mk-green)" label="With sound" />}
      </span>
      {model.description && <p className="cr-picker-desc">{model.description}</p>}
    </div>
  );
}

export function ModelTag({ mark, label }: { mark: string; label: string }) {
  return (
    <span className="nb-tape" style={{ "--mk": mark } as React.CSSProperties}>
      {label}
    </span>
  );
}

export type BenchProps = {
  models: CreateModel[];
  selected: CreateModel | null;
  onPickModel: (model: string) => void;
  query: string;
  onQuery: (value: string) => void;
  total: number;
  kind: "image" | "video";
  prompt: string;
  onPrompt: (value: string) => void;
  variations: number;
  onVariations: (value: number) => void;
  frame: RoomPicture | null;
  refs: RoomPicture[];
  seconds: number | null;
  onSeconds: (value: number | null) => void;
  resolution: string;
  onResolution: (value: string) => void;
  aspectRatio: string;
  onAspectRatio: (value: string) => void;
  onTakeToStory: () => void;
  onPickFrame: () => void;
  onPickRef: () => void;
  onClearFrame: () => void;
  onClearRef: (fileId: string) => void;
  busy: boolean;
  canGo: boolean;
  onGenerate: () => void;
};

/** The compose panel. */
export function Bench({
  models,
  selected,
  onPickModel,
  query,
  onQuery,
  total,
  kind,
  prompt,
  onPrompt,
  variations,
  onVariations,
  frame,
  refs,
  seconds,
  onSeconds,
  resolution,
  onResolution,
  aspectRatio,
  onAspectRatio,
  onTakeToStory,
  onPickFrame,
  onPickRef,
  onClearFrame,
  onClearRef,
  busy,
  canGo,
  onGenerate,
}: BenchProps) {
  return (
    <aside className="nb-panel cr-bench" aria-label="Compose">
      <BenchHeader kind={kind} />
      <ModelPicker
        models={models}
        selected={selected}
        onPick={onPickModel}
        query={query}
        onQuery={onQuery}
        kind={kind}
        total={total}
      />
      <PromptField prompt={prompt} kind={kind} onPrompt={onPrompt} onTakeToStory={onTakeToStory} />
      <VideoFrameControl kind={kind} model={selected} frame={frame} onPick={onPickFrame} onClear={onClearFrame} />
      <ReferenceControls selected={selected} kind={kind} refs={refs} onPick={onPickRef} onClear={onClearRef} />
      <DurationControl selected={selected} kind={kind} seconds={seconds} onSeconds={onSeconds} />
      <ShapeControls
        selected={selected}
        resolution={resolution}
        aspectRatio={aspectRatio}
        onResolution={onResolution}
        onAspectRatio={onAspectRatio}
      />
      <VariationControl variations={variations} onVariations={onVariations} />
      <PrivacySeam selected={selected} kind={kind} frame={frame} refs={refs} />
      <GenerateButton busy={busy} canGo={canGo} variations={variations} kind={kind} frame={frame} refs={refs} onGenerate={onGenerate} />
    </aside>
  );
}

export function BenchHeader({ kind }: Pick<BenchProps, "kind">) {
  return (
    <div className="cr-bench-head">
      <h2>The bench</h2>
      <span className="nb-num cr-dim">{kind === "video" ? "moving" : "still"}</span>
    </div>
  );
}

export function PromptField({
  prompt,
  kind,
  onPrompt,
  onTakeToStory,
}: Pick<BenchProps, "prompt" | "kind" | "onPrompt" | "onTakeToStory">) {
  const placeholder =
    kind === "video"
      ? "The boat pulls away, the light going out of the sky"
      : "A lighthouse at dusk, the storm still an hour out";
  return (
    <div>
      <label className="cr-field-label" htmlFor="cr-prompt">
        Describe it
      </label>
      <textarea
        id="cr-prompt"
        className="cr-field"
        value={prompt}
        rows={3}
        placeholder={placeholder}
        onChange={(event) => onPrompt(event.target.value)}
      />
      <WholeScriptNotice prompt={prompt} kind={kind} onTakeToStory={onTakeToStory} />
    </div>
  );
}

export function VideoFrameControl({
  kind,
  model,
  frame,
  onPick,
  onClear,
}: Pick<BenchProps, "kind" | "frame"> & {
  model: CreateModel | null;
  onPick: () => void;
  onClear: () => void;
}) {
  if (kind !== "video") return null;
  if (!takesFirstFrame(model)) return <FrameUnsupported model={model} />;
  return (
    <div>
      <span className="cr-field-label">Start from a picture</span>
      {frame ? (
        <Attached picture={frame} role="first frame" onClear={onClear} />
      ) : (
        <button type="button" className="nb-btn cr-attach" onClick={onPick}>
          Use a picture from this room
        </button>
      )}
    </div>
  );
}

export function FrameUnsupported({ model }: { model: CreateModel | null }) {
  return (
    <div>
      <span className="cr-field-label">Start from a picture</span>
      <p className="cr-hint">
        {model?.slug} makes a clip from words alone — it takes no starting picture, so attaching
        one would do nothing.
      </p>
    </div>
  );
}

export function ReferenceControls({
  selected,
  kind,
  refs,
  onPick,
  onClear,
}: Pick<BenchProps, "selected" | "kind" | "refs"> & {
  onPick: () => void;
  onClear: (fileId: string) => void;
}) {
  const maxReferences = selected?.limits?.maxReferences ?? null;
  const full = maxReferences !== null && refs.length >= maxReferences;
  return (
    <div>
      <span className="cr-field-label">{kind === "video" ? "Make it look like" : "Look like these"}</span>
      <div className="cr-attach-row">
        {refs.map((picture) => (
          <Attached
            key={picture.fileId}
            picture={picture}
            role="reference"
            onClear={() => onClear(picture.fileId)}
          />
        ))}
        {!full && <ReferenceAttachButton refs={refs} onPick={onPick} />}
      </div>
      {full && <ReferenceLimit model={selected} maximum={maxReferences!} />}
    </div>
  );
}

export function ReferenceAttachButton({ refs, onPick }: Pick<BenchProps, "refs"> & { onPick: () => void }) {
  return (
    <button type="button" className="nb-btn cr-attach" onClick={onPick}>
      {refs.length === 0 ? "Attach a picture" : "Attach another"}
    </button>
  );
}

export function ReferenceLimit({ model, maximum }: { model: CreateModel | null; maximum: number }) {
  return (
    <p className="cr-hint">
      {model?.slug} looks at {maximum} picture{maximum === 1 ? "" : "s"} at most.
    </p>
  );
}

export function DurationControl({
  selected,
  kind,
  seconds,
  onSeconds,
}: Pick<BenchProps, "selected" | "kind" | "seconds" | "onSeconds">) {
  const lengths = legalSeconds(selected);
  if (kind !== "video" || lengths.length === 0) return null;
  return (
    <div>
      <span className="cr-field-label">How long</span>
      <div className="cr-opts">
        {lengths.map((length) => (
          <DurationOption
            key={length}
            length={length}
            seconds={seconds}
            onSeconds={onSeconds}
          />
        ))}
      </div>
      {seconds === null && <DurationDefault length={Math.min(...lengths)} />}
    </div>
  );
}

export function DurationOption({
  length,
  seconds,
  onSeconds,
}: {
  length: number;
  seconds: number | null;
  onSeconds: (seconds: number | null) => void;
}) {
  const selected = seconds === length;
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`cr-opt${selected ? " is-on pick-on" : ""}`}
      onClick={() => onSeconds(selected ? null : length)}
    >
      {selected && <CheckIcon size={12} />}
      {length}s
    </button>
  );
}

export function DurationDefault({ length }: { length: number }) {
  return <p className="cr-hint">Nothing chosen — it will use {length}s, the shortest this model makes.</p>;
}

export function ShapeControls({
  selected,
  resolution,
  aspectRatio,
  onResolution,
  onAspectRatio,
}: Pick<BenchProps, "selected" | "resolution" | "aspectRatio" | "onResolution" | "onAspectRatio">) {
  const controls = shapeControls(selected, resolution, aspectRatio, onResolution, onAspectRatio);
  if (controls.length === 0) return null;
  return (
    <div className="cr-shape-knobs">
      {controls.map((control) => (
        <ShapeSelect key={control.label} {...control} />
      ))}
    </div>
  );
}

export function shapeControls(
  selected: CreateModel | null,
  resolution: string,
  aspectRatio: string,
  onResolution: (value: string) => void,
  onAspectRatio: (value: string) => void,
) {
  const limits = selected?.limits;
  return [
    { values: limits?.aspectRatios ?? [], value: aspectRatio, label: "Frame shape", onChange: onAspectRatio },
    { values: limits?.resolutions ?? [], value: resolution, label: "Size", onChange: onResolution },
  ].filter((control) => control.values.length > 0);
}

export function ShapeSelect({
  values,
  value,
  label,
  onChange,
}: {
  values: string[];
  value: string;
  label: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="cr-knob">
      <span>{label}</span>
      <select className="cr-field cr-select" value={value} onChange={(event) => onChange(event.target.value)}>
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

export function VariationControl({ variations, onVariations }: Pick<BenchProps, "variations" | "onVariations">) {
  return (
    <div>
      <span className="cr-field-label">How many</span>
      <div className="cr-opts">
        {[1, 2, 4].map((variation) => (
          <VariationOption
            key={variation}
            variation={variation}
            selected={variations === variation}
            onPick={onVariations}
          />
        ))}
      </div>
    </div>
  );
}

export function VariationOption({
  variation,
  selected,
  onPick,
}: {
  variation: number;
  selected: boolean;
  onPick: (variation: number) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={`cr-opt${selected ? " is-on pick-on" : ""}`}
      onClick={() => onPick(variation)}
    >
      {selected && <CheckIcon size={12} />}
      {variation}
    </button>
  );
}

export function pictureCount(kind: "image" | "video", frame: RoomPicture | null, refs: RoomPicture[]): number {
  return refs.length + (kind === "video" && frame ? 1 : 0);
}

export function PrivacySeam({
  selected,
  kind,
  frame,
  refs,
}: Pick<BenchProps, "selected" | "kind" | "frame" | "refs">) {
  if (!selected || selected.local) return null;
  const sending = pictureCount(kind, frame, refs);
  return (
    <div className="cr-seam">
      <LockIcon size={14} />
      <p>
        This runs on {selected.engineLabel}, so the words you type leave this Mac — the room’s
        privacy door redacts them first.
        {sending > 0 && <PictureDisclosure count={sending} />}
      </p>
    </div>
  );
}

export function PictureDisclosure({ count }: { count: number }) {
  return (
    <>
      {" "}
      <b>
        The {count} picture{count === 1 ? "" : "s"} above will be sent as well
      </b>
      , un-redacted, because a picture cannot be. Remove them to keep them here.
    </>
  );
}

export function generateButtonLabel(busy: boolean, sending: number, variations: number): string {
  if (busy) return "Starting…";
  const amount = variations === 1 ? "it" : String(variations);
  return sending > 0 ? `Send and make ${amount}` : `Make ${amount}`;
}

export function GenerateButton({
  busy,
  canGo,
  variations,
  kind,
  frame,
  refs,
  onGenerate,
}: Pick<BenchProps, "busy" | "canGo" | "variations" | "kind" | "frame" | "refs" | "onGenerate">) {
  const sending = pictureCount(kind, frame, refs);
  return (
    <>
      <button className="nb-btn nb-btn-primary cr-go" type="button" disabled={busy || !canGo} onClick={onGenerate}>
        {generateButtonLabel(busy, sending, variations)}
      </button>
      <BenchHint kind={kind} />
    </>
  );
}

export function BenchHint({ kind }: Pick<BenchProps, "kind">) {
  const text =
    kind === "video"
      ? "A clip takes a few minutes. It runs in the background and lands in this room when it is ready."
      : "Runs in the background — it opens here when it is ready, and lands in this room like any other file.";
  return <p className="cr-bench-hint">{text}</p>;
}

/** The bench makes ONE picture or ONE clip. Say so when it has been handed a
 * whole episode.
 *
 * This is the answer to a real report: a five-minute script pasted here and
 * "it only made 15 seconds". Nothing was broken — the bench did exactly what
 * it is for, once — but a control that silently uses the first fifteen seconds
 * of a five-minute script and discards the rest has not told the truth about
 * what it did, and the person watching has no way to tell that apart from a
 * model that ignored them.
 *
 * The numbers come from the SAME local splitter the Story tab uses, so they
 * are the real ones rather than an estimate: no model is asked, nothing leaves
 * the Mac, and it costs nothing to run on every pause in typing. */
