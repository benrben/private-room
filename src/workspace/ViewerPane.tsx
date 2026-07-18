import { RoomInfo } from "../api";
import {
  CloseIcon,
  DownloadIcon,
  EmptyViewerArt,
  EyeIcon,
  LockIcon,
  MicIcon,
  PencilIcon,
  PlusIcon,
  SendIcon,
  SparkIcon,
  TimeMachineIcon,
} from "../icons";
import RoomMap from "../viewers/RoomMap";
import { formatWhen } from "./composer";
import ViewerRouter from "./ViewerRouter";
import FrontPage from "./FrontPage";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** True when a media transcript carries real speech — at least one timestamped
 * "[m:ss] …" row with words. The "(transcribed from recording)" provenance line
 * and a lone silence "." don't count, so downstream actions (Minutes) don't
 * offer to summarize a recording that has nothing to summarize. */
function transcriptHasSpeech(text: string | null | undefined): boolean {
  if (!text) return false;
  return text.split("\n").some((line) => {
    const m = line.match(/^\[(?:\d+:)?\d{1,2}:\d{2}\]\s*(.*)$/);
    return m ? /[\p{L}\p{N}]/u.test(m[1]) : false;
  });
}

/** Pane 2: the Room Map host, the open-file viewer + head actions, the Front
 * Page dashboard, and the sealed-room empty state. Extracted verbatim. */
export default function ViewerPane({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  const { openFile } = s;
  const frontPageView =
    s.fp && (s.fp.fileCount > 0 || s.fp.chatCount > 0 || s.fp.memories.length > 0)
      ? s.fp
      : null;
  return (
    <section className="viewer" aria-label="Workspace">
      {s.showMap ? (
        <>
          <div className="viewer-head">
            <span className="viewer-title">Room map</span>
            <span className="viewer-actions">
              <button
                className="subtle btn-ic"
                onClick={() => s.setShowMap(false)}
              >
                <CloseIcon size={12} /> Close
              </button>
            </span>
          </div>
          <div className="room-map-canvas">
            <RoomMap onOpenFile={(id) => a.viewFile(id)} />
          </div>
        </>
      ) : openFile ? (
        <>
          <div className="viewer-head">
            <span className="viewer-title">{openFile.content.name}</span>
            <span className="viewer-actions">
              {a.editModeOf(openFile.content) && (
                <button
                  className="subtle btn-ic"
                  title={
                    a.editModeOf(openFile.content) === "copy"
                      ? "Edit the extracted text — saving creates a Markdown copy"
                      : "Switch between preview and editing"
                  }
                  onClick={() => s.setEditMode(!s.editMode)}
                >
                  {s.editMode ? <EyeIcon size={13} /> : <PencilIcon size={13} />}
                  {s.editMode
                    ? "Preview"
                    : a.editModeOf(openFile.content) === "copy"
                      ? "Edit as text"
                      : "Edit"}
                </button>
              )}
              <span className="history-wrap">
                <button
                  className={`subtle btn-ic ${s.showHistory ? "active" : ""}`}
                  title="Time Machine — earlier saved versions of this file"
                  onClick={a.openHistory}
                >
                  <TimeMachineIcon size={13} /> History
                </button>
                {s.showHistory && (
                  <div className="history-pop">
                    {s.versions.length === 0 ? (
                      <div className="history-empty">
                        No earlier versions yet.
                      </div>
                    ) : (
                      <div className="time-machine">
                        {s.versions.map((v) =>
                          s.confirmRestore === v.id ? (
                            // ADD-25: the agent driver must not be able to
                            // confirm a restore it didn't earn.
                            <div key={v.id} className="tm-confirm" data-agent-blocked>
                              <span className="tm-confirm-q">
                                Restore this version? Current changes will be
                                replaced.
                              </span>
                              <div className="tm-confirm-actions">
                                <button
                                  className="primary"
                                  onClick={() => {
                                    s.setConfirmRestore(null);
                                    void a.restoreVersion(v.id);
                                  }}
                                >
                                  Restore
                                </button>
                                <button
                                  className="subtle"
                                  onClick={() => s.setConfirmRestore(null)}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <button
                              key={v.id}
                              className="tm-version"
                              title="Restore this saved version"
                              onClick={() => s.setConfirmRestore(v.id)}
                            >
                              <span className="tm-version-dot" />
                              <span className="tm-cause">{v.cause}</span>
                              <span className="tm-time">
                                {formatWhen(v.savedAt)}
                              </span>
                            </button>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
              </span>
              {openFile.content.text && (
                <button
                  className="subtle"
                  title="Copy the whole document's extracted text"
                  onClick={a.copyAllText}
                >
                  Copy all text
                </button>
              )}
              {openFile.content.editable && (
                <button
                  className={`subtle btn-ic mic-btn ${a.micState("file").cls}`}
                  title={
                    s.dictOwner === "file" && s.dictState === "recording"
                      ? "Stop and append the words"
                      : "Dictate into this file — your words are appended to its saved content"
                  }
                  disabled={a.micState("file").disabled}
                  onClick={a.dictateIntoFile}
                >
                  <MicIcon size={12} /> Dictate
                </button>
              )}
              {(openFile.content.kind === "audio" ||
                openFile.content.kind === "video" ||
                openFile.content.kind === "recording") &&
                transcriptHasSpeech(openFile.content.text) && (
                  <button
                    className="subtle"
                    title="Turn this recording's transcript into timeline-style HTML minutes (summary, decisions, action items)"
                    disabled={s.asking}
                    onClick={a.makeMinutes}
                  >
                    <SparkIcon size={13} /> Minutes
                  </button>
                )}
              <button
                className="subtle btn-ic"
                title="Export a normal copy out of the room"
                data-agent-blocked
                onClick={() => a.exportOne(openFile.id, openFile.content.name)}
              >
                <DownloadIcon size={13} /> Export
              </button>
              <button
                className="subtle btn-ic"
                onClick={() => s.setOpenFile(null)}
              >
                <CloseIcon size={12} /> Close
              </button>
            </span>
          </div>
          {/* Wave 1b (idea 10): the AI wrote this file while the user's editor
              buffer was dirty — the reload was skipped, the user chooses. Both
              paths are safe: every overwrite snapshots to History first. */}
          {s.staleFile === openFile.id && (
            <div className="stale-banner" role="status">
              <span className="stale-banner-text">
                The AI changed this file while you were editing.
              </span>
              <span className="stale-banner-actions">
                <button
                  className="primary"
                  title="Show the AI's version (your unsaved edits are discarded)"
                  onClick={() => {
                    s.setStaleFile(null);
                    s.editorDirtyRef.current = false;
                    void a.viewFile(openFile.id);
                  }}
                >
                  Load AI version
                </button>
                <button
                  className="subtle"
                  title="Keep your buffer — your next ⌘S overwrites; the AI's version stays in History"
                  onClick={() => s.setStaleFile(null)}
                >
                  Keep editing
                </button>
              </span>
            </div>
          )}
          <div
            className={`viewer-body ${
              openFile.content.kind === "code" ||
              openFile.content.kind === "html" ||
              (s.editMode && a.editModeOf(openFile.content) !== "grid")
                ? "fill"
                : ""
            }`}
          >
            <ViewerRouter
              openFile={openFile}
              viewerRev={s.viewerRev}
              editMode={s.editMode}
              editModeOf={a.editModeOf}
              editCell={a.editCell}
              saveEdit={a.saveEdit}
              saveEditAsCopy={a.saveEditAsCopy}
              onDirtyChange={(d) => {
                s.editorDirtyRef.current = d;
              }}
              recording={{
                live: s.recLive,
                saveProgress: s.recSave,
                pushToast: s.pushToast,
                onStart: a.startLiveRecording,
                onPause: a.pauseLiveRecording,
                onResume: a.resumeLiveRecording,
                onStop: a.stopLiveRecording,
              }}
              sttStatus={s.sttStatus}
            />
          </div>
        </>
      ) : frontPageView ? (
        <FrontPage page={frontPageView} s={s} a={a} />
      ) : (
        <div className="viewer-empty">
          <div className="viewer-empty-icon">
            <EmptyViewerArt />
          </div>
          <h1 className="viewer-empty-title">Your room is sealed</h1>
          <p className="viewer-empty-sub">
            Everything you add stays inside{" "}
            <strong>{info.path.split("/").pop()}</strong>. Add a file, open a
            note, or ask the room a question about everything inside.
          </p>
          <div className="viewer-empty-actions">
            <button className="qa-btn primary" onClick={a.importFiles}>
              <PlusIcon size={15} /> Add a file
            </button>
            <button
              className="qa-btn"
              disabled={
                s.files.length === 0 ||
                s.summaryStarting ||
                s.jobs.some(
                  (j) => j.status === "running" || j.status === "queued",
                )
              }
              onClick={() => void a.startDeepSummary()}
            >
              <SparkIcon size={15} /> Summarize room
            </button>
            <button
              className="qa-btn"
              onClick={() => s.composerRef.current?.focus()}
            >
              <SendIcon size={14} /> Ask the room
            </button>
          </div>
          <div className="viewer-empty-note">
            <LockIcon size={16} />
            <div>
              <strong>Encrypted on your Mac.</strong> Your data is encrypted
              and never leaves this file unless you choose a cloud model.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
