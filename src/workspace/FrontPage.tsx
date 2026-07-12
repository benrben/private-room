import { useState } from "react";
import { FrontPage as FrontPageData } from "../api";
import { displayName } from "./composer";
import StudioShelf from "./StudioShelf";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** Moonshot D4: the Front Page dashboard shown in the viewer pane on unlock.
 * Extracted verbatim from renderFrontPage. */
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
  const rowStyle = {
    textAlign: "left",
    width: "100%",
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } as const;
  return (
    <div className="front-page">
      <div className="front-page-grid">
        <div className="fp-card">
          <div className="fp-card-title">
            Recent files <span className="count">{page.fileCount}</span>
          </div>
          <div className="fp-card-list">
            {page.recentFiles.length === 0 ? (
              <div className="fp-card-empty">Nothing added yet.</div>
            ) : (
              page.recentFiles.map((f) => (
                <button
                  key={f.id}
                  className="subtle"
                  style={rowStyle}
                  title={f.name}
                  onClick={() => a.viewFile(f.id)}
                >
                  {displayName(f.name)}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="fp-card">
          <div className="fp-card-title">
            Recent chats <span className="count">{page.chatCount}</span>
          </div>
          <div className="fp-card-list">
            {page.recentChats.length === 0 ? (
              <div className="fp-card-empty">No chats yet.</div>
            ) : (
              page.recentChats.map((c) => (
                <button
                  key={c.id}
                  className="subtle"
                  style={rowStyle}
                  title={c.title}
                  onClick={() => s.setActiveChatId(c.id)}
                >
                  {c.title}
                </button>
              ))
            )}
          </div>
        </div>

        <div className="fp-card">
          <div className="fp-card-title">
            Memory <span className="count">{page.memories.length}</span>
          </div>
          <div className="fp-card-list">
            {page.memories.length === 0 ? (
              <div className="fp-card-empty">Nothing remembered yet.</div>
            ) : (
              page.memories.slice(0, 5).map((m) => (
                <button
                  key={m.id}
                  className="subtle"
                  style={rowStyle}
                  title={m.content}
                  onClick={a.revealMemory}
                >
                  {m.content}
                </button>
              ))
            )}
          </div>
        </div>

        <StudioShelf s={s} a={a} />
      </div>

      {/* Suggested questions rest in a collapsed, low-contrast tray — the
          dashboard's optional ideas must not compete with the actual work.
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
  );
}
