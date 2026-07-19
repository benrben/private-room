import { useState } from "react";
import { FrontPage as FrontPageData } from "../api";
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
import { WSState } from "./state";
import { WSActions } from "./actions";

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
                  <span className="home-row-copy">File</span>
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
