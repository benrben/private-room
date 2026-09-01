import { useEffect, useState } from "react";
import { api, MediaQualityOption, RoomInfo } from "../api";
import { CloseIcon, LinkIcon, LockIcon } from "../icons";
import Settings from "../Settings";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { LayoutApi } from "../shell/useLayout";
import {
  fmtSize,
  importModeCopy,
  isYoutubeUrl,
  submitButtonLabel,
} from "./settingsLinkHelpers";

function isSettingsBusy(s: WSState) {
  return (
    s.jobs.some((job) => job.status === "running" || job.status === "queued") ||
    s.recLive !== null ||
    s.asking
  );
}

function SettingsDialog({ s, a, layout }: {
  s: WSState;
  a: WSActions;
  layout: LayoutApi;
}) {
  if (!s.showSettings) return null;
  return (
    <Settings
      ai={s.ai}
      model={s.model}
      onModelChange={a.changeModel}
      onModelsChanged={a.refreshAi}
      busy={isSettingsBusy(s)}
      initialSection={s.settingsSection}
      onApplyPreset={layout.applyPreset}
      onClose={() => {
        s.setShowSettings(false);
        s.setSettingsSection(null);
        a.refreshWebAccess();
        a.refreshAutolock();
        a.refreshPrivacy();
        a.refreshMemAutoSave();
      }}
    />
  );
}

function McpApprovalDialog({ s, a, info }: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
}) {
  const pending = info.pendingMcp;
  if (!pending || s.mcpDialogDismissed) return null;
  return (
    <div className="settings-backdrop mcp-approve-backdrop">
      <div className="settings mcp-approve">
        <div className="settings-head">
          <span className="badge-label">
            <LockIcon size={14} /> This room wants to start programs
          </span>
        </div>
        <div className="settings-body">
          <p className="mcp-approve-lead">
            Opening <strong>{info.name}</strong> wants to run these programs on
            this Mac to give the AI extra tools. Only allow this if you trust
            whoever made the room.
          </p>
          <div className="mcp-approve-list">
            {pending.servers.map((server) => (
              <div key={server.name} className="mcp-approve-server">
                <div className="mcp-approve-name">{server.name}</div>
                <code className="mcp-approve-cmd">{server.command}</code>
              </div>
            ))}
          </div>
        </div>
        <div className="settings-actions mcp-approve-actions">
          <button className="subtle" onClick={a.keepMcpOff} disabled={s.approvingMcp}>
            Keep off
          </button>
          <button className="primary" onClick={a.approveMcp} disabled={s.approvingMcp}>
            {s.approvingMcp ? "Starting…" : "Allow"}
          </button>
        </div>
      </div>
    </div>
  );
}

function AddLinkWhenOpen({ s, a }: { s: WSState; a: WSActions }) {
  if (!s.showAddLink) return null;
  return <AddLinkModal s={s} a={a} />;
}

/** Room settings, the SEC-1 MCP start-approval dialog, and the ADD-12 add-link
 * modal. Extracted verbatim. */
export default function SettingsModals({
  s,
  a,
  info,
  layout,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
}) {
  return <><SettingsDialog s={s} a={a} layout={layout} /><McpApprovalDialog s={s} a={a} info={info} /><AddLinkWhenOpen s={s} a={a} /></>;
}

/** The ADD-12 add-link modal, plus the ADD-26 "also save the video" path for
 * YouTube links. Mounted only while open, so the checkbox/progress state
 * resets each time. */
function AddLinkHeader({ isYoutube, onClose }: {
  isYoutube: boolean;
  onClose: () => void;
}) {
  return (
    <div className="settings-head">
      <span className="badge-label">
        <LinkIcon size={14} /> {isYoutube ? "Import YouTube video" : "Add a web link"}
      </span>
      <button
        className="subtle btn-ic"
        title="Close"
        aria-label="Close"
        onClick={onClose}
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}

function LinkPrivacyHint({ isYoutube, saveVideo }: {
  isYoutube: boolean;
  saveVideo: boolean;
}) {
  const message = isYoutube
    ? "This sends the public video link to YouTube to fetch it — your room files stay on this Mac."
    : saveVideo
      ? "This sends the public link to the site to fetch its video — your room files stay on this Mac."
      : "This fetches one page from the internet — your room files stay on this Mac.";
  return <p className="settings-hint">{message}</p>;
}

function LinkAddressInput({ value, onChange, onSubmit, onClose }: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <input
      className="add-link-input"
      autoFocus
      dir="auto"
      placeholder="https://example.com/article"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSubmit();
        if (event.key === "Escape") onClose();
      }}
    />
  );
}

function ImportModePicker({ isYoutube, saveVideo, importing, onSelect }: {
  isYoutube: boolean;
  saveVideo: boolean;
  importing: boolean;
  onSelect: (saveVideo: boolean) => void;
}) {
  const copy = importModeCopy(isYoutube);
  return (
    <div className="yt-mode" role="radiogroup" aria-label="What to import">
      <button
        className={`yt-mode-opt${!saveVideo ? " active" : ""}`}
        role="radio"
        aria-checked={!saveVideo}
        disabled={importing}
        onClick={() => onSelect(false)}
      >
        <span className="yt-mode-name">{copy.pageName}</span>
        <span className="yt-mode-sub">{copy.pageDetail}</span>
      </button>
      <button
        className={`yt-mode-opt${saveVideo ? " active" : ""}`}
        role="radio"
        aria-checked={saveVideo}
        disabled={importing}
        onClick={() => onSelect(true)}
      >
        <span className="yt-mode-name">{copy.videoName}</span>
        <span className="yt-mode-sub">{copy.videoDetail}</span>
      </button>
    </div>
  );
}

function QualitySize({ bytes }: { bytes: number | null }) {
  if (bytes === null) return null;
  return <span className="yt-quality-size"> · ~{fmtSize(bytes)}</span>;
}

function BestQualityOption({ importing, downloading, qualities, maxHeight, onSelect }: {
  importing: boolean;
  downloading: boolean;
  qualities: MediaQualityOption[];
  maxHeight: number | null;
  onSelect: () => void;
}) {
  const bestDoesNotFit = qualities.length > 0 && !qualities[0].fits;
  return (
    <button
      className={`yt-quality-opt${maxHeight === null ? " active" : ""}`}
      role="radio"
      aria-checked={maxHeight === null}
      disabled={importing || downloading || bestDoesNotFit}
      title={bestDoesNotFit ? "The best quality is too big for a room file" : undefined}
      onClick={onSelect}
    >
      Best
    </button>
  );
}

function VideoQualityOption({ quality, importing, downloading, maxHeight, onSelect }: {
  quality: MediaQualityOption;
  importing: boolean;
  downloading: boolean;
  maxHeight: number | null;
  onSelect: (height: number) => void;
}) {
  return (
    <button
      className={`yt-quality-opt${maxHeight === quality.height ? " active" : ""}`}
      role="radio"
      aria-checked={maxHeight === quality.height}
      disabled={importing || downloading || !quality.fits}
      title={quality.fits ? undefined : "Too big for a room file"}
      onClick={() => onSelect(quality.height)}
    >
      {quality.height}p
      <QualitySize bytes={quality.approxBytes} />
    </button>
  );
}

function QualityOptions({ importing, downloading, qualities, maxHeight, onSelect }: {
  importing: boolean;
  downloading: boolean;
  qualities: MediaQualityOption[];
  maxHeight: number | null;
  onSelect: (height: number | null) => void;
}) {
  return (
    <>
      <BestQualityOption
        importing={importing}
        downloading={downloading}
        qualities={qualities}
        maxHeight={maxHeight}
        onSelect={() => onSelect(null)}
      />
      {qualities.map((quality) => (
        <VideoQualityOption
          key={quality.height}
          quality={quality}
          importing={importing}
          downloading={downloading}
          maxHeight={maxHeight}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

function VideoQualityPicker({ visible, probing, importing, downloading, qualities, maxHeight, onSelect }: {
  visible: boolean;
  probing: boolean;
  importing: boolean;
  downloading: boolean;
  qualities: MediaQualityOption[] | null;
  maxHeight: number | null;
  onSelect: (height: number | null) => void;
}) {
  if (!visible) return null;
  return (
    <div className="yt-quality" role="radiogroup" aria-label="Video quality">
      {probing ? (
        <span className="yt-quality-hint">
          Checking which qualities this video offers…
        </span>
      ) : (
        <QualityOptions
          importing={importing}
          downloading={downloading}
          qualities={qualities ?? []}
          maxHeight={maxHeight}
          onSelect={onSelect}
        />
      )}
    </div>
  );
}

function DownloadProgress({ downloading, progress, onCancel }: {
  downloading: boolean;
  progress: { status: string; percent: number | null } | null;
  onCancel: () => void;
}) {
  if (!downloading) return null;
  return (
    <span className="banner-pull">
      <span className="banner-pull-label">
        Downloading <strong>video</strong>… you can close this — it keeps going
        and lands in the room.
        <button className="subtle" onClick={onCancel}>Stop download</button>
      </span>
      <span
        className="pull-bar"
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress?.percent ?? undefined}
      >
        <span
          className="pull-bar-fill"
          style={{ width: `${progress?.percent ?? 0}%` }}
        />
      </span>
      <span className="banner-pull-status">
        {progress?.status ?? "Starting"}
        {progress?.percent != null && ` — ${progress.percent.toFixed(0)}%`}
      </span>
    </span>
  );
}

function AddLinkActions({ importing, downloading, linkUrl, isYoutube, saveVideo, onClose, onSubmit }: {
  importing: boolean;
  downloading: boolean;
  linkUrl: string;
  isYoutube: boolean;
  saveVideo: boolean;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="settings-actions">
      <button className="subtle" onClick={onClose}>
        {importing ? "Close" : "Cancel"}
      </button>
      <button
        className="primary"
        onClick={onSubmit}
        disabled={importing || !linkUrl.trim()}
      >
        {submitButtonLabel({ downloading, importing, isYoutube, saveVideo })}
      </button>
    </div>
  );
}

function AddLinkModal({ s, a }: { s: WSState; a: WSActions }) {
  const [saveVideo, setSaveVideo] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [ytProgress, setYtProgress] = useState<{
    status: string;
    percent: number | null;
  } | null>(null);
  // The quality picker: what THIS video offers (probed, never assumed),
  // which resolution the user chose, and null while "Best" is the choice.
  const [qualities, setQualities] = useState<MediaQualityOption[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);
  const isYoutube = isYoutubeUrl(s.linkUrl);

  // ADD-26: follow yt-dlp while the modal is open.
  useEffect(() => {
    const unlisten = api.onYtdlpProgress((p) => setYtProgress(p));
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  // Ask the site which qualities the video comes in, debounced while the URL
  // is being typed. A probe that fails (not a video page, unsupported site)
  // just hides the picker — the download itself still reports truthfully.
  useEffect(() => {
    if (!saveVideo) return;
    const url = s.linkUrl.trim();
    setQualities(null);
    setMaxHeight(null);
    if (!url) return;
    let stale = false;
    setProbing(true);
    const t = setTimeout(() => {
      api
        .listMediaFormats(url)
        .then((q) => {
          if (stale) return;
          setQualities(q);
          // "Best" is only a sane default when the best actually fits the
          // room — otherwise start on the largest quality that does.
          if (q.length > 0 && !q[0].fits) {
            const fitting = q.find((o) => o.fits);
            if (fitting) setMaxHeight(fitting.height);
          }
        })
        .catch(() => {
          if (!stale) setQualities(null);
        })
        .finally(() => {
          if (!stale) setProbing(false);
        });
    }, 600);
    return () => {
      stale = true;
      clearTimeout(t);
      setProbing(false);
    };
  }, [saveVideo, s.linkUrl]);

  /** ADD-26 → BROWSE-2: download the video and let the room transcribe it
   * on-device. Shared by the explicit video option (any yt-dlp-supported
   * site, not just YouTube) and the automatic no-captions fallback. The
   * download can take minutes, so the modal stays open with progress.
   * Returns true when a video landed. */
  async function downloadAndTranscribe(url: string): Promise<boolean> {
    setDownloading(true);
    try {
      const report = await api.importMediaUrl(url, maxHeight ?? undefined);
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

  /** BROWSE-2: video-only path for a non-YouTube site — no captions to try
   * first, so it goes straight to the downloader. Failure on an unsupported
   * site surfaces truthfully via the toast in downloadAndTranscribe. */
  async function submitVideoOnly() {
    const url = s.linkUrl.trim();
    if (!url || s.importingLink) return;
    s.setImportingLink(true);
    try {
      await downloadAndTranscribe(url);
    } finally {
      s.setImportingLink(false);
    }
  }

  function submit() {
    if (saveVideo) void (isYoutube ? submitWithVideo() : submitVideoOnly());
    else void submitCaptionsOrFallback();
  }

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) s.setShowAddLink(false);
      }}
    >
      <div className="settings add-link-modal">
        <AddLinkHeader
          isYoutube={isYoutube}
          onClose={() => s.setShowAddLink(false)}
        />
        <div className="settings-body">
          <LinkPrivacyHint isYoutube={isYoutube} saveVideo={saveVideo} />
          <LinkAddressInput
            value={s.linkUrl}
            onChange={s.setLinkUrl}
            onSubmit={submit}
            onClose={() => s.setShowAddLink(false)}
          />
          <ImportModePicker
            isYoutube={isYoutube}
            saveVideo={saveVideo}
            importing={s.importingLink}
            onSelect={setSaveVideo}
          />
          <VideoQualityPicker
            visible={saveVideo && (probing || (qualities?.length ?? 0) > 0)}
            probing={probing}
            importing={s.importingLink}
            downloading={downloading}
            qualities={qualities}
            maxHeight={maxHeight}
            onSelect={setMaxHeight}
          />
          <DownloadProgress
            downloading={downloading}
            progress={ytProgress}
            onCancel={() => void api.cancelMediaDownload().catch(() => {})}
          />
          <AddLinkActions
            importing={s.importingLink}
            downloading={downloading}
            linkUrl={s.linkUrl}
            isYoutube={isYoutube}
            saveVideo={saveVideo}
            onClose={() => s.setShowAddLink(false)}
            onSubmit={submit}
          />
        </div>
      </div>
    </div>
  );
}
