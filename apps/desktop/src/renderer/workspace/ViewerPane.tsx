import {
  useEffect,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { RoomInfo } from "../api";
import {
  CollapseLeftIcon,
  EmptyViewerArt,
  FocusIcon,
  LockIcon,
  PlusIcon,
  SendIcon,
  SparkIcon,
} from "../icons";
import RoomMap from "../viewers/RoomMap";
import { fileLabel } from "./composer";
import ViewerRouter from "./ViewerRouter";
import CloudView from "../viewers/CloudView";
import FrontPage from "./FrontPage";
import MemoryView from "./MemoryView";
import RecordingsPage from "./RecordingsPage";
import { useTextEncoding } from "../viewers/TextEncoding";
import {
  DocSourceCard,
  READER_KINDS,
  ReadingProgress,
  useReadingProgress,
} from "./ReaderShell";
import { isCloudRoute, isModelReady, trustState } from "./markup";
import ConnectorsView from "./ConnectorsView";
import { BrowserView } from "./BrowserView";
import { WSState } from "./state";
import { WSActions } from "./actions";
import { FILE_BEARING_AREAS, WorkArea, isSketchFile } from "./types";
import { LayoutApi } from "../shell/useLayout";
import { WorkflowsPage } from "./workflows/WorkflowsPage";
import { ScriptsPage } from "./scripts/ScriptsPage";
import SkillsView from "./skills/SkillsView";
import { CreatePage } from "./create/CreatePage";
import type { ViewerKind } from "../api";
import { NO_FILE, useDismissOnEscape, useDocumentQuote, useFrameQuote, type ViewerQuote } from "./viewerQuote";
import { FileHeader, LibraryChip, QuoteAction } from "./ViewerFileHeader";

/** Viewers that draw their own toolbar and manage their own scrolling, and so
 * need the full height of the pane rather than sizing to their content.
 *
 * This used to be spelled inline as `kind === "code" || kind === "html"`, which
 * was complete when those were the only two. Every viewer added since has a
 * bar across the top and a scroll region under it, and one that misses this
 * set collapses to content height with its toolbar floating above nothing.
 *
 * `fill` also drops `.viewer-body`'s page margin to zero, so a viewer only
 * belongs here if it draws its OWN padding — `.sk-tools` and `.rec-transport`
 * do. `.audio-view` and `.image-view` do not: adding them pins their controls
 * at the cost of running the player, the transcript and the OCR block flush
 * into the pane edges, and `.image-view`'s siblings would be clipped rather
 * than scrolled under `overflow: hidden`. Those two need padding in
 * composer.css/viewer-formats.css before they can join. */
const FILL_HEIGHT_KINDS = new Set<ViewerKind>([
  "archive",
  "book",
  "code",
  "html",
  "json",
  "log",
  "recording",
  "sheet",
  "csv",
  "sketch",
  "slides",
  "subtitle",
  "svg",
  "worddoc",
]);

const AREA_CRUMBS: Record<WorkArea, string> = {
  files: "Files",
  home: "Home",
  map: "Room Map",
  recordings: "Recordings",
  workflows: "Workflows",
  scripts: "Scripts",
  skills: "Skills",
  memory: "Memory & scratch pad",
  connectors: "Connectors",
  create: "Create",
  sketch: "Sketch",
  browser: "Private browser",
};

/** Escape dismisses the popover, not the document behind it.
 *
 * Capture phase, because the shell's Escape handler (effects.ts) listens on
 * `window` in the BUBBLE phase and closes the open file: a menu that stopped
 * propagation only from its own subtree still lost the document underneath
 * it, leaving the popover drawn over whatever replaced it. Same dismissal
 * grammar as the top bar's shared menu slot. */
function OpeningOverlay({ openingFileId, openFileId }: { openingFileId: string | null | undefined; openFileId: string | undefined }) {
  if (!openingFileId || openingFileId === openFileId) return null;
  return <div className="viewer-opening" role="status">Opening…</div>;
}

function BreadcrumbTitle({ s, openFile, area, folderName, areaCrumb }: {
  s: WSState;
  openFile: WSState["openFile"];
  area: WorkArea;
  folderName: string | undefined;
  areaCrumb: string;
}) {
  if (!openFile) return <span className="crumb-title">{areaCrumb}</span>;
  const areaPrefix = FILE_BEARING_AREAS.includes(area) ? `${AREA_CRUMBS[area]} / ` : "";
  const folderPrefix = folderName ? `${folderName} / ` : "";
  return <>{areaPrefix}{folderPrefix}<span className="crumb-title">{fileLabel(openFile.content.name, s.files)}</span></>;
}

function ViewerBreadcrumb({ s, a, info, layout, area, openFile, folderName, areaCrumb }: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  area: WorkArea;
  openFile: WSState["openFile"];
  folderName: string | undefined;
  areaCrumb: string;
}) {
  return (
    <div className="editor-breadcrumb-bar">
      <div className="editor-breadcrumb" title={openFile?.content.name}>
        <strong>{info.name}</strong>{" / "}
        <BreadcrumbTitle s={s} openFile={openFile} area={area} folderName={folderName} areaCrumb={areaCrumb} />
      </div>
      {openFile && <LibraryChip s={s} a={a} fileId={openFile.id} />}
      <div className="pane-actions">
        <button className="pane-icon-btn" data-tip="Focus this pane" aria-label="Give the workspace pane the full width" onClick={() => layout.toggleFocus("center")}><FocusIcon size={14} /></button>
        <button className="pane-icon-btn" data-tip="Collapse" aria-label="Collapse the workspace pane" onClick={() => layout.collapsePane("center")}><CollapseLeftIcon size={14} /></button>
      </div>
    </div>
  );
}

function FileDescription({ openFile, description }: { openFile: WSState["openFile"]; description: string | null | undefined }) {
  if (!openFile || !description) return null;
  return <div className="viewer-file-description" title={description}>{description}</div>;
}

function FileStaleBanner({ s, a, fileId }: { s: WSState; a: WSActions; fileId: string }) {
  if (s.staleFile !== fileId) return null;
  const load = () => {
    s.setStaleFile(null);
    s.editorDirtyRef.current = false;
    void a.viewFile(fileId);
  };
  return (
    <div className="stale-banner" role="status">
      <span className="stale-banner-text">The AI changed this file while you were editing.</span>
      <span className="stale-banner-actions">
        <button className="primary" title="Show the AI's version (your unsaved edits are discarded)" onClick={load}>Load AI version</button>
        <button className="subtle" title="Keep your buffer — your next ⌘S overwrites; the AI's version stays in History" onClick={() => s.setStaleFile(null)}>Keep editing</button>
      </span>
    </div>
  );
}

function viewerBodyClass(cloudView: boolean, file: NonNullable<WSState["openFile"]>, s: WSState, a: WSActions, readerShell: boolean): string {
  const fills = cloudView || FILL_HEIGHT_KINDS.has(file.content.kind) || (s.editMode && a.editModeOf(file.content) !== "grid");
  return `viewer-body ${fills ? "fill" : ""}${readerShell ? " is-reader" : ""}`;
}

function ViewerRouterContent({ openFile, s, a, enc }: { openFile: NonNullable<WSState["openFile"]>; s: WSState; a: WSActions; enc: ReturnType<typeof useTextEncoding> }) {
  return <ViewerRouter openFile={openFile} viewerRev={s.viewerRev} editMode={s.editMode} editModeOf={a.editModeOf} enc={enc} editCell={a.editCell} saveEdit={a.saveEdit} saveEditAsCopy={a.saveEditAsCopy} onDirtyChange={(dirty) => { s.editorDirtyRef.current = dirty; }} registerSave={(save) => { s.editorSaveRef.current = save; }} recording={{ live: s.recLive, saveProgress: s.recSave, pushToast: s.pushToast, onStart: a.startLiveRecording, onPause: a.pauseLiveRecording, onResume: a.resumeLiveRecording, onStop: a.stopLiveRecording }} sttStatus={s.sttStatus} />;
}

function FileReadingProgress({ readerShell, viewerDrawsProgress, value }: { readerShell: boolean; viewerDrawsProgress: boolean; value: number }) {
  if (!readerShell || viewerDrawsProgress) return null;
  return <ReadingProgress value={value} />;
}

function FileSourceCard({ readerShell, openFile, s }: { readerShell: boolean; openFile: NonNullable<WSState["openFile"]>; s: WSState }) {
  if (!readerShell || openFile.content.webMeta) return null;
  return <DocSourceCard file={s.files.find((file) => file.id === openFile.id)} />;
}

function FileViewerContent({ cloudView, openFile, s, a, enc }: { cloudView: boolean; openFile: NonNullable<WSState["openFile"]>; s: WSState; a: WSActions; enc: ReturnType<typeof useTextEncoding> }) {
  if (cloudView) return <CloudView fileId={openFile.id} />;
  return <ViewerRouterContent openFile={openFile} s={s} a={a} enc={enc} />;
}

function FileViewerBody({ s, a, openFile, cloudView, readerShell, viewerDrawsProgress, reading, enc }: {
  s: WSState;
  a: WSActions;
  openFile: NonNullable<WSState["openFile"]>;
  cloudView: boolean;
  readerShell: boolean;
  viewerDrawsProgress: boolean;
  reading: ReturnType<typeof useReadingProgress>;
  enc: ReturnType<typeof useTextEncoding>;
}) {
  return (
    <>
      <FileReadingProgress readerShell={readerShell} viewerDrawsProgress={viewerDrawsProgress} value={reading.progress} />
      <div className={viewerBodyClass(cloudView, openFile, s, a, readerShell)} ref={readerShell ? reading.ref : undefined}>
        <FileSourceCard readerShell={readerShell} openFile={openFile} s={s} />
        <FileViewerContent cloudView={cloudView} openFile={openFile} s={s} a={a} enc={enc} />
      </div>
    </>
  );
}

function FileSurface({ s, a, openFile, cloudView, setCloudView, mode, overflowOpen, setOverflowOpen, cloudViewable, confirmDeleteVersion, setConfirmDeleteVersion, readerShell, viewerDrawsProgress, reading, enc }: {
  s: WSState;
  a: WSActions;
  openFile: NonNullable<WSState["openFile"]>;
  cloudView: boolean;
  setCloudView: Dispatch<SetStateAction<boolean>>;
  mode: ReturnType<WSActions["editModeOf"]>;
  overflowOpen: boolean;
  setOverflowOpen: Dispatch<SetStateAction<boolean>>;
  cloudViewable: boolean;
  confirmDeleteVersion: string | null;
  setConfirmDeleteVersion: Dispatch<SetStateAction<string | null>>;
  readerShell: boolean;
  viewerDrawsProgress: boolean;
  reading: ReturnType<typeof useReadingProgress>;
  enc: ReturnType<typeof useTextEncoding>;
}) {
  return <><FileHeader {...{ s, a, openFile, cloudView, setCloudView, mode, overflowOpen, setOverflowOpen, cloudViewable, confirmDeleteVersion, setConfirmDeleteVersion, enc }} /><FileStaleBanner s={s} a={a} fileId={openFile.id} /><FileViewerBody {...{ s, a, openFile, cloudView, readerShell, viewerDrawsProgress, reading, enc }} /></>;
}

function BrowserSurface({ s, a, layout, parked }: { s: WSState; a: WSActions; layout: LayoutApi; parked: boolean }) {
  const ask = (query: string) => {
    const draft = s.question.trim();
    s.setQuestion(draft ? `${draft}\n\n${query}` : query);
    layout.showPane("ai");
  };
  return <BrowserView parked={parked} onAttach={a.toggleAttach} onAsk={ask} />;
}

function summaryDisabled(s: WSState): boolean {
  return s.summaryStarting || s.jobs.some((job) => job.status === "running" || job.status === "queued");
}

function EmptyRoomActions({ s, a, layout, aiReady }: { s: WSState; a: WSActions; layout: LayoutApi; aiReady: boolean }) {
  if (!aiReady) return <button className="qa-btn" onClick={() => a.focusComposer(layout)}><SparkIcon size={14} /> Set up the AI</button>;
  return <><>{s.files.length > 0 && <button className="qa-btn" disabled={summaryDisabled(s)} onClick={() => void a.startDeepSummary()}><SparkIcon size={14} /> Summarize room</button>}</><button className="qa-btn" onClick={() => a.focusComposer(layout)}><SendIcon size={14} /> Ask the room</button></>;
}

function emptyRoomPrivacyLine(trust: ReturnType<typeof trustState>, alsoSendsOut: boolean): string {
  return trust.tone === "good" && alsoSendsOut ? "The AI runs on this Mac — but online search or a connected tool sends what it asks for off the device." : trust.title;
}

function SealedRoom({ s, a, info, layout, aiReady, trust, alsoSendsOut }: { s: WSState; a: WSActions; info: RoomInfo; layout: LayoutApi; aiReady: boolean; trust: ReturnType<typeof trustState>; alsoSendsOut: boolean }) {
  return <div className="viewer-empty"><div className="viewer-empty-icon"><EmptyViewerArt /></div><h1 className="viewer-empty-title">Your room is sealed</h1><p className="viewer-empty-sub">Everything you add stays inside <strong>{info.path.split("/").pop()}</strong>. {aiReady ? "Add a file, open a note, or ask the room a question about everything inside." : "Add a file to get started — asking the room a question needs a model, and this room's AI isn't set up yet."}</p><div className="viewer-empty-actions"><button className="qa-btn primary" onClick={a.importFiles}><PlusIcon size={14} /> Add a file</button><EmptyRoomActions s={s} a={a} layout={layout} aiReady={aiReady} /></div><div className="viewer-empty-note"><LockIcon size={16} /><div><strong>Your room data is on this Mac; private Arcelle state is encrypted.</strong> {emptyRoomPrivacyLine(trust, alsoSendsOut)}</div></div></div>;
}

function HomeSurface({ s, a, info, layout, frontPageView, aiReady, trust, alsoSendsOut }: { s: WSState; a: WSActions; info: RoomInfo; layout: LayoutApi; frontPageView: WSState["fp"]; aiReady: boolean; trust: ReturnType<typeof trustState>; alsoSendsOut: boolean }) {
  if (frontPageView) return <FrontPage page={frontPageView} s={s} a={a} layout={layout} info={info} />;
  return <SealedRoom {...{ s, a, info, layout, aiReady, trust, alsoSendsOut }} />;
}

function AreaSurface({ s, a, info, layout, area, overlayShowing, frontPageView, aiReady, trust, alsoSendsOut }: { s: WSState; a: WSActions; info: RoomInfo; layout: LayoutApi; area: WorkArea; overlayShowing: boolean; frontPageView: WSState["fp"]; aiReady: boolean; trust: ReturnType<typeof trustState>; alsoSendsOut: boolean }) {
  if (s.showWorkflows) return <WorkflowsPage s={s} a={a} />;
  if (s.showScripts) return <ScriptsPage s={s} a={a} />;
  if (s.showMap) return <div className="room-map-canvas"><RoomMap onOpenFile={(id) => a.viewFile(id)} /></div>;
  const surfaces: Partial<Record<WorkArea, ReactNode>> = {
    browser: <BrowserSurface s={s} a={a} layout={layout} parked={overlayShowing} />,
    connectors: <ConnectorsView />,
    skills: <SkillsView s={s} a={a} info={info} />,
    memory: <MemoryView s={s} a={a} info={info} />,
    recordings: <RecordingsPage s={s} a={a} info={info} />,
    create: <CreatePage s={s} a={a} />,
    sketch: <SketchLanding s={s} a={a} />,
  };
  return surfaces[area] ?? <HomeSurface {...{ s, a, info, layout, frontPageView, aiReady, trust, alsoSendsOut }} />;
}

function SketchLanding({ s, a }: { s: WSState; a: WSActions }) {
  const count = s.files.filter(isSketchFile).length;
  return (
    <div className="sk-empty" role="status">
      <p>{count === 0 ? "Nothing sketched yet" : "Pick a sketch to open it"}</p>
      <span>
        Drawings live in this room like any other file — versioned, searchable by
        their labels, and the room&rsquo;s AI can draw on them beside you. They
        stay in Sketches until you add one to the Library.
      </span>
      <button
        type="button"
        className="nb-btn nb-btn-primary"
        onClick={() => void a.createSketch()}
      >
        New sketch
      </button>
    </div>
  );
}

function hasCloudPayload(file: WSState["openFile"]): boolean {
  return Boolean(file?.content.text);
}

function editModeFor(file: WSState["openFile"], a: WSActions): ReturnType<WSActions["editModeOf"]> {
  if (!file) return null;
  return a.editModeOf(file.content);
}

function readerShellFor(file: WSState["openFile"], cloudView: boolean, editMode: boolean): boolean {
  return Boolean(file && !cloudView && !editMode && READER_KINDS.has(file.content.kind));
}

function viewerDrawsReadingProgress(file: WSState["openFile"]): boolean {
  return ["prose", "pdf"].includes(file?.content.kind ?? "");
}

function usableFrontPage(frontPage: WSState["fp"]): WSState["fp"] {
  if (!frontPage) return null;
  const hasContent = frontPage.fileCount > 0 || frontPage.chatCount > 0 || frontPage.memories.length > 0;
  return hasContent ? frontPage : null;
}

function viewerFileMetadata(s: WSState, openFile: WSState["openFile"]): { folderName: string | undefined; fileDescription: string | null | undefined } {
  if (!openFile) return { folderName: undefined, fileDescription: undefined };
  const file = s.files.find((candidate) => candidate.id === openFile.id);
  const folderName = s.folders.find((folder) => folder.id === file?.folderId)?.name;
  return { folderName, fileDescription: file?.aiSummary };
}

function areaCrumbFor(area: WorkArea, s: WSState): string {
  if (area !== "files") return AREA_CRUMBS[area];
  if ([s.showWorkflows, s.showScripts, s.showMap].some(Boolean)) return AREA_CRUMBS[area];
  return "Home";
}

function overlayIsShowing(s: WSState): boolean {
  return [
    s.browseConsents.length > 0,
    s.mcpApprovals.length > 0,
    s.editApprovals.length > 0,
    s.scriptApprovals.length > 0,
    s.showSearch,
    s.showSettings,
    s.showShortcuts,
    s.showFeedback,
    s.showAddLink,
    s.aiPrompt !== null,
    s.studioPrompt !== null,
    s.compare !== null,
    s.ctxMenu !== null,
  ].some(Boolean);
}

function useViewerEncoding(file: WSState["openFile"]) {
  return useTextEncoding(file?.id ?? "", file?.content ?? NO_FILE);
}

function useFrameQuotes(s: WSState, file: WSState["openFile"], enc: ReturnType<typeof useTextEncoding>, setQuote: Dispatch<SetStateAction<ViewerQuote | null>>): void {
  useFrameQuote(s, file?.id ?? null, enc.text, setQuote);
}

function sendsDataOutside(s: WSState): boolean {
  return s.webOn || s.mcpTools.length > 0;
}

function modelIsReady(s: WSState): boolean {
  return s.ai == null || isModelReady(s.ai, s.model);
}

function useViewerPaneData(s: WSState, a: WSActions, area: WorkArea) {
  const { openFile } = s;
  const [cloudView, setCloudView] = useState(false);
  const [confirmDeleteVersion, setConfirmDeleteVersion] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  useEffect(() => setCloudView(false), [openFile?.id]);
  useEffect(() => setConfirmDeleteVersion(null), [openFile?.id, s.showHistory]);
  useEffect(() => setOverflowOpen(false), [openFile?.id]);
  useDismissOnEscape(overflowOpen, setOverflowOpen);
  useDismissOnEscape(s.showHistory, s.setShowHistory);
  const [quote, setQuote] = useDocumentQuote(openFile?.id, openFile?.content.kind ?? null, s.editMode);
  const enc = useViewerEncoding(openFile);
  useFrameQuotes(s, openFile, enc, setQuote);
  const readerShell = readerShellFor(openFile, cloudView, s.editMode);
  const reading = useReadingProgress(openFile?.id ?? "");
  const metadata = viewerFileMetadata(s, openFile);
  return {
    openFile,
    cloudView,
    setCloudView,
    confirmDeleteVersion,
    setConfirmDeleteVersion,
    overflowOpen,
    setOverflowOpen,
    cloudViewable: hasCloudPayload(openFile),
    mode: editModeFor(openFile, a),
    quote,
    setQuote,
    enc,
    readerShell,
    reading,
    viewerDrawsProgress: viewerDrawsReadingProgress(openFile),
    trust: trustState(isCloudRoute(s.model, s.ai), s.privacyOn),
    alsoSendsOut: sendsDataOutside(s),
    aiReady: modelIsReady(s),
    frontPageView: usableFrontPage(s.fp),
    folderName: metadata.folderName,
    fileDescription: metadata.fileDescription,
    areaCrumb: areaCrumbFor(area, s),
    overlayShowing: overlayIsShowing(s),
  };
}

/** The center pane: a stable content header (breadcrumb + pane controls)
 * over the active surface — open file (any viewer), Workflows, Scripts,
 * Room Map, Memory, Recordings, the Front Page, or the sealed-room empty
 * state. An open file always wins, so citations and agent opens are never
 * swallowed by an area page; Escape returns to the area underneath. */
export default function ViewerPane({
  s,
  a,
  info,
  layout,
  area,
}: {
  s: WSState;
  a: WSActions;
  info: RoomInfo;
  layout: LayoutApi;
  /** The destination: which page draws when no file is open, where Escape
   * returns to when one is, and — since the two-level IA landed — the one
   * context every surface here describes. A document its destination does not
   * hold moves the app Home before it paints (see Workspace.tsx's
   * `showFileHere`), so there is no longer a second, disagreeing answer. */
  area: WorkArea;
}) {
  const {
    openFile,
    cloudView,
    setCloudView,
    confirmDeleteVersion,
    setConfirmDeleteVersion,
    overflowOpen,
    setOverflowOpen,
    cloudViewable,
    mode,
    quote,
    setQuote,
    enc,
    readerShell,
    reading,
    viewerDrawsProgress,
    trust,
    alsoSendsOut,
    aiReady,
    frontPageView,
    folderName,
    fileDescription,
    areaCrumb,
    overlayShowing,
  } = useViewerPaneData(s, a, area);
  return (
    <section className="viewer" aria-label="Workspace">
      <QuoteAction quote={quote} file={openFile} s={s} layout={layout} setQuote={setQuote} />
      <OpeningOverlay openingFileId={s.openingFileId} openFileId={openFile?.id} />
      <ViewerBreadcrumb
        s={s}
        a={a}
        info={info}
        layout={layout}
        area={area}
        openFile={openFile}
        folderName={folderName}
        areaCrumb={areaCrumb}
      />
      <FileDescription openFile={openFile} description={fileDescription} />
      {openFile ? (
        <FileSurface
          s={s}
          a={a}
          openFile={openFile}
          cloudView={cloudView}
          setCloudView={setCloudView}
          mode={mode}
          overflowOpen={overflowOpen}
          setOverflowOpen={setOverflowOpen}
          cloudViewable={cloudViewable}
          confirmDeleteVersion={confirmDeleteVersion}
          setConfirmDeleteVersion={setConfirmDeleteVersion}
          readerShell={readerShell}
          viewerDrawsProgress={viewerDrawsProgress}
          reading={reading}
          enc={enc}
        />
      ) : (
        <AreaSurface
          s={s}
          a={a}
          info={info}
          layout={layout}
          area={area}
          overlayShowing={overlayShowing}
          frontPageView={frontPageView}
          aiReady={aiReady}
          trust={trust}
          alsoSendsOut={alsoSendsOut}
        />
      )}
    </section>
  );
}
