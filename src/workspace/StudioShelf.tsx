import { GraphIcon, PodcastIcon, StudioIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The Studio Shelf (D5/D12). `scope` is a file id (this file) or undefined
 * (whole room). Reused by the Front Page. Extracted verbatim. */
export default function StudioShelf({
  scope,
  s,
  a,
}: {
  scope?: string;
  s: WSState;
  a: WSActions;
}) {
  return (
    <div className="studio-shelf">
      <div className="studio-shelf-title">
        Studio · {scope ? "this file" : "whole room"}
      </div>
      <button
        className="studio-btn"
        onClick={() => a.openStudioPrompt("flashcards", scope)}
      >
        <StudioIcon size={18} />
        <span className="studio-btn-label">
          Flashcards
          <span className="studio-btn-sub">A flip-card deck you can review</span>
        </span>
      </button>
      <button
        className="studio-btn"
        onClick={() => a.openStudioPrompt("mindmap", scope)}
      >
        <GraphIcon size={18} />
        <span className="studio-btn-label">
          Mind map
          <span className="studio-btn-sub">See how the ideas connect</span>
        </span>
      </button>
      <button
        className="studio-btn"
        onClick={() => a.openStudioPrompt("podcast", scope)}
      >
        <PodcastIcon size={18} />
        <span className="studio-btn-label">
          Podcast script
          <span className="studio-btn-sub">A two-host transcript (script only)</span>
        </span>
      </button>
      {(s.aiActionDefs ?? []).some((x) => x.scope === "room") && (
        <>
          <div className="studio-shelf-title studio-shelf-subtitle">
            AI actions · {scope ? "this folder" : "whole room"}
          </div>
          <div className="ai-action-grid">
            {(s.aiActionDefs ?? [])
              .filter((x) => x.scope === "room")
              .map((x) => (
                <button
                  key={x.id}
                  className="ai-action-chip"
                  disabled={s.aiBusy}
                  title={x.description}
                  onClick={() => a.openAiAction(x, scope ?? null, null)}
                >
                  {x.title}
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
