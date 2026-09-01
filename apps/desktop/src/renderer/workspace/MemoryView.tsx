import { useEffect, useState } from "react";
import { api, Memory, RoomInfo } from "../api";
import {
  CheckIcon,
  CloseIcon,
  MemoryIcon,
  MicIcon,
  PencilIcon,
  SearchIcon,
} from "../icons";
import { formatWhen, uniqueFileName } from "./composer";
import { MEMORY_INTRO_SEEN } from "./constants";
import DeleteControl from "./DeleteControl";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { isCloudRoute, trustState } from "./markup";

/** Wave 1b (idea 5): fixed display order for the memory groups; null = the
 * uncategorized bucket every legacy memory lives in. */
const MEMORY_GROUPS: { key: string | null; label: string }[] = [
  { key: "instruction", label: "Instructions" },
  { key: "preference", label: "Preferences" },
  { key: "project", label: "Projects" },
  { key: "fact", label: "Facts" },
  { key: null, label: "Other" },
];
const CATEGORY_OPTIONS = ["preference", "fact", "project", "instruction"];
const KNOWN_CATS = new Set(CATEGORY_OPTIONS);

/** Which display group a memory belongs to: its category when it is one of the
 * known buckets, otherwise the catch-all "Other" (null) group. This keeps the
 * grouping EXHAUSTIVE — a memory with a null OR an unrecognized category still
 * renders, so the count can never disagree with what's on screen. */
const groupKey = (m: { category: string | null }): string | null =>
  m.category && KNOWN_CATS.has(m.category) ? m.category : null;

/** The one category that earns a marker colour.
 *
 * The five marker meanings are product-wide — pink saved, yellow pending,
 * green done, blue linked, red urgent — and a memory's CATEGORY is not a
 * status: a fact, a project note and an instruction are all equally current
 * and equally approved. Painting them would import a meaning the product uses
 * elsewhere and make a plain fact look like something waiting on the reader.
 *
 * Pink is "personal", and a preference is definitionally a personal standing
 * note, so that one maps honestly and takes the marker. Everything else takes
 * the neutral graphite tab and is carried by the category WORD instead — the
 * same conclusion the sidebar's own category pill reached. */
const catClass = (category: string | null) =>
  category === "preference" ? " is-preference" : "";

/** Three worked examples for the empty state, so the page shows what a good
 * memory looks like instead of only saying there are none.
 *
 * They are inert by construction: no ids, no handlers, nothing focusable — and
 * the caption, the tape label and the dashed pencil border each say
 * independently that these are not saved. */
const EXAMPLE_MEMORIES: { text: string; category: string }[] = [
  { text: "Answer in British English, and keep replies under 200 words unless I ask for detail.", category: "instruction" },
  { text: "Prefers bullet points over paragraphs when comparing options.", category: "preference" },
  { text: "The Q3 supplier review runs from September to mid-October.", category: "project" },
];

type MemoryViewProps = {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
};

function matchingMemories(
  memories: Memory[],
  filter: string,
  newestFirst: boolean,
): Memory[] {
  const query = filter.trim().toLowerCase();
  const matches = (memory: Memory) =>
    !query ||
    memory.content.toLowerCase().includes(query) ||
    (memory.category ?? "").toLowerCase().includes(query);
  return memories.filter(matches).sort((left, right) =>
    newestFirst
      ? right.createdAt.localeCompare(left.createdAt)
      : left.createdAt.localeCompare(right.createdAt),
  );
}

function memoryExportBody(memories: Memory[], roomName: string): string {
  const lines = MEMORY_GROUPS.filter((group) =>
    memories.some((memory) => groupKey(memory) === group.key),
  ).flatMap((group) => [
    `## ${group.label}`,
    "",
    ...memories
      .filter((memory) => groupKey(memory) === group.key)
      .map((memory) => `- ${memory.content}  _(added ${formatWhen(memory.createdAt)})_`),
    "",
  ]);
  return [`# Memory — ${roomName}`, "", ...lines].join("\n");
}

async function saveMemoriesAsNote(s: WSState, info: RoomInfo) {
  try {
    const meta = await api.saveGeneratedFile(
      uniqueFileName(
        `Memory — ${info.name}.md`,
        s.files.map((file) => file.name),
      ),
      memoryExportBody(s.memories, info.name),
    );
    s.setFiles(await api.listFiles());
    s.pushToast("success", `Saved "${meta.name}" into the room.`);
  } catch (error) {
    s.pushToast("error", String(error));
  }
}

function useMemoryIntroSeen(s: WSState) {
  useEffect(() => {
    if (!s.showMemoryIntro) return;
    s.setShowMemoryIntro(false);
    api.setSetting(MEMORY_INTRO_SEEN, "1").catch(() => {
      /* non-fatal */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

function memoryRoute(s: WSState): string {
  return {
    good: "Memories are read on this Mac.",
    warn: "Memories relevant to a question are sent to the cloud model with it — private details are replaced first.",
    danger: "Memories relevant to a question are sent to the cloud model with it, exactly as written.",
  }[trustState(isCloudRoute(s.model, s.ai), s.privacyOn).tone];
}

function memoryMicLabel(s: WSState): string {
  return s.dictOwner === "memory" && s.dictState === "recording"
    ? "Stop recording"
    : "Speak a memory";
}

function appendDictation(text: string, setMemoryDraft: WSState["setMemoryDraft"]) {
  setMemoryDraft((draft) =>
    draft.trim() ? `${draft.trimEnd()} ${text}` : text,
  );
}

function MemoryMasthead({ count, route }: { count: number; route: string }) {
  return (
    <header className="mem-masthead">
      <div className="mem-masthead-main">
        <h1 className="mem-title">Memory</h1>
        <p className="mem-lead">
          Everything the AI remembers about you — visible, editable, and used
          only when relevant. {route}
        </p>
      </div>
      {count > 0 && <div className="mem-stamp">{count} saved</div>}
    </header>
  );
}

function MemoryNote() {
  return (
    <details className="mem-note">
      <summary>How suggested memories are handled</summary>
      <div className="mem-note-body">
        <p>
          Suggestions from conversations wait for your approval unless you turn
          on auto-save in Settings → AI &amp; behavior.
        </p>
      </div>
    </details>
  );
}

function MemoryAdd({ s, a }: Pick<MemoryViewProps, "s" | "a">) {
  const mic = a.micState("memory");
  const label = memoryMicLabel(s);
  return (
    <div className="mem-add">
      <input
        placeholder="Something the AI should always remember…"
        value={s.memoryDraft}
        dir="auto"
        aria-label="New memory"
        onChange={(event) => s.setMemoryDraft(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && a.addMemory()}
      />
      <button
        className={`subtle btn-ic mic-btn ${mic.cls}`}
        title={label}
        aria-label={label}
        disabled={mic.disabled}
        onClick={() =>
          a.dictateTo("memory", (text) => appendDictation(text, s.setMemoryDraft))
        }
      >
        <MicIcon size={12} />
      </button>
      <select
        className="memory-cat-select"
        title="Category for the new memory"
        aria-label="Category for the new memory"
        value={s.memoryDraftCat}
        onChange={(event) => s.setMemoryDraftCat(event.target.value)}
      >
        <option value="">no category</option>
        {CATEGORY_OPTIONS.map((category) => (
          <option key={category} value={category}>
            {category}
          </option>
        ))}
      </select>
      <button className="primary" onClick={a.addMemory}>
        Add
      </button>
    </div>
  );
}

function MemoryTools({
  filter,
  newestFirst,
  setFilter,
  setNewestFirst,
  onSave,
}: {
  filter: string;
  newestFirst: boolean;
  setFilter: (filter: string) => void;
  setNewestFirst: (next: boolean | ((previous: boolean) => boolean)) => void;
  onSave: () => void;
}) {
  return (
    <div className="mem-tools">
      <label className="search-field">
        <SearchIcon size={14} />
        <input
          type="search"
          placeholder="Filter memories"
          aria-label="Filter memories"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {filter && (
          <button
            className="side-search-clear"
            title="Clear the filter"
            aria-label="Clear the filter"
            onClick={() => setFilter("")}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </label>
      <button
        className="subtle"
        title="Reverse the order these were added in"
        onClick={() => setNewestFirst((order) => !order)}
      >
        {newestFirst ? "Newest first" : "Oldest first"}
      </button>
      <button
        className="subtle"
        title="Write every memory into a Markdown note in this room"
        onClick={onSave}
      >
        Save as a note
      </button>
    </div>
  );
}

function EmptyMemoryExamples() {
  return (
    <figure className="mem-example">
      <figcaption className="mem-example-cap">
        <span className="nb-tape nb-sem-pending">Example</span>
        <span>Not saved — this is what a good memory looks like.</span>
      </figcaption>
      <ul className="mem-example-list">
        {EXAMPLE_MEMORIES.map((example) => (
          <li
            key={example.text}
            className={`mem-card mem-example-card nb-card${catClass(example.category)}`}
          >
            <span className="mem-card-pin nb-ico nb-ico-pin" aria-hidden="true" />
            <span className="mem-card-body">{example.text}</span>
            <span className="mem-card-foot">
              <span className="mem-cat">{example.category}</span>
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function MemoryEmptyState({
  total,
  shown,
  filter,
}: {
  total: number;
  shown: number;
  filter: string;
}) {
  if (total === 0) {
    return (
      <div className="mem-empty">
        <p className="mem-empty-copy">
          <MemoryIcon size={20} />
          <span>
            Nothing saved yet. Add a durable fact above, or accept a "Worth
            remembering?" suggestion in Chat.
          </span>
        </p>
        <EmptyMemoryExamples />
      </div>
    );
  }
  if (shown !== 0) return null;
  return (
    <div className="mem-empty">
      <p className="mem-empty-copy">
        <MemoryIcon size={20} />
        <span>
          No memory matches “{filter.trim()}”. {total} saved in total.
        </span>
      </p>
    </div>
  );
}

function MemoryGroups({
  shown,
  s,
  a,
}: {
  shown: Memory[];
  s: WSState;
  a: WSActions;
}) {
  const groups = MEMORY_GROUPS.filter((group) =>
    shown.some((memory) => groupKey(memory) === group.key),
  );
  return groups.map((group) => (
    <MemoryGroup
      key={group.key ?? "other"}
      group={group}
      rows={shown.filter((memory) => groupKey(memory) === group.key)}
      hideHeading={groups.length === 1 && group.key === null}
      s={s}
      a={a}
    />
  ));
}

function MemoryGroup({
  group,
  rows,
  hideHeading,
  s,
  a,
}: {
  group: (typeof MEMORY_GROUPS)[number];
  rows: Memory[];
  hideHeading: boolean;
  s: WSState;
  a: WSActions;
}) {
  return (
    <section className="mem-group">
      {!hideHeading && (
        <div className="mem-group-head">
          <h2>{group.label}</h2>
          <span className="nb-circled">{rows.length}</span>
        </div>
      )}
      <ul className="mem-list nb-frame-set">
        <MemoryRows rows={rows} s={s} a={a} />
      </ul>
    </section>
  );
}

function MemoryRows({
  rows,
  s,
  a,
}: {
  rows: Memory[];
  s: WSState;
  a: WSActions;
}) {
  const editing = s.editingMemory;
  return rows.map((memory) =>
    editing?.id === memory.id ? (
      <EditingMemoryRow
        key={memory.id}
        memory={memory}
        editing={editing}
        s={s}
        a={a}
      />
    ) : (
      <SavedMemoryRow key={memory.id} memory={memory} s={s} a={a} />
    ),
  );
}

function EditingMemoryRow({
  memory,
  editing,
  s,
  a,
}: {
  memory: Memory;
  editing: NonNullable<WSState["editingMemory"]>;
  s: WSState;
  a: WSActions;
}) {
  return (
    <li className="mem-card nb-card is-editing">
      <input
        className="mem-edit-input"
        autoFocus
        dir="auto"
        aria-label="Edit this memory"
        value={editing.content}
        onChange={(event) =>
          s.setEditingMemory({
            id: memory.id,
            content: event.target.value,
            category: editing.category ?? null,
          })
        }
        onKeyDown={(event) => {
          if (event.key === "Enter") a.saveMemoryEdit();
          if (event.key === "Escape") s.setEditingMemory(null);
        }}
      />
      <select
        className="memory-cat-select"
        title="Category"
        aria-label="Category"
        value={editing.category ?? ""}
        onChange={(event) =>
          s.setEditingMemory({
            id: memory.id,
            content: editing.content ?? memory.content,
            category: event.target.value || null,
          })
        }
      >
        <option value="">no category</option>
        {CATEGORY_OPTIONS.map((category) => (
          <option key={category} value={category}>
            {category}
          </option>
        ))}
      </select>
      <span className="mem-actions">
        <button className="chip-btn" title="Save" aria-label="Save" onClick={a.saveMemoryEdit}>
          <CheckIcon size={14} />
        </button>
        <button
          className="chip-btn"
          title="Cancel"
          aria-label="Cancel"
          onClick={() => s.setEditingMemory(null)}
        >
          <CloseIcon size={14} />
        </button>
      </span>
    </li>
  );
}

async function forgetMemory(memory: Memory, s: WSState) {
  try {
    await api.deleteMemory(memory.id);
  } catch (error) {
    s.pushToast("error", `Could not forget that memory: ${String(error)}`);
  }
  try {
    s.setMemories(await api.listMemories());
  } catch (error) {
    s.pushToast("error", String(error));
  }
}

function SavedMemoryRow({
  memory,
  s,
  a,
}: {
  memory: Memory;
  s: WSState;
  a: WSActions;
}) {
  return (
    <li className={`mem-card nb-card${catClass(memory.category)}`}>
      <span className="mem-card-pin nb-ico nb-ico-pin" aria-hidden="true" />
      <span className="mem-card-body" dir="auto">
        {memory.content}
      </span>
      <span className="mem-card-foot">
        {memory.category && <span className="mem-cat">{memory.category}</span>}
        <span className="mem-when">Added {formatWhen(memory.createdAt)}</span>
      </span>
      <span className="mem-actions">
        <button
          className="chip-btn"
          title="Edit this memory"
          aria-label="Edit this memory"
          onClick={() =>
            s.setEditingMemory({
              id: memory.id,
              content: memory.content,
              category: memory.category ?? null,
            })
          }
        >
          <PencilIcon size={14} />
        </button>
        <DeleteControl
          k={`mem:${memory.id}`}
          trigger="×"
          onConfirm={() => forgetMemory(memory, s)}
          title="Forget this"
          confirmDelete={s.confirmDelete}
          askConfirm={a.askConfirm}
          cancelConfirm={a.cancelConfirm}
        />
      </span>
    </li>
  );
}

function MemoryScratchPad({ a }: Pick<MemoryViewProps, "a">) {
  return (
    <>
      <hr className="nb-rule-dash mem-fold" />
      <section className="mem-scratch">
        <div className="mem-scratch-head">
          <h2>Scratch pad</h2>
          <span className="mem-scratch-note">temporary — not memory</span>
        </div>
        <div className="mem-sheet">
          <p className="mem-sheet-copy">
            A shared working file — you and the AI both write{" "}
            <strong>Scratch pad.md</strong>. It is ordinary room content and
            never becomes memory automatically.
          </p>
          <button className="subtle btn-ic" onClick={() => void a.openScratchPad()}>
            <PencilIcon size={14} /> Open the scratch pad
          </button>
        </div>
      </section>
    </>
  );
}

/** The Memory & Scratch Pad area: durable, user-visible AI context with
 * add/edit/delete/categories (moved intact from the old sidebar panel),
 * kept clearly apart from the ordinary scratch-pad file. */
export default function MemoryView({ s, a, info }: MemoryViewProps) {
  const [filter, setFilter] = useState("");
  const [newestFirst, setNewestFirst] = useState(false);
  const shown = matchingMemories(s.memories, filter, newestFirst);
  useMemoryIntroSeen(s);
  return (
    <div className="mem-view">
      <div className="mem-inner">
        <MemoryMasthead count={s.memories.length} route={memoryRoute(s)} />
        <MemoryNote />
        <MemoryAdd s={s} a={a} />
        {s.memories.length > 0 && (
          <MemoryTools
            filter={filter}
            newestFirst={newestFirst}
            setFilter={setFilter}
            setNewestFirst={setNewestFirst}
            onSave={() => void saveMemoriesAsNote(s, info)}
          />
        )}
        <MemoryEmptyState
          total={s.memories.length}
          shown={shown.length}
          filter={filter}
        />
        <MemoryGroups shown={shown} s={s} a={a} />
        <MemoryScratchPad a={a} />
      </div>
    </div>
  );
}
