import { useEffect, useState } from "react";
import { api, RoomInfo } from "../api";
import { CloseIcon, LinkIcon, LockIcon } from "../icons";
import Settings from "../Settings";
import { WSState } from "./state";
import { WSActions } from "./actions";

/** ADD-26: is this a YouTube page URL? Checked against the URL with its
 * scheme stripped, so "https://youtu.be/…" matches too. */
function isYoutubeUrl(url: string): boolean {
  const bare = url.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  return /(^|\.)((youtube(-nocookie)?\.com)|youtu\.be)\//i.test(bare);
}

/** Room settings, the SEC-1 MCP start-approval dialog, and the ADD-12 add-link
 * modal. Extracted verbatim. */
export default function SettingsModals({
  s,
  a,
  info,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  return (
    <>
      {s.showSettings && (
        <Settings
          ai={s.ai}
          model={s.model}
          onModelChange={a.changeModel}
          onModelsChanged={a.refreshAi}
          // Idea 9: CheckpointsSection can't reach WSState, so compute the
          // rollback-disable gate here (same signals as the Summarize button).
          busy={
            s.jobs.some(
              (j) => j.status === "running" || j.status === "queued",
            ) ||
            s.recLive !== null ||
            s.asking
          }
          onClose={() => {
            s.setShowSettings(false);
            a.refreshWebAccess();
            a.refreshAutolock();
            a.refreshPrivacy();
            // Wave 1b (idea 5): the Behavior checkbox only writes the DB —
            // re-read it so auto-save flips without reopening the room.
            a.refreshMemAutoSave();
          }}
        />
      )}

      {info.pendingMcp && !s.mcpDialogDismissed && (
        <div className="settings-backdrop mcp-approve-backdrop">
          <div className="settings mcp-approve">
            <div className="settings-head">
              <span className="badge-label">
                <LockIcon size={15} /> This room wants to start programs
              </span>
            </div>
            <div className="settings-body">
              <p className="mcp-approve-lead">
                Opening <strong>{info.name}</strong> wants to run these programs
                on this Mac to give the AI extra tools. Only allow this if you
                trust whoever made the room.
              </p>
              <div className="mcp-approve-list">
                {info.pendingMcp.servers.map((srv) => (
                  <div key={srv.name} className="mcp-approve-server">
                    <div className="mcp-approve-name">{srv.name}</div>
                    <code className="mcp-approve-cmd">{srv.command}</code>
                  </div>
                ))}
              </div>
            </div>
            <div className="settings-actions mcp-approve-actions">
              <button
                className="subtle"
                onClick={a.keepMcpOff}
                disabled={s.approvingMcp}
              >
                Keep off
              </button>
              <button
                className="primary"
                onClick={a.approveMcp}
                disabled={s.approvingMcp}
              >
                {s.approvingMcp ? "Starting…" : "Allow"}
              </button>
            </div>
          </div>
        </div>
      )}

      {s.showAddLink && <AddLinkModal s={s} a={a} />}
    </>
  );
}

/** The ADD-12 add-link modal, plus the ADD-26 "also save the video" path for
 * YouTube links. Mounted only while open, so the checkbox/progress state
 * resets each time. */
function AddLinkModal({ s, a }: { s: WSState; a: WSActions }) {
  const [saveVideo, setSaveVideo] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [ytProgress, setYtProgress] = useState<{
    status: string;
    percent: number | null;
  } | null>(null);
  const isYoutube = isYoutubeUrl(s.linkUrl);

  // ADD-26: follow yt-dlp while the modal is open.
  useEffect(() => {
    const unlisten = api.onYtdlpProgress((p) => setYtProgress(p));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  /** ADD-26: download the video and let the room transcribe it on-device.
   * Shared by the explicit "also save the video" checkbox and the automatic
   * no-captions fallback. The download can take minutes, so the modal stays
   * open with progress. Returns true when a video landed. */
  async function downloadAndTranscribe(url: string): Promise<boolean> {
    setDownloading(true);
    try {
      const report = await api.importYoutubeVideo(url);
      s.setFiles(await api.listFiles());
      if (report.errors.length > 0) {
        s.pushToast("error", report.errors.join("\n"));
        return false;
      }
      const first = report.imported[0];
      s.pushToast(
        "success",
        first
          ? `Saved "${first.name}" — it will transcribe itself shortly.`
          : "Video saved — it will transcribe itself shortly.",
      );
      s.setShowAddLink(false);
      s.setLinkUrl("");
      // Land the user ON the result — a file appearing silently in the
      // sidebar makes a finished import look like nothing happened.
      if (first) a.viewFile(first.id);
      return true;
    } catch (e) {
      s.pushToast("error", String(e));
      return false;
    } finally {
      setDownloading(false);
      setYtProgress(null);
    }
  }

  /** Checked path: captions page first, then the video itself. Missing
   * captions are fine here — the video download transcribes anyway. */
  async function submitWithVideo() {
    const url = s.linkUrl.trim();
    if (!url || s.importingLink) return;
    s.setImportingLink(true);
    try {
      try {
        const meta = await api.importLink(url);
        s.setFiles(await api.listFiles());
        s.pushToast("success", `Saved "${meta.name}" into the room.`);
        a.viewFile(meta.id);
      } catch (e) {
        // No captions is expected — the download below transcribes it. Any
        // other failure is worth showing, but we still try the video.
        if (String(e) !== "YT_NO_CAPTIONS") s.pushToast("error", String(e));
      }
      await downloadAndTranscribe(url);
    } finally {
      s.setImportingLink(false);
    }
  }

  /** Default path: save captions/page. ADD-26: if a YouTube video simply has
   * no captions, automatically download it and transcribe on-device instead
   * of failing — the user just gets a searchable, playable video either way. */
  async function submitCaptionsOrFallback() {
    const url = s.linkUrl.trim();
    if (!url || s.importingLink) return;
    s.setImportingLink(true);
    try {
      const meta = await api.importLink(url);
      s.setFiles(await api.listFiles());
      s.setShowAddLink(false);
      s.setLinkUrl("");
      s.pushToast("success", `Saved "${meta.name}" into the room.`);
      a.viewFile(meta.id);
    } catch (e) {
      if (String(e) === "YT_NO_CAPTIONS") {
        s.pushToast(
          "info",
          "This video has no captions — downloading it to transcribe on-device…",
        );
        await downloadAndTranscribe(url);
      } else {
        s.pushToast("error", String(e));
      }
    } finally {
      s.setImportingLink(false);
    }
  }

  function submit() {
    if (isYoutube && saveVideo) void submitWithVideo();
    else void submitCaptionsOrFallback();
  }

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !s.importingLink)
          s.setShowAddLink(false);
      }}
    >
      <div className="settings add-link-modal">
        <div className="settings-head">
          <span className="badge-label">
            {/* The sheet renames itself the moment a YouTube URL is
                recognized — the mental model must never change mid-form. */}
            <LinkIcon size={15} />{" "}
            {isYoutube ? "Import YouTube video" : "Add a web link"}
          </span>
          <button
            className="subtle btn-ic"
            title="Close"
            onClick={() => s.setShowAddLink(false)}
            disabled={s.importingLink}
          >
            <CloseIcon size={12} />
          </button>
        </div>
        <div className="settings-body">
          <p className="settings-hint">
            {/* The boundary sentence lives here, in the action surface —
                what leaves the Mac and what doesn't, before the click. */}
            {isYoutube
              ? "This sends the public video link to YouTube to fetch it — your room files stay on this Mac."
              : "This fetches one page from the internet — your room files stay on this Mac."}
          </p>
          <input
            className="add-link-input"
            autoFocus
            dir="auto"
            placeholder="https://example.com/article"
            value={s.linkUrl}
            onChange={(e) => s.setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape" && !s.importingLink) s.setShowAddLink(false);
            }}
          />
          {isYoutube && (
            <div
              className="yt-mode"
              role="radiogroup"
              aria-label="What to import"
            >
              <button
                className={`yt-mode-opt${!saveVideo ? " active" : ""}`}
                role="radio"
                aria-checked={!saveVideo}
                disabled={s.importingLink}
                onClick={() => setSaveVideo(false)}
              >
                <span className="yt-mode-name">Transcript only</span>
                <span className="yt-mode-sub">captions, small and fast</span>
              </button>
              <button
                className={`yt-mode-opt${saveVideo ? " active" : ""}`}
                role="radio"
                aria-checked={saveVideo}
                disabled={s.importingLink}
                onClick={() => setSaveVideo(true)}
              >
                <span className="yt-mode-name">Video + transcript</span>
                <span className="yt-mode-sub">larger, plays offline forever</span>
              </button>
            </div>
          )}
          {downloading && (
            <span className="banner-pull">
              <span className="banner-pull-label">
                Downloading <strong>video</strong>…
              </span>
              <span className="pull-bar">
                <span
                  className="pull-bar-fill"
                  style={{ width: `${ytProgress?.percent ?? 0}%` }}
                />
              </span>
              <span className="banner-pull-status">
                {ytProgress?.status ?? "Starting"}
                {ytProgress?.percent != null &&
                  ` — ${ytProgress.percent.toFixed(0)}%`}
              </span>
            </span>
          )}
          <div className="settings-actions">
            <button
              className="subtle"
              onClick={() => s.setShowAddLink(false)}
              disabled={s.importingLink}
            >
              Cancel
            </button>
            <button
              className="primary"
              onClick={submit}
              disabled={s.importingLink || !s.linkUrl.trim()}
            >
              {downloading
                ? "Downloading…"
                : s.importingLink
                  ? "Fetching…"
                  : isYoutube
                    ? saveVideo
                      ? "Import video"
                      : "Import transcript"
                    : "Save page"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
