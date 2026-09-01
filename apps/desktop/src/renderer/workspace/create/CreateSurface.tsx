import { useEffect, useState } from "react";
import { api, formatSize, type CreateCatalog, type CreateModel, type RoomPicture } from "../../api";
import { CreateIcon } from "../../icons";
import type { WSState } from "../state";
import type { WSActions } from "../actions";
import { PicturePicker } from "./PicturePicker";
import { StoryTab } from "./StoryTab";
import { tallies } from "./selectors";
import { Bench, type BenchProps } from "./CreateBench";
import { EmptyShelf } from "./CreateNotices";
import type { Surface } from "./CreatePage";

export function CreateLayout({ children }: { children: React.ReactNode }) {
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
      <div className="cr-body">{children}</div>
    </div>
  );
}

export type CreatePageBodyProps = {
  s: WSState;
  a: WSActions;
  catalog: CreateCatalog | null;
  loading: boolean;
  loadError: string | null;
  counts: ReturnType<typeof tallies>;
  surface: Surface;
  onSurface: (surface: Surface) => void;
  whyOpen: boolean;
  onToggleWhy: () => void;
  models: CreateModel[];
  handoff: string | null;
  onHandoffUsed: () => void;
  kind: "image" | "video";
  activeJobs: WSState["jobs"];
  failedJobs: WSState["jobs"];
  made: WSState["files"];
  bench: BenchProps;
  picking: "frame" | "ref" | null;
  onClosePicker: () => void;
  onPickPicture: (picture: RoomPicture) => void;
};

export function CreatePageBody(props: CreatePageBodyProps) {
  if (props.loading) return <div className="cr-note">Reading what this room’s models can do…</div>;
  return (
    <>
      {props.loadError && <div className="cr-note cr-note-bad">Could not read the model list: {props.loadError}</div>}
      <Ledger catalog={props.catalog} counts={props.counts} open={props.whyOpen} onToggle={props.onToggleWhy} />
      <CreateTabs catalog={props.catalog} counts={props.counts} surface={props.surface} onSurface={props.onSurface} />
      <CreateSurface {...props} />
    </>
  );
}

export function CreateTabs({
  catalog,
  counts,
  surface,
  onSurface,
}: Pick<CreatePageBodyProps, "catalog" | "counts" | "surface" | "onSurface">) {
  return (
    <div className="cr-controls">
      <div className="cr-tabs" role="tablist" aria-label="What to make">
        <Tab label="Images" count={catalog ? counts.image : undefined} on={surface === "image"} mark="var(--mk-blue)" onPick={() => onSurface("image")} />
        <Tab label="Video" count={catalog ? counts.video : undefined} on={surface === "video"} mark="var(--mk-green)" onPick={() => onSurface("video")} />
        <Tab label="Story" on={surface === "story"} mark="var(--mk-yellow)" onPick={() => onSurface("story")} />
      </div>
    </div>
  );
}

export function CreateSurface(props: CreatePageBodyProps) {
  if (props.surface === "story") {
    return <StoryTab s={props.s} a={props.a} models={props.models} handoff={props.handoff} onHandoffUsed={props.onHandoffUsed} />;
  }
  if (props.models.length === 0) return <EmptyShelf catalog={props.catalog} />;
  return <CreateBenchSurface {...props} />;
}

export function CreateBenchSurface({
  s,
  a,
  kind,
  activeJobs,
  failedJobs,
  made,
  bench,
  picking,
  onClosePicker,
  onPickPicture,
}: CreatePageBodyProps) {
  return (
    <>
      <div className="cr-worktable">
        <Canvas
          s={s}
          a={a}
          kind={kind}
          activeJobs={activeJobs}
          failedJobs={failedJobs}
          made={made}
          onDismiss={(id) => void a.dismissJob(id)}
        />
        <Bench {...bench} />
      </div>
      <PicturePicker
        open={picking !== null}
        title={pickerTitle(picking)}
        onClose={onClosePicker}
        onPick={onPickPicture}
      />
    </>
  );
}

export function pickerTitle(picking: CreatePageBodyProps["picking"]): string {
  return picking === "frame"
    ? "Which picture does the clip start on?"
    : "Which picture should it look like?";
}

export function addPictureReference(current: RoomPicture[], picture: RoomPicture): RoomPicture[] {
  return current.some((candidate) => candidate.fileId === picture.fileId) ? current : [...current, picture];
}

/** The gate, stated as a number. */
export function Ledger({
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

export function Tally({ n, label, mark }: { n: number; label: string; mark: string }) {
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

export function Tab({
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
export function Canvas({
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

      {/* No bar and no figure. `done` only moves at a VARIATION boundary, so
          the ordinary one-picture job reported 0% from its first event to its
          last — a determinate meter stuck at zero for three minutes, which
          says something false about a paid call. The provider's own percentage
          is already in the label when there is one, and the label says no
          number when there is not. */}
      {activeJobs.map((j) => {
        const live = s.jobProgress[j.id];
        return (
          <div key={j.id} className="nb-card cr-job" role="status">
            <span className="cr-job-dot" aria-hidden="true" />
            <span className="cr-job-text">
              <span className="cr-job-title">{j.title}</span>
              <span className="cr-job-sub">
                {live?.label ?? (j.status === "queued" ? "Queued" : "Working…")}
              </span>
            </span>
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
