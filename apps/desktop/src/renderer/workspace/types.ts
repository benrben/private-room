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
  /** WHAT THIS MESSAGE IS ABOUT — an object id, when the message confirms a
   * change to something that is still on screen.
   *
   * Two things follow from it, and both exist because of the same live report:
   * adding and removing one sketch from the Library five times left five
   * undismissed confirmations covering the workspace, across destinations,
   * with nothing expiring them.
   *
   *   • REPEATS REPLACE. A second message about the same object supersedes the
   *     first rather than stacking under it. Only the latest is true anyway —
   *     the earlier one's Undo would put back a state two acts ago.
   *   • IT CLEARS ITSELF, action or not. The usual rule is that a toast
   *     carrying an action waits forever, because the action is the only route
   *     to something the app deliberately did not do for you. That is not this:
   *     the object is right there, its own chip offers the exact inverse, and
   *     the change is reversible from the object at any time. */
  about?: string;
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
  // The device-wide visual system editor. Its draft is local to this Mac and
  // can be edited by the user, the Design agent, or both.
  | "skin"
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
  "skin",
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
export function isWorkArea(value: string): value is WorkArea {
  return (WORK_AREAS as readonly string[]).includes(value);
}

const UNIVERSAL_FILE_AREAS: readonly WorkArea[] = ["files", "home", "map"];

function holdsClassifiedFile(area: WorkArea, file: FileMeta): boolean {
  if (area === "recordings") return isRecordingFile(file);
  if (area === "sketch") return isSketchFile(file);
  if (area === "create") return isCreationFile(file);
  return false;
}

/** Whether `area` actually CONTAINS the open file.
 *
 * An open file always wins the centre pane — that is deliberate, so a citation
 * or an agent open is never swallowed by whichever area page happens to be
 * showing (see ViewerPane). This answers the other half: is the destination on
 * the rail the one that OWNS this document?
 *
 * It is now the router for the whole two-level IA. A file its destination
 * holds stays there, with that destination's own list beside it and the row
 * highlighted; a file its destination does NOT hold moves the app to Home,
 * atomically, rather than leaving a document on screen with an unrelated
 * sidebar next to it (see `Workspace.tsx`'s `showFileHere` effect). Open a
 * .docx from the private browser and you arrive in Home, where that document
 * lives — not in a browser that has quietly started listing room files.
 *
 * Five destinations hold files. Home browses the library, so it holds
 * everything; the map draws the whole room, so it holds everything it can open.
 * Recordings, Scripts, Sketches and Creations each hold their own kind, and
 * each highlights the very row that was opened. Nothing else holds files, so
 * nothing else may put its name on one. */
export function areaHoldsFile(
  area: WorkArea,
  fileId: string,
  files: FileMeta[],
  scripts: ScriptInfo[],
): boolean {
  if (UNIVERSAL_FILE_AREAS.includes(area)) return true;
  if (area === "scripts") return scripts.some((sc) => sc.fileId === fileId);
  const file = files.find((candidate) => candidate.id === fileId);
  if (!file) return false;
  return holdsClassifiedFile(area, file);
}

/** A drawing. The extension is the format's own marker (`commands/sketch.rs`
 * mints `<name>.sketch`), so it is the honest test — a sketch imported into an
 * older room predates `originDestination` and is still a sketch. */
export function isSketchFile(f: FileMeta): boolean {
  return f.name.toLowerCase().endsWith(".sketch");
}

/** A picture or clip the Create page made.
 *
 * Asks the file where it CAME FROM, never what it looks like. Matching on mime
 * type would sweep in every photo the user imported and every screenshot the
 * browser saved, which are not creations and do not belong in a list whose
 * rows offer to re-render or re-charge for their subject. */
export function isCreationFile(f: FileMeta): boolean {
  return f.originDestination === "create";
}

/** The areas that name themselves in a file's breadcrumb trail.
 *
 * `areaHoldsFile` also answers true for the file-centric areas, and rightly —
 * they browse the whole library. They are absent here because "Files", "Home"
 * and "Room Map" are not places a document lives; the folder is. */
export const FILE_BEARING_AREAS: readonly WorkArea[] = ["recordings", "scripts"];
