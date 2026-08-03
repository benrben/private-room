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
  StopIcon,
} from "../icons";
import { displayName } from "./composer";
import { isCloudEngine, isCloudRoute, isExternalEngine } from "./markup";
import { bestLocalModel } from "./localModel";
import { RECOMMENDED_MODELS } from "./constants";
import { WSState } from "./state";
import { WSActions } from "./actions";
import TokenBudgetBar from "./TokenBudgetBar";

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
  // The palette's a11y wiring, computed once for the textarea below: the
  // popover is rendered inside an IIFE (it has to weigh rows against the
  // honest empty-state note), and the input needs the same two facts.
  const acItems = s.ac ? a.autocompleteItems() : [];
  const acOpen = Boolean(s.ac) && (acItems.length > 0 || Boolean(a.autocompleteNote()));
  const acActive =
    s.ac && acItems.length > 0 ? `ac-opt-${Math.min(s.ac.index, acItems.length - 1)}` : undefined;
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
              aria-label="Dismiss these suggestions"
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
      {isCloudRoute(s.model, s.ai) &&
        (() => {
          // "Use local" has to land on a model that actually runs on this Mac.
          // `ai.defaultModel` echoes the room's SAVED model setting, which in a
          // cloud room is the cloud model itself — switching to it was a no-op.
          // Taking the FIRST installed model instead is no better: that list is
          // Ollama's raw /api/tags order, so it can name the grounding model or
          // a 1B with no tool calling. Ask in the host's own preference order.
          const localModel = bestLocalModel(
            (s.ai?.models ?? []).filter((m) => !isCloudEngine(m)),
            RECOMMENDED_MODELS.map((m) => m.name),
          );
          return (
            <div className="cloud-strip" title="This room is using a cloud model — your prompts and attached context are sent to it.">
              <span className="cloud-strip-label">
                <CloudIcon size={13} /> Cloud · leaves this Mac
              </span>
              <button
                className="cloud-strip-action"
                title={
                  localModel
                    ? `Switch this room to ${localModel}, which runs on this Mac`
                    : "No on-device model is installed yet"
                }
                onClick={() => {
                  if (!localModel) {
                    s.pushToast(
                      "info",
                      "No on-device model is installed yet — download one in Settings → AI model.",
                    );
                    return;
                  }
                  void a.changeModel(localModel);
                }}
              >
                Use local
              </button>
            </div>
          );
        })()}
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
        // Match the name the user actually SEES as well as the stored one:
        // every list in the app labels files with `displayName` (no extension),
        // so "what's in the receipt?" must nudge just like "receipt.png" does.
        const hit = s.files.find((f) => {
          if (!f.mimeType.startsWith("image/") || attachedIds.has(f.id)) return false;
          const names = [f.name, displayName(f.name)];
          return names.some(
            (n) => n.length >= 3 && q.includes(n.toLowerCase()),
          );
        });
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
      <TokenBudgetBar s={s} a={a} />
      <div className={`composer-card${s.asking ? " busy" : ""}`}>
        {(() => {
          if (!s.ac) return null;
          const items = a.autocompleteItems();
          // The "*" menu stays open on its NOTE alone. Every other palette
          // closes when it has no rows, and should: "no file matches" is not a
          // claim about the room, but "this room has no specialists" is, and
          // an empty menu would leave the user to guess which it meant.
          const note = a.autocompleteNote();
          if (items.length === 0 && !note) return null;
          return (
            <div className="ac-popover">
              {/* The count says how much is below the fold; the key hints make
                  the whole list reachable without the mouse. */}
              <div className="ac-hint ac-hint-row" id="ac-label">
                <span>
                  {s.ac.kind === "cmd"
                    ? `${items.length} commands`
                    : s.ac.kind === "skill"
                      ? `${items.length} enabled skills`
                      : s.ac.kind === "agent"
                        ? items.length > 0
                          ? `${items.length} specialists`
                          : "Specialists"
                        : `${items.length} files & folders`}
                </span>
                {/* A menu with no rows has nothing to arrow onto — promising
                    keys that do nothing is the same small lie in miniature. */}
                <span className="ac-keys">
                  {items.length > 0 ? "↑↓ choose · Enter run · Esc close" : "Esc close"}
                </span>
              </div>
              {note ? (
                // `alert` rather than a row: it is a statement about the room,
                // not something to choose, and a screen reader should say it
                // when it appears instead of counting it among the options.
                <div className="ac-hint ac-empty" role="alert">
                  {note}
                </div>
              ) : null}
              <div id="ac-listbox" role="listbox" aria-labelledby="ac-label">
                {items.map((it, i) => (
                  <button
                    key={it.key}
                    id={`ac-opt-${i}`}
                    role="option"
                    aria-selected={i === s.ac!.index}
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
            </div>
          );
        })()}
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
                aria-label="Close the command list"
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
          // The palette is a combobox whose input is this box: focus never
          // leaves it, so the ACTIVE option has to be announced from here
          // (`aria-activedescendant`) — a role on the list alone would be read
          // by nobody. Applies to all four menus (#, @, /, *), which is the
          // point: one palette, one set of semantics.
          role="combobox"
          aria-expanded={acOpen}
          aria-controls={acOpen ? "ac-listbox" : undefined}
          aria-activedescendant={acActive}
          aria-autocomplete="list"
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
            <button
              className="tool-chip"
              title={
                s.skills.some((skill) => skill.enabled)
                  ? "Use a specific enabled skill for this answer"
                  : "Enable a skill in Skills before invoking it"
              }
              disabled={!s.skills.some((skill) => skill.enabled)}
              onClick={() => a.insertComposerToken("/")}
            >
              <span className="tool-hash">/</span> Skill
            </button>
            {/* Never DISABLED on an empty roster, unlike Skill above: the
                roster may simply not have been read yet, and a greyed-out
                button would state as fact something we have not established.
                The menu itself says which of the two it is. */}
            <button
              className="tool-chip"
              title="Send this turn to one specialist agent"
              onClick={() => a.insertComposerToken("*")}
            >
              <span className="tool-hash">*</span> Specialist
            </button>
          </div>
          <div className="composer-tools-right">
            <button
              className={`icon-btn mic-btn ${a.micState("composer").cls}`}
              title={a.micState("composer").title}
              aria-label={a.micState("composer").title}
              // NOT gated on `asking`: the box itself stays typable while an
              // answer streams, so speaking the next question must be too.
              disabled={a.micState("composer").disabled}
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
                aria-label="Stop this answer"
                onClick={a.stopAsk}
              >
                <StopIcon size={14} />
              </button>
            ) : (
              <button
                className="send-btn"
                title="Send ⏎"
                aria-label="Send"
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
