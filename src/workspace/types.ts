import {
  FileContent,
  FileMeta,
  FileTarget,
  RoomInfo,
  ScriptInfo,
  isRecordingFile,
} from "../api";

export interface OpenFile {
  id: string;
  content: FileContent;
  target?: FileTarget;
}

/** One flattened search hit (ADD-6) — the arrow-key navigable unit. */
export type FlatResult =
  | { kind: "file"; id: string; name: string; snippet: string }
  | { kind: "message"; chatId: string; messageId: string; snippet: string }
  | { kind: "memory"; id: string; snippet: string };

/** A transient message to the user. Successes/info self-dismiss; errors stay
 * until closed (UX-7). */
export interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
  /** Optional remediation button (e.g. "Open Ollama", "Download"). Runs, then
   * the toast dismisses itself. */
  action?: { label: string; run: () => void };
}

export interface Props {
  info: RoomInfo;
  onLock: () => void | Promise<void>;
  /** The room was renamed (top bar → the room name). The shell owns `info`, so
   * it has to be handed the refreshed record — nothing else re-reads it, and
   * without this the new name would only appear after locking and unlocking. */
  onRenamed?: (info: RoomInfo) => void;
}

/** The product areas the activity rail navigates between. "files" is the
 * default document workspace; map/workflows/scripts keep their existing
 * show* flags as the source of truth, and this value adds the areas that
 * had no flag before (home, recordings, memory). */
export type WorkArea =
  | "files"
  | "home"
  | "map"
  | "recordings"
  | "workflows"
  | "scripts"
  | "skills"
  | "memory"
  | "connectors"
  // Pictures and video, made by whichever connected model can actually make
  // one. Only models a live catalog vouches for are offered.
  | "create"
  | "sketch"
  // BROWSE-1: the private browser. Its page is a native child webview
  // parked over the workspace pane, not a React subtree.
  | "browser";

/** The areas the rail can navigate to, as VALUES — the type above cannot be
 * checked at runtime, and the room's remembered place comes back off disk as
 * a bare string. Keep this in step with the union; the exhaustiveness check
 * below makes the compiler say so if it ever falls behind. */
export const WORK_AREAS = [
  "files",
  "home",
  "map",
  "recordings",
  "workflows",
  "scripts",
  "skills",
  "memory",
  "connectors",
  "create",
  "sketch",
  "browser",
] as const;

/** Fails to compile if WORK_AREAS and WorkArea ever disagree in either
 * direction — a missing member, or one that is no longer in the union. */
const _areasCoverUnion: readonly WorkArea[] = WORK_AREAS;
type _UnionCoversAreas = Exclude<WorkArea, (typeof WORK_AREAS)[number]> extends never
  ? true
  : never;
const _unionCovered: _UnionCoversAreas = true;
void _areasCoverUnion;
void _unionCovered;

/** Whether a string off disk still names a real area. A remembered place
 * outlives the build that wrote it, so a retired area name has to degrade to
 * the default rather than put the room into a state that no longer renders. */
export function isWorkArea(value: string): value is Exclude<WorkArea, "files"> {
  return value !== "files" && (WORK_AREAS as readonly string[]).includes(value);
}

/** Whether `area` actually CONTAINS the open file.
 *
 * An open file always wins the centre pane — that is deliberate, so a citation
 * or an agent open is never swallowed by whichever area page happens to be
 * showing (see ViewerPane). But most areas hold no room files at all, and the
 * two contextual surfaces — the breadcrumb trail and the library pane — were
 * naming the area regardless. Open a .docx while the private browser is the
 * current area and the trail read `Room / Private browser / report.docx` with
 * the browser's own controls still in the left pane: an ordinary room document
 * announced as browser content.
 *
 * Only three answers are true. The file-centric areas browse the library, so
 * they contain everything. Recordings and Scripts each list a subset and their
 * navigators highlight the very row that was opened, so they contain a file
 * when it is one of theirs. Nothing else contains files, so nothing else may
 * put its name on one. */
export function areaHoldsFile(
  area: WorkArea,
  fileId: string,
  files: FileMeta[],
  scripts: ScriptInfo[],
): boolean {
  if (area === "files" || area === "home" || area === "map") return true;
  if (area === "recordings") {
    const meta = files.find((f) => f.id === fileId);
    return meta != null && isRecordingFile(meta);
  }
  if (area === "scripts") return scripts.some((sc) => sc.fileId === fileId);
  return false;
}

/** The areas that name themselves in a file's breadcrumb trail.
 *
 * `areaHoldsFile` also answers true for the file-centric areas, and rightly —
 * they browse the whole library. They are absent here because "Files", "Home"
 * and "Room Map" are not places a document lives; the folder is. */
export const FILE_BEARING_AREAS: readonly WorkArea[] = ["recordings", "scripts"];
