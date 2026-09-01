import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  type CreateModel,
  type ShotPlan,
  type StoryBoard,
} from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { clock } from "./clock";
import { CastStrip } from "./StoryCast";
import { ShotList } from "./StoryShots";

export { clock };

export function RenderWhen({
  children,
}: {
  when: boolean;
  children: () => React.ReactNode;
}) {
  return children();
}

export function WithValue<T>({
  value,
  children,
}: {
  value: T | null;
  children: (value: T) => React.ReactNode;
}) {
  return value === null ? null : children(value);
}

export function RenderPart({ children }: { children: () => React.ReactNode }) {
  return children();
}

export function effectiveShotSeconds(lengths: number[], selected: number): number {
  if (lengths.length === 0) return selected;
  return lengths.includes(selected) ? selected : Math.max(...lengths);
}

export function missingSplitModels(imageModel: string, videoModel: string): string[] {
  return [
    imageModel ? null : "picture model",
    videoModel ? null : "clip model",
  ].filter((model): model is string => model !== null);
}

export function useScriptPlan(script: string, minutes: number, seconds: number) {
  const [plan, setPlan] = useState<ShotPlan | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!script.trim()) {
      setPlan(null);
      return;
    }
    let live = true;
    api
      .storyPlanSplit(script, minutes, seconds)
      .then((next) => live && (setPlan(next), setError("")))
      .catch((cause) => live && setError(String(cause)));
    return () => {
      live = false;
    };
  }, [script, minutes, seconds]);
  return { plan, error, setError };
}

function batchProgressMessage(kind: "image" | "video", count: number): string {
  const suffix = count === 1 ? "" : "s";
  if (kind === "image") {
    return `Drawing ${count} shot${suffix} — one at a time, landing here as they finish.`;
  }
  return `Filming ${count} clip${suffix} — one at a time. The last one lands well after the first.`;
}

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
      if (run.shortfall) s.pushToast("error", run.shortfall);
      else s.pushToast("info", batchProgressMessage(kind, n));
    } catch (e) {
      s.pushToast("error", String(e));
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <div className="cr-note cr-note-bad">
        Could not read this room’s story: {error}
      </div>
    );
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
            api.storySetShape({
              id,
              aspectRatio,
              stillResolution,
              clipResolution,
            }),
          )
        }
        handoff={handoff ?? null}
        onHandoffUsed={onHandoffUsed}
        onAddShot={(listId, action) =>
          run(() => api.storyAddShot(listId, action))
        }
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
            s.pushToast(
              "info",
              `${n} shots added — ${clock(plan.totalSeconds)} in all.`,
            );
          })
        }
        onOpenFile={(id) => void a.viewFile(id)}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ cast */
