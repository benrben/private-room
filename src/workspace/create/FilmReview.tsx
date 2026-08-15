import { useEffect, useMemo, useState } from "react";
import { api, type FilmPlan, type ShotPreview } from "../../api";
import { LockIcon } from "../../icons";
import { clock } from "./clock";

/** Read the whole run before any of it is paid for.
 *
 * A generation is billed, and a list is twenty of them. Every other control on
 * this page can be undone by clicking it again; this one cannot, so it is the
 * last place the run can be read as a whole — and the only place the two
 * questions that actually matter can be answered:
 *
 *   * **what words is each part being sent?** Not the line typed in the row —
 *     the assembled prompt, logline and cast descriptions and all, exactly as
 *     the model will receive it. That string is the shot; the row is an
 *     abbreviation of it.
 *   * **which picture does each part open and close on?** The join between
 *     shots is a picture, not a description, so it can be looked at. A part
 *     with no closing picture is a part that will not run on into the next
 *     one, and that is visible here rather than discovered afterwards.
 *
 * The plan is built by the same Rust that runs the job (`plan_shot_list`),
 * never assembled again on this side. A preview drawn from separate code is
 * one edit away from putting a claim on screen above a button that pays for
 * something else. */
export function FilmReview({
  listId,
  kind,
  continuous,
  busy,
  onClose,
  onSend,
}: {
  listId: string;
  kind: "image" | "video";
  continuous: boolean;
  busy: boolean;
  onClose: () => void;
  onSend: () => void;
}) {
  const [plan, setPlan] = useState<FilmPlan | null>(null);
  const [error, setError] = useState("");
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [openPrompt, setOpenPrompt] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .storyFilmPlan(listId, kind, continuous)
      .then((next) => live && (setPlan(next), setError("")))
      .catch((e) => live && setError(String(e)));
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
  }, [listId, kind, continuous]);

  const verb = kind === "video" ? "film" : "draw";
  const noun = kind === "video" ? "clip" : "picture";

  // Only the parts that will actually be sent. A run of twenty-one where two
  // are skipped is a run of nineteen, and the number above the button has to
  // be the number the button does.
  const sending = useMemo(
    () => plan?.shots.filter((s) => !s.skip) ?? [],
    [plan],
  );

  return (
    <div className="cr-review-back" role="dialog" aria-modal="true" aria-label={`Before you ${verb} them`}>
      <div className="nb-panel cr-review">
        <div className="cr-sec-head">
          <span className="nb-subtitle">before you {verb} them</span>
          <button type="button" className="cr-pick-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {error && <div className="cr-note cr-note-bad">{error}</div>}
        {!plan && !error && <div className="cr-note">Working out what this would do…</div>}

        {plan && (
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
                    setOpenPrompt((v) => (v === shot.shotId ? null : shot.shotId))
                  }
                />
              ))}
            </ol>

            {/* The seam, stated where the money is. Faces are pictures and a
                picture cannot be redacted — so what leaves the room is named
                before the button, not after the bill. */}
            <div className="cr-seam">
              <LockIcon size={14} />
              <p>
                Each part is sent to the provider on its own: its prompt above,
                and any picture shown with it. A hero’s written backstory is
                never sent.
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
        )}
      </div>
    </div>
  );
}

/** The arithmetic, said once, above the detail. */
function Summary({
  plan,
  kind,
  noun,
}: {
  plan: FilmPlan;
  kind: "image" | "video";
  noun: string;
}) {
  return (
    <div className="cr-review-sum">
      <div className="cr-review-big">
        <b>{plan.sending}</b> {noun}
        {plan.sending === 1 ? "" : "s"} to pay for
        {kind === "video" && plan.totalSeconds > 0 && (
          <>
            {" · "}
            <b>{clock(plan.totalSeconds)}</b> of video
          </>
        )}
      </div>

      {/* THE ANSWER TO "it only made one". They do not run at once — the room
          has a single running slot, on purpose, so twenty clips are twenty
          waits end to end. Someone watching the page sees one clip finish and
          reasonably concludes that was all of it. */}
      {plan.sending > 1 && (
        <p className="cr-hint">
          They are queued together and run <b>one at a time</b>, in this order.
          The first lands in a few minutes; the last one lands well after it.
          All {plan.sending} appear in the list above the bench as they go.
        </p>
      )}

      {kind === "video" && plan.sending > 1 && (
        <p className="cr-hint">
          {plan.joined === 0 ? (
            <>
              None of these will run on from each other — turn on continuous,
              or pick a clip model that takes a starting picture.
            </>
          ) : (
            <>
              <b>{plan.joined}</b> of these open on the <b>exact final frame</b>{" "}
              of the clip before them, captured from the finished video when it
              lands. If an end frame ever cannot be read, that one cut falls
              back to the drawn picture and the job’s progress bar says so —
              nothing is skipped.
            </>
          )}
        </p>
      )}

      {/* THE TWO THINGS THAT MAKE AN EPISODE LOOK LIKE ONE EPISODE, and both
          were only discoverable by watching the finished clips. A person with
          no portrait is re-imagined from words on every call; a model that
          takes no ending picture makes twenty clips that do not run on from
          each other. Neither fails, so neither shows up as an error. */}
      {plan.faceless.length > 0 && (
        <div className="cr-note cr-note-bad">
          <b>{plan.faceless.join(", ")}</b>{" "}
          {plan.faceless.length === 1 ? "has" : "have"} no picture, so{" "}
          {plan.faceless.length === 1 ? "they will" : "they will each"} be drawn
          from the words alone — which come out as a different person every
          time. Give {plan.faceless.length === 1 ? "them" : "each of them"} a
          face in the cast strip first.
        </div>
      )}

      {kind === "video" && plan.joinBlockedBy && plan.joined > 0 && (
        <p className="cr-hint">
          {plan.joinBlockedBy} takes no ending picture, so each clip ends
          wherever it likes — but the next one still opens on its real final
          frame, so the joins hold either way.
        </p>
      )}

      {plan.skipped > 0 && (
        <p className="cr-hint">
          {plan.skipped} {plan.skipped === 1 ? "part is" : "parts are"} not being
          sent — each one says why below.
        </p>
      )}

      {plan.overCap && (
        <div className="cr-note cr-note-bad">
          That is more than this room will queue in one press. Make the first
          batch, then come back for the rest.
        </div>
      )}
    </div>
  );
}

function ReviewRow({
  shot,
  kind,
  thumbs,
  open,
  onToggle,
}: {
  shot: ShotPreview;
  kind: "image" | "video";
  thumbs: Record<string, string>;
  open: boolean;
  onToggle: () => void;
}) {
  // The whole prompt is long — logline, every hero's description, the action.
  // Shown in full on demand rather than truncated silently, because the point
  // of the sheet is that nothing about the call is hidden.
  const short = shot.prompt.length > 160 && !open
    ? `${shot.prompt.slice(0, 160)}…`
    : shot.prompt;

  return (
    <li className={`cr-review-row${shot.skip ? " is-skipped" : ""}`}>
      <span className="cr-shot-n">{shot.n}</span>

      <div className="cr-review-main">
        <div className="cr-review-top">
          <span className="cr-review-model nb-num">{shot.model || "no model"}</span>
          {shot.seconds !== null && (
            <span className="cr-review-secs nb-num">{shot.seconds}s</span>
          )}
          {shot.cast.length > 0 && (
            <span className="cr-review-cast">{shot.cast.join(", ")}</span>
          )}
          {shot.cast.length === 0 && !shot.skip && kind === "image" && (
            // An empty cast on a drawn shot is why a lead changes face between
            // scenes. Worth saying on the row, not only in the total.
            <span className="cr-review-warn">nobody in this shot</span>
          )}
          {shot.faceless.length > 0 && (
            <span className="cr-review-warn">
              {shot.faceless.join(", ")} — no picture
            </span>
          )}
        </div>

        {shot.skip ? (
          // Never colour alone: the reason is written out, and the row is the
          // only place it can be read.
          <p className="cr-review-skip">Not being sent — {shot.skip}.</p>
        ) : null}

        <button
          type="button"
          className="cr-review-prompt"
          onClick={onToggle}
          title={open ? "Show less" : "Show the whole prompt"}
        >
          {short}
        </button>

        {/* A part that is not being sent does not open or close on anything.
            Drawing its frames anyway would show a join that will not be made
            — the exact false promise this sheet exists to prevent. */}
        {shot.skip ? null : kind === "video" ? (
          <div className="cr-review-frames">
            {shot.startsOnPrevious ? (
              // The strongest promise on the sheet, and it has no thumbnail
              // BECAUSE it is strong: the frame does not exist yet — it is
              // captured from the previous clip the moment that clip lands.
              <span className="cr-review-frame">
                <span className="cr-review-flabel">opens on</span>
                <span className="cr-review-fnone">
                  the exact final frame of the part before — captured when it
                  lands
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
        ) : (
          shot.referenceFileIds.length > 0 && (
            <div className="cr-review-frames">
              {shot.referenceFileIds.map((id) => (
                <Frame key={id} label="looks like" fileId={id} thumbs={thumbs} missing="" />
              ))}
            </div>
          )
        )}
      </div>
    </li>
  );
}

/** One end of a clip, as the picture it actually is. */
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
  if (!fileId) {
    if (!missing) return null;
    return (
      <span className="cr-review-frame is-empty">
        <span className="cr-review-flabel">{label}</span>
        <span className="cr-review-fnone">{missing}</span>
      </span>
    );
  }
  const thumb = thumbs[fileId];
  return (
    <span className="cr-review-frame">
      <span className="cr-review-flabel">{label}</span>
      {thumb ? (
        <img src={`data:image/jpeg;base64,${thumb}`} alt="" />
      ) : (
        // In the room, but not among the thumbnails the picker holds. Saying
        // "a picture from this room" is true; saying "missing" would not be.
        <span className="cr-review-fnone">a picture from this room</span>
      )}
    </span>
  );
}
