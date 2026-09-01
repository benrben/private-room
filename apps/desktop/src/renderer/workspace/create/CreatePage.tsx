import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type CreateCatalog,
  type CreateModel,
  type RoomPicture,
} from "../../api";
import { WSState } from "../state";
import { WSActions } from "../actions";
import { isCreationFile } from "../types";
import { CreateLayout, CreatePageBody, addPictureReference } from "./CreateSurface";
import { type BenchProps } from "./CreateBench";
import {
  selectedModel,
  takesFirstFrame,
  tallies,
  visibleModels,
  type CreateKind,
} from "./selectors";

/** What the page is showing: a shelf of models, or the story surface. */
export type Surface = CreateKind | "story";

function surfaceKind(surface: Surface): CreateKind {
  return surface === "story" ? "image" : surface;
}

function dropsSelectedFrame(kind: CreateKind, selected: CreateModel | null): boolean {
  if (kind !== "video" || !selected) return false;
  return !takesFirstFrame(selected);
}

type CreationRequest = {
  prompt: string;
  model: CreateModel;
  kind: "image" | "video";
  variations: number;
  seconds: number | null;
  resolution: string;
  aspectRatio: string;
  refs: RoomPicture[];
  frame: RoomPicture | null;
};

function canGenerate(
  selected: CreateModel | null,
  kind: "image" | "video",
  prompt: string,
  frame: RoomPicture | null,
): boolean {
  return Boolean(selected) && (Boolean(prompt.trim()) || (kind === "video" && Boolean(frame)));
}

function createJobRequest(request: CreationRequest) {
  return {
    prompt: request.prompt.trim(),
    model: request.model.model,
    kind: request.kind,
    variations: request.variations,
    seconds: request.kind === "video" ? request.seconds : null,
    resolution: request.resolution,
    aspectRatio: request.aspectRatio,
    referenceFileIds: request.refs.map((picture) => picture.fileId),
    frameFileId: request.kind === "video" ? (request.frame?.fileId ?? null) : null,
    referencesAck: request.refs.length > 0 || Boolean(request.frame),
  };
}

function generationNotice(kind: "image" | "video", variations: number): string {
  const single = {
    image: "Making it — it will open when it is ready.",
    video: "Filming — a clip takes a few minutes.",
  };
  return variations > 1 ? `Making ${variations} — they will open when they are ready.` : single[kind];
}

async function generateCreation({
  request,
  busy,
  canGo,
  refreshJobs,
  pushToast,
  setBusy,
}: {
  request: CreationRequest;
  busy: boolean;
  canGo: boolean;
  refreshJobs: () => Promise<void>;
  pushToast: WSState["pushToast"];
  setBusy: (busy: boolean) => void;
}) {
  if (!canGo || busy) return;
  setBusy(true);
  try {
    await api.startCreateJob(createJobRequest(request));
    await refreshJobs();
    pushToast("info", generationNotice(request.kind, request.variations));
  } catch (error) {
    pushToast("error", String(error));
  } finally {
    setBusy(false);
  }
}

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
  const kind = surfaceKind(surface);

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

  // A video model with no first-frame slot hides the attached picture AND its
  // only Remove control, so a frame left in state could not be seen or taken
  // off: the lock notice still counted it as something that would be sent, and
  // Make it refused, telling the user to clear a picture the bench no longer
  // showed. Dropped on the video bench only — the frame slot is video's, and
  // clearing it because the reader glanced at the Images tab would throw away
  // an attachment they never touched.
  const dropsFrame = dropsSelectedFrame(kind, selected);
  useEffect(() => {
    if (dropsFrame) setFrame(null);
  }, [dropsFrame]);

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
  // `source === "generated"` is written by every producer in the room — sketch
  // creation, the deep summary, the organizer — so this grid used to claim the
  // bench had made a drawing somebody drew by hand. `originDestination` is the
  // destination contract's own answer, and the one the Creations sidebar reads,
  // so the two lists can no longer disagree about what Create has made.
  const made = s.files.filter(isCreationFile);

  // A clip may be made from a picture alone — several models animate a still
  // with no words at all, and the API marks the prompt optional for exactly
  // that. A still always needs words: there is nothing else to draw from.
  const canGo = canGenerate(selected, kind, prompt, frame);
  const generate = () => {
    if (!selected) return;
    void generateCreation({
      request: {
        prompt,
        model: selected,
        kind,
        variations,
        seconds,
        resolution,
        aspectRatio,
        refs,
        frame,
      },
      busy,
      canGo,
      refreshJobs: a.refreshJobs,
      pushToast: s.pushToast,
      setBusy,
    });
  };

  const bench: BenchProps = {
    models: visible,
    selected,
    onPickModel: setPickedModel,
    query,
    onQuery: setQuery,
    total: kind === "video" ? counts.video : counts.image,
    kind,
    prompt,
    onPrompt: setPrompt,
    variations,
    onVariations: setVariations,
    frame,
    refs,
    seconds,
    onSeconds: setSeconds,
    resolution,
    onResolution: setResolution,
    aspectRatio,
    onAspectRatio: setAspectRatio,
    onTakeToStory: () => {
      setHandoff(prompt);
      setSurface("story");
    },
    onPickFrame: () => setPicking("frame"),
    onPickRef: () => setPicking("ref"),
    onClearFrame: () => setFrame(null),
    onClearRef: (id) => setRefs((current) => current.filter((picture) => picture.fileId !== id)),
    busy,
    canGo,
    onGenerate: generate,
  };
  return (
    <CreateLayout>
      <CreatePageBody
        s={s}
        a={a}
        catalog={catalog}
        loading={loading}
        loadError={loadError}
        counts={counts}
        surface={surface}
        onSurface={setSurface}
        whyOpen={whyOpen}
        onToggleWhy={() => setWhyOpen((open) => !open)}
        models={models}
        handoff={handoff}
        onHandoffUsed={() => setHandoff(null)}
        kind={kind}
        activeJobs={activeJobs}
        failedJobs={failedJobs}
        made={made}
        bench={bench}
        picking={picking}
        onClosePicker={() => setPicking(null)}
        onPickPicture={(picture) => {
          if (picking === "frame") setFrame(picture);
          else setRefs((current) => addPictureReference(current, picture));
        }}
      />
    </CreateLayout>
  );
}
