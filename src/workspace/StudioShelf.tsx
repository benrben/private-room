import { GraphIcon, PodcastIcon, StudioIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The Studio Shelf (D5/D12). `scope` is a file id (this file) or undefined
 * (whole room). Rendered inside the right pane's Studio tab and reused by
 * area views. Flat rows, not cards — outputs are saved back into the room. */
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
      <div className="studio-section-title">
        {scope ? "From the open file" : "From this room's sources"}
      </div>
      <button
        className="studio-row"
        onClick={() => a.openStudioPrompt("flashcards", scope)}
      >
        <span className="studio-row-icon">
          <StudioIcon size={15} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Flashcards</span>
          <span className="studio-row-copy">A flip-card deck you can review</span>
        </span>
        <span className="studio-row-state">Create</span>
      </button>
      <button
        className="studio-row"
        onClick={() => a.openStudioPrompt("mindmap", scope)}
      >
        <span className="studio-row-icon">
          <GraphIcon size={15} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Mind map</span>
          <span className="studio-row-copy">See how the ideas connect</span>
        </span>
        <span className="studio-row-state">Create</span>
      </button>
      <button
        className="studio-row"
        onClick={() => a.openStudioPrompt("podcast", scope)}
      >
        <span className="studio-row-icon">
          <PodcastIcon size={15} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Podcast script</span>
          <span className="studio-row-copy">
            A two-host transcript (script only)
          </span>
        </span>
        <span className="studio-row-state">Create</span>
      </button>
      {(s.aiActionDefs ?? []).some((x) => x.scope === "room") && (
        <>
          <div className="studio-section-title">
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
