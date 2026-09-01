import { GraphIcon, PodcastIcon, StudioIcon } from "../icons";
import type { ComponentType } from "react";
import { WSState } from "./state";
import { WSActions } from "./actions";
/* The AI column's own stylesheet — the Studio shelf and the Activity journal —
 * is `styles/aiPane.css`, loaded from the App.css barrel beside every other
 * section sheet. It is deliberately NOT a side-effect import in this file or in
 * AiPane.tsx: tests/contract/activityPane.test.mjs transpiles AiPane.tsx in
 * memory and rewrites only its `… from "…"` specifiers, so a bare `import
 * "…css"` would survive into a data: URL module and fail to resolve. */

/** Which studio kinds already have a run in flight for THIS scope.
 *
 * The scope is half the answer: a deck of the whole room and a deck of the open
 * file are different work, so a run started elsewhere must not grey out the row
 * in front of you — the same false reading AiPane's summary row was fixed for.
 * Both facts come off the job's plan, which is what `start_studio_job` wrote. */
type StudioKind = "flashcards" | "mindmap" | "podcast";

type StudioCard = {
  kind: StudioKind;
  title: string;
  copy: string;
  className: string;
  Icon: ComponentType<{ size?: number }>;
};

const studioCards: StudioCard[] = [
  {
    kind: "flashcards",
    title: "Flashcards",
    copy: "A flip-card deck you can review",
    className: "studio-row nb-mark-blue",
    Icon: StudioIcon,
  },
  {
    kind: "mindmap",
    title: "Mind map",
    copy: "See how the ideas connect",
    className: "studio-row ap-sig-b nb-mark-green",
    Icon: GraphIcon,
  },
  {
    kind: "podcast",
    title: "Podcast script",
    copy: "A two-host transcript (script only)",
    className: "studio-row ap-sig-c nb-mark-yellow",
    Icon: PodcastIcon,
  },
];

function isRunningStudioJob(job: WSState["jobs"][number]) {
  return job.kind === "studio" && ["running", "queued"].includes(job.status);
}

function studioPlan(job: WSState["jobs"][number]) {
  return job.plan as { kind?: string; scope?: string | null } | null;
}

function planIsInScope(
  plan: { scope?: string | null } | null,
  scope: string | undefined,
) {
  return (plan?.scope ?? undefined) === scope;
}

function addStudioKind(kinds: Set<string>, plan: { kind?: string } | null) {
  if (plan?.kind) kinds.add(plan.kind);
}

function runningKinds(s: WSState, scope?: string): Set<string> {
  const kinds = new Set<string>();
  for (const job of s.jobs) {
    if (!isRunningStudioJob(job)) continue;
    const plan = studioPlan(job);
    if (!planIsInScope(plan, scope)) continue;
    addStudioKind(kinds, plan);
  }
  return kinds;
}

function StudioCardButton({
  card,
  isRunning,
  scope,
  openStudioPrompt,
}: {
  card: StudioCard;
  isRunning: boolean;
  scope?: string;
  openStudioPrompt: WSActions["openStudioPrompt"];
}) {
  const { Icon } = card;
  return (
    <button
      className={card.className}
      disabled={isRunning}
      onClick={() => openStudioPrompt(card.kind, scope)}
    >
      <span className="studio-row-icon">
        <Icon size={14} />
      </span>
      <span className="studio-row-text">
        <span className="studio-row-title">{card.title}</span>
        <span className="studio-row-copy">{card.copy}</span>
      </span>
      <span
        className={`studio-row-state${isRunning ? " is-working nb-tape nb-sem-pending" : ""}`}
      >
        {isRunning ? "Working…" : "Create"}
      </span>
    </button>
  );
}

function RoomAiActions({
  actionDefs,
  aiBusy,
  scope,
  openAiAction,
}: {
  actionDefs: NonNullable<WSState["aiActionDefs"]>;
  aiBusy: boolean;
  scope?: string;
  openAiAction: WSActions["openAiAction"];
}) {
  const roomActions = actionDefs.filter((action) => action.scope === "room");
  if (roomActions.length === 0) return null;
  return (
    <>
      <div className="studio-section-title">
        AI actions · {scope ? "this folder" : "whole room"}
      </div>
      <div className="ai-action-grid">
        {roomActions.map((action) => (
          <button
            key={action.id}
            className="ai-action-chip"
            disabled={aiBusy}
            title={action.description}
            onClick={() => openAiAction(action, scope ?? null, null)}
          >
            {action.title}
          </button>
        ))}
      </div>
    </>
  );
}

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
  const running = runningKinds(s, scope);
  return (
    <div className="studio-shelf">
      <div className="studio-section-title">
        {scope ? "From the open file" : "From this room's sources"}
      </div>
      {studioCards.map((card) => (
        <StudioCardButton
          key={card.kind}
          card={card}
          isRunning={running.has(card.kind)}
          scope={scope}
          openStudioPrompt={a.openStudioPrompt}
        />
      ))}
      <RoomAiActions
        actionDefs={s.aiActionDefs ?? []}
        aiBusy={s.aiBusy}
        scope={scope}
        openAiAction={a.openAiAction}
      />
    </div>
  );
}
