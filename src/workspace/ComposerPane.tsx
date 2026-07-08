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
import { isCloudEngine } from "./markup";
import Toasts from "./Toasts";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** The composer block: toasts, import-tidy chips, cloud/tools strips, the
 * attach nudge, attachment chips, the textarea + #/@ autocomplete popover, the
 * #help sheet, the tool row, mic, and send/stop. Extracted verbatim. */
export default function Composer({ s, a }: { s: WSState; a: WSActions }) {
  return (
    <div className="composer">
      <Toasts toasts={s.toasts} dismissToast={s.dismissToast} />
      {s.importSuggestions.map((sug) => (
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
      ))}
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
      {!isCloudEngine(s.model) && (s.webOn || s.mcpTools.length > 0) && (
        <div
          className="mcp-badge"
          title={[
            s.webOn ? "Web search: on" : null,
            s.mcpTools.length > 0
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
      )}
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
            <div className="ac-hint">
              {s.ac.kind === "cmd"
                ? "Commands — run a prebuilt action"
                : "Attach a file or folder as context"}
            </div>
            {a.autocompleteItems().map((it, i) => (
              <button
                key={it.key}
                className={`ac-item ${i === s.ac!.index ? "active" : ""}`}
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
              onClick={() =>
                a.dictateTo("composer", (text) =>
                  s.setQuestion((q) =>
                    q.trim() ? `${q.trimEnd()} ${text}` : text,
                  ),
                )
              }
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
                onClick={a.send}
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
