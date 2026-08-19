import { WSState } from "../state";
import { WSActions } from "../actions";
import { ScriptIcon, CloseIcon, PlusIcon } from "../../icons";
import { ScriptRow } from "./ScriptRow";
import { SCRIPT_POWERS, SCRIPT_WORKSPACE_NOTE } from "../scriptTrust";

type Props = { s: WSState; a: WSActions };

/** The full-pane Scripts view: every `.py`/`.js` room file as a runnable,
 * schedulable script (mirrors the Workflows page view-flag pattern). */
export function ScriptsPage({ s, a }: Props) {
  return (
    <div className="scripts-page">
      <div className="viewer-head">
        <span className="viewer-title">
          <ScriptIcon size={14} /> Scripts
        </span>
        <span className="viewer-actions">
          <button className="btn-ic script-go" onClick={() => void a.createNewScript()}>
            <PlusIcon size={14} /> New script
          </button>
          <button className="subtle btn-ic" onClick={() => a.closeScripts()}>
            <CloseIcon size={12} /> Close
          </button>
        </span>
      </div>
      <div className="scripts-body">
        {/* The permissions every run on this page gets, stated once, in the
            interface sans at reading size — a security statement is never an
            aside and never handwriting. The sentences come from scriptTrust.ts
            rather than being retyped here, because that module is deliberately
            the ONE place the app's trust wording lives: the run-consent card
            and this page must never be able to drift apart.

            Shown on the empty page too, with its lead changed: the screen
            where someone decides to write their first script is the screen
            that most needs to say what running one will be allowed to do.
            Meeting that sentence for the first time on the consent card is
            meeting it after the script is written. */}
        <p className="script-caution script-caution-page">
          <strong>
            {s.scripts.length > 0 ? "Every run:" : "Before you write one:"}
          </strong>{" "}
          a script here is a real program: {SCRIPT_POWERS}{" "}
          {SCRIPT_WORKSPACE_NOTE} Each version is approved once, on this Mac,
          before it can run at all.
        </p>
        {s.scripts.length === 0 ? (
          <div className="scripts-empty">
            <h3>No scripts yet</h3>
            <p className="caption">
              Use <strong>New script</strong> above, or add a <code>.py</code> / <code>.js</code> file to this room — it
              becomes a first-class script you can run with one click or on a schedule. Declare its
              inputs, outputs and dependencies in a short header:
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
