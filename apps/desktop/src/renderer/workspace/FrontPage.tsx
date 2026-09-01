import { ReactNode, useId, useState } from "react";
import { api, FrontPage as FrontPageData, fileKindLabel, RoomInfo } from "../api";
import { ChatBubbleIcon, ClockIcon, FileTypeIcon } from "../icons";
import { displayName, formatWhen } from "./composer";
import { isCloudRoute } from "./markup";
import { visibleWorkflows } from "./workflows/selectors";
import { groupActivity, runningJobCount } from "../shell/activity";
import { NAV_AREAS, type NavArea } from "../shell/navPrefs";
import { WSState } from "./state";
import { WSActions } from "./actions";
import type { LayoutApi } from "../shell/useLayout";

type BriefTone = "danger" | "warn" | "info";
interface BriefItem {
  key: string;
  tone: BriefTone;
  text: string;
  cta: string;
  run: () => void;
}
const TONE_RANK: Record<BriefTone, number> = { danger: 0, warn: 1, info: 2 };
/** A strip's colour comes from the marker MEANING, never from a hue picked by
 * hand, so "red means urgent" stays a fact of the stylesheet rather than a
 * convention this file has to remember. */
const TONE_MARK: Record<BriefTone, string> = {
  danger: "nb-sem-urgent",
  warn: "nb-sem-pending",
  info: "nb-sem-linked",
};
/* A word, not just a colour, so a strip is still fully readable with colour
 * ignored entirely -- by a screen reader, in greyscale, or by anyone who
 * cannot separate the yellow strip from the red one. "warn" is the one
 * exception: its rows already open with a number ("3 scripts need review"),
 * so the word is genuinely redundant there in a way it isn't for danger/info
 * -- those don't lead with a number and lose their non-colour cue entirely
 * without it. */
const TONE_WORD: Partial<Record<BriefTone, string>> = {
  danger: "Urgent",
  info: "Note",
};
/** Room Brief: the one place Home leads with what NEEDS ATTENTION rather than
 * what's merely recent — raw-cloud exposure, unscanned files, scripts to
 * review, failed runs, drafts to activate. Every row resolves its own issue in
 * one click. Renders nothing when the room is clear, so Home stays calm. */
function openPrivacySettings(s: WSState) {
  s.setSettingsSection("set-cloud-privacy");
  s.setShowSettings(true);
}

function pluralEnding(count: number): string {
  return count === 1 ? "" : "s";
}

function rawCloudItem(s: WSState): BriefItem | null {
  if (isCloudRoute(s.model, s.ai) && s.privacyOn === false) {
    return {
      key: "raw-cloud",
      tone: "danger",
      text: "This room is answering with a raw cloud model — real names and content leave this Mac.",
      cta: "Review privacy",
      run: () => openPrivacySettings(s),
    };
  }
  return null;
}

function privacyScanText(pending: number, scanning: boolean): string {
  if (scanning) {
    return `Scanning ${pending} file${pluralEnding(pending)} for private details.`;
  }
  return `${pending} file${pluralEnding(pending)} haven't been scanned for private details yet.`;
}

function startPrivacyScan(s: WSState, scanning: boolean) {
  if (!scanning) {
    api.startPrivacyScan().catch((error) => s.pushToast("error", String(error)));
  }
  openPrivacySettings(s);
}

function privacyScanItem(s: WSState): BriefItem | null {
  if (s.privacyPending <= 0) return null;
  const scanning = s.privacyScanning;
  return {
    key: "scan",
    tone: "warn",
    text: privacyScanText(s.privacyPending, scanning),
    cta: scanning ? "Watch progress" : "Scan now",
    run: () => startPrivacyScan(s, scanning),
  };
}

function scriptsNeedingReview(s: WSState): number {
  return s.scripts.filter((script) => !script.approved || script.changedSinceApproval).length;
}

function scriptReviewItem(s: WSState, a: WSActions): BriefItem | null {
  const count = scriptsNeedingReview(s);
  if (count === 0) return null;
  return {
    key: "script-review",
    tone: "warn",
    text: `${count} script${pluralEnding(count)} need review before ${count === 1 ? "it" : "they"} can run.`,
    cta: "Review scripts",
    run: () => a.openScripts(),
  };
}

function failedScripts(s: WSState): number {
  return s.scripts.filter(
    (script) => script.lastRun && (script.lastRun.status === "failed" || script.lastRun.status === "error"),
  ).length;
}

function failedScriptItem(s: WSState, a: WSActions): BriefItem | null {
  const count = failedScripts(s);
  if (count === 0) return null;
  return {
    key: "script-failed",
    tone: "warn",
    text: `${count} script${pluralEnding(count)} failed on ${count === 1 ? "its" : "their"} last run.`,
    cta: "Open scripts",
    run: () => a.openScripts(),
  };
}

function workflowDraftItem(s: WSState, a: WSActions): BriefItem | null {
  const count = visibleWorkflows(s.workflows).filter((workflow) => workflow.status === "draft").length;
  if (count === 0) return null;
  return {
    key: "wf-draft",
    tone: "info",
    text: `${count} workflow${pluralEnding(count)} ${count === 1 ? "is a draft" : "are drafts"} waiting to be activated.`,
    cta: "Review workflows",
    run: () => a.openWorkflows(),
  };
}

function briefItems(s: WSState, a: WSActions): BriefItem[] {
  return [
    rawCloudItem(s),
    privacyScanItem(s),
    scriptReviewItem(s, a),
    failedScriptItem(s, a),
    workflowDraftItem(s, a),
  ]
    .filter((item): item is BriefItem => item !== null)
    .sort((first, second) => TONE_RANK[first.tone] - TONE_RANK[second.tone]);
}

function BriefItemRow({ item }: { item: BriefItem }) {
  const word = TONE_WORD[item.tone];
  return (
    <li className={`rh-attn ${TONE_MARK[item.tone]}`}>
      {word && <span className="nb-tape rh-attn-tag">{word}</span>}
      <span className="rh-attn-text">{item.text}</span>
      <button className="nb-btn nb-btn-go rh-attn-cta" onClick={item.run}>
        {item.cta}
      </button>
    </li>
  );
}

function RoomBrief({ s, a }: { s: WSState; a: WSActions }) {
  const items = briefItems(s, a);
  if (items.length === 0) return null;
  return (
    <section className="rh-section">
      <div className="rh-section-head">
        <h2>Needs your attention</h2>
        <span className="rh-section-note">
          {items.length} item{pluralEnding(items.length)}
        </span>
      </div>
      <ul className="rh-attn-list">
        {items.map((item) => <BriefItemRow key={item.key} item={item} />)}
      </ul>
    </section>
  );
}

type StampState = { word: string; mark: string };

function recordingStamp(rec: WSState["recLive"]): StampState | null {
  if (rec?.status === "recording") return { word: "Recording now", mark: "nb-sem-urgent" };
  if (rec?.status === "paused") return { word: "Recording paused", mark: "nb-sem-pending" };
  return null;
}

function activityStamp(s: WSState): StampState {
  const busy = runningJobCount(s);
  const recording = recordingStamp(s.recLive);
  if (recording) return recording;
  if (busy > 0) return { word: `${busy} running or waiting`, mark: "nb-sem-linked" };
  if (s.privacyScanning) return { word: "Scanning files", mark: "nb-sem-pending" };
  return { word: "All quiet", mark: "nb-sem-done" };
}

/** The dated annotation in the masthead's upper-right: what day it is, how big
 * the room is, and whether anything is happening in it right now. */
function RoomStamp({ page, s }: { page: FrontPageData; s: WSState }) {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const state = activityStamp(s);
  return (
    <div className="rh-stamp">
      <span className="rh-stamp-date">{today}</span>
      <span className="rh-stamp-counts">
        {page.fileCount} room file{pluralEnding(page.fileCount)} · {page.chatCount}{" "}
        chat{pluralEnding(page.chatCount)}
      </span>
      <span className={`nb-tape rh-stamp-state ${state.mark}`}>{state.word}</span>
    </div>
  );
}

/** One entry on the ruled timeline. `at` is the ISO instant it is filed under;
 * `running` swaps the date for a live state, because work that is still
 * happening has no "when" yet. */
interface TimelineEntry {
  key: string;
  icon: ReactNode;
  title: string;
  kind: string;
  at: string;
  hint: string;
  running?: boolean;
  open: () => void;
}

/** ISO instant as a number, with a malformed value sorting to the bottom
 * rather than poisoning the comparator into an unstable order. */
function instant(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Everything that has happened in this room lately, newest first.
 *
 * Files and chats interleave rather than sitting in two blocks: a timeline is
 * chronological or it is not a timeline, and "I added that PDF right after I
 * asked about it" is exactly the relationship the two separate lists hid.
 * Work that is still running is filed above all of it, because "now" is newer
 * than anything with a timestamp. */
function timeline(
  page: FrontPageData,
  s: WSState,
  a: WSActions,
  layout: LayoutApi,
): TimelineEntry[] {
  const openActivity = () => {
    s.setAiTab("activity");
    layout.showPane("ai");
  };
  const running: TimelineEntry[] = groupActivity(s.jobs).active.map((j) => {
    const live = s.jobProgress[j.id];
    const done = live?.done ?? j.cursor;
    // A job's step count is 0 until a plan says otherwise (jobs.rs defaults it,
    // and an empty plan leaves it there), so there is often no denominator to
    // report. Clamping it to 1 manufactured one: a job with no known length
    // read "0 of 1" here while the Activity tab beside it correctly said
    // nothing, and this timeline exists precisely so Home cannot disagree with
    // the rest of the window. The Running tape already carries the state.
    const total = live?.total ?? j.total;
    return {
      key: `job:${j.id}`,
      icon: <ClockIcon size={14} />,
      title: j.title,
      kind: total > 0 ? `${done} of ${total}` : "Running",
      at: j.updatedAt,
      hint: j.title,
      running: true,
      open: openActivity,
    };
  });

  const past: TimelineEntry[] = [];
  for (const f of page.recentFiles) {
    past.push({
      key: `file:${f.id}`,
      icon: <FileTypeIcon file={f} size={14} />,
      title: displayName(f.name),
      kind: fileKindLabel(f).replace(/^./, (c) => c.toUpperCase()),
      at: f.createdAt,
      hint: f.name,
      open: () => a.viewFile(f.id),
    });
  }
  for (const c of page.recentChats) {
    past.push({
      key: `chat:${c.id}`,
      icon: <ChatBubbleIcon size={14} />,
      title: c.title,
      kind: "Chat",
      // When you last SPOKE in it, not when it was started — the same fact the
      // chat list is now ordered by, so Home's timeline and the list agree
      // about which conversation is recent.
      at: c.lastAt,
      hint: c.title,
      open: () => {
        s.setActiveChatId(c.id);
        s.setAiTab("chat");
        // The conversation lives in the AI pane — reveal it, or a
        // collapsed pane makes this click look like nothing.
        layout.showPane("ai");
      },
    });
  }
  past.sort((x, y) => instant(y.at) - instant(x.at));
  return [...running, ...past];
}

/** A destination that already has a permanent home in the rail. It keeps its
 * link and its full description (as the hover title), and gives up the row of
 * page it did not need — Home was a second copy of the primary navigation. */
/** A compressed link to a place, below the fold on Room Home.
 *
 * The hint is carried three ways on purpose. As `title`, for a pointer. As an
 * `aria-describedby` target, because a `title` is not reliably announced and a
 * chip reading only "Scripts" tells a screen-reader user nothing about what is
 * behind it. And, when the chip cannot be used, as VISIBLE text — see below.
 *
 * `aria-disabled`, never the `disabled` attribute. A disabled button does not
 * fire pointer events, so its `title` cannot appear: the Room Map chip on an
 * empty room was greyed out with the explanation for WHY sealed inside a
 * tooltip that could not open. Marking it disabled instead keeps it focusable
 * and hoverable, so the reason is reachable by every route. */
function AreaChip({
  label,
  hint,
  icon,
  unavailable,
  onClick,
  children,
}: {
  label: string;
  hint: string;
  icon: ReactNode;
  /** Why the chip cannot be used right now, shown in place of the hint. */
  unavailable?: string;
  onClick: () => void;
  children?: ReactNode;
}) {
  const describedBy = useId();
  const note = unavailable ?? hint;
  return (
    <>
      <button
        className={`nb-chip nb-chip-btn rh-chip${unavailable ? " is-unavailable" : ""}`}
        title={note}
        aria-disabled={unavailable ? true : undefined}
        aria-describedby={describedBy}
        onClick={unavailable ? undefined : onClick}
      >
        <span className="rh-chip-ico" aria-hidden="true">
          {icon}
        </span>
        {label}
        {children}
      </button>
      {/* Visible when it explains an unavailable chip, since that is the one
          case where the reader is stuck and needs the words on screen; a
          screen-reader description the rest of the time. */}
      <span
        id={describedBy}
        className={unavailable ? "rh-chip-why" : "rh-chip-why sr-only"}
      >
        {note}
      </span>
    </>
  );
}

/** Room home, as a briefing: masthead and date, then what needs attention,
 * then a ruled timeline of what has been happening, and only then the things
 * you can start. Shown in the center pane on unlock. */
export default function FrontPage({
  page,
  s,
  a,
  layout,
}: {
  page: FrontPageData;
  s: WSState;
  a: WSActions;
  layout: LayoutApi;
  info: RoomInfo;
}) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const goArea = (
    area: "files" | "recordings" | "memory" | "skills" | "connectors" | "sketch" | "create",
  ) => {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
    s.setArea(area);
  };
  /** How Home reaches every destination the rail knows. Keyed by the catalog,
   * so an area added to `NAV_AREAS` with no way in from here stops the build —
   * this list has silently fallen two and three destinations behind twice. */
  const openArea: Record<NavArea, (() => void) | null> = {
    home: null,
    files: () => goArea("files"),
    recordings: () => goArea("recordings"),
    browser: () => a.revealBrowser(),
    sketch: () => goArea("sketch"),
    create: () => goArea("create"),
    map: () => {
      s.setOpenFile(null);
      s.setShowMap(true);
    },
    workflows: () => a.openWorkflows(),
    scripts: () => a.openScripts(),
    skills: () => goArea("skills"),
    connectors: () => goArea("connectors"),
    memory: () => goArea("memory"),
  };
  const recent = timeline(page, s, a, layout);
  return (
    <div className="rh-view">
      <div className="rh-inner">
        <header className="rh-masthead">
          <div className="rh-masthead-main">
            <h1 className="rh-title">Continue where you left off</h1>
            <p className="rh-subtitle nb-subtitle">
              Recent work, current background activity, and everything this room
              can do — nothing here leaves this Mac on its own.
            </p>
          </div>
          <RoomStamp page={page} s={s} />
        </header>

        <RoomBrief s={s} a={a} />

        <section className="rh-section">
          <div className="rh-section-head">
            <h2>Continue</h2>
            <span className="rh-section-note">Recent activity</span>
          </div>
          {recent.length === 0 ? (
            <p className="rh-empty nb-annot">
              Nothing here yet — add a file or ask the room a question.
            </p>
          ) : (
            <ul className="rh-timeline nb-connect">
              {recent.map((e) => (
                <li key={e.key}>
                  <button
                    className={`rh-tl-row${e.running ? " is-running" : ""}`}
                    title={e.hint}
                    onClick={e.open}
                  >
                    <span className="rh-tl-ico" aria-hidden="true">
                      {e.icon}
                    </span>
                    <span className="rh-tl-main">
                      <span className="rh-tl-title">{e.title}</span>
                      <span className="rh-tl-kind">{e.kind}</span>
                    </span>
                    {e.running ? (
                      <span className="nb-tape rh-tl-state nb-sem-linked">
                        Running
                      </span>
                    ) : (
                      <span className="rh-tl-when">{formatWhen(e.at)}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rh-section">
          <div className="rh-section-head">
            <h2>Work in this room</h2>
            <span className="rh-section-note">Go to an area</span>
          </div>

          <div className="rh-more">
            {NAV_AREAS.map((def) => {
              const go = openArea[def.key];
              if (!go) return null;
              return (
                <AreaChip
                  key={def.key}
                  label={def.label}
                  hint={def.blurb}
                  icon={def.icon(14)}
                  unavailable={
                    // Not "fewer than two files": RoomMap counts NODES, and one
                    // file with linked memories is a real constellation it
                    // draws (see RoomMap.tsx's `showEmpty`). An empty room is
                    // the only state it can say nothing about.
                    def.key === "map" && s.files.length === 0
                      ? "Add a file first — the map draws the connections between them"
                      : undefined
                  }
                  onClick={go}
                >
                  {/* A count is the handwriting's natural home, and the ring
                      keeps it from reading as part of the label. */}
                  {def.key === "memory" && page.memories.length > 0 && (
                    <span className="nb-circled rh-chip-count">
                      {page.memories.length}
                    </span>
                  )}
                </AreaChip>
              );
            })}
          </div>
        </section>

        {/* Suggested questions rest in a collapsed, low-contrast tray — the
            home page's optional ideas must not compete with the actual work.
            One click opens them; the count says what's inside. */}
        {s.fpSuggestions.length > 0 && (
          <div className="fp-suggestions rh-tray">
            <button
              className="fp-suggestions-toggle"
              aria-expanded={suggestionsOpen}
              onClick={() => setSuggestionsOpen((o) => !o)}
            >
              Suggestions <span className="count">{s.fpSuggestions.length}</span>
            </button>
            {suggestionsOpen &&
              s.fpSuggestions.map((sug, i) => (
                <button
                  key={i}
                  className="fp-suggestion"
                  onClick={() => {
                    s.setQuestion(sug);
                    // Bring the chat forward first: focusing a composer that
                    // isn't mounted stored the question out of sight.
                    a.focusComposer(layout);
                  }}
                >
                  {sug}
                </button>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
