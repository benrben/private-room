import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { api } from "../api";
import { type AutocompleteItem, specialistItems, specialistNote, tokenAtCaret } from "./composer";
import { HELP_COMMAND } from "./constants";
import type { WSState } from "./state";
import { nextAutocompleteIndex, selectedAutocompleteItem } from "./chatActions";
import type { ChatCore } from "./chatCore";

export function makeComposerActions(s: WSState, core: ChatCore) {
  const { send } = core;


  // ---- "#"/"@"/"/"/"*" autocomplete ----

  /** The room's canonical specialists, for the "*" menu. Re-read every time
   * it opens rather than only at room open: provider/privacy/prerequisite
   * changes update each row's effective capability and explanation. */
  async function refreshSpecialists() {
    try {
      s.setSpecialists(await api.listSpecialists());
      s.setSpecialistsError("");
    } catch (e) {
      // The previous roster is NOT kept: it may be why the lookup failed (the
      // room's engine changed). Unknown is the honest state, and the menu says
      // so with the reason attached.
      s.setSpecialists(null);
      s.setSpecialistsError(String(e));
    }
  }

  function autocompleteItems(): AutocompleteItem[] {
    if (!s.ac) return [];
    if (s.ac.kind === "agent") {
      return specialistItems(s.specialists ?? [], s.ac.query);
    }
    if (s.ac.kind === "cmd") {
      return [...s.commands, HELP_COMMAND]
        .filter((c) => c.name.startsWith(s.ac!.query))
        .map((c) => ({
          key: c.name,
          label: `#${c.name}`,
          hint: c.summary,
          insert: `#${c.name} `,
          usage: c.usage,
        }));
    }
    if (s.ac.kind === "skill") {
      return s.skills
        .filter((skill) => skill.enabled && skill.name.startsWith(s.ac!.query))
        .slice(0, 10)
        .map((skill) => ({
          key: `skill-${skill.id}`,
          label: `/${skill.name}`,
          hint: skill.description,
          insert: `/${skill.name} `,
          usage: "Skill",
        }));
    }
    const q = s.ac.query;
    const folderItems = s.folders
      .filter((f) => f.name.toLowerCase().includes(q))
      .map((f) => ({
        key: `fo-${f.id}`,
        label: `@${f.name}/`,
        hint: "folder",
        insert: `@${f.name}/ `,
      }));
    const fileItems = s.files
      .filter((f) => f.name.toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({
        key: `fi-${f.id}`,
        label: `@${f.name}`,
        hint: f.mimeType,
        insert: `@${f.name} `,
      }));
    return [...folderItems, ...fileItems].slice(0, 10);
  }

  /** What the "*" menu shows INSTEAD of rows when it has none — "" otherwise,
   * and "" for every other menu (they close when they have nothing, because
   * "no file matches" is not a claim about what this room can do). */
  function autocompleteNote(): string {
    if (!s.ac || s.ac.kind !== "agent") return "";
    return specialistNote(s.specialists, s.specialistsError, s.ac.query);
  }

  function refreshAutocomplete(value: string, caret: number) {
    const tok = tokenAtCaret(value, caret);
    // Opening the "*" menu is the moment its roster has to be current.
    if (tok?.kind === "agent" && s.ac?.kind !== "agent") void refreshSpecialists();
    s.setAc(tok ? { kind: tok.kind, query: tok.query, start: tok.start, index: 0 } : null);
  }

  function insertComposerToken(token: "@" | "#" | "/" | "*") {
    const cur = s.question;
    let next: string;
    let caret: number;
    if (token === "#" || token === "/" || token === "*") {
      const body = cur.replace(/^\s+/, "");
      next = `${token}${body}`;
      caret = 1;
    } else {
      const needsSpace = cur.length > 0 && !/\s$/.test(cur);
      next = `${cur}${needsSpace ? " " : ""}@`;
      caret = next.length;
    }
    s.setQuestion(next);
    // Open the palette in the SAME tick as the text change, exactly the way
    // typing "#"/"/"/"*" does from the box's own onChange — `refreshAutocomplete`
    // is pure over `next`/`caret` and needs no DOM read, so it does not have to
    // wait for a browser round-trip. This used to run only inside the
    // requestAnimationFrame below, alongside the focus/caret-move — which meant
    // the popover's appearance depended on that callback actually firing against
    // a still-mounted `composerRef`. The "*" menu hid the gap: its render gate
    // stays open on `autocompleteNote()` alone (e.g. "Looking up this room's
    // specialists…") even with zero items, so a late or dropped rAF was
    // invisible there. "#" and "/" have no such fallback note — with `s.ac`
    // still unset, `items.length === 0 && !note` is true and NOTHING renders,
    // even though the token was inserted and the chip lit up as "on". Button
    // clicks now reach the same `s.ac` state typing does, unconditionally.
    refreshAutocomplete(next, caret);
    requestAnimationFrame(() => {
      const el = s.composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
  }

  function acceptAutocomplete(insert: string) {
    const el = s.composerRef.current;
    const caret = el ? el.selectionStart : s.question.length;
    const start = s.ac ? s.ac.start : caret;
    const next = s.question.slice(0, start) + insert + s.question.slice(caret);
    s.setQuestion(next);
    s.setAc(null);
    requestAnimationFrame(() => {
      if (el) {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      }
    });
  }

  /** Close the palette AND, with it, an abandoned trigger token — shared by
   * every way a palette can be dismissed without picking a row (Escape, the
   * textarea losing focus). A trigger token was only ever there to open the
   * palette — bare ("*") OR still being filtered ("*fil") — so dismissing it
   * takes the whole attempt with it, and the chip's "is-on" state (which reads
   * straight off `s.question` via `openingSigil`) clears along with it.
   * Checked against the WHOLE current question, not just up to the caret: a
   * first-token trigger with something typed AFTER it ("*file summarize
   * this") is a real message the user finished composing, not an abandoned
   * menu, and must not be swept away. "@" references are different again —
   * they can sit anywhere in an otherwise-finished sentence ("check
   * @lease.pdf then summarize"), so only a bare, un-filtered "@" goes with it.
   * Selecting a row is NOT this path (`acceptAutocomplete` below) — a picked
   * item is a finished choice, not something to undo. */
  function dismissAutocomplete() {
    if (!s.ac) return;
    s.setAc(null);
    const wholeToken = tokenAtCaret(s.question, s.question.length);
    const abandonedTrigger = wholeToken && wholeToken.kind !== "ref";
    const bareRef = s.question.trim() === "@";
    if (abandonedTrigger || bareRef) s.setQuestion("");
  }

  function dismissAutocompleteOnEscape(e: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
    // Escape closes an OPEN palette, whether or not it has rows to move
    // through. The "*" menu can be open on an honest note alone ("this room
    // has no specialists"), and a popover the keyboard cannot dismiss is a
    // trap — this used to sit inside the rows-only branch below.
    if (!s.ac || e.key !== "Escape") return false;
    // The palette swallows Escape completely — nothing else (viewer
    // close, app-level handlers) may react to the same keypress.
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    dismissAutocomplete();
    s.composerRef.current?.focus();
    return true;
  }

  function moveAutocomplete(e: ReactKeyboardEvent<HTMLTextAreaElement>, items: AutocompleteItem[]): boolean {
    if (!s.ac || items.length === 0) return false;
    const index = nextAutocompleteIndex(e.key, s.ac.index, items);
    if (index === null) return false;
    e.preventDefault();
    s.setAc({ ...s.ac, index });
    return true;
  }

  function acceptAutocompleteKey(
    e: ReactKeyboardEvent<HTMLTextAreaElement>,
    items: AutocompleteItem[],
  ): boolean {
    if (!s.ac) return false;
    const selected = selectedAutocompleteItem(e.key, s.ac.index, items);
    if (selected === null) return false;
    e.preventDefault();
    if (!selected.disabled) acceptAutocomplete(selected.insert);
    return true;
  }

  function onComposerKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    const items = autocompleteItems();
    if (dismissAutocompleteOnEscape(e)) return;
    if (moveAutocomplete(e, items)) return;
    if (acceptAutocompleteKey(e, items)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }
  return { ...core, refreshSpecialists, autocompleteItems, autocompleteNote, refreshAutocomplete, insertComposerToken, acceptAutocomplete, dismissAutocomplete, dismissAutocompleteOnEscape, moveAutocomplete, acceptAutocompleteKey, onComposerKeyDown };
}
export type ComposerActions = ReturnType<typeof makeComposerActions>;
