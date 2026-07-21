import { useEffect, useState } from "react";
import { api, FrontPage as FrontPageData, fileKindLabel } from "../api";
import {
  ChatBubbleIcon,
  FileTypeIcon,
  GraphIcon,
  MemoryIcon,
  MicIcon,
  ScriptIcon,
  SparkIcon,
  WorkflowsIcon,
} from "../icons";
import { displayName, formatWhen } from "./composer";
import { isCloudEngine } from "./markup";
import { visibleWorkflows } from "./workflows/selectors";
import { WSState } from "./state";
import { WSActions } from "./actions";

type BriefTone = "danger" | "warn" | "info";
interface BriefItem {
  key: string;
  tone: BriefTone;
  text: string;
  cta: string;
  run: () => void;
}
const TONE_RANK: Record<BriefTone, number> = { danger: 0, warn: 1, info: 2 };

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
  if (isCloudEngine(s.model) && s.privacyOn === false) {
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
    <section className="home-section room-brief">
      <div className="home-section-head">
        <h2>Needs your attention</h2>
        <span>
          {items.length} item{items.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="brief-list">
        {items.map((it) => (
          <div key={it.key} className={`brief-row ${it.tone}`}>
            <span className="brief-dot" aria-hidden="true" />
            <span className="brief-text">{it.text}</span>
            <button className="brief-cta" onClick={it.run}>
              {it.cta}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Room home: continue recent work, then reach every capability — quiet
 * lists, not a card gallery. Shown in the center pane on unlock. */
export default function FrontPage({
  page,
  s,
  a,
}: {
  page: FrontPageData;
  s: WSState;
  a: WSActions;
}) {
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const goArea = (area: "recordings" | "memory") => {
    s.setShowMap(false);
    s.setShowWorkflows(false);
    s.setShowScripts(false);
    s.setOpenFile(null);
    s.setArea(area);
  };
  return (
    <div className="home-view">
      <div className="home-inner">
        <header className="home-head">
          <h1>Continue where you left off</h1>
          <p>
            Recent work, current background activity, and everything this room
            can do — nothing here leaves this Mac on its own.
          </p>
        </header>

        <RoomBrief s={s} a={a} />

        <section className="home-section">
          <div className="home-section-head">
            <h2>Continue</h2>
            <span>Recent activity</span>
          </div>
          <div className="home-list">
            {page.recentFiles.length === 0 && page.recentChats.length === 0 && (
              <div className="empty-hint">
                Nothing here yet — add a file or ask the room a question.
              </div>
            )}
            {page.recentFiles.map((f) => (
              <button
                key={f.id}
                className="home-row"
                title={f.name}
                onClick={() => a.viewFile(f.id)}
              >
                <span className="home-row-icon">
                  <FileTypeIcon file={f} size={15} />
                </span>
                <span className="home-row-main">
                  <span className="home-row-title">{displayName(f.name)}</span>
                  <span className="home-row-copy">
                    {fileKindLabel(f).replace(/^./, (c) => c.toUpperCase())}
                  </span>
                </span>
                <span className="home-row-meta">{formatWhen(f.createdAt)}</span>
              </button>
            ))}
            {page.recentChats.map((c) => (
              <button
                key={c.id}
                className="home-row"
                title={c.title}
                onClick={() => {
                  s.setActiveChatId(c.id);
                  s.setAiTab("chat");
                }}
              >
                <span className="home-row-icon">
                  <ChatBubbleIcon size={15} />
                </span>
                <span className="home-row-main">
                  <span className="home-row-title">{c.title}</span>
                  <span className="home-row-copy">Chat</span>
                </span>
                <span className="home-row-meta">{formatWhen(c.createdAt)}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <h2>Work in this room</h2>
            <span>All capabilities</span>
          </div>
          <div className="home-list">
            <button className="home-row" onClick={() => goArea("recordings")}>
              <span className="home-row-icon">
                <MicIcon size={15} />
              </span>
              <span className="home-row-main">
                <span className="home-row-title">Record and transcribe</span>
                <span className="home-row-copy">
                  Microphone, Mac audio, live translation, editing, export
                </span>
              </span>
              <span className="home-row-meta">Recordings</span>
            </button>
            <button className="home-row" onClick={() => a.openWorkflows()}>
              <span className="home-row-icon">
                <WorkflowsIcon size={15} />
              </span>
              <span className="home-row-main">
                <span className="home-row-title">Automate repeated work</span>
                <span className="home-row-copy">
                  Visual pipelines, schedules, file actions, run history
                </span>
              </span>
              <span className="home-row-meta">Workflows</span>
            </button>
            <button className="home-row" onClick={() => a.openScripts()}>
              <span className="home-row-icon">
                <ScriptIcon size={15} />
              </span>
              <span className="home-row-main">
                <span className="home-row-title">Run a room script</span>
                <span className="home-row-copy">
                  Python or JavaScript with explicit inputs, outputs, and consent
                </span>
              </span>
              <span className="home-row-meta">Scripts</span>
            </button>
            <button
              className="home-row"
              disabled={s.files.length === 0}
              onClick={() => {
                s.setOpenFile(null);
                s.setShowMap(true);
              }}
            >
              <span className="home-row-icon">
                <GraphIcon size={15} />
              </span>
              <span className="home-row-main">
                <span className="home-row-title">See how files connect</span>
                <span className="home-row-copy">
                  The Room Map of files, notes, and their relationships
                </span>
              </span>
              <span className="home-row-meta">Room Map</span>
            </button>
            <button className="home-row" onClick={() => goArea("memory")}>
              <span className="home-row-icon">
                <MemoryIcon size={15} />
              </span>
              <span className="home-row-main">
                <span className="home-row-title">
                  Manage memory and scratch notes
                </span>
                <span className="home-row-copy">
                  {page.memories.length > 0
                    ? `${page.memories.length} saved memor${page.memories.length === 1 ? "y" : "ies"} — visible and editable`
                    : "Durable facts and preferences, always visible and editable"}
                </span>
              </span>
              <span className="home-row-meta">Memory</span>
            </button>
            <button className="home-row" onClick={() => s.setAiTab("studio")}>
              <span className="home-row-icon">
                <SparkIcon size={15} />
              </span>
              <span className="home-row-main">
                <span className="home-row-title">Transform your sources</span>
                <span className="home-row-copy">
                  Flashcards, mind maps, podcast scripts, room summary
                </span>
              </span>
              <span className="home-row-meta">Studio</span>
            </button>
          </div>
        </section>

        {/* Suggested questions rest in a collapsed, low-contrast tray — the
            home page's optional ideas must not compete with the actual work.
            One click opens them; the count says what's inside. */}
        {s.fpSuggestions.length > 0 && (
          <div className="fp-suggestions">
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
                    s.composerRef.current?.focus();
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
