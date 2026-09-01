import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { prefersReducedMotion } from "../rooms/helpers";
import { type Ink, type Point, type Sketch, type SketchElement, emptyHistory, mergeAgentDoc, parseSketch, pushHistory, serializeSketch, type Handle, type Rect, type Guide } from "./sketch/model";
import { Tool, SAVE_IDLE_MS, SAVE_RETRY_MS, SAVE_RETRY_MAX_MS, MIN_ZOOM, MAX_ZOOM, REVEAL_STEP_MS, REVEAL_BUDGET_MS, REVEAL_MIN_STEP_MS, FRESH_HOLD_MS, type Props, keysAreForThePage } from "./SketchView";
export function useSketchBase({ fileId, text }: Props) {
  const initial = useMemo(() => parseSketch(text), [text]);
  const [doc, setDoc] = useState<Sketch>(initial.doc);
  const [history, setHistory] = useState(emptyHistory());
  const [tool, setTool] = useState<Tool>("select");
  const [sticky, setSticky] = useState(false);
  const [ink, setInk] = useState<Ink>("blue");
  const [fill, setFill] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [snap, setSnap] = useState(true);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [menu, setMenu] = useState<
    "arrange" | "export" | "zoom" | "ink" | null
  >(null);
  const [stripOpen, setStripOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const connectFrom = useRef<string | null>(null);
  const [saveState, setSaveState] = useState<"saved" | "saving" | "failed">(
    "saved",
  );
  const [note, setNote] = useState<string | null>(initial.error);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const svgRef = useRef<SVGSVGElement | null>(null);
  const pageRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const chipRefs = useRef(new Map<string, HTMLButtonElement>());
  const selectedRef = useRef<string[]>([]);
  const menuRef = useRef<string | null>(null);
  const toolRef = useRef<Tool>("select");
  const docRef = useRef(doc);
  docRef.current = doc;
  selectedRef.current = selected;
  menuRef.current = menu;
  toolRef.current = tool;
  const advance = (next: Sketch) => {
    docRef.current = next;
    setDoc(next);
  };
  const drawingRef = useRef(false);
  const pendingAgent = useRef<{
    doc: Sketch;
    added: string[];
    removed: string[];
  } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const externalRevision = useRef(0);
  const retryTimer = useRef<number | null>(null);
  const retryIn = useRef(SAVE_RETRY_MS);
  const revealTimers = useRef<number[]>([]);
  const dirty = useRef(false);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const docVersion = useRef(0);
  const snapshotted = useRef(false);
  const persistedDoc = useRef(text);
  const [preview, setPreview] = useState<SketchElement | null>(null);
  const trail = useRef<Point[]>([]);
  const anchor = useRef<Point | null>(null);
  const dragFrom = useRef<Point | null>(null);
  const resizing = useRef<{
    handle: Handle;
    box: Rect;
    from: Point;
    els: SketchElement[];
  } | null>(null);
  const marqueeFrom = useRef<Point | null>(null);
  const erasing = useRef(false);
  const capturedPointer = useRef<number | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const panning = useRef<{ from: Point } | null>(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [textAt, setTextAt] = useState<Point | null>(null);
  const [textValue, setTextValue] = useState("");
  const persist = useCallback(
    (next: Sketch): Promise<void> => {
      const basedOnExternalRevision = externalRevision.current;
      const write = saveChain.current
        .catch(() => undefined)
        .then(async () => {
          if (externalRevision.current !== basedOnExternalRevision) return;
          const serialized = serializeSketch(next);
          await api.saveSketch(
            fileId,
            serialized,
            !snapshotted.current,
            persistedDoc.current,
          );
          snapshotted.current = true;
          persistedDoc.current = serialized;
        });
      saveChain.current = write;
      return write;
    },
    [fileId],
  );
  const clearRetry = () => {
    if (retryTimer.current) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
  };
  const saveSucceeded = (wrote: number, revision: number) => {
    if (externalRevision.current !== revision) return;
    clearRetry();
    retryIn.current = SAVE_RETRY_MS;
    if (docVersion.current !== wrote) return;
    dirty.current = false;
    setSaveState("saved");
  };
  const saveFailed = (wrote: number, revision: number) => {
    if (externalRevision.current !== revision) return;
    if (docVersion.current !== wrote) return;
    dirty.current = true;
    setSaveState("failed");
    clearRetry();
    retryTimer.current = window.setTimeout(
      () => void flushRef.current(docRef.current),
      retryIn.current,
    );
    retryIn.current = Math.min(retryIn.current * 2, SAVE_RETRY_MAX_MS);
  };
  const flush = useCallback(
    async (next: Sketch) => {
      const wrote = docVersion.current;
      const revision = externalRevision.current;
      try {
        await persist(next);
        saveSucceeded(wrote, revision);
      } catch {
        saveFailed(wrote, revision);
      }
    },
    [persist],
  );
  const flushRef = useRef(flush);
  flushRef.current = flush;
  const scheduleSave = useCallback(
    (next: Sketch) => {
      dirty.current = true;
      docVersion.current += 1;
      setSaveState("saving");
      setNote(null);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(
        () => void flush(next),
        SAVE_IDLE_MS,
      );
    },
    [flush],
  );
  const commit = useCallback(
    (next: Sketch, opts: { undoable?: boolean } = {}) => {
      const before = docRef.current;
      if (opts.undoable !== false) setHistory((h) => pushHistory(h, before));
      advance(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );
  const dropRevealTimers = useCallback(() => {
    for (const t of revealTimers.current) window.clearTimeout(t);
    revealTimers.current = [];
  }, []);
  const clearReveal = useCallback(() => {
    dropRevealTimers();
    setHidden(new Set());
  }, [dropRevealTimers]);
  useEffect(() => {
    let stop: (() => void) | undefined;
    void api
      .onFileUpdated((updatedId) => {
        if (updatedId !== fileId) return;
        externalRevision.current += 1;
        dirty.current = false;
        if (saveTimer.current) window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        if (retryTimer.current) window.clearTimeout(retryTimer.current);
        retryTimer.current = null;
      })
      .then((unlisten) => {
        stop = unlisten;
      });
    return () => stop?.();
  }, [fileId]);
  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      dropRevealTimers();
      if (dirty.current) {
        void persist(docRef.current).catch(() => undefined);
      }
    },
    [dropRevealTimers, persist],
  );
  const applyAgent = useCallback(
    (theirs: Sketch, added: string[], removed: string[]) => {
      const before = docRef.current;
      const { doc: merged } = mergeAgentDoc(before, theirs, removed);
      setHistory((h) => pushHistory(h, before));
      advance(merged);
      scheduleSave(merged);
      if (!added.length) return;
      clearReveal();
      if (prefersReducedMotion()) {
        setFresh(new Set(added));
        revealTimers.current.push(
          window.setTimeout(() => setFresh(new Set()), FRESH_HOLD_MS),
        );
        return;
      }
      const step = Math.max(
        REVEAL_MIN_STEP_MS,
        Math.min(REVEAL_STEP_MS, Math.floor(REVEAL_BUDGET_MS / added.length)),
      );
      setHidden(new Set(added));
      setFresh(new Set(added));
      added.forEach((id, i) => {
        revealTimers.current.push(
          window.setTimeout(() => {
            setHidden((h) => {
              const n = new Set(h);
              n.delete(id);
              return n;
            });
          }, i * step),
        );
      });
      revealTimers.current.push(
        window.setTimeout(
          () => setFresh(new Set()),
          added.length * step + FRESH_HOLD_MS,
        ),
      );
    },
    [scheduleSave, clearReveal],
  );
  useEffect(() => {
    let stop: (() => void) | undefined;
    void api
      .onSketchDrawn((e) => {
        if (e.fileId !== fileId) return;
        const parsed = parseSketch(e.doc);
        if (parsed.error) {
          setNote(
            `The room drew something this page couldn't read: ${parsed.error}`,
          );
          return;
        }
        persistedDoc.current = e.doc;
        setNote(null);
        if (drawingRef.current) {
          pendingAgent.current = {
            doc: parsed.doc,
            added: e.added,
            removed: e.removed,
          };
          return;
        }
        applyAgent(parsed.doc, e.added, e.removed);
      })
      .then((un) => {
        stop = un;
      });
    return () => stop?.();
  }, [fileId, applyAgent]);
  const zoomAt = useCallback((factor: number, at?: Point) => {
    setView((v) => {
      const k = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.k * factor));
      if (k === v.k) return v;
      const p = at ?? [
        v.x + docRef.current.width / v.k / 2,
        v.y + docRef.current.height / v.k / 2,
      ];
      return {
        k,
        x: p[0] - (p[0] - v.x) * (v.k / k),
        y: p[1] - (p[1] - v.y) * (v.k / k),
      };
    });
  }, []);
  const fitPage = useCallback(() => setView({ x: 0, y: 0, k: 1 }), []);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const m = el.getScreenCTM();
      const at: Point | undefined = m
        ? (() => {
            const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(
              m.inverse(),
            );
            return [p.x, p.y] as Point;
          })()
        : undefined;
      if (ev.ctrlKey || ev.metaKey) {
        zoomAt(Math.exp(-ev.deltaY / 180), at);
      } else {
        setView((v) => ({
          ...v,
          x: v.x + ev.deltaX / v.k,
          y: v.y + ev.deltaY / v.k,
        }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);
  useEffect(() => {
    const isTyping = () => {
      const el = document.activeElement;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
    };
    const down = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !isTyping() &&
        keysAreForThePage(pageRef.current)
      ) {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    const blur = () => setSpaceHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);
  return {
    fileId,
    text,
    initial,
    doc,
    setDoc,
    history,
    setHistory,
    tool,
    setTool,
    sticky,
    setSticky,
    ink,
    setInk,
    fill,
    setFill,
    selected,
    setSelected,
    snap,
    setSnap,
    guides,
    setGuides,
    marquee,
    setMarquee,
    menu,
    setMenu,
    stripOpen,
    setStripOpen,
    typing,
    setTyping,
    connectFrom,
    saveState,
    setSaveState,
    note,
    setNote,
    hidden,
    setHidden,
    fresh,
    setFresh,
    svgRef,
    pageRef,
    stageRef,
    chipRefs,
    selectedRef,
    menuRef,
    toolRef,
    docRef,
    advance,
    drawingRef,
    pendingAgent,
    saveTimer,
    externalRevision,
    retryTimer,
    retryIn,
    revealTimers,
    dirty,
    saveChain,
    docVersion,
    snapshotted,
    persistedDoc,
    preview,
    setPreview,
    trail,
    anchor,
    dragFrom,
    resizing,
    marqueeFrom,
    erasing,
    capturedPointer,
    view,
    setView,
    panning,
    spaceHeld,
    setSpaceHeld,
    textAt,
    setTextAt,
    textValue,
    setTextValue,
    persist,
    clearRetry,
    saveSucceeded,
    saveFailed,
    flush,
    flushRef,
    scheduleSave,
    commit,
    dropRevealTimers,
    clearReveal,
    applyAgent,
    zoomAt,
    fitPage
  };
}
export type SketchBase = ReturnType<typeof useSketchBase>;
