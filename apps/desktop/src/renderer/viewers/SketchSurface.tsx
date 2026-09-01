import { INKS, type SketchElement, bboxOfMany, chipLabel, describeElement, historyHint, type AlignEdge, type Ordering } from "./sketch/model";
import { TOOLS, nextChipIndex, GRID_GAP, When, chosenElement, canvasDescription, saveLabel, arrangeTitle, toolClass, toolTitle, lockActionName, canvasClass, objectStripClass, objectStripTitle, pluralSuffix, labelValue, footerHint, saveMessage, PreviewElement, MarqueeOverlay, SelectionOverlay } from "./SketchView";
import { Drawn } from "./SketchElements";
import type { SketchActions } from "./sketchActions";

export function SketchSurface({ actions }: { actions: SketchActions }) {
  const { doc, history, tool, setTool, sticky, setSticky, ink, setInk, fill, setFill, selected, setSelected, snap, setSnap, guides, marquee, menu, setMenu, stripOpen, setStripOpen, typing, saveState, note, hidden, fresh, svgRef, pageRef, stageRef, chipRefs, docRef, preview, view, panning, spaceHeld, textAt, setTextAt, textValue, setTextValue, commit, zoomAt, fitPage, stagePosition, onPointerDown, onPointerMove, endGesture, commitText, doUndo, doRedo, doAlign, doDistribute, doOrder, doDuplicate, toggleLock, zoomToSelection, relabel, endRelabel, startTemplate } = actions;
  const picked = doc.elements.filter((e) => selected.includes(e.id));
  const chosen = chosenElement(picked);
  const selBox = bboxOfMany(picked);
  const canvasSummary = canvasDescription(doc.elements, selected);
  const saveWord = saveLabel(saveState);
  const chipStop = Math.max(
    0,
    doc.elements.findIndex((e) => selected.includes(e.id)),
  );
  return (
    <div className="sk-page" ref={pageRef}>
      <div className="sk-tools" role="group" aria-label="Drawing tools">
        {TOOLS.map((tl) => (
          <button
            key={tl.key}
            type="button"
            className={toolClass(sticky, tool === tl.key)}
            title={toolTitle(tl.key === tool, sticky, tl.hint)}
            aria-label={tl.label}
            aria-pressed={tool === tl.key}
            onClick={() => {
              setTool(tl.key);
              setSticky(false);
              setMenu(null);
            }}
            onDoubleClick={() => {
              setTool(tl.key);
              setSticky(tl.key !== "select");
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {tl.icon}
            </svg>
          </button>
        ))}
        <span className="sk-div" />
        <div className="sk-pop-wrap">
          <button
            type="button"
            className={`sk-tool sk-current-ink sk-ink-${ink}`}
            aria-haspopup="menu"
            aria-expanded={menu === "ink"}
            aria-label={`Colour: ${ink}`}
            title={`Colour: ${ink}`}
            onClick={() => setMenu((m) => (m === "ink" ? null : "ink"))}
          >
            <i />
          </button>
          <When show={menu === "ink"}>
            <div className="sk-pop" role="menu" aria-label="Colour">
              <div className="sk-pop-row">
                {INKS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="menuitemradio"
                    aria-checked={ink === k}
                    className={`sk-swatch sk-ink-${k}`}
                    aria-label={`${k} ink`}
                    title={k}
                    onClick={() => {
                      setInk(k);
                      if (selected.length) {
                        const on = new Set(selected);
                        commit({
                          ...docRef.current,
                          elements: docRef.current.elements.map((e) =>
                            on.has(e.id) ? { ...e, ink: k } : e,
                          ),
                        });
                      }
                      setMenu(null);
                    }}
                  >
                    <i />
                  </button>
                ))}
              </div>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={fill}
                className="sk-pop-item"
                onClick={() => setFill((f) => !f)}
              >
                Fill shapes with a wash
              </button>
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={snap}
                className="sk-pop-item"
                onClick={() => setSnap((s) => !s)}
              >
                Snap to shapes and the grid
              </button>
            </div>
          </When>
        </div>
        <div className="sk-pop-wrap">
          <button
            type="button"
            className="sk-tool sk-wide"
            aria-haspopup="menu"
            aria-expanded={menu === "arrange"}
            disabled={!selected.length}
            title={arrangeTitle(selected.length)}
            onClick={() => setMenu((m) => (m === "arrange" ? null : "arrange"))}
          >
            Arrange
          </button>
          <When show={menu === "arrange"}>
            <div className="sk-pop" role="menu" aria-label="Arrange">
              <div className="sk-pop-label">Align</div>
              <div className="sk-pop-row">
                {(
                  [
                    ["left", "Left"],
                    ["hcenter", "Centre"],
                    ["right", "Right"],
                    ["top", "Top"],
                    ["vcenter", "Middle"],
                    ["bottom", "Bottom"],
                  ] as Array<[AlignEdge, string]>
                ).map(([edge, word]) => (
                  <button
                    key={edge}
                    type="button"
                    role="menuitem"
                    className="sk-pop-chip"
                    disabled={selected.length < 2}
                    onClick={() => {
                      doAlign(edge);
                      setMenu(null);
                    }}
                  >
                    {word}
                  </button>
                ))}
              </div>
              <div className="sk-pop-label">Distribute</div>
              <div className="sk-pop-row">
                <button
                  type="button"
                  role="menuitem"
                  className="sk-pop-chip"
                  disabled={selected.length < 3}
                  onClick={() => {
                    doDistribute("x");
                    setMenu(null);
                  }}
                >
                  Across
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="sk-pop-chip"
                  disabled={selected.length < 3}
                  onClick={() => {
                    doDistribute("y");
                    setMenu(null);
                  }}
                >
                  Down
                </button>
              </div>
              <div className="sk-pop-sep" role="separator" />
              {(
                [
                  ["front", "Bring to front", "⇧⌘]"],
                  ["forward", "Bring forward", "⌘]"],
                  ["backward", "Send backward", "⌘["],
                  ["back", "Send to back", "⇧⌘["],
                ] as Array<[Ordering, string, string]>
              ).map(([where, word, key]) => (
                <button
                  key={where}
                  type="button"
                  role="menuitem"
                  className="sk-pop-item"
                  onClick={() => {
                    doOrder(where);
                    setMenu(null);
                  }}
                >
                  {word}
                  <span className="sk-pop-key">{key}</span>
                </button>
              ))}
              <div className="sk-pop-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  doDuplicate();
                  setMenu(null);
                }}
              >
                Duplicate
                <span className="sk-pop-key">⌘D</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  toggleLock();
                  setMenu(null);
                }}
              >
                {lockActionName(picked)}
              </button>
            </div>
          </When>
        </div>
        <span className="sk-div" />
        <button
          type="button"
          className="sk-tool"
          onClick={doUndo}
          disabled={!history.past.length}
          title={historyHint({
            verb: "Undo",
            shortcut: "⌘Z",
            depth: history.past.length,
            typing,
          })}
          aria-label="Undo drawing change"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8.5 6 4.5 10l4 4M4.5 10h9a5.5 5.5 0 1 1 0 11H9" />
          </svg>
        </button>
        <button
          type="button"
          className="sk-tool"
          onClick={doRedo}
          disabled={!history.future.length}
          title={historyHint({
            verb: "Redo",
            shortcut: "⇧⌘Z",
            depth: history.future.length,
            typing,
          })}
          aria-label="Redo drawing change"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M15.5 6l4 4-4 4M19.5 10h-9a5.5 5.5 0 1 0 0 11H15" />
          </svg>
        </button>
        <div className="sk-pop-wrap sk-shrink">
          <button
            type="button"
            className="sk-tool sk-zoom"
            aria-haspopup="menu"
            aria-expanded={menu === "zoom"}
            title="Zoom"
            onClick={() => setMenu((m) => (m === "zoom" ? null : "zoom"))}
          >
            {Math.round(view.k * 100)}%
          </button>
          <When show={menu === "zoom"}>
            <div className="sk-pop" role="menu" aria-label="Zoom">
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  zoomAt(1.25);
                  setMenu(null);
                }}
              >
                Zoom in<span className="sk-pop-key">⌘+</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  zoomAt(0.8);
                  setMenu(null);
                }}
              >
                Zoom out<span className="sk-pop-key">⌘−</span>
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                disabled={!selected.length}
                onClick={() => {
                  zoomToSelection();
                  setMenu(null);
                }}
              >
                Zoom to selection
              </button>
              <button
                type="button"
                role="menuitem"
                className="sk-pop-item"
                onClick={() => {
                  fitPage();
                  setMenu(null);
                }}
              >
                Fit the page<span className="sk-pop-key">⌘0</span>
              </button>
            </div>
          </When>
        </div>
      </div>
      <div className="sk-stage" ref={stageRef}>
        <svg
          ref={svgRef}
          className={canvasClass(spaceHeld, !!panning.current)}
          viewBox={`${view.x} ${view.y} ${doc.width / view.k} ${doc.height / view.k}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={canvasSummary}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        >
          <defs>
            <pattern
              id="sk-dots"
              width={GRID_GAP}
              height={GRID_GAP}
              patternUnits="userSpaceOnUse"
            >
              <circle className="sk-dot" cx={1.1} cy={1.1} r={1.1} />
            </pattern>
          </defs>
          <rect
            className="sk-paper"
            x={-doc.width}
            y={-doc.height}
            width={doc.width * 3}
            height={doc.height * 3}
          />
          <rect
            x={-doc.width}
            y={-doc.height}
            width={doc.width * 3}
            height={doc.height * 3}
            fill="url(#sk-dots)"
          />
          <rect className="sk-edge" width={doc.width} height={doc.height} />
          {doc.elements.map((e) =>
            hidden.has(e.id) ? null : (
              <Drawn
                key={e.id}
                el={e}
                selected={selected.includes(e.id)}
                fresh={fresh.has(e.id)}
              />
            ),
          )}
          <PreviewElement preview={preview} />
          {guides.map((g) => (
            <line
              key={`${g.axis}${g.at}`}
              className="sk-guide"
              x1={g.axis === "x" ? g.at : -doc.width}
              y1={g.axis === "x" ? -doc.height : g.at}
              x2={g.axis === "x" ? g.at : doc.width * 2}
              y2={g.axis === "x" ? doc.height * 2 : g.at}
            />
          ))}
          <MarqueeOverlay marquee={marquee} />
          <SelectionOverlay
            box={selBox}
            tool={tool}
            picked={picked}
            view={view}
          />
        </svg>
        <When show={doc.elements.length === 0 && !preview}>
          <div className="sk-empty" aria-hidden={false}>
            <div className="sk-empty-cards">
              <button
                type="button"
                className="sk-empty-card"
                onClick={() => {
                  setTool("pen");
                  setSticky(true);
                }}
              >
                <span className="sk-empty-title">Draw freely</span>
                <span className="sk-empty-copy">
                  Use the pen and shapes to sketch ideas.
                </span>
              </button>
              <button
                type="button"
                className="sk-empty-card"
                onClick={() => startTemplate()}
              >
                <span className="sk-empty-title">Start from a shape</span>
                <span className="sk-empty-copy">
                  Three linked boxes to rename and rearrange.
                </span>
              </button>
            </div>
          </div>
        </When>
        <When show={!!textAt}>
          <input
            className="sk-text-input"
            style={stagePosition(textAt || [0, 0])}
            value={textValue}
            autoFocus
            aria-label="Note text"
            placeholder="note…"
            onChange={(e) => setTextValue(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") {
                setTextAt(null);
                setTextValue("");
              }
            }}
          />
        </When>
      </div>
      <When show={doc.elements.length > 0}>
        <div className={objectStripClass(stripOpen)}>
          <button
            type="button"
            className="sk-objects-toggle"
            aria-expanded={stripOpen}
            title={objectStripTitle(stripOpen)}
            onClick={() => setStripOpen((v) => !v)}
          >
            {doc.elements.length} object{pluralSuffix(doc.elements.length)}
          </button>
          <div
            className="sk-objects-row"
            role="listbox"
            aria-label="Objects on this page"
            aria-multiselectable="true"
            onKeyDown={(ev) => {
              const ids = doc.elements.map((x) => x.id);
              const id = (ev.target as HTMLElement).dataset.id;
              const at = ids.indexOf(id || "");
              const to = nextChipIndex(ev.key, at, ids.length);
              if (at < 0 || to < 0) return;
              ev.preventDefault();
              ev.stopPropagation();
              setSelected([ids[to]]);
              chipRefs.current.get(ids[to])?.focus();
            }}
          >
            {doc.elements.map((e, i) => (
              <button
                key={e.id}
                data-id={e.id}
                tabIndex={i === chipStop ? 0 : -1}
                ref={(node) => {
                  if (node) chipRefs.current.set(e.id, node);
                  else chipRefs.current.delete(e.id);
                }}
                type="button"
                role="option"
                aria-selected={selected.includes(e.id)}
                aria-label={describeElement(e)}
                aria-posinset={i + 1}
                aria-setsize={doc.elements.length}
                className={`sk-object${selected.includes(e.id) ? " on" : ""}${
                  e.locked ? " sk-object-locked" : ""
                }`}
                title={describeElement(e)}
                onClick={(ev) => {
                  setSelected((cur) =>
                    ev.shiftKey
                      ? cur.includes(e.id)
                        ? cur.filter((id) => id !== e.id)
                        : [...cur, e.id]
                      : [e.id],
                  );
                }}
              >
                {e.locked ? (
                  <svg
                    className="sk-object-lock"
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                  >
                    <rect x="5" y="11" width="14" height="10" rx="2" />
                    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
                  </svg>
                ) : null}
                {chipLabel(e)}
              </button>
            ))}
          </div>
        </div>
      </When>
      <div className="sk-foot">
        <When show={!!chosen}>
          <label className="sk-label-edit">
            <span>Label</span>
            <input
              value={labelValue(chosen)}
              placeholder="give this a name"
              onChange={(e) =>
                relabel((chosen as SketchElement).id, e.target.value)
              }
              onBlur={endRelabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") endRelabel();
              }}
            />
          </label>
        </When>
        <When show={!chosen && picked.length > 1}>
          <span className="sk-hint">
            {picked.length} selected · Arrange to align them · ⌘D to duplicate
          </span>
        </When>
        <When show={!chosen && picked.length <= 1}>
          <span className="sk-hint">
            {footerHint(sticky, tool, doc.elements.length === 0)}
          </span>
        </When>
        <When show={typing}>
          <span className="sk-hint sk-hint-typing">
            ⌘Z undoes your typing here — the toolbar’s undo covers the drawing
          </span>
        </When>
        <span className={`sk-save sk-save-${saveState}`} role="status">
          {saveMessage(note, saveWord)}
        </span>
      </div>
    </div>
  );

}
