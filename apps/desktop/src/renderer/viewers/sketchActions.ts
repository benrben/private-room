import { useCallback, useEffect, useRef } from "react";
import { prefersReducedMotion } from "../rooms/helpers";
import { setSketchFocus } from "../workspace/sketchFocus";
import { type Sketch, type SketchElement, pushHistory, redo, translate, undo, align, bboxOfMany, describeElement, distribute, duplicate, reflow, reorder, type AlignEdge, type Ordering } from "./sketch/model";
import { KeyAction, shortcutFor, keyboardLeavesPageAlone, GRID_GAP, MIN_ZOOM, MAX_ZOOM } from "./SketchView";
import type { SketchGestures } from "./sketchGestures";

export function useSketchActions(gestures: SketchGestures) {
  const { fileId, doc, setDoc, history, setHistory, setTool, setSticky, ink, selected, setSelected, setMenu, setTyping, pageRef, chipRefs, selectedRef, menuRef, toolRef, docRef, setView, scheduleSave, commit, commitText, zoomAt, fitPage } = gestures;


  // --------------------------------------------------------------- commands
  const doUndo = useCallback(() => {
    const r = undo(history, docRef.current);
    if (!r) return;
    setHistory(r.history);
    setDoc(r.doc);
    scheduleSave(r.doc);
    setSelected([]);
  }, [history, scheduleSave]);

  const doRedo = useCallback(() => {
    const r = redo(history, docRef.current);
    if (!r) return;
    setHistory(r.history);
    setDoc(r.doc);
    scheduleSave(r.doc);
  }, [history, scheduleSave]);

  const deleteSelected = useCallback(() => {
    if (!selected.length) return;
    const picked = new Set(selected);
    // Reflowed, so a connector whose shape was just deleted drops its
    // attachment here rather than at the next unrelated edit.
    commit(
      reflow({
        ...docRef.current,
        elements: docRef.current.elements.filter(
          (e) => !picked.has(e.id) || e.locked,
        ),
      }),
    );
    setSelected([]);
  }, [selected, commit]);

  /** The elements the selection names, in document order. */
  const chosenEls = useCallback(
    () => docRef.current.elements.filter((e) => selected.includes(e.id)),
    [selected],
  );

  const doAlign = useCallback(
    (edge: AlignEdge) => {
      const moved = new Map(align(chosenEls(), edge).map((e) => [e.id, e]));
      commit(
        reflow({
          ...docRef.current,
          elements: docRef.current.elements.map((e) => moved.get(e.id) ?? e),
        }),
      );
    },
    [chosenEls, commit],
  );

  const doDistribute = useCallback(
    (axis: "x" | "y") => {
      const moved = new Map(
        distribute(chosenEls(), axis).map((e) => [e.id, e]),
      );
      commit(
        reflow({
          ...docRef.current,
          elements: docRef.current.elements.map((e) => moved.get(e.id) ?? e),
        }),
      );
    },
    [chosenEls, commit],
  );

  const doOrder = useCallback(
    (where: Ordering) => commit(reorder(docRef.current, selected, where)),
    [selected, commit],
  );

  const doDuplicate = useCallback(() => {
    const { doc: next, ids } = duplicate(docRef.current, selected);
    if (!ids.length) return;
    commit(next);
    setSelected(ids);
  }, [selected, commit]);

  const toggleLock = useCallback(() => {
    const picked = new Set(selected);
    if (!picked.size) return;
    // One question for the whole selection: if anything in it is loose,
    // locking is what the user means. A per-element toggle would leave a mixed
    // selection alternating on every press.
    const anyLoose = docRef.current.elements.some(
      (e) => picked.has(e.id) && !e.locked,
    );
    commit({
      ...docRef.current,
      elements: docRef.current.elements.map((e) =>
        picked.has(e.id) ? { ...e, locked: anyLoose || undefined } : e,
      ),
    });
    if (anyLoose) setSelected([]);
  }, [selected, commit]);

  const selectAll = useCallback(() => {
    setSelected(
      docRef.current.elements.filter((e) => !e.locked).map((e) => e.id),
    );
  }, []);

  /** Move the selection by whole units, or by the grid with Shift. */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      const picked = new Set(selected);
      if (!picked.size) return;
      commit(
        reflow({
          ...docRef.current,
          // "Lock in place" means the arrow keys too. A locked shape reaches a
          // selection only through the object strip, and it rides along there
          // rather than being the target — so it must sit still.
          elements: docRef.current.elements.map((e) =>
            picked.has(e.id) && !e.locked ? translate(e, dx, dy) : e,
          ),
        }),
      );
    },
    [selected, commit],
  );

  /** Zoom until the selection fills the pane, or the whole page if nothing is
   * selected. */
  const zoomToSelection = useCallback(() => {
    const box = bboxOfMany(chosenEls()) ?? {
      x: 0,
      y: 0,
      w: docRef.current.width,
      h: docRef.current.height,
    };
    if (box.w <= 0 || box.h <= 0) return;
    const pad = 60;
    const k = Math.max(
      MIN_ZOOM,
      Math.min(
        MAX_ZOOM,
        Math.min(
          docRef.current.width / (box.w + pad),
          docRef.current.height / (box.h + pad),
        ),
      ),
    );
    setView({
      k,
      x: box.x + box.w / 2 - docRef.current.width / k / 2,
      y: box.y + box.h / 2 - docRef.current.height / k / 2,
    });
  }, [chosenEls]);

  /** Renaming a shape is ONE act, however many characters it took.
   *
   * Every keystroke used to push a whole-document snapshot, so the toolbar's
   * Undo removed one letter at a time and an eighty-character label pushed
   * every real drawing edit out of the 80-deep history. The document as it was
   * before the first keystroke is parked here and pushed once, when the field
   * gives up the keyboard.
   *
   * Keyed by the element, not just held: React fires no blur when the field
   * UNMOUNTS, and the agent removing the shape being renamed does exactly that.
   * A doc parked under one element and banked under the next would push a
   * document from before that removal onto the history, so one ⌘Z would jump
   * FORWARD over everything drawn since. */
  const labelBefore = useRef<{ id: string; doc: Sketch } | null>(null);

  const relabel = (id: string, label: string) => {
    if (labelBefore.current?.id !== id)
      labelBefore.current = { id, doc: docRef.current };
    commit(
      {
        ...docRef.current,
        elements: docRef.current.elements.map((e) =>
          e.id !== id
            ? e
            : e.type === "text"
              ? { ...e, text: label }
              : { ...e, label },
        ),
      },
      { undoable: false },
    );
  };

  /** The rename is finished — bank it as a single undo step. */
  const endRelabel = () => {
    const parked = labelBefore.current;
    labelBefore.current = null;
    if (parked && parked.doc !== docRef.current) {
      setHistory((h) => pushHistory(h, parked.doc));
    }
  };

  /** Three linked boxes: something to rename and rearrange rather than a
   * blank page. Deliberately the smallest useful thing — a template GALLERY is
   * a feature of its own, and one starter that always works beats a menu of
   * layouts that mostly do not fit. */
  const startTemplate = () => {
    let seq = docRef.current.seq;
    const id = () => `e${++seq}`;
    const a = id();
    const b = id();
    const c = id();
    const mk = (eid: string, x: number, label: string): SketchElement => ({
      id: eid,
      type: "rect",
      x,
      y: 420,
      w: 260,
      h: 140,
      ink,
      label,
    });
    const boxes = [
      mk(a, 180, "First"),
      mk(b, 660, "Then"),
      mk(c, 1140, "After that"),
    ];
    const link = (eid: string, from: string, to: string): SketchElement => ({
      id: eid,
      type: "arrow",
      points: [
        [0, 0],
        [0, 0],
      ],
      ink,
      from,
      to,
    });
    const next = reflow({
      ...docRef.current,
      seq: seq + 2,
      elements: [...boxes, link(id(), a, b), link(id(), b, c)],
    });
    commit(next);
    setSelected([a]);
  };

  /* No export control on this toolbar.
   *
   * There was one, and the file header a few pixels above it had another with
   * the same word on it — two buttons named Export, doing different things
   * (this one wrote a flattened copy INTO the room; that one writes a copy OUT
   * of it), with nothing on either saying which. File-level acts belong to the
   * file header, so both of this one's formats moved there and the toolbar went
   * back to being about drawing. */

  const stopShortcut = (event: KeyboardEvent) => event.preventDefault();

  const closeMenuForEscape = (event: KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu(null);
  };

  const resetToolForEscape = (event: KeyboardEvent) => {
    if (!selectedRef.current.length && toolRef.current === "select") return;
    event.preventDefault();
    event.stopPropagation();
    setSelected([]);
    setTool("select");
    setSticky(false);
  };

  const shortcutHandlers: Record<
    KeyAction["kind"],
    (event: KeyboardEvent, action: KeyAction) => void
  > = {
    "zoom-in": (event) => {
      stopShortcut(event);
      zoomAt(1.25);
    },
    "zoom-out": (event) => {
      stopShortcut(event);
      zoomAt(0.8);
    },
    fit: (event) => {
      stopShortcut(event);
      fitPage();
    },
    undo: (event) => {
      stopShortcut(event);
      doUndo();
    },
    redo: (event) => {
      stopShortcut(event);
      doRedo();
    },
    "select-all": (event) => {
      stopShortcut(event);
      selectAll();
    },
    duplicate: (event) => {
      stopShortcut(event);
      doDuplicate();
    },
    order: (event, action) => {
      stopShortcut(event);
      doOrder((action as Extract<KeyAction, { kind: "order" }>).where);
    },
    nudge: (event, action) => {
      if (!selectedRef.current.length) return;
      stopShortcut(event);
      const move = action as Extract<KeyAction, { kind: "nudge" }>;
      const by = event.shiftKey ? GRID_GAP : 1;
      nudge(move.dx * by, move.dy * by);
    },
    tool: (_, action) =>
      setTool((action as Extract<KeyAction, { kind: "tool" }>).tool),
    delete: (event) => {
      stopShortcut(event);
      deleteSelected();
    },
  };

  /** ESCAPE, CLAIMED IN LAYERS — and claimed BEFORE the shell sees it.
   *
   * The shell closes the open file on Escape (`effects.ts`), and both handlers
   * sit on `window`. The shell's is registered when the room mounts and this
   * one when a sketch opens, so in the bubble phase the shell always ran
   * first: pressing Escape to dismiss the Arrange menu closed the drawing
   * instead. Capture runs before every bubble listener on the same target, so
   * this one gets to decide first and stops the event when it does.
   *
   * The layers are what a person expects: the topmost thing goes first.
   *
   *   1. a menu is open  → close the menu, and nothing else
   *   2. something is selected, or a tool is armed → back to a safe canvas
   *   3. neither         → fall through, and the shell closes the file
   *
   * Only the layers this component actually acts on stop the event. Falling
   * through silently is what keeps Escape-closes-the-file working everywhere
   * else in the app. */
  useEffect(() => {
    const onEscape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (keyboardLeavesPageAlone(pageRef.current)) return;
      if (menuRef.current) return closeMenuForEscape(e);
      resetToolForEscape(e);
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () =>
      window.removeEventListener("keydown", onEscape, { capture: true });
  }, []);

  /** WHICH UNDO THE KEYBOARD IS TALKING TO.
   *
   * A note or a label is a real text field, and ⌘Z inside one is the field's
   * own undo — the drawing keeps out of it deliberately (see the shortcut
   * handler above). So typing, then pressing ⌘Z, then seeing the toolbar's
   * undo greyed out reads as a broken history when both are working: two
   * histories, one of them not the toolbar's. Knowing which has the keyboard
   * is what lets the page say so. */
  useEffect(() => {
    const isField = (n: EventTarget | null): boolean => {
      const el = n as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };
    const arrived = (e: FocusEvent) => setTyping(isField(e.target));
    const left = () => setTyping(false);
    window.addEventListener("focusin", arrived);
    window.addEventListener("focusout", left);
    return () => {
      window.removeEventListener("focusin", arrived);
      window.removeEventListener("focusout", left);
    };
  }, []);

  /** TELL THE ASSISTANT WHAT IS SELECTED.
   *
   * The chat is a sibling pane with no way to see this canvas; without this it
   * answers "what is missing here?" from the whole room while the drawing sits
   * unread beside it. Published as the same sentences the object strip shows,
   * so the two can never describe the selection differently. */
  useEffect(() => {
    setSketchFocus({
      fileId,
      selection: doc.elements
        .filter((e) => selected.includes(e.id))
        .map(describeElement),
    });
  }, [fileId, doc.elements, selected]);
  // Separately from the value, because closing the drawing must retire it even
  // if the last render never ran: a stale focus would have the chat offering to
  // answer from a canvas that is no longer on screen.
  useEffect(() => () => setSketchFocus(null), []);

  /** BRING THE SELECTED OBJECT BACK INTO THE ROW.
   *
   * The strip is one row that scrolls sideways, so on a busy page the chip for
   * whatever was just selected — clicked on the canvas, caught by a marquee,
   * or drawn a moment ago — is usually past the right edge. A strip that does
   * not follow the selection is worse than no strip at all: it shows a row of
   * unselected chips while claiming to be the list of what is selected. */
  useEffect(() => {
    const first = selected[0];
    if (!first) return;
    chipRefs.current.get(first)?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [selected]);

  /** THE DRAWING'S SHORTCUTS, AND ONLY WHILE THE DRAWING IS BEING WORKED IN.
   *
   * The listener has to be on `window` — the canvas is an SVG and cannot hold
   * focus — but the sketch is the CENTRE pane, with the sidebar and the
   * assistant on screen beside it and focusable buttons in both. Unscoped,
   * Delete pressed on an assistant button deleted the selected shapes, and `t`
   * pressed on a sidebar file row changed the drawing's tool. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (keyboardLeavesPageAlone(pageRef.current)) return;
      const action = shortcutFor(e);
      if (!action) return;
      shortcutHandlers[action.kind](e, action);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    doUndo,
    doRedo,
    deleteSelected,
    zoomAt,
    fitPage,
    selectAll,
    doDuplicate,
    doOrder,
    nudge,
  ]);
  return { ...gestures,
    commitText,
    doUndo,
    doRedo,
    deleteSelected,
    chosenEls,
    doAlign,
    doDistribute,
    doOrder,
    doDuplicate,
    toggleLock,
    selectAll,
    nudge,
    zoomToSelection,
    labelBefore,
    relabel,
    endRelabel,
    startTemplate,
    stopShortcut,
    closeMenuForEscape,
    resetToolForEscape,
    shortcutHandlers
  };
}
export type SketchActions = ReturnType<typeof useSketchActions>;
