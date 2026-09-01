import { fileKindLabel, formatSize, type FileMeta, type SearchResults } from "../api";
import { ChatBubbleIcon, CloseIcon, FileTypeIcon, MemoryIcon } from "../icons";
import { fileLabel, formatWhen } from "./composer";
import type { FlatResult } from "./types";
import { filterSummary, placeholderMeta, shortWhen, splitMatches, type SavedSearch, type ShownResults } from "./SearchExpanded";

/** Renders `text` with the searched words marked, one node per run.
 *
 * `<mark>` is the element the browser and the screen reader already understand
 * for "this is why you are looking at this"; find.css's `.nb-mark` clears the
 * UA's own yellow and paints the highlighter over it. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  const parts = splitMatches(text, terms);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="nb-mark">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function fileHitNote(meta: FileMeta | undefined, nameOnly: boolean): string {
  if (!meta) return "no longer in this room";
  if (nameOnly) return "the name matched, not the text";
  if (meta.partiallyIndexed) return "only the first part of this file is indexed";
  return meta.source === "generated" ? "written by the AI in this room" : "";
}

function FileHitMetadata({ meta, note }: { meta: FileMeta | undefined; note: string }) {
  return (
    <span className="find-row-meta">
      {meta ? (
        <>
          <span className="find-row-kind">{fileKindLabel(meta)}</span>
          <span className="find-row-dot" aria-hidden>
            ·
          </span>
          <span>{formatSize(meta.sizeBytes)}</span>
        </>
      ) : (
        <span className="find-row-kind">file</span>
      )}
      {note !== "" && <span className="find-row-note">{note}</span>}
    </span>
  );
}

function FileHitText({
  hit,
  files,
  nameOnly,
  terms,
  meta,
}: {
  hit: SearchResults["files"][number];
  files: FileMeta[];
  nameOnly: boolean;
  terms: string[];
  meta: FileMeta | undefined;
}) {
  return (
    <span className="find-row-main">
      <span className="find-row-title" dir="auto">
        <Highlight text={fileLabel(hit.name, files)} terms={terms} />
      </span>
      {!nameOnly && (
        <span className="find-row-snippet" dir="auto">
          <Highlight text={hit.snippet} terms={terms} />
        </span>
      )}
      <FileHitMetadata meta={meta} note={fileHitNote(meta, nameOnly)} />
    </span>
  );
}

function FileHitDate({ meta }: { meta: FileMeta | undefined }) {
  if (!meta) return null;
  return (
    <span className="find-row-date" title={formatWhen(meta.createdAt)}>
      {shortWhen(meta.createdAt)}
    </span>
  );
}

function openFileHit(
  hit: SearchResults["files"][number],
  nameOnly: boolean,
  onOpenResult: (hit: FlatResult) => void,
  onOpenFile: (id: string) => void,
): void {
  // A name-only hit has no passage to scroll to, so it opens the file plainly
  // rather than sending the viewer hunting for words the document does not contain.
  if (nameOnly) {
    onOpenFile(hit.id);
    return;
  }
  onOpenResult({ kind: "file", id: hit.id, name: hit.name, snippet: hit.snippet });
}

function FileSearchRow({
  hit,
  files,
  fileById,
  terms,
  index,
  isSelected,
  registerRowRef,
  onSelectIndex,
  onOpenResult,
  onOpenFile,
}: {
  hit: SearchResults["files"][number];
  files: FileMeta[];
  fileById: Map<string, FileMeta>;
  terms: string[];
  index: number;
  isSelected: boolean;
  registerRowRef: (idx: number) => (el: HTMLButtonElement | null) => void;
  onSelectIndex: (idx: number) => void;
  onOpenResult: (hit: FlatResult) => void;
  onOpenFile: (id: string) => void;
}) {
  const meta = fileById.get(hit.id);
  const shape = meta ?? placeholderMeta(hit.id, hit.name);
  const nameOnly = hit.snippet === "";
  return (
    <button
      ref={registerRowRef(index)}
      type="button"
      className={`find-row${isSelected ? " is-sel" : ""}`}
      title={meta ? `Open ${hit.name}` : hit.name}
      onMouseEnter={() => onSelectIndex(index)}
      onClick={() => openFileHit(hit, nameOnly, onOpenResult, onOpenFile)}
    >
      <span className="find-row-ico" aria-hidden>
        <FileTypeIcon file={shape} size={16} />
      </span>
      <FileHitText hit={hit} files={files} nameOnly={nameOnly} terms={terms} meta={meta} />
      <FileHitDate meta={meta} />
    </button>
  );
}

/** The Files / Conversations / Memories groups, in the launcher's row style —
 * icon, highlighted title or snippet, a meta line, the date pencilled in the
 * margin. `selectedIndex` is the launcher's own arrow-key position; a row
 * knows it is "sel" the same way the launcher's Commands rows do. */
export function SearchResultRows({
  shown,
  files,
  fileById,
  terms,
  selectedIndex,
  registerRowRef,
  onSelectIndex,
  onOpenResult,
  onOpenFile,
}: {
  shown: ShownResults;
  /** Every file in the room, for `fileLabel`'s duplicate-name disambiguation —
   * the same list the retired Find page read it from. */
  files: FileMeta[];
  fileById: Map<string, FileMeta>;
  terms: string[];
  selectedIndex: number;
  registerRowRef: (idx: number) => (el: HTMLButtonElement | null) => void;
  onSelectIndex: (idx: number) => void;
  onOpenResult: (hit: FlatResult) => void;
  onOpenFile: (id: string) => void;
}) {
  const msgOffset = shown.files.length;
  const memOffset = shown.files.length + shown.messages.length;
  return (
    <div className="find-groups">
      {shown.files.length > 0 && (
        <section className="find-group">
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-blue">Files</span>
            <span className="find-group-n">{shown.files.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {shown.files.map((hit, index) => (
              <FileSearchRow
                key={hit.id}
                hit={hit}
                files={files}
                fileById={fileById}
                terms={terms}
                index={index}
                isSelected={selectedIndex === index}
                registerRowRef={registerRowRef}
                onSelectIndex={onSelectIndex}
                onOpenResult={onOpenResult}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
        </section>
      )}

      {shown.messages.length > 0 && (
        <section className="find-group">
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-green">Conversations</span>
            <span className="find-group-n">{shown.messages.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {shown.messages.map((m, i) => {
              const idx = msgOffset + i;
              return (
                <button
                  key={m.messageId}
                  ref={registerRowRef(idx)}
                  type="button"
                  className={`find-row${selectedIndex === idx ? " is-sel" : ""}`}
                  title="Show this message in the conversation"
                  onMouseEnter={() => onSelectIndex(idx)}
                  onClick={() =>
                    onOpenResult({ kind: "message", chatId: m.chatId, messageId: m.messageId, snippet: m.snippet })
                  }
                >
                  <span className="find-row-ico" aria-hidden>
                    <ChatBubbleIcon size={16} />
                  </span>
                  <span className="find-row-main">
                    <span className="find-row-snippet find-row-lead" dir="auto">
                      <Highlight text={m.snippet} terms={terms} />
                    </span>
                    <span className="find-row-meta">
                      <span className="find-row-kind">message</span>
                      <span className="find-row-note">opens in the transcript</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {shown.memories.length > 0 && (
        <section className="find-group">
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-pink">Memories</span>
            <span className="find-group-n">{shown.memories.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {shown.memories.map((m, i) => {
              const idx = memOffset + i;
              return (
                <button
                  key={m.id}
                  ref={registerRowRef(idx)}
                  type="button"
                  className={`find-row${selectedIndex === idx ? " is-sel" : ""}`}
                  title="Show this in Memory"
                  onMouseEnter={() => onSelectIndex(idx)}
                  onClick={() => onOpenResult({ kind: "memory", id: m.id, snippet: m.snippet })}
                >
                  <span className="find-row-ico" aria-hidden>
                    <MemoryIcon size={16} />
                  </span>
                  <span className="find-row-main">
                    <span className="find-row-snippet find-row-lead" dir="auto">
                      <Highlight text={m.snippet} terms={terms} />
                    </span>
                    <span className="find-row-meta">
                      <span className="find-row-kind">memory</span>
                      <span className="find-row-note">the AI may use this when relevant</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** "Save this search" / "Ask the room instead" — the two things worth doing
 * with a query besides opening a hit. Shown once a query has actually run. */
export function SearchQueryActions({
  query,
  isSaved,
  onToggleSaved,
  onAsk,
}: {
  query: string;
  isSaved: boolean;
  onToggleSaved: () => void;
  onAsk: (q: string) => void;
}) {
  return (
    <div className="find-query-actions">
      <button
        type="button"
        className={`nb-chip nb-chip-btn find-chip${isSaved ? " is-on" : ""}`}
        aria-pressed={isSaved}
        title={isSaved ? "Stop keeping this search" : "Keep this search — words and filters — in this room"}
        onClick={onToggleSaved}
      >
        {isSaved && <span className="nb-ico nb-ico-check find-chip-tick" aria-hidden />}
        <span>{isSaved ? "Saved" : "Save this search"}</span>
      </button>
      <button
        type="button"
        className="nb-btn find-ask"
        title="Hand these words to the room's AI instead of listing hits"
        onClick={() => onAsk(query)}
      >
        Ask the room instead
      </button>
    </div>
  );
}

/** Idle recall — shown while the query field is empty, above the Commands
 * list. Recent searches are automatic; saved ones are a deliberate keep. */
export function SearchIdlePanel({
  recent,
  saved,
  onRunRecent,
  onRunSaved,
  onRemoveSaved,
  onClearRecent,
}: {
  recent: string[];
  saved: SavedSearch[];
  onRunRecent: (q: string) => void;
  onRunSaved: (s: SavedSearch) => void;
  onRemoveSaved: (q: string) => void;
  onClearRecent: () => void;
}) {
  if (recent.length === 0 && saved.length === 0) return null;
  return (
    <div className="find-idle">
      {saved.length > 0 && (
        <section>
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-yellow">Saved searches</span>
            <span className="find-group-n">{saved.length}</span>
          </h2>
          <div className="find-rows nb-list">
            {saved.map((s) => {
              const summary = filterSummary(s.filters);
              return (
                <div key={s.q} className="find-saved-row">
                  <button
                    type="button"
                    className="find-row find-saved-run"
                    title={`Search this room for “${s.q}” again`}
                    onClick={() => onRunSaved(s)}
                  >
                    <span className="find-row-ico" aria-hidden>
                      <span className="nb-bookmark" />
                    </span>
                    <span className="find-row-main">
                      <span className="find-row-title" dir="auto">
                        {s.q}
                      </span>
                      <span className="find-row-meta">
                        {summary.length > 0 ? (
                          summary.map((w) => (
                            <span key={w} className="find-row-kind">
                              {w}
                            </span>
                          ))
                        ) : (
                          <span className="find-row-kind">the whole room</span>
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="find-saved-del"
                    title={`Stop keeping “${s.q}”`}
                    aria-label={`Stop keeping the saved search “${s.q}”`}
                    onClick={() => onRemoveSaved(s.q)}
                  >
                    <CloseIcon size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
      {recent.length > 0 && (
        <section>
          <h2 className="find-group-head">
            <span className="nb-cat nb-mark-yellow">Recent</span>
            <span className="find-group-n">{recent.length}</span>
          </h2>
          <div className="find-chips find-recent">
            {recent.map((r) => (
              <button
                key={r}
                type="button"
                className="nb-chip nb-chip-btn find-chip"
                title={`Search for “${r}” again`}
                onClick={() => onRunRecent(r)}
              >
                <span dir="auto">{r}</span>
              </button>
            ))}
            <button type="button" className="nb-btn nb-btn-quiet find-clear" onClick={onClearRecent}>
              Clear recent
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
