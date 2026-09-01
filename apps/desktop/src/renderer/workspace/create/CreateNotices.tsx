import { useEffect, useState } from "react";
import { api, type CreateCatalog, type ShotPlan } from "../../api";
import { CreateIcon } from "../../icons";
import { clock } from "./clock";
import { emptyReason } from "./selectors";

export function WholeScriptNotice({
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
export function EmptyShelf({ catalog }: { catalog: CreateCatalog | null }) {
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
