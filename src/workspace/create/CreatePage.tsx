import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  formatSize,
  type CreateCatalog,
  type CreateModel,
  type RoomPicture,
  type ShotPlan,
} from "../../api";
import { clock } from "./clock";
import { CheckIcon, CreateIcon, LockIcon, SearchIcon } from "../../icons";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { Attached, PicturePicker } from "./PicturePicker";
import { StoryTab } from "./StoryTab";
import {
  emptyReason,
  emptyShelfLine,
  legalSeconds,
  selectedModel,
  takesFirstFrame,
  tallies,
  visibleModels,
  type CreateKind,
} from "./selectors";

/** What the page is showing: a shelf of models, or the story surface. */
type Surface = CreateKind | "story";

/** The Create page: pictures and video, made by whichever connected model can
 * actually make one.
 *
 * The page has ONE governing rule, and most of its layout exists to serve it:
 * a model appears here only when a live provider catalog says it produces
 * pixels. Nothing matches on a name — see `commands/create.rs` for why a name
 * test both invites failures and hides capable models.
 *
 * That rule needs its counterpart on screen. A shelf that silently omits
 * Claude and every local model reads as a broken page, so the ledger at the
 * top states the denominator ("11 of 34") and the disclosure under it names
 * every engine that cannot draw, with the reason. "Where is Claude" is the
 * question this page exists to answer before it is asked.
 *
 * The gallery does NOT own generation progress. A finished picture arrives
 * through the ordinary job pipeline — `job-progress` with a `fileId`, which
 * `effects.ts` already turns into a toast and an opened viewer — so this page
 * subscribes to nothing and simply reads `s.jobs` for the cards it draws. */
export function CreatePage({ s, a }: { s: WSState; a: WSActions }) {
  const [catalog, setCatalog] = useState<CreateCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [surface, setSurface] = useState<Surface>("image");
  const [query, setQuery] = useState("");
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [variations, setVariations] = useState(1);
  const [whyOpen, setWhyOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Attached room pictures. `frame` begins a clip; `refs` only guide the look.
  // Two separate slots because they are two different things, and collapsing
  // them would make "start from this picture" and "look like this" the same
  // control — which they are not, and one of them costs a wrong clip.
  const [frame, setFrame] = useState<RoomPicture | null>(null);
  const [refs, setRefs] = useState<RoomPicture[]>([]);
  const [picking, setPicking] = useState<null | "frame" | "ref">(null);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [resolution, setResolution] = useState("");
  const [aspectRatio, setAspectRatio] = useState("");
  // A script carried across from the bench to Story, so "take it there" does
  // not mean "paste it again".
  const [handoff, setHandoff] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api
      .listCreateModels()
      .then((next) => {
        if (!live) return;
        setCatalog(next);
        setLoadError(null);
      })
      .catch((e) => {
        if (live) setLoadError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // "New creation" — the Creations sidebar header and ⌘T in this destination.
  // A creation is COMPOSED rather than created, so "new" means an empty bench:
  // no prompt, no starting frame, no references. Keyed on the counter rather
  // than a flag so pressing it twice clears twice (see `newCreationSeq`), and
  // skipped on the first render so arriving at Create never wipes a draft the
  // reader had left in the box.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setPrompt("");
    setFrame(null);
    setRefs([]);
    setHandoff(null);
  }, [s.newCreationSeq]);

  const models = catalog?.models ?? [];
  const counts = tallies(catalog);
  // The Story tab has no shelf of its own; it borrows the whole catalogue and
  // narrows per shot. `kind` is only meaningful for the two model tabs.
  const kind: CreateKind = surface === "story" ? "image" : surface;

  const visible = useMemo(
    () => visibleModels(models, kind, query),
    [models, kind, query],
  );
  const selected: CreateModel | null = selectedModel(visible, pickedModel);

  // A size or shape legal for one model is often illegal for the next — the
  // picture catalogue talks in "1K"/"2K", the video one in "720p"/"1080p".
  // Clearing them on a model change means the call falls back to that model's
  // own default rather than carrying over a value it would refuse.
  const selectedId = selected?.model ?? "";
  useEffect(() => {
    setResolution("");
    setAspectRatio("");
  }, [selectedId]);

  const createJobs = s.jobs.filter((j) => j.kind === "create");
  const activeJobs = createJobs.filter(
    (j) => j.status === "running" || j.status === "queued",
  );
  // Failures stay on the page with their reason. Showing only live work meant a
  // generation that failed simply vanished a second after it started — the row
  // left the active list, and the only account of what went wrong sat on a job
  // record in another pane. A paid call that produced nothing owes an answer
  // in the place the person is looking.
  const failedJobs = createJobs.filter((j) => j.status === "error").slice(0, 3);
  const made = s.files.filter((f) => f.source === "generated");

  // A clip may be made from a picture alone — several models animate a still
  // with no words at all, and the API marks the prompt optional for exactly
  // that. A still always needs words: there is nothing else to draw from.
  const canGo =
    !!selected && (!!prompt.trim() || (kind === "video" && !!frame));

  async function generate() {
    if (!selected || !canGo || busy) return;
    setBusy(true);
    try {
      await api.startCreateJob({
        prompt: prompt.trim(),
        model: selected.model,
        kind,
        variations,
        seconds: kind === "video" ? seconds : null,
        resolution,
        aspectRatio,
        referenceFileIds: refs.map((r) => r.fileId),
        frameFileId: kind === "video" ? (frame?.fileId ?? null) : null,
        // Set here and nowhere else: the pictures are on screen, named, above
        // a button that says they will be sent. That is what makes this
        // consent rather than a setting — see `videogen.guard`.
        referencesAck: refs.length > 0 || !!frame,
      });
      await a.refreshJobs();
      s.pushToast(
        "info",
        variations > 1
          ? `Making ${variations} — they will open when they are ready.`
          : kind === "video"
            ? "Filming — a clip takes a few minutes."
            : "Making it — it will open when it is ready.",
      );
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cr-page">
      <header className="cr-head">
        <div>
          <h1 className="cr-title">Create</h1>
          <div className="nb-subtitle">
            pictures and video, made by whoever in this room can hold the pen
          </div>
        </div>
      </header>

      <div className="cr-body">
        {loading ? (
          <div className="cr-note">Reading what this room’s models can do…</div>
        ) : loadError ? (
          <div className="cr-note cr-note-bad">
            Could not read the model list: {loadError}
          </div>
        ) : (
          <>
            <Ledger
              catalog={catalog}
              counts={counts}
              open={whyOpen}
              onToggle={() => setWhyOpen((v) => !v)}
            />

            {models.length === 0 ? (
              <EmptyShelf catalog={catalog} />
            ) : (
              <>
                <div className="cr-controls">
                  <div className="cr-tabs" role="tablist" aria-label="What to make">
                    <Tab
                      label="Images"
                      count={counts.image}
                      on={surface === "image"}
                      mark="var(--mk-blue)"
                      onPick={() => setSurface("image")}
                    />
                    <Tab
                      label="Video"
                      count={counts.video}
                      on={surface === "video"}
                      mark="var(--mk-green)"
                      onPick={() => setSurface("video")}
                    />
                    <Tab
                      label="Story"
                      on={surface === "story"}
                      mark="var(--mk-yellow)"
                      onPick={() => setSurface("story")}
                    />
                  </div>
                  {surface !== "story" && (
                    <label className="cr-search">
                      <SearchIcon size={14} />
                      <input
                        type="search"
                        value={query}
                        placeholder="Filter by name…"
                        aria-label="Filter models by name"
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                  )}
                </div>

                {surface === "story" ? (
                  <StoryTab
                    s={s}
                    a={a}
                    models={models}
                    handoff={handoff}
                    onHandoffUsed={() => setHandoff(null)}
                  />
                ) : (
                  <div className="cr-worktable">
                    {/* THE WORKSPACE. This used to be a grid of model cards —
                        forty of them, filling the page, to make one choice
                        that is made once and then not thought about again.
                        The models are a dropdown on the bench now, and the
                        room's own work gets the space instead. */}
                    <Canvas
                      s={s}
                      a={a}
                      kind={kind}
                      activeJobs={activeJobs}
                      failedJobs={failedJobs}
                      made={made}
                      onDismiss={(id) => void a.dismissJob(id)}
                    />

                    <Bench
                      models={visible}
                      selected={selected}
                      onPickModel={setPickedModel}
                      query={query}
                      onQuery={setQuery}
                      total={kind === "video" ? counts.video : counts.image}
                      kind={kind}
                      prompt={prompt}
                      onPrompt={setPrompt}
                      variations={variations}
                      onVariations={setVariations}
                      frame={frame}
                      refs={refs}
                      seconds={seconds}
                      onSeconds={setSeconds}
                      resolution={resolution}
                      onResolution={setResolution}
                      aspectRatio={aspectRatio}
                      onAspectRatio={setAspectRatio}
                      onTakeToStory={() => {
                        setHandoff(prompt);
                        setSurface("story");
                      }}
                      onPickFrame={() => setPicking("frame")}
                      onPickRef={() => setPicking("ref")}
                      onClearFrame={() => setFrame(null)}
                      onClearRef={(id) => setRefs((r) => r.filter((p) => p.fileId !== id))}
                      busy={busy}
                      canGo={canGo}
                      onGenerate={() => void generate()}
                    />
                  </div>
                )}

                <PicturePicker
                  open={picking !== null}
                  title={
                    picking === "frame"
                      ? "Which picture does the clip start on?"
                      : "Which picture should it look like?"
                  }
                  onClose={() => setPicking(null)}
                  onPick={(p) => {
                    if (picking === "frame") setFrame(p);
                    else
                      setRefs((current) =>
                        current.some((x) => x.fileId === p.fileId)
                          ? current
                          : [...current, p],
                      );
                  }}
                />
              </>
            )}

          </>
        )}
      </div>
    </div>
  );
}

/** The gate, stated as a number. */
function Ledger({
  catalog,
  counts,
  open,
  onToggle,
}: {
  catalog: CreateCatalog | null;
  counts: ReturnType<typeof tallies>;
  open: boolean;
  onToggle: () => void;
}) {
  if (!catalog) return null;
  const { can, cannot } = counts;
  return (
    <section className="nb-panel cr-ledger">
      <div className="cr-ledger-top">
        <div className="cr-ledger-count">
          <span className="cr-ledger-big">{can}</span>
          <div className="cr-ledger-text">
            <b>
              of {counts.scanned} model{counts.scanned === 1 ? "" : "s"}
            </b>{" "}
            in this room can actually make a picture
            <span>
              Read live from each provider’s own catalogue — never a list kept
              in the app.
            </span>
          </div>
        </div>
        <div className="cr-tally">
          <Tally n={counts.image} label="Images" mark="var(--mk-blue)" />
          <Tally n={counts.video} label="Video" mark="var(--mk-green)" />
          <Tally n={cannot} label="Can’t" mark="var(--mk-red)" />
        </div>
      </div>

      {catalog.excluded.length > 0 && (
        <div className="cr-why">
          <button
            className="cr-why-toggle"
            aria-expanded={open}
            onClick={onToggle}
            type="button"
          >
            <span className={`cr-why-chevron${open ? " is-open" : ""}`} aria-hidden>
              ›
            </span>
            Why the other {cannot} aren’t here
          </button>
          {open && (
            <div className="cr-why-body">
              {catalog.excluded.map((row) => (
                <div className="cr-why-row" key={`${row.engineLabel}-${row.reason}`}>
                  <span className="cr-why-who">
                    {row.engineLabel}
                    <span className="nb-num cr-dim"> · {row.count}</span>
                  </span>
                  <span className="cr-why-reason">
                    {row.reason}
                    {row.examples.length > 0 && (
                      <span className="cr-why-eg"> {row.examples.join(", ")}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Tally({ n, label, mark }: { n: number; label: string; mark: string }) {
  return (
    <div className="cr-tally-item">
      <span className="cr-tally-n">{n}</span>
      <span className="cr-tally-l">
        <span className="cr-tally-dot" style={{ background: mark }} aria-hidden />
        {label}
      </span>
    </div>
  );
}

function Tab({
  label,
  count,
  on,
  mark,
  onPick,
}: {
  label: string;
  /** Absent for a tab that is not a shelf of models — Story counts nothing. */
  count?: number;
  on: boolean;
  mark: string;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={on}
      className={`cr-tab${on ? " is-active nb-underline" : ""}`}
      style={on ? ({ "--mk": mark } as React.CSSProperties) : undefined}
      onClick={onPick}
    >
      {label}
      {count !== undefined && <span className="nb-num cr-dim"> {count}</span>}
    </button>
  );
}

/** The workspace: what this room has actually made.
 *
 * This is the space the model gallery used to occupy. Forty index cards is a
 * lot of screen to spend on a choice made once per session — and it pushed the
 * pictures, the ones the page exists to produce, below the fold and into a
 * list of filenames. The models are a dropdown on the bench now; the work goes
 * here, at a size where you can see it. */
function Canvas({
  s,
  a,
  kind,
  activeJobs,
  failedJobs,
  made,
  onDismiss,
}: {
  s: WSState;
  a: WSActions;
  kind: "image" | "video";
  activeJobs: WSState["jobs"];
  failedJobs: WSState["jobs"];
  made: WSState["files"];
  onDismiss: (id: string) => void;
}) {
  const [thumbs, setThumbs] = useState<Record<string, string>>({});

  // Pre-shrunk previews, read once and re-read whenever the room's files
  // change. Streaming the real bytes to draw a 160px tile would cost hundreds
  // of megabytes for a page of pictures.
  useEffect(() => {
    let live = true;
    api
      .storyPictures()
      .then((all) => {
        if (!live) return;
        const next: Record<string, string> = {};
        for (const p of all) next[p.fileId] = p.thumbB64;
        setThumbs(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [made.length]);

  return (
    <section className="cr-canvas">
      {failedJobs.map((j) => (
        <div key={j.id} className="nb-card cr-job cr-job-bad" role="alert">
          <span className="cr-job-text">
            <span className="cr-job-title">{j.title} — nothing was made</span>
            {/* The provider's own words, verbatim. A generation is a paid
                call, so "it failed" without the reason is not enough to
                decide whether to spend another. */}
            <span className="cr-job-why">{j.error || "The reason was not recorded."}</span>
          </span>
          <button
            className="cr-job-dismiss"
            onClick={() => onDismiss(j.id)}
            aria-label="Dismiss this failure"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      ))}

      {activeJobs.map((j) => {
        const live = s.jobProgress[j.id];
        const pct = live ? Math.min(100, Math.round(live.done)) : 0;
        return (
          <div key={j.id} className="nb-card cr-job" role="status">
            <span className="cr-job-dot" aria-hidden="true" />
            <span className="cr-job-text">
              <span className="cr-job-title">{j.title}</span>
              <span className="cr-job-sub">{live?.label ?? "Queued"}</span>
            </span>
            <span
              className="cr-job-bar"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Generation progress"
            >
              <span className="cr-job-fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="nb-num cr-dim">{pct}%</span>
          </div>
        );
      })}

      {made.length === 0 ? (
        <div className="cr-empty cr-canvas-empty">
          <CreateIcon size={26} />
          <h2>Nothing made here yet</h2>
          <p>
            {kind === "video"
              ? "Describe a clip on the right — or start it from a picture that is already in this room."
              : "Describe a picture on the right. Anything you make lands in this room like any other file."}
          </p>
        </div>
      ) : (
        <>
          <div className="cr-sec-head">
            <span className="nb-subtitle">made in this room</span>
            <span className="nb-num cr-dim">
              {made.length} file{made.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="cr-canvas-grid">
            {made.map((f) => (
              <button
                key={f.id}
                className="cr-tile"
                onClick={() => void a.viewFile(f.id)}
                title={`Open ${f.name}`}
              >
                {thumbs[f.id] ? (
                  <img src={`data:image/jpeg;base64,${thumbs[f.id]}`} alt="" />
                ) : (
                  // No preview, and WHY matters. A clip has no still to show;
                  // anything else generated here is not a picture at all.
                  // Labelling a document "clip" — which is what a single
                  // fallback did — states something false about the file.
                  <span className="cr-tile-clip">
                    <CreateIcon size={20} />
                    <span>{f.mimeType?.startsWith("video/") ? "clip" : "file"}</span>
                  </span>
                )}
                <span className="cr-tile-name">{f.name}</span>
                <span className="nb-num cr-dim">{formatSize(f.sizeBytes)}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Which model, as one line instead of forty cards.
 *
 * The cards carried more than a name — engine, medium, whether it leaves the
 * Mac — and none of that may be lost just because the control got smaller. So
 * the facts move under the dropdown, for the ONE model actually chosen, which
 * is the only one they were ever needed for. */
function ModelPicker({
  models,
  selected,
  onPick,
  query,
  onQuery,
  kind,
  total,
}: {
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
}) {
  const limits = selected?.limits ?? null;

  return (
    <div className="cr-picker">
      <label className="cr-field-label" htmlFor="cr-model">
        Which model
      </label>
      <select
        id="cr-model"
        className="cr-field cr-select cr-model-select"
        value={selected?.model ?? ""}
        onChange={(e) => onPick(e.target.value)}
      >
        {models.length === 0 && <option value="">no model available</option>}
        {models.map((m) => (
          <option key={m.model} value={m.model}>
            {m.label}
          </option>
        ))}
      </select>

      {(total > 8 || query.trim()) && (
        <input
          type="search"
          className="cr-field cr-model-filter"
          value={query}
          placeholder={`Filter ${total} models…`}
          aria-label="Filter models by name"
          onChange={(e) => onQuery(e.target.value)}
        />
      )}

      {models.length === 0 && (
        <p className="cr-hint">{emptyShelfLine(kind, query)}</p>
      )}

      {selected && (
        <div className="cr-picker-facts">
          <span className="cr-bench-slug">{selected.slug}</span>
          <span className="cr-picker-tags">
            <span className="nb-tape" style={{ "--mk": "var(--mk-blue)" } as React.CSSProperties}>
              {selected.engineLabel}
            </span>
            {!selected.local && (
              <span
                className="nb-tape"
                style={{ "--mk": "var(--mk-yellow)" } as React.CSSProperties}
              >
                Leaves room
              </span>
            )}
            {limits?.generateAudio && (
              <span
                className="nb-tape"
                style={{ "--mk": "var(--mk-green)" } as React.CSSProperties}
              >
                With sound
              </span>
            )}
          </span>
          {selected.description && (
            <p className="cr-picker-desc">{selected.description}</p>
          )}
        </div>
      )}
    </div>
  );
}

/** The compose panel. */
function Bench({
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
}: {
  models: CreateModel[];
  selected: CreateModel | null;
  onPickModel: (model: string) => void;
  query: string;
  onQuery: (v: string) => void;
  /** The tab's count before filtering. */
  total: number;
  kind: "image" | "video";
  prompt: string;
  onPrompt: (v: string) => void;
  variations: number;
  onVariations: (v: number) => void;
  frame: RoomPicture | null;
  refs: RoomPicture[];
  seconds: number | null;
  onSeconds: (v: number | null) => void;
  resolution: string;
  onResolution: (v: string) => void;
  aspectRatio: string;
  onAspectRatio: (v: string) => void;
  onTakeToStory: () => void;
  onPickFrame: () => void;
  onPickRef: () => void;
  onClearFrame: () => void;
  onClearRef: (fileId: string) => void;
  busy: boolean;
  canGo: boolean;
  onGenerate: () => void;
}) {
  const lengths = legalSeconds(selected);
  const framesOk = takesFirstFrame(selected);
  const maxRefs = selected?.limits?.maxReferences ?? null;
  const sending = refs.length + (kind === "video" && frame ? 1 : 0);
  // Only what this model publishes. An empty list is the provider declining to
  // say, so the control disappears rather than offering invented values.
  const sizes = selected?.limits?.resolutions ?? [];
  const shapes = selected?.limits?.aspectRatios ?? [];

  return (
    <aside className="nb-panel cr-bench" aria-label="Compose">
      <div className="cr-bench-head">
        <h2>The bench</h2>
        <span className="nb-num cr-dim">{kind === "video" ? "moving" : "still"}</span>
      </div>

      <ModelPicker
        models={models}
        selected={selected}
        onPick={onPickModel}
        query={query}
        onQuery={onQuery}
        kind={kind}
        total={total}
      />

      <div>
        <label className="cr-field-label" htmlFor="cr-prompt">
          Describe it
        </label>
        <textarea
          id="cr-prompt"
          className="cr-field"
          value={prompt}
          rows={3}
          placeholder={
            kind === "video"
              ? "The boat pulls away, the light going out of the sky"
              : "A lighthouse at dusk, the storm still an hour out"
          }
          onChange={(e) => onPrompt(e.target.value)}
        />
        <WholeScriptNotice prompt={prompt} kind={kind} onTakeToStory={onTakeToStory} />
      </div>

      {/* Pictures from this room. The frame slot is video-only and is a
          genuinely different thing from a reference: the clip BEGINS on that
          picture, rather than merely resembling it. */}
      {kind === "video" && (
        <div>
          <span className="cr-field-label">Start from a picture</span>
          {!framesOk ? (
            <p className="cr-hint">
              {selected?.slug} makes a clip from words alone — it takes no
              starting picture, so attaching one would do nothing.
            </p>
          ) : frame ? (
            <Attached picture={frame} role="first frame" onClear={onClearFrame} />
          ) : (
            <button type="button" className="nb-btn cr-attach" onClick={onPickFrame}>
              Use a picture from this room
            </button>
          )}
        </div>
      )}

      <div>
        <span className="cr-field-label">
          {kind === "video" ? "Make it look like" : "Look like these"}
        </span>
        <div className="cr-attach-row">
          {refs.map((p) => (
            <Attached
              key={p.fileId}
              picture={p}
              role="reference"
              onClear={() => onClearRef(p.fileId)}
            />
          ))}
          {(maxRefs === null || refs.length < maxRefs) && (
            <button type="button" className="nb-btn cr-attach" onClick={onPickRef}>
              {refs.length === 0 ? "Attach a picture" : "Attach another"}
            </button>
          )}
        </div>
        {maxRefs !== null && refs.length >= maxRefs && (
          <p className="cr-hint">
            {selected?.slug} looks at {maxRefs} picture{maxRefs === 1 ? "" : "s"} at
            most.
          </p>
        )}
      </div>

      {kind === "video" && lengths.length > 0 && (
        <div>
          <span className="cr-field-label">How long</span>
          <div className="cr-opts">
            {/* Only the lengths this model publishes. An illegal number does
                not produce a shorter clip — it produces a refusal, and on the
                models with a per-generation floor, a charge for nothing. */}
            {lengths.map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={seconds === v}
                className={`cr-opt${seconds === v ? " is-on pick-on" : ""}`}
                onClick={() => onSeconds(seconds === v ? null : v)}
              >
                {seconds === v && <CheckIcon size={12} />}
                {v}s
              </button>
            ))}
          </div>
          {seconds === null && (
            <p className="cr-hint">
              Nothing chosen — it will use {Math.min(...lengths)}s, the shortest
              this model makes.
            </p>
          )}
        </div>
      )}

      {/* Size and shape, from the model's OWN published lists. These were
          being sent all along and quietly dropped — the image seam had no
          field for them at all — so the page never offered them. */}
      {(sizes.length > 0 || shapes.length > 0) && (
        <div className="cr-shape-knobs">
          {shapes.length > 0 && (
            <label className="cr-knob">
              <span>Frame shape</span>
              <select
                className="cr-field cr-select"
                value={aspectRatio}
                onChange={(e) => onAspectRatio(e.target.value)}
              >
                <option value="">model’s own</option>
                {shapes.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
          {sizes.length > 0 && (
            <label className="cr-knob">
              <span>Size</span>
              <select
                className="cr-field cr-select"
                value={resolution}
                onChange={(e) => onResolution(e.target.value)}
              >
                <option value="">model’s own</option>
                {sizes.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      <div>
        <span className="cr-field-label">How many</span>
        <div className="cr-opts">
          {[1, 2, 4].map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={variations === n}
              className={`cr-opt${variations === n ? " is-on pick-on" : ""}`}
              onClick={() => onVariations(n)}
            >
              {variations === n && <CheckIcon size={12} />}
              {n}
            </button>
          ))}
        </div>
      </div>

      {/* The seam. Every generation model in the catalogue today is a trip off
          this Mac, and a prompt is room content — so the page says so before
          the button rather than after the bill. When pictures are attached it
          says HOW MANY: consent that does not name what is being sent is not
          consent, and this is the only thing that opens the privacy door. */}
      {selected && !selected.local && (
        <div className="cr-seam">
          <LockIcon size={14} />
          <p>
            This runs on {selected.engineLabel}, so the words you type leave this
            Mac — the room’s privacy door redacts them first.
            {sending > 0 && (
              <>
                {" "}
                <b>
                  The {sending} picture{sending === 1 ? "" : "s"} above will be
                  sent as well
                </b>
                , un-redacted, because a picture cannot be. Remove them to keep
                them here.
              </>
            )}
          </p>
        </div>
      )}

      <button
        className="nb-btn nb-btn-primary cr-go"
        type="button"
        disabled={busy || !canGo}
        onClick={onGenerate}
      >
        {busy ? "Starting…" : sending > 0 ? "Send and make it" : "Make it"}
      </button>
      <p className="cr-bench-hint">
        {kind === "video"
          ? "A clip takes a few minutes. It runs in the background and lands in this room when it is ready."
          : "Runs in the background — it opens here when it is ready, and lands in this room like any other file."}
      </p>
    </aside>
  );
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
function WholeScriptNotice({
  prompt,
  kind,
  onTakeToStory,
}: {
  prompt: string;
  kind: "image" | "video";
  onTakeToStory: () => void;
}) {
  const [plan, setPlan] = useState<ShotPlan | null>(null);
  const text = prompt.trim();

  useEffect(() => {
    // Only worth asking about something long enough to be a script. A short
    // prompt is one shot, which is what this bench is for.
    if (text.length < 400) {
      setPlan(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      api
        .storyPlanSplit(text, 5, 15)
        .then((next) => live && setPlan(next))
        .catch(() => live && setPlan(null));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [text]);

  // Only when the script SAYS it is one — timestamped chunks of its own. For
  // anything else, "this looks like a script" would be a guess, and a guess
  // that nags is worse than silence.
  if (!plan?.fromScript || plan.parts < 2) return null;

  const total = plan.totalSeconds;
  return (
    <div className="cr-note cr-note-warn cr-script-note">
      <p>
        This marks its own <b>{plan.parts} chunks</b> — {clock(total)} in all.
        The bench makes <b>one</b> {kind === "video" ? "clip" : "picture"}, so
        it would use all of this text for a single{" "}
        {kind === "video" ? "clip" : "picture"} and the other{" "}
        {plan.parts - 1} chunks would not be made.
      </p>
      <button type="button" className="nb-btn" onClick={onTakeToStory}>
        Take it to Story — {plan.parts} parts
      </button>
    </div>
  );
}

/** Nothing can draw. Which of the three reasons matters a great deal — see
 * `emptyReason`, which is where the choice actually lives. */
function EmptyShelf({ catalog }: { catalog: CreateCatalog | null }) {
  const reason = emptyReason(catalog);
  if (reason === null || reason === "loading") return null;
  if (reason === "error") {
    return (
      <div className="cr-note cr-note-bad">
        Connected, but the catalogue would not load: {catalog?.error}
      </div>
    );
  }
  if (reason === "no-provider") {
    return (
      <div className="cr-empty">
        <CreateIcon size={26} />
        <h2>No provider is connected</h2>
        <p>
          Nothing that runs on this Mac can make a picture yet — Ollama serves
          chat models, and a drawing model is not reachable over its chat API.
          Connect a provider in Settings → AI providers and the models it
          offers will appear here.
        </p>
      </div>
    );
  }
  return (
    <div className="cr-empty">
      <CreateIcon size={26} />
      <h2>Nothing here can draw</h2>
      <p>
        The connected provider’s catalogue lists {catalog?.scanned ?? 0} models
        and none of them produces pictures.
      </p>
    </div>
  );
}
