import { ReactNode, useEffect, useId, useState } from "react";
import { api, FrontPage as FrontPageData, fileKindLabel } from "../api";
import {
  BookOpenIcon,
  ChatBubbleIcon,
  ClockIcon,
  FileTypeIcon,
  GlobeIcon,
  GraphIcon,
  LinkIcon,
  MemoryIcon,
  MicIcon,
  ScriptIcon,
  SparkIcon,
  WorkflowsIcon,
} from "../icons";
import { displayName, formatWhen } from "./composer";
import { isCloudRoute } from "./markup";
import { visibleWorkflows } from "./workflows/selectors";
import { groupActivity, runningJobCount } from "../shell/activity";
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
/** …and the colour never travels alone. The tape label spells the tone out in
 * a word, so a strip is still fully readable with colour ignored entirely —
 * by a screen reader, in greyscale, or by anyone who cannot separate the
 * yellow strip from the red one. */
const TONE_WORD: Record<BriefTone, string> = {
  danger: "Urgent",
  warn: "Check",
  info: "Note",
};

/** Room Brief: the one place Home leads with what NEEDS ATTENTION rather than
 * what's merely recent — raw-cloud exposure, unscanned files, scripts to
 * review, failed runs, drafts to activate. Every row resolves its own issue in
 * one click. Renders nothing when the room is clear, so Home stays calm. */
function RoomBrief({ s, a }: { s: WSState; a: WSActions }) {
  const [pendingScan, setPendingScan] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .privacyStatus()
      .then((st) => live && setPendingScan(st.pendingFiles))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [s.files.length]);

  const openPrivacy = () => {
    s.setSettingsSection("set-cloud-privacy");
    s.setShowSettings(true);
  };

  const items: BriefItem[] = [];
  if (isCloudRoute(s.model, s.ai) && s.privacyOn === false) {
    items.push({
      key: "raw-cloud",
      tone: "danger",
      text: "This room is answering with a raw cloud model — real names and content leave this Mac.",
      cta: "Review privacy",
      run: openPrivacy,
    });
  }
  if (pendingScan > 0) {
    items.push({
      key: "scan",
      tone: "warn",
      text: `${pendingScan} file${pendingScan === 1 ? "" : "s"} haven't been scanned for private details yet.`,
      cta: "Scan now",
      run: () => {
        api.startPrivacyScan().catch(() => {});
        openPrivacy();
      },
    });
  }
  const needReview = s.scripts.filter((sc) => !sc.approved || sc.changedSinceApproval).length;
  if (needReview > 0) {
    items.push({
      key: "script-review",
      tone: "warn",
      text: `${needReview} script${needReview === 1 ? "" : "s"} need review before ${needReview === 1 ? "it" : "they"} can run.`,
      cta: "Review scripts",
      run: () => a.openScripts(),
    });
  }
  const failed = s.scripts.filter(
    (sc) => sc.lastRun && (sc.lastRun.status === "failed" || sc.lastRun.status === "error"),
  ).length;
  if (failed > 0) {
    items.push({
      key: "script-failed",
      tone: "warn",
      text: `${failed} script${failed === 1 ? "" : "s"} failed on ${failed === 1 ? "its" : "their"} last run.`,
      cta: "Open scripts",
      run: () => a.openScripts(),
    });
  }
  const drafts = visibleWorkflows(s.workflows).filter((w) => w.status === "draft").length;
  if (drafts > 0) {
    items.push({
      key: "wf-draft",
      tone: "info",
      text: `${drafts} workflow${drafts === 1 ? "" : "s"} ${drafts === 1 ? "is a draft" : "are drafts"} waiting to be activated.`,
      cta: "Review workflows",
      run: () => a.openWorkflows(),
    });
  }

  if (items.length === 0) return null;
  items.sort((x, y) => TONE_RANK[x.tone] - TONE_RANK[y.tone]);

  return (
    <section className="rh-section">
      <div className="rh-section-head">
        <h2>Needs your attention</h2>
        <span className="rh-section-note">
          {items.length} item{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="rh-attn-list">
        {items.map((it) => (
          <li key={it.key} className={`rh-attn ${TONE_MARK[it.tone]}`}>
            <span className="nb-tape rh-attn-tag">{TONE_WORD[it.tone]}</span>
            <span className="rh-attn-text">{it.text}</span>
            <button className="nb-btn nb-btn-go rh-attn-cta" onClick={it.run}>
              {it.cta}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The dated annotation in the masthead's upper-right: what day it is, how big
 * the room is, and whether anything is happening in it right now.
 *
 * The date is CONTENT, not decoration — nothing on this page derives its shape,
 * angle or position from the clock, so a given room state still draws an
 * identical frame every render. */
function RoomStamp({ page, s }: { page: FrontPageData; s: WSState }) {
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  // `runningJobCount` is the ONE definition of "something is happening" the
  // status bar and the Activity tab already count through. Asking it here
  // rather than re-testing job statuses is what stops Home from disagreeing
  // with the rest of the window about whether the room is busy.
  const busy = runningJobCount(s);
  const rec = s.recLive;
  const state =
    rec && rec.status === "recording"
      ? { word: "Recording now", mark: "nb-sem-urgent" }
      : rec && rec.status === "paused"
        ? { word: "Recording paused", mark: "nb-sem-pending" }
        : busy > 0
          ? { word: `${busy} running`, mark: "nb-sem-linked" }
          : { word: "All quiet", mark: "nb-sem-done" };
  return (
    <div className="rh-stamp">
      <span className="rh-stamp-date">{today}</span>
      <span className="rh-stamp-counts">
        {page.fileCount} file{page.fileCount === 1 ? "" : "s"} · {page.chatCount}{" "}
        chat{page.chatCount === 1 ? "" : "s"}
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
      at: c.createdAt,
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

/** A major action: a wide notebook card, drawn as a frame on the sheet. These
 * are the four things Home actively invites you to START. */
function ActionCard({
  area,
  title,
  copy,
  icon,
  onClick,
}: {
  area: string;
  title: string;
  copy: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button className="rh-card nb-card nb-lift" onClick={onClick}>
      <span className="rh-card-ico" aria-hidden="true">
        {icon}
      </span>
      <span className="rh-card-title">{title}</span>
      {/* Sans, never the hand: this is an instruction about what the area
          does, and handwriting is reserved for asides, dates and counts. */}
      <span className="rh-card-copy">{copy}</span>
      <span className="rh-card-area">{area}</span>
    </button>
  );
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
        className={unavailable ? "rh-chip-why nb-hand" : "rh-chip-why sr-only"}
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
}) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const goArea = (area: "recordings" | "memory" | "skills" | "connectors" | "browser") => {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
    s.setArea(area);
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
            {/* This list is a shortcut into the areas, not an inventory —
                it said "All capabilities" while omitting three of them. */}
            <span className="rh-section-note">Go to an area</span>
          </div>

          {/* Marginalia: deterministic, inert, and hidden by the stylesheet
              the moment the column stops having a margin to draw in. */}
          <aside className="rh-margin" aria-hidden="true">
            <span className="rh-margin-note">start here</span>
            <span className="nb-arrow-curve nb-arrow-curve--se rh-margin-arrow" />
          </aside>

          <div className="rh-cards nb-frame-set">
            <ActionCard
              area="Recordings"
              title="Record and transcribe"
              copy="Microphone, Mac audio, live translation, editing, export"
              icon={<MicIcon size={17} />}
              onClick={() => goArea("recordings")}
            />
            <ActionCard
              area="Workflows"
              title="Automate repeated work"
              copy="Visual pipelines, schedules, file actions, run history"
              icon={<WorkflowsIcon size={17} />}
              onClick={() => a.openWorkflows()}
            />
            <ActionCard
              area="Studio"
              title="Transform your sources"
              copy="Flashcards, mind maps, podcast scripts, room summary"
              icon={<SparkIcon size={17} />}
              onClick={() => {
                s.setAiTab("studio");
                layout.showPane("ai");
              }}
            />
            <ActionCard
              area="Browser"
              title="Read the web privately"
              copy="A browser that keeps no history, with search and downloads straight into the room"
              icon={<GlobeIcon size={17} />}
              onClick={() => a.revealBrowser()}
            />
          </div>

          {/* A dashed pencil rule is the system's mark for a provisional
              boundary — below it is the fold, not a second class of feature.
              Every one of these still has a permanent home in the rail. */}
          <hr className="nb-rule-dash rh-more-rule" />

          <div className="rh-more">
            <AreaChip
              label="Scripts"
              hint="Run a room script — Python or JavaScript with explicit inputs, outputs, and consent"
              icon={<ScriptIcon size={13} />}
              onClick={() => a.openScripts()}
            />
            <AreaChip
              label="Room Map"
              hint="See how files connect — the Room Map of files, notes, and their relationships"
              icon={<GraphIcon size={13} />}
              unavailable={
                s.files.length === 0
                  ? "Add a file first — the map draws the connections between them"
                  : undefined
              }
              onClick={() => {
                s.setOpenFile(null);
                s.setShowMap(true);
              }}
            />
            <AreaChip
              label="Memory"
              hint="Manage memory and scratch notes — durable facts and preferences, always visible and editable"
              icon={<MemoryIcon size={13} />}
              onClick={() => goArea("memory")}
            >
              {/* A count is the handwriting's natural home, and the ring keeps
                  it from reading as part of the label. */}
              {page.memories.length > 0 && (
                <span className="nb-circled rh-chip-count">
                  {page.memories.length}
                </span>
              )}
            </AreaChip>
            <AreaChip
              label="Skills"
              hint="Teach the AI a skill — reusable instructions and resources, stored encrypted in this room"
              icon={<BookOpenIcon size={13} />}
              onClick={() => goArea("skills")}
            />
            <AreaChip
              label="Connectors"
              hint="Connect outside tools — MCP connectors, every call asks first"
              icon={<LinkIcon size={13} />}
              onClick={() => goArea("connectors")}
            />
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
