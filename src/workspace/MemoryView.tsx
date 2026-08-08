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
import { useAdaptiveText } from "./adaptiveText";

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

  // A1 "living dek": the mem-lead line below is a privacy PROMISE, not a fact
  // about content, so the static string stays the permanent fallback (RULE
  // 1/3/8) and this only swaps in once there is something true and specific
  // to say instead. Facts are a category breakdown grouped the same way the
  // list below already groups (`groupKey`/`MEMORY_GROUPS`), plus the newest
  // entry's category — nothing fetched fresh for this (RULE 4/10). Gated on
  // 2+ memories: a single memory has no breakdown worth describing.
  const memGroupCounts = MEMORY_GROUPS.map((g) => ({
    label: g.label,
    count: s.memories.filter((m) => groupKey(m) === g.key).length,
  })).filter((g) => g.count > 0);
  const newestMemory =
    s.memories.length > 0
      ? s.memories.reduce((latest, m) =>
          m.createdAt.localeCompare(latest.createdAt) > 0 ? m : latest,
        )
      : null;
  const memDekFacts =
    s.memories.length >= 2
      ? {
          total: s.memories.length,
          byCategory: memGroupCounts,
          newestCategory: newestMemory
            ? (MEMORY_GROUPS.find((g) => g.key === groupKey(newestMemory))?.label ?? "Other")
            : null,
        }
      : null;
  const memDek = useAdaptiveText({
    roomId: info.path,
    kind: "dek",
    prompt: memDekFacts
      ? `Write one plain sentence, max 20 words, describing what's saved in this room's memory. Use ONLY these facts: ${JSON.stringify(memDekFacts)}. Match this voice: plain, direct (existing example: "Everything the AI remembers about you — visible, editable, and used only when relevant."). No preamble, just the sentence.`
      : "",
    facts: memDekFacts,
    maxWords: 20,
    enabled: memDekFacts !== null,
  });

  return (
    <div className="mem-view">
      <div className="mem-inner">
        <header className="mem-masthead">
          <div className="mem-masthead-main">
            <h1 className="mem-title">Memory</h1>
            {/* A privacy statement, so it stays in the sans and at reading
                size. Only the second half — how suggestions are approved —
                moves into the note below, because that is a setting's
                behaviour rather than the promise this page opens with. */}
            <p className="mem-lead">
              {memDek ?? (
                <>
                  Everything the AI remembers about you — visible, editable, and used
                  only when relevant.
                </>
              )}
            </p>
          </div>
          {s.memories.length > 0 && (
            <div className="mem-stamp">
              {s.memories.length} saved
            </div>
          )}
        </header>

        <details className="mem-note">
          <summary>How suggested memories are handled</summary>
          <div className="mem-note-body">
            <p>
              Suggestions from conversations wait for your approval unless you
              turn on auto-save in Settings → AI &amp; behavior.
            </p>
          </div>
        </details>

        <div className="mem-add">
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
            aria-label="Category for the new memory"
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
          <button className="primary" onClick={a.addMemory}>
            Add
          </button>
        </div>

        {s.memories.length > 0 && (
          <div className="mem-tools">
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
          <div className="mem-empty">
            <p className="mem-empty-copy">
              <MemoryIcon size={20} />
              <span>
                Nothing saved yet. Add a durable fact above, or accept a
                "Worth remembering?" suggestion in Chat.
              </span>
            </p>
            <figure className="mem-example">
              <figcaption className="mem-example-cap">
                <span className="nb-tape nb-sem-pending">Example</span>
                <span>Not saved — this is what a good memory looks like.</span>
              </figcaption>
              <ul className="mem-example-list">
                {EXAMPLE_MEMORIES.map((ex) => (
                  <li key={ex.text} className={`mem-card mem-example-card nb-card${catClass(ex.category)}`}>
                    <span className="mem-card-pin nb-ico nb-ico-pin" aria-hidden="true" />
                    <span className="mem-card-body">{ex.text}</span>
                    <span className="mem-card-foot">
                      <span className="mem-cat">{ex.category}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </figure>
          </div>
        )}
        {s.memories.length > 0 && shown.length === 0 && (
          <div className="mem-empty">
            <p className="mem-empty-copy">
              <MemoryIcon size={20} />
              <span>
                No memory matches “{filter.trim()}”. {s.memories.length} saved in
                total.
              </span>
            </p>
          </div>
        )}

        {MEMORY_GROUPS.filter((g) =>
          shown.some((m) => groupKey(m) === g.key),
        ).map((g, _, groups) => {
          const rows = shown.filter((m) => groupKey(m) === g.key);
          return (
            <section key={g.key ?? "other"} className="mem-group">
              {!(groups.length === 1 && g.key === null) && (
                <div className="mem-group-head">
                  <h2>{g.label}</h2>
                  {/* A count is exactly what the handwriting is for, and the
                      ring keeps it from reading as part of the label. */}
                  <span className="nb-circled">{rows.length}</span>
                </div>
              )}
              <ul className="mem-list nb-frame-set">
                {rows.map((m) =>
                  s.editingMemory?.id === m.id ? (
                    <li key={m.id} className="mem-card nb-card is-editing">
                      <input
                        className="mem-edit-input"
                        autoFocus
                        dir="auto"
                        aria-label="Edit this memory"
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
                        aria-label="Category"
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
                      <span className="mem-actions">
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
                      </span>
                    </li>
                  ) : (
                    <li key={m.id} className={`mem-card nb-card${catClass(m.category)}`}>
                      {/* Decoration: a pseudo-glyph, aria-hidden, and
                          pointer-events:none via .nb-ico, so the pin is a mark
                          on the page and never something to tab to. */}
                      <span className="mem-card-pin nb-ico nb-ico-pin" aria-hidden="true" />
                      <span className="mem-card-body" dir="auto">
                        {m.content}
                      </span>
                      <span className="mem-card-foot">
                        {m.category && <span className="mem-cat">{m.category}</span>}
                        <span className="mem-when">Added {formatWhen(m.createdAt)}</span>
                      </span>
                      <span className="mem-actions">
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
                    </li>
                  ),
                )}
              </ul>
            </section>
          );
        })}

        {/* A dashed pencil rule is the system's mark for a provisional
            boundary, and it is doing real work here: above it is durable
            memory the assistant may quote back at you, below it is a working
            file that never becomes one. */}
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
              <PencilIcon size={13} /> Open the scratch pad
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
