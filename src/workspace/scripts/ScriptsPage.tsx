import { WSState } from "../state";
import { WSActions } from "../actions";
import { ScriptIcon, CloseIcon } from "../../icons";
import { ScriptRow } from "./ScriptRow";

type Props = { s: WSState; a: WSActions };

/** The full-pane Scripts view: every `.py`/`.js` room file as a runnable,
 * schedulable script (mirrors the Workflows page view-flag pattern). */
export function ScriptsPage({ s, a }: Props) {
  return (
    <div className="scripts-page">
      <div className="viewer-head">
        <span className="viewer-title">
          <ScriptIcon size={15} /> Scripts
        </span>
        <span className="viewer-actions">
          <button className="subtle btn-ic" onClick={() => a.closeScripts()}>
            <CloseIcon size={12} /> Close
          </button>
        </span>
      </div>
      <div className="scripts-body">
        {s.scripts.length === 0 ? (
          <div className="scripts-empty">
            <h3>No scripts yet</h3>
            <p className="caption">
              Add a <code>.py</code> or <code>.js</code> file to this room and it becomes a
              first-class script — run it with one click or on a schedule. Declare its inputs,
              outputs and dependencies in a short header:
            </p>
            <pre className="scripts-manifest-example">{`# /// script
# dependencies = ["yfinance", "pandas"]
# ///
# room-inputs: portfolio.csv
# room-outputs: portfolio.csv
# room-timeout: 300
# room-shortcut: global`}</pre>
            <p className="caption">
              Each run materializes its declared inputs into a temporary folder, runs there, and
              saves its outputs back into the room as versioned files (undoable via Time Machine).
            </p>
          </div>
        ) : (
          <div className="scripts-list">
            {s.scripts.map((sc) => (
              <ScriptRow key={sc.fileId} sc={sc} s={s} a={a} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
