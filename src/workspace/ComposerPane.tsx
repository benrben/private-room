import { useEffect, useState, useSyncExternalStore } from "react";
import {
  CloseIcon,
  CloudIcon,
  FileTypeIcon,
  GlobeIcon,
  MicIcon,
  PaperclipIcon,
  SparkIcon,
  StopIcon,
} from "../icons";
import { displayName, openingSigil } from "./composer";
import { isCloudEngine, isCloudRoute, isExternalEngine } from "./markup";
import { currentTurnScope, subscribeTurnScope } from "./chatActions";
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
  // Which of the three token controls the message currently commits to, so the
  // matching chip can be drawn circled. Display only — `parseComposer` still
  // decides what is actually sent, and this reads the same patterns it does.
  const sigil = openingSigil(s.question);
  // The box says what this turn will actually be answered from, in the same
  // words the strip above the chat states it in. Subscribed rather than passed:
  // the strip is three components up, and a box promising the room while the
  // strip promises the page is precisely the drift this is here to prevent.
  const scope = useSyncExternalStore(subscribeTurnScope, currentTurnScope);
  return (
    <div className="composer">
      {batchTidy ? (
        <div className="import-suggestion batch">
          <SparkIcon size={14} />
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
      {/* Engine parity: every engine can reach connected tools now — local
          and `:cloud` through the sidecar loop, external CLIs through the
          room bridge (web always when enabled; connected MCP tools only when
          the advisor-tools switch says so). Reach is a fact about the ROOM's
          own internet switch and its connected tools (Settings → Online:
          "search queries and fetched pages leave this Mac"), not about which
          model is answering — a local model keeps its OWN reasoning on this
          Mac, but a local room with web search on still sends every query
          out, which is exactly what the badge below exists to say. */}
      {(() => {
        const external = isExternalEngine(s.model);
        const webReach = s.webOn;
        const mcpReach =
          s.mcpTools.length > 0 && (!external || s.advisorToolsOn);
        const reachesInternet = webReach || mcpReach;
        const reachTitle = [
          webReach ? "Web search: on" : null,
          mcpReach ? `Connected tools: ${s.mcpTools.join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        // ONE contextual line, not two permanent ribbons: it reflects what
        // THIS turn is about to do, not a standing fact repeated under every
        // past message (that lived here too, but rendered unconditionally —
        // the same words under every answer in the transcript). A cloud
        // model only says so once the user has actually started composing a
        // message to send it — an empty box has nothing pending to warn
        // about — and reach folds into the same sentence rather than a
        // second parallel strip, since while actively composing on a cloud
        // model both facts are true at once and saying so twice is noise.
        if (isCloudRoute(s.model, s.ai) && s.question.trim().length > 0) {
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
            <div
              className="cloud-strip"
              title={[
                "This room is using a cloud model — your prompts and attached context are sent to it.",
                reachTitle,
              ]
                .filter(Boolean)
                .join("\n")}
            >
              <span className="cloud-strip-label">
                <CloudIcon size={14} />
                {reachesInternet
                  ? "This will leave your Mac — this room can also reach the internet."
                  : "This will leave your Mac."}
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
        }

        // The complementary case: reach is real but the sentence above either
        // isn't drawn (a local room, or a cloud room the reader hasn't
        // started typing into yet) or already said its own thing without
        // folding this in. A local room's own reasoning never leaves the
        // Mac, but the room's internet switch and connected tools still can
        // — this is the one honest place left to say so.
        if (!reachesInternet) return null;
        return (
          <div className="mcp-badge" title={reachTitle}>
            <span className="badge-label">
              <GlobeIcon size={14} /> This room can reach the internet
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
              <PaperclipIcon size={14} /> Attach it
            </button>
          </div>
        );
      })()}
      {s.attachments.length > 0 && (
        // A labelled group, so the count reaches assistive technology once and
        // the chips read as belonging to it rather than as loose buttons.
        <div
          className="attach-row"
          role="group"
          aria-label={`${s.attachments.length} attached ${
            s.attachments.length === 1 ? "file" : "files"
          }`}
        >
          {/* The ring keeps the number from reading as part of a sentence.
              Not the hand: the app counted these, and the hand is for words a
              person wrote (paper.css §3). aria-hidden: the group above already
              says the number, and saying it twice is noise. */}
          <span className="attach-row-label" aria-hidden="true">
            Attached <span className="nb-circled">{s.attachments.length}</span>
          </span>
          {s.attachments.map((f) => (
            // `title` carries the FULL stored filename. The visible label is
            // the tidy one every other list in the app uses (no extension —
            // the type icon beside it says that), so ellipsising its tail can
            // never hide what kind of file this is.
            <span key={f.id} className="attach-chip" title={f.name}>
              <FileTypeIcon file={f} size={14} />
              <span className="attach-chip-name">{displayName(f.name)}</span>
              <button
                title="Remove"
                // The bare "×" was this button's whole accessible name, which
                // told a screen-reader user nothing about WHICH chip they were
                // on. The real filename does.
                aria-label={`Remove ${f.name} from this message`}
                onClick={() => a.toggleAttach(f)}
              >
                <CloseIcon size={12} />
              </button>
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
          // `autocompleteItems` CAPS what it returns — ten skills, and ten rows
          // for files & folders — so `items.length` is the length of this list,
          // never how many the room holds. "10 enabled skills" said to someone
          // who enabled twenty-five states our cap as a fact about their room.
          // The same filters the list itself uses, run without the cap.
          const q = s.ac.query;
          const matched =
            s.ac.kind === "skill"
              ? s.skills.filter((skill) => skill.enabled && skill.name.startsWith(q)).length
              : s.ac.kind === "ref"
                ? s.folders.filter((f) => f.name.toLowerCase().includes(q)).length +
                  s.files.filter((f) => f.name.toLowerCase().includes(q)).length
                : items.length;
          const count = matched > items.length ? `${items.length} of ${matched}` : `${items.length}`;
          return (
            <div className="ac-popover">
              {/* The count says how much is below the fold; the key hints make
                  the whole list reachable without the mouse. */}
              <div className="ac-hint ac-hint-row" id="ac-label">
                <span>
                  {s.ac.kind === "cmd"
                    ? `${items.length} commands`
                    : s.ac.kind === "skill"
                      ? `${count} enabled skills`
                      : s.ac.kind === "agent"
                        ? items.length > 0
                          ? `${items.length} specialists`
                          : "Specialists"
                        : `${count} files & folders`}
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
                    aria-disabled={it.disabled || undefined}
                    disabled={it.disabled}
                    title={it.disabled ? it.hint : undefined}
                    className={`ac-item ${i === s.ac!.index ? "active" : ""}${it.disabled ? " unavailable" : ""}`}
                    ref={(el) => {
                      // Arrow-keying below the fold must scroll the list with it.
                      if (i === s.ac!.index) el?.scrollIntoView({ block: "nearest" });
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (it.disabled) return;
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
          placeholder={scope.placeholder}
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
          onBlur={a.dismissAutocomplete}
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
            {/* `is-on` is drawn, not announced: it says the message already
                opens with this control's token, which is sitting in the
                textarea in plain text where a screen reader is reading it
                anyway. Adding a pressed state would claim these are toggles,
                and they are not — each one inserts a token. */}
            <button
              className={`tool-chip${sigil === "#" ? " is-on" : ""}`}
              title="Run a prebuilt action"
              onClick={() => a.insertComposerToken("#")}
            >
              <span className="tool-hash">#</span> Action
            </button>
            <button
              className={`tool-chip${sigil === "/" ? " is-on" : ""}`}
              title={
                s.skills.some((skill) => skill.enabled)
                  ? "Use a specific enabled skill for this answer"
                  : "Enable a skill in Skills to use this"
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
              className={`tool-chip${sigil === "*" ? " is-on" : ""}`}
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
                {/* The spec's "small hand-drawn arrow" on the primary action.
                    paper.css already owns that mark (--nb-glyph-arrow, masked
                    from currentColor), so it costs no second icon system and
                    inherits the button's ink for free. Decorative: the
                    button's accessible name is the aria-label above. */}
                <span className="nb-ico nb-ico-arrow send-arrow" aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
