import { useEffect, useMemo, useState } from "react";
import { api, type FilmPlan, type ShotPreview } from "../../api";
import { LockIcon } from "../../icons";
import { clock } from "./clock";

type ReviewProps = {
  listId: string;
  kind: "image" | "video";
  continuous: boolean;
  busy: boolean;
  onClose: () => void;
  onSend: () => void;
};

function useReviewData(
  listId: string,
  kind: ReviewProps["kind"],
  continuous: boolean,
) {
  const [plan, setPlan] = useState<FilmPlan | null>(null);
  const [error, setError] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    api.storyFilmPlan(listId, kind, continuous).then(
      (next) => live && (setPlan(next), setError("")),
      (reason) => live && setError(String(reason)),
    );
    api
      .storyPictures()
      .then((pictures) => {
        if (!live) return;
        setThumbs(
          Object.fromEntries(
            pictures.map((picture) => [picture.fileId, picture.thumbB64]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [listId, kind, continuous]);
  return { plan, error, thumbs };
}

function words(kind: ReviewProps["kind"]) {
  return kind === "video" ? ["film", "clip"] : ["draw", "picture"];
}
function sendingShots(plan: FilmPlan) {
  return plan.shots.filter((shot) => !shot.skip);
}

export function FilmReview(props: ReviewProps) {
  const { plan, error, thumbs } = useReviewData(
    props.listId,
    props.kind,
    props.continuous,
  );
  const [verb] = words(props.kind);
  return (
    <div
      className="cr-review-back"
      role="dialog"
      aria-modal="true"
      aria-label={`Before you ${verb} them`}
    >
      <div className="nb-panel cr-review">
        <ReviewHeader verb={verb} onClose={props.onClose} />
        <ReviewState {...props} plan={plan} error={error} thumbs={thumbs} />
      </div>
    </div>
  );
}

function ReviewHeader({
  verb,
  onClose,
}: {
  verb: string;
  onClose: () => void;
}) {
  return (
    <div className="cr-sec-head">
      <span className="nb-subtitle">before you {verb} them</span>
      <button
        type="button"
        className="cr-pick-x"
        onClick={onClose}
        aria-label="Close"
      >
        ✕
      </button>
    </div>
  );
}

function ReviewState(
  props: ReviewProps & {
    plan: FilmPlan | null;
    error: string;
    thumbs: Record<string, string>;
  },
) {
  if (props.error)
    return <div className="cr-note cr-note-bad">{props.error}</div>;
  if (!props.plan)
    return <div className="cr-note">Working out what this would do…</div>;
  return <PlanReview {...props} plan={props.plan} />;
}

function PlanReview({
  plan,
  kind,
  busy,
  onClose,
  onSend,
  thumbs,
}: ReviewProps & { plan: FilmPlan; thumbs: Record<string, string> }) {
  const [verb, noun] = words(kind);
  const sending = useMemo(() => sendingShots(plan), [plan]);
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);
  return (
    <>
      <Summary plan={plan} kind={kind} noun={noun} />
      <ol className="cr-review-rows">
        {plan.shots.map((shot) => (
          <ReviewRow
            key={shot.shotId}
            shot={shot}
            kind={kind}
            thumbs={thumbs}
            open={openPrompt === shot.shotId}
            onToggle={() =>
              setOpenPrompt((open) =>
                open === shot.shotId ? null : shot.shotId,
              )
            }
          />
        ))}
      </ol>
      <div className="cr-seam">
        <LockIcon size={14} />
        <p>
          Each part is sent to the provider on its own: its prompt above, and
          any picture shown with it. A hero’s written backstory is never sent.
        </p>
      </div>
      <div className="cr-form-acts">
        <button type="button" className="nb-btn" onClick={onClose}>
          Not yet
        </button>
        <button
          type="button"
          className="nb-btn nb-btn-primary"
          disabled={busy || sending.length === 0 || plan.overCap}
          onClick={onSend}
        >
          {sending.length === 0
            ? `Nothing to ${verb}`
            : `Send all ${sending.length} — ${verb} them`}
        </button>
      </div>
    </>
  );
}

function Summary({
  plan,
  kind,
  noun,
}: {
  plan: FilmPlan;
  kind: ReviewProps["kind"];
  noun: string;
}) {
  return (
    <div className="cr-review-sum">
      <SummaryCount plan={plan} kind={kind} noun={noun} />
      <QueueNotice sending={plan.sending} />
      <ContinuityNotice plan={plan} kind={kind} />
      <FacelessNotice names={plan.faceless} />
      <BlockedNotice plan={plan} kind={kind} />
      <SkippedNotice skipped={plan.skipped} />
      <CapNotice overCap={plan.overCap} />
    </div>
  );
}
function SummaryCount({
  plan,
  kind,
  noun,
}: {
  plan: FilmPlan;
  kind: ReviewProps["kind"];
  noun: string;
}) {
  return (
    <div className="cr-review-big">
      <b>{plan.sending}</b> {noun}
      {plan.sending === 1 ? "" : "s"} to pay for{" "}
      {kind === "video" && plan.totalSeconds > 0 && (
        <>
          {" "}
          · <b>{clock(plan.totalSeconds)}</b> of video
        </>
      )}
    </div>
  );
}
function QueueNotice({ sending }: { sending: number }) {
  if (sending <= 1) return null;
  return (
    <p className="cr-hint">
      They are queued together and run <b>one at a time</b>, in this order. The
      first lands in a few minutes; the last one lands well after it. All{" "}
      {sending} appear in the list above the bench as they go.
    </p>
  );
}
function ContinuityNotice({
  plan,
  kind,
}: {
  plan: FilmPlan;
  kind: ReviewProps["kind"];
}) {
  if (kind !== "video" || plan.sending <= 1) return null;
  return (
    <p className="cr-hint">
      {plan.joined === 0 ? (
        "None of these will run on from each other — turn on continuous, or pick a clip model that takes a starting picture."
      ) : (
        <>
          <b>{plan.joined}</b> of these open on the <b>exact final frame</b> of
          the clip before them, captured from the finished video when it lands.
          If an end frame ever cannot be read, that one cut falls back to the
          drawn picture and the job’s progress bar says so — nothing is skipped.
        </>
      )}
    </p>
  );
}
function FacelessNotice({ names }: { names: string[] }) {
  if (!names.length) return null;
  const singular = names.length === 1;
  return (
    <div className="cr-note cr-note-bad">
      <b>{names.join(", ")}</b> {singular ? "has" : "have"} no picture, so{" "}
      {singular ? "they will" : "they will each"} be drawn from the words alone
      — which come out as a different person every time. Give{" "}
      {singular ? "them" : "each of them"} a face in the cast strip first.
    </div>
  );
}
function BlockedNotice({
  plan,
  kind,
}: {
  plan: FilmPlan;
  kind: ReviewProps["kind"];
}) {
  if (kind !== "video" || !plan.joinBlockedBy || plan.joined <= 0) return null;
  return (
    <p className="cr-hint">
      {plan.joinBlockedBy} takes no ending picture, so each clip ends wherever
      it likes — but the next one still opens on its real final frame, so the
      joins hold either way.
    </p>
  );
}
function SkippedNotice({ skipped }: { skipped: number }) {
  if (!skipped) return null;
  return (
    <p className="cr-hint">
      {skipped} {skipped === 1 ? "part is" : "parts are"} not being sent — each
      one says why below.
    </p>
  );
}
function CapNotice({ overCap }: { overCap: boolean }) {
  return overCap ? (
    <div className="cr-note cr-note-bad">
      That is more than this room will queue in one press. Make the first batch,
      then come back for the rest.
    </div>
  ) : null;
}

function ReviewRow({
  shot,
  kind,
  thumbs,
  open,
  onToggle,
}: {
  shot: ShotPreview;
  kind: ReviewProps["kind"];
  thumbs: Record<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <li className={`cr-review-row${shot.skip ? " is-skipped" : ""}`}>
      <span className="cr-shot-n">{shot.n}</span>
      <div className="cr-review-main">
        <RowMeta shot={shot} kind={kind} />
        {shot.skip && (
          <p className="cr-review-skip">Not being sent — {shot.skip}.</p>
        )}
        <Prompt shot={shot} open={open} onToggle={onToggle} />
        <RowFrames shot={shot} kind={kind} thumbs={thumbs} />
      </div>
    </li>
  );
}
function RowMeta({
  shot,
  kind,
}: {
  shot: ShotPreview;
  kind: ReviewProps["kind"];
}) {
  return (
    <div className="cr-review-top">
      <ModelFacts shot={shot} />
      <CastFacts shot={shot} kind={kind} />
    </div>
  );
}
function ModelFacts({ shot }: { shot: ShotPreview }) {
  return (
    <>
      <span className="cr-review-model nb-num">{shot.model || "no model"}</span>
      {shot.seconds !== null && (
        <span className="cr-review-secs nb-num">{shot.seconds}s</span>
      )}
    </>
  );
}
function CastFacts({
  shot,
  kind,
}: {
  shot: ShotPreview;
  kind: ReviewProps["kind"];
}) {
  return (
    <>
      {shot.cast.length > 0 && (
        <span className="cr-review-cast">{shot.cast.join(", ")}</span>
      )}
      {shot.cast.length === 0 && !shot.skip && kind === "image" && (
        <span className="cr-review-warn">nobody in this shot</span>
      )}
      {shot.faceless.length > 0 && (
        <span className="cr-review-warn">
          {shot.faceless.join(", ")} — no picture
        </span>
      )}
    </>
  );
}
function Prompt({
  shot,
  open,
  onToggle,
}: {
  shot: ShotPreview;
  open: boolean;
  onToggle: () => void;
}) {
  const text =
    shot.prompt.length > 160 && !open
      ? `${shot.prompt.slice(0, 160)}…`
      : shot.prompt;
  return (
    <button
      type="button"
      className="cr-review-prompt"
      onClick={onToggle}
      title={open ? "Show less" : "Show the whole prompt"}
    >
      {text}
    </button>
  );
}
function RowFrames({
  shot,
  kind,
  thumbs,
}: {
  shot: ShotPreview;
  kind: ReviewProps["kind"];
  thumbs: Record<string, string>;
}) {
  if (shot.skip) return null;
  if (kind === "video") return <VideoFrames shot={shot} thumbs={thumbs} />;
  return shot.referenceFileIds.length ? (
    <div className="cr-review-frames">
      {shot.referenceFileIds.map((id) => (
        <Frame
          key={id}
          label="looks like"
          fileId={id}
          thumbs={thumbs}
          missing=""
        />
      ))}
    </div>
  ) : null;
}
function VideoFrames({
  shot,
  thumbs,
}: {
  shot: ShotPreview;
  thumbs: Record<string, string>;
}) {
  return (
    <div className="cr-review-frames">
      {shot.startsOnPrevious ? (
        <span className="cr-review-frame">
          <span className="cr-review-flabel">opens on</span>
          <span className="cr-review-fnone">
            the exact final frame of the part before — captured when it lands
          </span>
        </span>
      ) : (
        <Frame
          label="opens on"
          fileId={shot.startFileId}
          thumbs={thumbs}
          missing="no picture drawn yet — it will be made from words alone"
        />
      )}
      <span className="cr-review-arrow" aria-hidden>
        →
      </span>
      <Frame
        label="closes on"
        fileId={shot.endFileId}
        thumbs={thumbs}
        missing="nothing to close on — this part will not run on into the next"
      />
    </div>
  );
}
function Frame({
  label,
  fileId,
  thumbs,
  missing,
}: {
  label: string;
  fileId: string | null;
  thumbs: Record<string, string>;
  missing: string;
}) {
  if (!fileId)
    return missing ? (
      <span className="cr-review-frame is-empty">
        <span className="cr-review-flabel">{label}</span>
        <span className="cr-review-fnone">{missing}</span>
      </span>
    ) : null;
  const thumb = thumbs[fileId];
  return (
    <span className="cr-review-frame">
      <span className="cr-review-flabel">{label}</span>
      {thumb ? (
        <img src={`data:image/jpeg;base64,${thumb}`} alt="" />
      ) : (
        <span className="cr-review-fnone">a picture from this room</span>
      )}
    </span>
  );
}
