import { useState } from "react";
import { type CastMember, type CreateModel, type ShotPlan, type StoryBoard } from "../../api";
import { CreateIcon } from "../../icons";
import { FilmReview } from "./FilmReview";
import { clock } from "./clock";
import { legalSeconds, takesFirstFrame } from "./selectors";
import { RenderPart } from "./StoryTab";
import { ScriptSplitter } from "./StoryScript";
import { ListHead, MakeAllPanel, ShapeRow } from "./StoryBatch";
import { ShotRow } from "./StoryShotEditor";

export function ShotList({
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
    (shot) =>
      !shot.seconds &&
      !legalSeconds(
        videoModels.find((m) => m.model === shot.videoModel) ?? null,
      ).length,
  );
  // Chaining needs a model that takes a FIRST frame — 19 of the 21 do. The
  // join is made by capturing the finished clip's real end frame and opening
  // the next clip on it, so a last-frame slot is no longer required; it only
  // helps a clip aim its ending.
  // Receivers only: the first shot is never handed a frame, so its model's
  // first-frame support says nothing about whether this list can chain.
  const receivers = board.shots
    .slice(1)
    .map(
      (shot) => videoModels.find((m) => m.model === shot.videoModel) ?? null,
    );
  const canChain = receivers.some(takesFirstFrame);
  // The models actually looked at and found to refuse a starting picture. A
  // one-shot list looks at none, and used to be told a capability fact about
  // "the clip model chosen here" that nothing had evaluated — and which
  // contradicts what most of them publish.
  const noFirstFrame = [
    ...new Set(
      receivers
        .filter((m): m is CreateModel => !!m && !takesFirstFrame(m))
        .map((m) => m.slug),
    ),
  ];

  if (board.lists.length === 0) {
    return (
      <section className="nb-panel cr-shots">
        <div className="cr-empty">
          <CreateIcon size={26} />
          <h2>No shot list yet</h2>
          {/* A script carried over from the bench is HELD here, not lost: the
              splitter that opens with it in place only mounts once a list
              exists. A first-time user is by definition in this state, so the
              screen that greets their handoff has to say where it went. */}
          <p>
            {handoff
              ? "Your script is waiting. A shot list is the order things happen in — one line per shot, and the script is split into them on the next screen."
              : "A shot list is the order things happen in — one line per shot. Each line becomes a picture, and each picture can become a clip."}
          </p>
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            onClick={() => onNewList("Untitled", "")}
            disabled={busy}
          >
            {handoff ? "Start a list from your script" : "Start one"}
          </button>
        </div>
      </section>
    );
  }

  return (
    <RenderPart>
      {() => (
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

          <RenderPart>
            {() => (
              <>
                {current && (
                  <ListHead
                    key={current.id}
                    list={current}
                    onCommit={(title, logline) =>
                      onUpdateList(current.id, title, logline)
                    }
                  />
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
              </>
            )}
          </RenderPart>

          <RenderPart>
            {() => (
              <>
                <RenderPart>
                  {() => (
                    <>
                      {board.shots.length > 0 && (
                        <div className="cr-runtime">
                          <b>{board.shots.length}</b> shot
                          {board.shots.length === 1 ? "" : "s"}
                          {runtime > 0 && (
                            <>
                              {" · "}
                              <b>{clock(runtime)}</b> of video
                            </>
                          )}
                          {unpriced && (
                            <span className="cr-hint">
                              {" "}
                              — some shots have no clip model yet, so they are
                              not in the total.
                            </span>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </RenderPart>

                <RenderPart>
                  {() => (
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
                  )}
                </RenderPart>

                <RenderPart>
                  {() => (
                    <div className="cr-shot-new">
                      <input
                        className="cr-field"
                        value={newAction}
                        placeholder="What happens next…"
                        aria-label="A new shot"
                        onChange={(e) => setNewAction(e.target.value)}
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            newAction.trim() &&
                            board.selected
                          ) {
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
                  )}
                </RenderPart>

                <MakeAllPanel
                  shotCount={board.shots.length}
                  busy={busy}
                  continuous={continuous}
                  canChain={canChain}
                  noFirstFrame={noFirstFrame}
                  onSetContinuous={setContinuous}
                  onReview={setReviewing}
                />
              </>
            )}
          </RenderPart>

          <RenderPart>
            {() => (
              <>
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
              </>
            )}
          </RenderPart>
        </section>
      )}
    </RenderPart>
  );
}
