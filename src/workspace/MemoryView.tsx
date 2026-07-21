import { useEffect } from "react";
import { api, RoomInfo } from "../api";
import { CheckIcon, CloseIcon, MemoryIcon, MicIcon, PencilIcon } from "../icons";
import { formatWhen } from "./composer";
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
  // Opening the area is the "I've seen it" moment for the first-run intro.
  useEffect(() => {
    if (!s.showMemoryIntro) return;
    s.setShowMemoryIntro(false);
    try {
      localStorage.setItem(`memoryIntroSeen:${info.name}`, "1");
    } catch {
      /* non-fatal */
    }
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

        {s.memories.length === 0 && (
          <div className="memory-view-empty">
            <MemoryIcon size={20} />
            <p>
              Nothing saved yet. Add a durable fact above, or accept a
              "Worth remembering?" suggestion in Chat.
            </p>
          </div>
        )}

        {MEMORY_GROUPS.filter((g) =>
          s.memories.some((m) => groupKey(m) === g.key),
        ).map((g, _, shown) => (
          <section key={g.key ?? "other"} className="memory-group">
            {!(shown.length === 1 && g.key === null) && (
              <div className="group-heading">{g.label}</div>
            )}
            {s.memories
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
