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

/** The Memory & Scratch Pad area: durable, user-visible AI context with
 * add/edit/delete/categories (moved intact from the old sidebar panel),
 * kept clearly apart from the ordinary scratch-pad file. */
export default function MemoryView({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  // A long-lived room accumulates memories faster than a single ungrouped
  // list can be read: filter, order, and take a copy out.
  const [filter, setFilter] = useState("");
  const [newestFirst, setNewestFirst] = useState(false);
  const q = filter.trim().toLowerCase();
  const matches = (m: Memory) =>
    !q ||
    m.content.toLowerCase().includes(q) ||
    (m.category ?? "").toLowerCase().includes(q);
  // The stored order is oldest-first; the toggle only ever reverses it, so
  // "what the room returned" stays the resting state.
  const shown: Memory[] = s.memories
    .filter(matches)
    .sort((x, y) =>
      newestFirst
        ? y.createdAt.localeCompare(x.createdAt)
        : x.createdAt.localeCompare(y.createdAt),
    );

  /** Write every memory into an ordinary room note — the readable copy the
   * list itself can't be (and the thing an "Export a copy…" can then take out
   * of the room, since exporting works on files). */
  async function saveAsNote() {
    const lines = MEMORY_GROUPS.filter((g) =>
      s.memories.some((m) => groupKey(m) === g.key),
    ).flatMap((g) => [
      `## ${g.label}`,
      "",
      ...s.memories
        .filter((m) => groupKey(m) === g.key)
        .map((m) => `- ${m.content}  _(added ${formatWhen(m.createdAt)})_`),
      "",
    ]);
    const body = [`# Memory — ${info.name}`, "", ...lines].join("\n");
    try {
      // Save the list twice and both notes are called the same thing — Rust
      // never dedups, so the room would carry two rows nothing can tell apart.
      const meta = await api.saveGeneratedFile(
        uniqueFileName(
          `Memory — ${info.name}.md`,
          s.files.map((f) => f.name),
        ),
        body,
      );
      s.setFiles(await api.listFiles());
      s.pushToast("success", `Saved "${meta.name}" into the room.`);
    } catch (e) {
      s.pushToast("error", String(e));
    }
  }

  // Opening the area is the "I've seen it" moment for the first-run intro.
  // The marker is a ROOM setting: keyed by the room's file name it came back
  // after a rename, and two rooms with the same file name shared it.
  useEffect(() => {
    if (!s.showMemoryIntro) return;
    s.setShowMemoryIntro(false);
    api.setSetting(MEMORY_INTRO_SEEN, "1").catch(() => {
      /* non-fatal */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="memory-view">
      <div className="memory-view-inner">
        <header className="memory-view-head">
          <h1>Memory</h1>
        </header>
        <p className="memory-view-sub">
          Everything the AI remembers about you — visible, editable, and used
          only when relevant. Suggestions from conversations wait for your
          approval unless you turn on auto-save in Settings → AI &amp;
          behavior.
        </p>

        <div className="memory-add">
          <input
            placeholder="Something the AI should always remember…"
            value={s.memoryDraft}
            dir="auto"
            aria-label="New memory"
            onChange={(e) => s.setMemoryDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && a.addMemory()}
          />
          <button
            className={`subtle btn-ic mic-btn ${a.micState("memory").cls}`}
            title={
              s.dictOwner === "memory" && s.dictState === "recording"
                ? "Stop recording"
                : "Speak a memory"
            }
            aria-label={
              s.dictOwner === "memory" && s.dictState === "recording"
                ? "Stop recording"
                : "Speak a memory"
            }
            disabled={a.micState("memory").disabled}
            onClick={() =>
              a.dictateTo("memory", (text) =>
                s.setMemoryDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text)),
              )
            }
          >
            <MicIcon size={12} />
          </button>
          <select
            className="memory-cat-select"
            title="Category for the new memory"
            value={s.memoryDraftCat}
            onChange={(e) => s.setMemoryDraftCat(e.target.value)}
          >
            <option value="">no category</option>
            {CATEGORY_OPTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button className="subtle" onClick={a.addMemory}>
            Add
          </button>
        </div>

        {s.memories.length > 0 && (
          <div className="source-tools">
            <label className="search-field">
              <SearchIcon size={13} />
              <input
                type="search"
                placeholder="Filter memories"
                aria-label="Filter memories"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              {filter && (
                <button
                  className="side-search-clear"
                  title="Clear the filter"
                  aria-label="Clear the filter"
                  onClick={() => setFilter("")}
                >
                  <CloseIcon size={11} />
                </button>
              )}
            </label>
            <button
              className="subtle"
              title="Reverse the order these were added in"
              onClick={() => setNewestFirst((o) => !o)}
            >
              {newestFirst ? "Newest first" : "Oldest first"}
            </button>
            <button
              className="subtle"
              title="Write every memory into a Markdown note in this room"
              onClick={() => void saveAsNote()}
            >
              Save as a note
            </button>
          </div>
        )}

        {s.memories.length === 0 && (
          <div className="memory-view-empty">
            <MemoryIcon size={20} />
            <p>
              Nothing saved yet. Add a durable fact above, or accept a
              "Worth remembering?" suggestion in Chat.
            </p>
          </div>
        )}
        {s.memories.length > 0 && shown.length === 0 && (
          <div className="memory-view-empty">
            <MemoryIcon size={20} />
            <p>
              No memory matches “{filter.trim()}”. {s.memories.length} saved in
              total.
            </p>
          </div>
        )}

        {MEMORY_GROUPS.filter((g) =>
          shown.some((m) => groupKey(m) === g.key),
        ).map((g, _, groups) => (
          <section key={g.key ?? "other"} className="memory-group">
            {!(groups.length === 1 && g.key === null) && (
              <div className="group-heading">{g.label}</div>
            )}
            {shown
              .filter((m) => groupKey(m) === g.key)
              .map((m) =>
                s.editingMemory?.id === m.id ? (
                  <div key={m.id} className="memory-row editing">
                    <input
                      className="memory-edit-input"
                      autoFocus
                      dir="auto"
                      value={s.editingMemory.content}
                      onChange={(e) =>
                        s.setEditingMemory({
                          id: m.id,
                          content: e.target.value,
                          category: s.editingMemory?.category ?? null,
                        })
                      }
                      onKeyDown={(e) => {
                        if (e.key === "Enter") a.saveMemoryEdit();
                        if (e.key === "Escape") s.setEditingMemory(null);
                      }}
                    />
                    <select
                      className="memory-cat-select"
                      title="Category"
                      value={s.editingMemory.category ?? ""}
                      onChange={(e) =>
                        s.setEditingMemory({
                          id: m.id,
                          content: s.editingMemory?.content ?? m.content,
                          category: e.target.value || null,
                        })
                      }
                    >
                      <option value="">no category</option>
                      {CATEGORY_OPTIONS.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                    <button className="chip-btn" title="Save" aria-label="Save" onClick={a.saveMemoryEdit}>
                      <CheckIcon size={13} />
                    </button>
                    <button
                      className="chip-btn"
                      title="Cancel"
                      aria-label="Cancel"
                      onClick={() => s.setEditingMemory(null)}
                    >
                      <CloseIcon size={13} />
                    </button>
                  </div>
                ) : (
                  <div key={m.id} className="memory-row">
                    <span className="memory-row-body" dir="auto">
                      <span className="memory-row-text">
                        {m.content}
                        {m.category && (
                          <span className="memory-cat-pill">{m.category}</span>
                        )}
                      </span>
                      <span className="memory-row-when">
                        Added {formatWhen(m.createdAt)}
                      </span>
                    </span>
                    <span className="memory-actions">
                      <button
                        className="chip-btn"
                        title="Edit this memory"
                        aria-label="Edit this memory"
                        onClick={() =>
                          s.setEditingMemory({
                            id: m.id,
                            content: m.content,
                            category: m.category ?? null,
                          })
                        }
                      >
                        <PencilIcon size={13} />
                      </button>
                      <DeleteControl
                        k={`mem:${m.id}`}
                        trigger="×"
                        onConfirm={async () => {
                          await api.deleteMemory(m.id);
                          s.setMemories(await api.listMemories());
                        }}
                        title="Forget this"
                        confirmDelete={s.confirmDelete}
                        askConfirm={a.askConfirm}
                        cancelConfirm={a.cancelConfirm}
                      />
                    </span>
                  </div>
                ),
              )}
          </section>
        ))}

        <section className="memory-scratch-note">
          <div className="group-heading">Scratch pad</div>
          <p>
            A shared working file — you and the AI both write{" "}
            <strong>Scratch pad.md</strong>. It is ordinary room content and
            never becomes memory automatically.
          </p>
          <button className="subtle btn-ic" onClick={() => void a.openScratchPad()}>
            <PencilIcon size={13} /> Open the scratch pad
          </button>
        </section>
      </div>
    </div>
  );
}
