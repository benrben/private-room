import { GraphIcon, PodcastIcon, StudioIcon } from "../icons";
import { WSState } from "./state";
import { WSActions } from "./actions";
/* The AI column's own stylesheet — the Studio shelf and the Activity journal —
 * is `styles/aiPane.css`, loaded from the App.css barrel beside every other
 * section sheet. It is deliberately NOT a side-effect import in this file or in
 * AiPane.tsx: e2e/page-script/activityPane.test.mjs transpiles AiPane.tsx in
 * memory and rewrites only its `… from "…"` specifiers, so a bare `import
 * "…css"` would survive into a data: URL module and fail to resolve. */

/** The Studio Shelf (D5/D12). `scope` is a file id (this file) or undefined
 * (whole room). Rendered inside the right pane's Studio tab and reused by
 * area views.
 *
 * A shelf of things you can make, so each artefact is an INDEX CARD with a
 * hand-drawn category mark — flashcards blue, mind map green, podcast script
 * yellow. Those hues are identity, not status: they say WHICH artefact, never
 * how a run is going, which is why they come from the hue setters
 * (.nb-mark-*) and not from the semantic ones. `ap-sig-*` picks one of the
 * four fixed frame signatures so a run of cards does not look stamped, and it
 * is assigned per card rather than by position so nothing re-shapes when the
 * shelf grows a row. */
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
        className="studio-row nb-mark-blue"
        onClick={() => a.openStudioPrompt("flashcards", scope)}
      >
        <span className="studio-row-icon">
          <StudioIcon size={14} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Flashcards</span>
          <span className="studio-row-copy">A flip-card deck you can review</span>
        </span>
        <span className="studio-row-state">Create</span>
      </button>
      <button
        className="studio-row ap-sig-b nb-mark-green"
        onClick={() => a.openStudioPrompt("mindmap", scope)}
      >
        <span className="studio-row-icon">
          <GraphIcon size={14} />
        </span>
        <span className="studio-row-text">
          <span className="studio-row-title">Mind map</span>
          <span className="studio-row-copy">See how the ideas connect</span>
        </span>
        <span className="studio-row-state">Create</span>
      </button>
      <button
        className="studio-row ap-sig-c nb-mark-yellow"
        onClick={() => a.openStudioPrompt("podcast", scope)}
      >
        <span className="studio-row-icon">
          <PodcastIcon size={14} />
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
