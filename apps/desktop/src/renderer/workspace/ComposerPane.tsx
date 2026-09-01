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
import { displayName, openingSigil, type AutocompleteItem } from "./composer";
import { isCloudEngine, isCloudRoute, isExternalEngine } from "./markup";
import { currentTurnScope, subscribeTurnScope } from "./chatActions";
import { bestLocalModel } from "./localModel";
import { RECOMMENDED_MODELS } from "./constants";
import { WSState } from "./state";
import { WSActions } from "./actions";
import TokenBudgetBar from "./TokenBudgetBar";

type ComposerProps = { s: WSState; a: WSActions };

function ImportSuggestions({
  s,
  a,
  tidyExpanded,
  setTidyExpanded,
}: ComposerProps & { tidyExpanded: boolean; setTidyExpanded: (expanded: boolean) => void }) {
  const batchTidy = s.importSuggestions.length > 1 && !tidyExpanded;
  if (batchTidy) {
    return (
      <div className="import-suggestion batch">
        <SparkIcon size={14} />
        <span className="import-suggestion-text">
          {s.importSuggestions.length} new files could be renamed and filed.
        </span>
        <span className="import-suggestion-actions">
          <button className="subtle accent" onClick={() => void a.applyAllImportSuggestions()}>
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
    );
  }
  return s.importSuggestions.map((suggestion) => (
    <div className="import-suggestion" key={suggestion.fileId}>
      <SparkIcon size={14} />
      <span className="import-suggestion-text">
        Tidy up <strong>{displayName(suggestion.current)}</strong> →{" "}
        <strong>{suggestion.suggestion.title}</strong>
        {suggestion.suggestion.folder ? (
          <>
            {" "}in <strong>{suggestion.suggestion.folder}</strong>
          </>
        ) : null}
      </span>
      <span className="import-suggestion-actions">
        <button className="subtle accent" onClick={() => a.applyImportSuggestion(suggestion)}>
          Apply
        </button>
        <button className="subtle" onClick={() => a.dismissImportSuggestion(suggestion.fileId)}>
          Dismiss
        </button>
      </span>
    </div>
  ));
}

interface InternetReachability {
  reachesInternet: boolean;
  title: string;
}

function internetReachability(s: WSState): InternetReachability {
  const mcpReach = s.mcpTools.length > 0 && (!isExternalEngine(s.model) || s.advisorToolsOn);
  const reachesInternet = s.webOn || mcpReach;
  const title = [
    s.webOn ? "Web search: on" : null,
    mcpReach ? `Connected tools: ${s.mcpTools.join(", ")}` : null,
  ].filter(Boolean).join("\n");
  return { reachesInternet, title };
}

function CloudReachabilityNotice({ s, a, reachability }: ComposerProps & { reachability: InternetReachability }) {
  const localModel = bestLocalModel(
    (s.ai?.models ?? []).filter((model) => !isCloudEngine(model)),
    RECOMMENDED_MODELS.map((model) => model.name),
  );
  return (
    <div
      className="cloud-strip"
      title={[
        "This room is using a cloud model — your prompts and attached context are sent to it.",
        reachability.title,
      ].filter(Boolean).join("\n")}
    >
      <span className="cloud-strip-label">
        <CloudIcon size={14} />
        {reachability.reachesInternet
          ? "This will leave your Mac — this room can also reach the internet."
          : "This will leave your Mac."}
      </span>
      <button
        className="cloud-strip-action"
        title={localModel
          ? `Switch this room to ${localModel}, which runs on this Mac`
          : "No on-device model is installed yet"}
        onClick={() => {
          if (localModel) {
            void a.changeModel(localModel);
            return;
          }
          s.pushToast(
            "info",
            "No on-device model is installed yet — download one in Settings → AI model.",
          );
        }}
      >
        Use local
      </button>
    </div>
  );
}

function ReachabilityNotice({ s, a }: ComposerProps) {
  const reachability = internetReachability(s);
  if (isCloudRoute(s.model, s.ai) && s.question.trim().length > 0) {
    return <CloudReachabilityNotice s={s} a={a} reachability={reachability} />;
  }
  if (!reachability.reachesInternet) return null;
  return (
    <div className="mcp-badge" title={reachability.title}>
      <span className="badge-label">
        <GlobeIcon size={14} /> This room can reach the internet
      </span>
    </div>
  );
}

function AttachmentNudge({ s, a }: ComposerProps) {
  const query = s.question.trim().toLowerCase();
  if (query === "") return null;
  const attachedIds = new Set(s.attachments.map((file) => file.id));
  const match = s.files.find((file) => {
    if (!file.mimeType.startsWith("image/") || attachedIds.has(file.id)) return false;
    return [file.name, displayName(file.name)].some(
      (name) => name.length >= 3 && query.includes(name.toLowerCase()),
    );
  });
  if (match === undefined) return null;
  return (
    <div className="attach-nudge">
      <span>
        The AI can only see <strong>{displayName(match.name)}</strong> if you attach it.
      </span>
      <button className="subtle" onClick={() => a.toggleAttach(match)}>
        <PaperclipIcon size={14} /> Attach it
      </button>
    </div>
  );
}

function AttachmentChips({ s, a }: ComposerProps) {
  if (s.attachments.length === 0) return null;
  const label = s.attachments.length === 1 ? "file" : "files";
  return (
    <div className="attach-row" role="group" aria-label={`${s.attachments.length} attached ${label}`}>
      <span className="attach-row-label" aria-hidden="true">
        Attached <span className="nb-circled">{s.attachments.length}</span>
      </span>
      {s.attachments.map((file) => (
        <span key={file.id} className="attach-chip" title={file.name}>
          <FileTypeIcon file={file} size={14} />
          <span className="attach-chip-name">{displayName(file.name)}</span>
          <button
            title="Remove"
            aria-label={`Remove ${file.name} from this message`}
            onClick={() => a.toggleAttach(file)}
          >
            <CloseIcon size={12} />
          </button>
        </span>
      ))}
    </div>
  );
}

interface AutocompleteView {
  items: AutocompleteItem[];
  note: string;
  open: boolean;
  activeId: string | undefined;
}

function activeAutocompleteId(s: WSState, items: readonly AutocompleteItem[]): string | undefined {
  if (s.ac === null || items.length === 0) return undefined;
  return `ac-opt-${Math.min(s.ac.index, items.length - 1)}`;
}

function autocompleteView(s: WSState, a: WSActions): AutocompleteView {
  const items = s.ac ? a.autocompleteItems() : [];
  const note = a.autocompleteNote();
  return {
    items,
    note,
    open: s.ac !== null && (items.length > 0 || Boolean(note)),
    activeId: activeAutocompleteId(s, items),
  };
}

function matchedAutocompleteCount(s: WSState, items: readonly AutocompleteItem[]): number {
  if (s.ac?.kind === "skill") {
    return s.skills.filter((skill) => skill.enabled && skill.name.startsWith(s.ac!.query)).length;
  }
  if (s.ac?.kind === "ref") {
    const query = s.ac.query;
    return s.folders.filter((folder) => folder.name.toLowerCase().includes(query)).length
      + s.files.filter((file) => file.name.toLowerCase().includes(query)).length;
  }
  return items.length;
}

function autocompleteHeading(s: WSState, items: readonly AutocompleteItem[], count: string): string {
  if (s.ac?.kind === "cmd") return `${items.length} commands`;
  if (s.ac?.kind === "skill") return `${count} enabled skills`;
  if (s.ac?.kind === "agent") return items.length > 0 ? `${items.length} specialists` : "Specialists";
  return `${count} files & folders`;
}

function autocompleteCountLabel(items: readonly AutocompleteItem[], matched: number): string {
  return matched > items.length ? `${items.length} of ${matched}` : `${items.length}`;
}

function AutocompletePopover({ s, a, autocomplete }: ComposerProps & { autocomplete: AutocompleteView }) {
  if (s.ac === null) return null;
  const { items, note } = autocomplete;
  if (items.length === 0 && !note) return null;
  const matched = matchedAutocompleteCount(s, items);
  const count = autocompleteCountLabel(items, matched);
  return (
    <div className="ac-popover">
      <div className="ac-hint ac-hint-row" id="ac-label">
        <span>{autocompleteHeading(s, items, count)}</span>
        <span className="ac-keys">
          {items.length > 0 ? "↑↓ choose · Enter run · Esc close" : "Esc close"}
        </span>
      </div>
      {note ? <div className="ac-hint ac-empty" role="alert">{note}</div> : null}
      <div id="ac-listbox" role="listbox" aria-labelledby="ac-label">
        {items.map((item, index) => (
          <button
            key={item.key}
            id={`ac-opt-${index}`}
            role="option"
            aria-selected={index === s.ac!.index}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            title={item.disabled ? item.hint : undefined}
            className={`ac-item ${index === s.ac!.index ? "active" : ""}${item.disabled ? " unavailable" : ""}`}
            ref={(element) => {
              if (index === s.ac!.index) element?.scrollIntoView({ block: "nearest" });
            }}
            onMouseDown={(event) => {
              event.preventDefault();
              if (!item.disabled) a.acceptAutocomplete(item.insert);
            }}
          >
            <span className="ac-label">{item.label}</span>
            {item.usage && <code className="ac-usage">{item.usage}</code>}
            <span className="ac-desc">{item.hint}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function HelpPopover({ s }: Pick<ComposerProps, "s">) {
  if (!s.showHelp || s.ac !== null) return null;
  return (
    <div className="ac-popover help-popover">
      <div className="ac-hint" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
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
      {s.commands.map((command) => (
        <button
          key={command.name}
          className="ac-item"
          onMouseDown={(event) => {
            event.preventDefault();
            s.setShowHelp(false);
            s.setQuestion(`#${command.name} `);
            s.composerRef.current?.focus();
          }}
        >
          <span className="ac-label">#{command.name}</span>
          <code className="ac-usage">{command.usage}</code>
          <span className="ac-desc">{command.summary}</span>
        </button>
      ))}
    </div>
  );
}

function ComposerInput({ s, a, autocomplete, placeholder }: ComposerProps & { autocomplete: AutocompleteView; placeholder: string }) {
  return (
    <textarea
      ref={s.composerRef}
      className="composer-input"
      placeholder={placeholder}
      value={s.question}
      rows={3}
      dir="auto"
      role="combobox"
      aria-expanded={autocomplete.open}
      aria-controls={autocomplete.open ? "ac-listbox" : undefined}
      aria-activedescendant={autocomplete.activeId}
      aria-autocomplete="list"
      onChange={(event) => {
        s.setQuestion(event.target.value);
        a.refreshAutocomplete(event.target.value, event.target.selectionStart);
        if (s.showHelp) s.setShowHelp(false);
      }}
      onSelect={(event) => a.refreshAutocomplete(event.currentTarget.value, event.currentTarget.selectionStart)}
      onBlur={a.dismissAutocomplete}
      onPaste={a.onComposerPaste}
      onKeyDown={a.onComposerKeyDown}
    />
  );
}

function ComposerTools({ s, a }: ComposerProps) {
  const sigil = openingSigil(s.question);
  const hasEnabledSkill = s.skills.some((skill) => skill.enabled);
  const mic = a.micState("composer");
  return (
    <div className="composer-tools">
      <div className="composer-tools-left">
        <button className="tool-chip" title="Attach a file as context" onClick={() => a.insertComposerToken("@")}>
          <PaperclipIcon size={14} /> Attach
        </button>
        <button className={`tool-chip${sigil === "#" ? " is-on" : ""}`} title="Run a prebuilt action" onClick={() => a.insertComposerToken("#")}>
          <span className="tool-hash">#</span> Action
        </button>
        <button
          className={`tool-chip${sigil === "/" ? " is-on" : ""}`}
          title={hasEnabledSkill ? "Use a specific enabled skill for this answer" : "Enable a skill in Skills to use this"}
          disabled={!hasEnabledSkill}
          onClick={() => a.insertComposerToken("/")}
        >
          <span className="tool-hash">/</span> Skill
        </button>
        <button className={`tool-chip${sigil === "*" ? " is-on" : ""}`} title="Send this turn to one specialist agent" onClick={() => a.insertComposerToken("*")}>
          <span className="tool-hash">*</span> Specialist
        </button>
      </div>
      <div className="composer-tools-right">
        <button
          className={`icon-btn mic-btn ${mic.cls}`}
          title={mic.title}
          aria-label={mic.title}
          disabled={mic.disabled}
          onClick={() => {
            const base = s.question.trim() ? s.question.trimEnd() : "";
            const paint = (text: string) => s.setQuestion(base && text ? `${base} ${text}` : base || text);
            a.dictateTo("composer", paint, paint);
          }}
        >
          <MicIcon size={16} />
        </button>
        {s.asking ? (
          <button className="send-btn stop" title="Stop this answer" aria-label="Stop this answer" onClick={a.stopAsk}>
            <StopIcon size={14} />
          </button>
        ) : (
          <button className="send-btn" title="Send ⏎" aria-label="Send" onClick={() => void a.send()} disabled={!s.question.trim()}>
            <span className="nb-ico nb-ico-arrow send-arrow" aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}

function ComposerCard({ s, a, autocomplete, placeholder }: ComposerProps & { autocomplete: AutocompleteView; placeholder: string }) {
  return (
    <div className={`composer-card${s.asking ? " busy" : ""}`}>
      <AutocompletePopover s={s} a={a} autocomplete={autocomplete} />
      <HelpPopover s={s} />
      <ComposerInput s={s} a={a} autocomplete={autocomplete} placeholder={placeholder} />
      <ComposerTools s={s} a={a} />
    </div>
  );
}

/** The composer block: toasts, import-tidy chips, cloud/tools strips, the
 * attach nudge, attachment chips, the textarea + #/@ autocomplete popover,
 * the #help sheet, the tool row, mic, and send/stop. */
export default function Composer({ s, a }: ComposerProps) {
  const [tidyExpanded, setTidyExpanded] = useState(false);
  useEffect(() => {
    if (s.importSuggestions.length === 0) setTidyExpanded(false);
  }, [s.importSuggestions.length]);
  useEffect(() => {
    if (!s.showHelp) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      s.setShowHelp(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [s.showHelp, s]);
  const autocomplete = autocompleteView(s, a);
  const scope = useSyncExternalStore(subscribeTurnScope, currentTurnScope);
  return (
    <div className="composer">
      <ImportSuggestions s={s} a={a} tidyExpanded={tidyExpanded} setTidyExpanded={setTidyExpanded} />
      <ReachabilityNotice s={s} a={a} />
      <AttachmentNudge s={s} a={a} />
      <AttachmentChips s={s} a={a} />
      <TokenBudgetBar s={s} a={a} />
      <ComposerCard s={s} a={a} autocomplete={autocomplete} placeholder={scope.placeholder} />
    </div>
  );
}
