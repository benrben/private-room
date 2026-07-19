import { useEffect, useState } from "react";
import {
  CloseIcon,
  CloudIcon,
  FileTypeIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  SendIcon,
  SparkIcon,
} from "../icons";
import { displayName } from "./composer";
import { isCloudEngine, isExternalEngine } from "./markup";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The composer block: toasts, import-tidy chips, cloud/tools strips, the
 * attach nudge, attachment chips, the textarea + #/@ autocomplete popover, the
 * #help sheet, the tool row, mic, and send/stop. Extracted verbatim. */
export default function Composer({ s, a }: { s: WSState; a: WSActions }) {
  // Several tidy-up suggestions collapse into ONE card (a stack of three chips
  // over the composer read as noise); Review expands to the per-file chips.
  const [tidyExpanded, setTidyExpanded] = useState(false);
  useEffect(() => {
    // A fresh batch after the last one cleared starts collapsed again.
    if (s.importSuggestions.length === 0) setTidyExpanded(false);
  }, [s.importSuggestions.length]);
  const batchTidy = s.importSuggestions.length > 1 && !tidyExpanded;
  // The #help sheet closes like every other popover: Escape, from anywhere.
  useEffect(() => {
    if (!s.showHelp) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      s.setShowHelp(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s.showHelp, s]);
  return (
    <div className="composer">
      {batchTidy ? (
        <div className="import-suggestion batch">
          <SparkIcon size={13} />
          <span className="import-suggestion-text">
            {s.importSuggestions.length} new files could be renamed and filed.
          </span>
          <span className="import-suggestion-actions">
            <button
              className="subtle accent"
              onClick={() => void a.applyAllImportSuggestions()}
            >
              Tidy up
            </button>
            <button className="subtle quiet" onClick={() => setTidyExpanded(true)}>
              Review
            </button>
            <button
              className="tidy-dismiss"
              title="Dismiss"
              onClick={() => a.dismissAllImportSuggestions()}
            >
              <CloseIcon size={12} />
            </button>
          </span>
        </div>
      ) : (
        s.importSuggestions.map((sug) => (
          <div className="import-suggestion" key={sug.fileId}>
            <SparkIcon size={14} />
            <span className="import-suggestion-text">
              Tidy up <strong>{displayName(sug.current)}</strong> →{" "}
              <strong>{sug.suggestion.title}</strong>
              {sug.suggestion.folder ? (
                <>
                  {" "}
                  in <strong>{sug.suggestion.folder}</strong>
                </>
              ) : null}
            </span>
            <span className="import-suggestion-actions">
              <button
                className="subtle accent"
                onClick={() => a.applyImportSuggestion(sug)}
              >
                Apply
              </button>
              <button
                className="subtle"
                onClick={() => a.dismissImportSuggestion(sug.fileId)}
              >
                Dismiss
              </button>
            </span>
          </div>
        ))
      )}
      {isCloudEngine(s.model) && (
        <div className="cloud-strip" title="This room is using a cloud model — your prompts and attached context are sent to it.">
          <span className="cloud-strip-label">
            <CloudIcon size={13} /> Cloud · leaves this Mac
          </span>
          <button
            className="cloud-strip-action"
            onClick={() => a.changeModel(s.ai?.defaultModel ?? "")}
          >
            Use local
          </button>
        </div>
      )}
      {/* Engine parity: every engine can reach these tools now — local and
          `:cloud` through the sidecar loop, external CLIs through the room
          bridge (web always when enabled; connected MCP tools only when the
          advisor-tools switch says so). The badge states the truth per engine. */}
      {(() => {
        const external = isExternalEngine(s.model);
        const webReach = s.webOn;
        const mcpReach =
          s.mcpTools.length > 0 && (!external || s.advisorToolsOn);
        if (!webReach && !mcpReach) return null;
        return (
          <div
            className="mcp-badge"
            title={[
              webReach ? "Web search: on" : null,
              mcpReach
                ? `Connected tools: ${s.mcpTools.join(", ")}`
                : null,
            ]
              .filter(Boolean)
              .join("\n")}
          >
            <span className="badge-label">
              <GlobeIcon size={13} /> This room can reach the internet
            </span>
          </div>
        );
      })()}
      {(() => {
        const q = s.question.trim().toLowerCase();
        if (!q) return null;
        const attachedIds = new Set(s.attachments.map((f) => f.id));
        const hit = s.files.find(
          (f) =>
            f.mimeType.startsWith("image/") &&
            !attachedIds.has(f.id) &&
            f.name.length >= 3 &&
            q.includes(f.name.toLowerCase()),
        );
        if (!hit) return null;
        return (
          <div className="attach-nudge">
            <span>
              The AI can only see <strong>{displayName(hit.name)}</strong> if you
              attach it.
            </span>
            <button className="subtle" onClick={() => a.toggleAttach(hit)}>
              <PaperclipIcon size={13} /> Attach it
            </button>
          </div>
        );
      })()}
      {s.attachments.length > 0 && (
        <div className="attach-row">
          {s.attachments.map((f) => (
            <span key={f.id} className="attach-chip">
              <FileTypeIcon file={f} size={13} /> {displayName(f.name)}
              <button onClick={() => a.toggleAttach(f)}>×</button>
            </span>
          ))}
        </div>
      )}
      <div className={`composer-card${s.asking ? " busy" : ""}`}>
        {s.ac && a.autocompleteItems().length > 0 && (
          <div className="ac-popover">
            {/* The count says how much is below the fold; the key hints make
                the whole list reachable without the mouse. */}
            <div className="ac-hint ac-hint-row">
              <span>
                {s.ac.kind === "cmd"
                  ? `${a.autocompleteItems().length} commands`
                  : `${a.autocompleteItems().length} files & folders`}
              </span>
              <span className="ac-keys">↑↓ choose · Enter run · Esc close</span>
            </div>
            {a.autocompleteItems().map((it, i) => (
              <button
                key={it.key}
                className={`ac-item ${i === s.ac!.index ? "active" : ""}`}
                ref={(el) => {
                  // Arrow-keying below the fold must scroll the list with it.
                  if (i === s.ac!.index) el?.scrollIntoView({ block: "nearest" });
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  a.acceptAutocomplete(it.insert);
                }}
              >
                <span className="ac-label">{it.label}</span>
                {it.usage && <code className="ac-usage">{it.usage}</code>}
                <span className="ac-desc">{it.hint}</span>
              </button>
            ))}
          </div>
        )}
        {s.showHelp && !s.ac && (
          <div className="ac-popover help-popover">
            <div
              className="ac-hint"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
              }}
            >
              <span>Commands — type # in the box to run one</span>
              <button
                className="toast-close"
                title="Close"
                onClick={() => s.setShowHelp(false)}
              >
                <CloseIcon size={12} />
              </button>
            </div>
            {s.commands.map((c) => (
              <button
                key={c.name}
                className="ac-item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  s.setShowHelp(false);
                  s.setQuestion(`#${c.name} `);
                  s.composerRef.current?.focus();
                }}
              >
                <span className="ac-label">#{c.name}</span>
                <code className="ac-usage">{c.usage}</code>
                <span className="ac-desc">{c.summary}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={s.composerRef}
          className="composer-input"
          placeholder="Ask anything about this room…"
          value={s.question}
          rows={3}
          dir="auto"
          onChange={(e) => {
            s.setQuestion(e.target.value);
            a.refreshAutocomplete(e.target.value, e.target.selectionStart);
            if (s.showHelp) s.setShowHelp(false);
          }}
          onSelect={(e) =>
            a.refreshAutocomplete(
              e.currentTarget.value,
              e.currentTarget.selectionStart,
            )
          }
          onBlur={() => s.setAc(null)}
          onPaste={a.onComposerPaste}
          onKeyDown={a.onComposerKeyDown}
        />
        <div className="composer-tools">
          <div className="composer-tools-left">
            <button
              className="tool-chip"
              title="Attach a file as context"
              onClick={() => a.insertComposerToken("@")}
            >
              <PaperclipIcon size={14} /> Attach
            </button>
            <button
              className="tool-chip"
              title="Run a prebuilt action"
              onClick={() => a.insertComposerToken("#")}
            >
              <span className="tool-hash">#</span> Action
            </button>
          </div>
          <div className="composer-tools-right">
            <button
              className={`icon-btn mic-btn ${a.micState("composer").cls}`}
              title={a.micState("composer").title}
              disabled={a.micState("composer").disabled || s.asking}
              onClick={() => {
                // Streaming dictation paints the words into the box as they
                // are spoken; the shaped final replaces them. `base` is what
                // was typed before the mic opened — captured ONCE, so partial
                // repaints never compound. (The stop re-click lands in the
                // dictateTo toggle branch; its callbacks are discarded.)
                const base = s.question.trim() ? s.question.trimEnd() : "";
                const paint = (t: string) =>
                  s.setQuestion(base && t ? `${base} ${t}` : base || t);
                a.dictateTo("composer", paint, paint);
              }}
            >
              <MicIcon size={16} />
            </button>
            {s.asking ? (
              <button
                className="send-btn stop"
                title="Stop this answer"
                onClick={a.stopAsk}
              >
                <span className="stop-glyph">◼</span>
              </button>
            ) : (
              <button
                className="send-btn"
                title="Send ⏎"
                onClick={() => void a.send()}
                disabled={!s.question.trim()}
              >
                <SendIcon size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
