/**
 * REAL logic for eight of `exec_tool`'s arms — `mark_image`, `create_file`,
 * `rename_file`, `move_file`, `set_in_library`, `organize_files`,
 * `trash_files`, `merge_files` — ported from `src-tauri/src/commands/agent.rs`
 * (mark_image ~3837, create_file ~3902, rename_file ~4011, set_in_library
 * ~4055, move_file ~4074, organize_files ~4101, trash_files ~4140,
 * merge_files ~4169).
 *
 * Follows `fileTools.ts`'s own precedent exactly: this module has no
 * dependency, type or value, on `execTool.ts` — {@link OrganizeToolOutcome}
 * and {@link EmitFn} are structurally-identical siblings of that file's
 * `ToolOutcome`/`EmitFn` rather than imports, and each `exec*` takes the
 * room's ALREADY-UNWRAPPED `Database.Database` (`execTool.ts` resolves
 * `requireRoom` once, as it does before every other real arm) plus whatever
 * the Rust arm's own `args`/`window.emit`/`ToolEffects`/cancel-flag touch, and
 * nothing more. `execTool.ts` stays the only side of this seam that has to
 * know the other exists.
 *
 * WHAT THIS MODULE IS: the arm SHELL — args parsing, refusals, room events,
 * `effects` bookkeeping — around business logic that already lives elsewhere.
 * That is the same division of labour `agent.rs` itself draws against
 * `commands/organize.rs`, and it is why almost nothing here is new code:
 *   - `organize.ts` (committed): `organize`, `organizeSentence`, `trashNamed`,
 *     `merge`, and the `OrganizeEntry`/`OrganizeReport` types.
 *   - `bulkReport.ts` (this batch): `BulkReport::changed_anything`/`::sentence`,
 *     the one piece of `commands/bulk.rs` `organize.ts`'s own doc flags as
 *     still missing and which `trash_files` needs.
 *   - `docsHtml.ts` (this batch): the scratch-pad and HTML-first slice of
 *     `commands/docs_html.rs` that `create_file` needs — `SCRATCH_PAD_NAME`,
 *     `isScratchPadName`, `noteMime`, `htmlDocument` (with the app's real
 *     inlined design system, copied character-for-character, NOT a
 *     look-alike substitute).
 *   - `db-host/files.ts`, `db-host/folders.ts`, `db-host/versions.ts`,
 *     `db-host/artifacts.ts` (all committed): every DB call below.
 *
 * ARGS TRANSLATION IS THIS FILE'S JOB. `organize.ts`'s `OrganizeEntry`
 * camelCases Rust's `new_name` to `newName` (a TS-idiomatic rename Rust's own
 * struct has no need of, since it deserializes the raw tool-call key
 * directly), and that module's doc says a later wiring batch "calls these
 * exactly the way `agent.rs` calls `super::organize::*` today" — so remapping
 * the raw snake_case `args["files"]` JSON onto `OrganizeEntry[]` happens here,
 * in {@link parseOrganizeEntries}.
 *
 * THE ONE HONEST GAP — `mark_image`'s vision grounding pass. Read in full, the
 * Rust arm is: resolve the image (`db::find_image_like`), reuse an existing
 * grounding for the SAME image this turn (CHG-17), THEN list the installed
 * Ollama models, pick a vision-capable one, check the privacy door, prepare
 * the image and call the model for boxes (`ollama::list_models`,
 * `grounding_pick`, `image_grounding_blocked_by_privacy`, `prepare_image`,
 * `ground_prepared_image`). Everything before that line is REAL here; from
 * there on it is a labelled `NOT_IMPLEMENTED`, because `ollama.rs`'s whole
 * model-execution surface has no Electron port yet (`local_generate` is
 * stubbed for the same reason).
 *
 * That refusal deliberately does NOT reuse Rust's own "no vision model is
 * installed on this Mac" sentence, which is a true statement about the
 * machine's capability. This build cannot reach ANY vision model, installed or
 * not, so claiming a fact about what is on the Mac would be exactly the
 * fabrication `react_verify` exists to catch. Naming the missing subsystem is
 * the honest form of the same refusal. The lookup still runs first, so a wrong
 * image name gets the real "no such image" answer rather than a stub message
 * about vision.
 *
 * `commitArtifact` is a small local port of `commands/artifact.rs`'s
 * `Artifact::commit` — stage, read the cancel flag, commit, discarding the
 * staged row on either a cancel or a failed commit — built directly over
 * `db-host/artifacts.ts`'s already-committed `stageArtifact`/`commitStaged`/
 * `discardStaged` rather than porting the whole fluent builder type for the
 * one call site that needs it.
 *
 * `move_file`'s "top level" vocabulary is RE-SPELLED here ({@link
 * meansTopLevel}) rather than shared with `organize.ts`, because `agent.rs`'s
 * own `move_file` arm does exactly that: it does not call into
 * `commands::organize` for this either, it duplicates the small
 * top-level-words check and the get-or-create-folder step inline. Trivially
 * collapsible later if a shared `organize.ts` export is preferred.
 */

import type Database from "better-sqlite3-multiple-ciphers";
import path from "node:path";
import { Readable } from "node:stream";
import {
  fileByExactName,
  findFileLikeQualified,
  findImageLike,
  availableName,
  getFileExtractedText,
  getFileMeta,
  inTransaction,
  renameFile,
  setLibraryVisibility,
  updateFileContent,
  setFileExtractedText,
  type FileMeta,
} from "./db-host/files.js";
import { createFolder, listFolders, moveFileToFolder } from "./db-host/folders.js";
import { setFileProvenance, snapshotFileVersion } from "./db-host/versions.js";
import {
  commitStaged,
  discardStaged,
  provenanceToJson,
  stageArtifact,
  type Provenance,
} from "./db-host/artifacts.js";
import {
  merge,
  organize,
  organizeSentence,
  trashNamed,
  type OrganizeEntry,
  type OrganizeReport,
} from "./organize.js";
import { bulkReportChangedAnything, bulkReportSentence } from "./bulkReport.js";
import { htmlDocument, isScratchPadName, noteMime, SCRATCH_PAD_NAME } from "./docsHtml.js";
import type { WorkspaceService } from "./workspace/workspaceService.js";

// --------------------------------------------------------------------- shell

/** `exec_tool`'s `Result<String, String>` for these arms. Structurally
 * identical to `execTool.ts`'s own `ToolOutcome` (and to `fileTools.ts`'s
 * `FileToolOutcome`) — see the module doc for why it is a sibling type rather
 * than an import. */
export type OrganizeToolOutcome = { ok: true; text: string } | { ok: false; error: string };

function ok(text: string): OrganizeToolOutcome {
  return { ok: true, text };
}

function fail(error: string): OrganizeToolOutcome {
  return { ok: false, error };
}

/** A clearly-labeled "the real subsystem behind this isn't ported yet" result,
 * matching `execTool.ts`'s own `notImplemented` shape exactly — never a silent
 * success, never a thrown exception. */
function notImplemented(reason: string): OrganizeToolOutcome {
  return fail(`NOT_IMPLEMENTED: ${reason}`);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `args["k"].as_str().unwrap_or_default()`. */
function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `args["k"].as_bool().unwrap_or(fallback)`. */
function asBoolDefault(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** `let _ = window.emit(...)` — a best-effort UI notification that must never
 * turn a successful call into a failed one. Narrowest possible contract, same
 * as `fileTools.ts`'s own `EmitFn`. */
export type EmitFn = (event: string, payload: unknown) => void;

function emitSafely(emit: EmitFn | undefined, event: string, payload: unknown): void {
  try {
    emit?.(event, payload);
  } catch {
    // Swallowed deliberately, matching Rust's `let _ = window.emit(...)`.
  }
}

/** `extraction::extension_of` — a `std::path::Path` extension: none for a
 * dotfile or a name with no dot, lower-cased. A local copy, the same choice
 * `organize.ts`, `docsHtml.ts` and `turnEngine.ts` already made for this exact
 * function; they all collapse onto one `extraction.ts` when that module lands.
 * Only `rename_file` and `create_file`'s extension default need it here. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

/**
 * `serde_json::from_value::<Vec<String>>(v).unwrap_or_default()` — ALL of `v`
 * or NONE of it.
 *
 * A JSON array deserializes as `Vec<String>` only when EVERY element is a
 * string; one wrong-typed element fails the whole array in serde, which
 * `unwrap_or_default()` then folds to an empty vec. Mirrored as
 * all-or-nothing rather than "keep the strings, drop the rest", so a malformed
 * call degrades exactly the way Rust's does — into the arm's own "needs at
 * least one …" refusal — instead of silently acting on a partial list the
 * model never intended.
 */
function parseStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== "string") {
      return [];
    }
    out.push(item);
  }
  return out;
}

/**
 * `serde_json::from_value::<Vec<OrganizeEntry>>(args["files"].clone()).unwrap_or_default()`,
 * with the same all-or-nothing failure shape as {@link parseStringArray} and
 * one translation on top of it: the raw tool-call key is `new_name` (Rust's
 * struct field is literally that), while `organize.ts`'s `OrganizeEntry` is
 * `newName`. See the module doc's "ARGS TRANSLATION" note.
 *
 * A JSON `null` for `folder`/`newName` is kept as `null` rather than dropped,
 * because Rust's `Option<String>` fields distinguish absent ("don't touch
 * this") from present-and-empty ("move it to the top level") — the whole
 * reason `organize.rs` made them `Option` in the first place. `name` is a
 * plain `String` with `#[serde(default)]`, so a `null` there fails the parse.
 */
function parseOrganizeEntries(v: unknown): OrganizeEntry[] {
  if (!Array.isArray(v)) {
    return [];
  }
  const out: OrganizeEntry[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return [];
    }
    const r = item as Record<string, unknown>;
    const entry: OrganizeEntry = {};
    if (r.name !== undefined) {
      if (typeof r.name !== "string") {
        return [];
      }
      entry.name = r.name;
    }
    if (r.folder !== undefined) {
      if (r.folder !== null && typeof r.folder !== "string") {
        return [];
      }
      entry.folder = r.folder as string | null;
    }
    if (r.new_name !== undefined) {
      if (r.new_name !== null && typeof r.new_name !== "string") {
        return [];
      }
      entry.newName = r.new_name as string | null;
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------- mark_image

/**
 * Ported from `exec_tool`'s `"mark_image"` arm. Real: the image lookup and the
 * CHG-17 already-marked reuse. Labelled `NOT_IMPLEMENTED`: the grounding pass
 * itself — see the module doc's "THE ONE HONEST GAP".
 */
export function execMarkImage(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { boxes: unknown }
): OrganizeToolOutcome {
  const imageName = asString(args.image_name).toLowerCase();

  let id: string;
  let realName: string;
  try {
    [id, realName] = findImageLike(db, imageName);
  } catch (e) {
    return fail(errMessage(e));
  }

  // CHG-17: if this image was already grounded this turn, don't run a second
  // multi-GB vision pass — reuse the existing boxes.
  const existing = effects.boxes;
  if (typeof existing === "object" && existing !== null) {
    if ((existing as Record<string, unknown>).fileId === id) {
      return ok(`The image "${realName}" is already marked.`);
    }
  }

  return notImplemented(
    `mark_image found "${realName}", but the vision grounding pass — ollama.rs's model ` +
      "listing and vision pick, the privacy-door check, image preparation, and " +
      "ground_prepared_image — has no Electron port yet, so no image was marked — Batch D"
  );
}

// --------------------------------------------------------------- create_file

/**
 * `commands/artifact.rs`'s `Artifact::commit`, narrowed to exactly what
 * `create_file`'s two branches use (no `.indexed_as()`, no `.from_files()`, no
 * `.by()`): stage → read the cancel token → commit.
 *
 * THE CANCEL CHECK SITS BETWEEN STAGING AND COMMITTING, and the flag is read
 * HERE rather than by the caller, because that is the whole reason the funnel
 * has this shape. Rust's own comment: "Checking earlier would leave a window
 * in which a Stop is honoured everywhere except the write." A flag snapshotted
 * before `stageArtifact` ran would miss a Stop pressed during the staging
 * write itself — which is why {@link CreateFileOpts.cancel} carries the live
 * flag object rather than a boolean.
 *
 * Discarding is best-effort on both paths — Rust writes `let _ =
 * db::discard_staged(...)`, and the sweep on the next room open is the real
 * backstop — so a failing discard must not replace the accurate error the
 * caller is about to be told with a database complaint about cleanup.
 *
 * Throws exactly where `Artifact::commit` returns `Err`: an empty, nameless or
 * oversized artifact (`stageArtifact`'s own validation), a cancelled write, or
 * a failed commit.
 */
function commitArtifact(
  db: Database.Database,
  name: string,
  mime: string,
  content: string,
  provenance: Provenance,
  cancel: { load(): boolean } | null | undefined
): { meta: FileMeta; versioned: boolean } {
  const staged = stageArtifact(db, name, mime, Buffer.from(content, "utf8"), content, provenance);
  if (cancel?.load() ?? false) {
    discardQuietly(db, staged.id);
    throw new Error(`Stopped before "${staged.name}" was saved — nothing was written to the room.`);
  }
  try {
    const [meta, versioned] = commitStaged(db, staged.id);
    return { meta, versioned };
  } catch (e) {
    discardQuietly(db, staged.id);
    throw e;
  }
}

/** `let _ = db::discard_staged(conn, &id)` — see {@link commitArtifact}. */
function discardQuietly(db: Database.Database, stagingId: string): void {
  try {
    discardStaged(db, stagingId);
  } catch {
    // Best-effort by design; the staged-artifact sweep is the backstop.
  }
}

/**
 * `commands/files.rs`'s `store_file_bytes`: snapshot the file's CURRENT bytes
 * into version history tagged with `cause`, then overwrite them.
 *
 * ONE WRITE, not two, and that is load-bearing rather than tidy. Rust's own
 * comment: taken separately, a failed overwrite (a blob past SQLite's ceiling,
 * a full disk) still cut a version — the file was unchanged, its history had
 * gained a duplicate of the current bytes, and at the ten-unpinned-version
 * window the oldest snapshot was evicted to make room for it, while the caller
 * was told nothing had been saved.
 *
 * A local copy for the same reason `recBridge.ts` already carries one: there
 * is no `files.ts`-level port of this two-call pairing to import, only the two
 * halves.
 */
function storeFileBytes(
  db: Database.Database,
  id: string,
  bytes: Buffer,
  text: string | null,
  cause: string
): void {
  inTransaction(db, () => {
    snapshotFileVersion(db, id, cause);
    updateFileContent(db, id, bytes, text);
  });
}

/**
 * What `execCreateFile` needs beyond `db`/`args`/`effects`, grouped so the
 * arm's signature stays readable. Mirrors `execTool.ts`'s `ExecToolDeps`
 * fields of the same names.
 */
export interface CreateFileOpts {
  /** `turn.map(|t| t.run_id())` — the run this write belongs to, recorded in
   * the file's provenance so History can say which answer produced it.
   * `undefined`/`null` both mean "no run behind this call", which is Rust's
   * own `turn: None` path (a tool dispatched by the persistent room bridge
   * runs behind no ask) rather than a gap this port introduces. */
  runId?: string | null;
  /** The run's Stop flag, read once immediately before the write — see
   * {@link commitArtifact} for why the live object rather than a boolean. */
  cancel?: { load(): boolean } | null;
  emit?: EmitFn;
}

/** Ported from `exec_tool`'s `"create_file"` arm. */
export function execCreateFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  opts: CreateFileOpts = {}
): OrganizeToolOutcome {
  const rawName = typeof args.name === "string" ? args.name : "AI note";
  const content = asString(args.content);
  const { cancel, emit, runId } = opts;

  const provenance = (): Provenance => {
    const p: Provenance = { tool: "create_file" };
    if (runId !== undefined && runId !== null) {
      p.runId = runId;
    }
    return p;
  };

  // Wave 1b (idea 10): the canonical scratch pad is get-or-create. Every name
  // resolver returns the NEWEST match, so a duplicate "Scratch pad.md" would
  // silently shadow the real pad (and its notes) for the chip and every future
  // agent edit — redirect a create onto the existing pad as a normal versioned
  // overwrite.
  if (isScratchPadName(rawName)) {
    const existing = fileByExactName(db, SCRATCH_PAD_NAME);
    if (existing !== null) {
      // ART-1: this is the one generated write that CANNOT go through the
      // staging funnel. The pad is get-or-create over any source, so the
      // funnel's "never version a person's file" rule would step aside to
      // "Scratch pad (2).md" for a pad the user made — the exact shadowing
      // this branch exists to prevent. The funnel's other two guarantees still
      // hold here, by hand, because the reasons for them do not change:
      //
      //   * an empty rewrite is refused. `content` defaults to "" when the
      //     model omits it, and blanking the shared pad on the strength of a
      //     missing argument is the app throwing the user's notes away and
      //     reporting a successful write.
      //   * the Stop is read before the write, not after.
      if (content.trim() === "") {
        return fail(
          `Nothing was generated for "${existing.name}" — it was left as it was. ` +
            "(An empty pad would look like finished work.)"
        );
      }
      if (cancel?.load() ?? false) {
        return fail(
          `Stopped before "${existing.name}" was rewritten — nothing was written to the room.`
        );
      }
      storeFileBytes(db, existing.id, Buffer.from(content, "utf8"), content, "AI edit");
      // The pad's History says who rewrote it, like every other generated
      // state. `storeFileBytes` has already snapshotted the outgoing head
      // (carrying ITS provenance onto the version), so this only moves the
      // head's.
      setFileProvenance(db, existing.id, provenanceToJson(provenance()));
      emitSafely(emit, "room-files-changed", undefined);
      emitSafely(emit, "file-updated", existing.id);
      effects.wrote = true;
      return ok(
        `"${existing.name}" already exists — rewrote it instead of creating a duplicate. ` +
          "The previous notes are kept in History."
      );
    }
    // No pad yet: create it under the CANONICAL name (never the HTML-defaulted
    // variant), so the chip and prompt line resolve it.
    let created: { meta: FileMeta };
    try {
      created = commitArtifact(
        db,
        SCRATCH_PAD_NAME,
        noteMime(SCRATCH_PAD_NAME),
        content,
        provenance(),
        cancel
      );
    } catch (e) {
      return fail(errMessage(e));
    }
    emitSafely(emit, "room-files-changed", undefined);
    effects.wrote = true;
    return ok(`Created "${created.meta.name}" in the room.`);
  }

  // ADD-22 (HTML-first): a document with no explicit extension defaults to
  // HTML; body/plain content is wrapped in a styled standalone page (a no-op
  // when the model already returned a full HTML document).
  const name = extensionOf(rawName) === "" ? `${rawName}.html` : rawName;
  const finalContent = extensionOf(name) === "html" ? htmlDocument(name, content) : content;

  // ART-1: the agent's own write goes through the staging funnel like every
  // other generated artifact. Two consequences the model is told about below:
  // a Stop pressed while it was writing lands BEFORE the commit, and asking
  // for the same document twice versions it instead of leaving two files with
  // the same name.
  let written: { meta: FileMeta; versioned: boolean };
  try {
    written = commitArtifact(db, name, noteMime(name), finalContent, provenance(), cancel);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  effects.wrote = true;
  return ok(
    written.versioned
      ? `"${written.meta.name}" already existed — rewrote it instead of creating a duplicate. ` +
          "The previous version is kept in History."
      : `Created "${written.meta.name}" in the room.`
  );
}

// --------------------------------------------------------------- rename_file

/** Ported from `exec_tool`'s `"rename_file"` arm. */
export function execRenameFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn
): OrganizeToolOutcome {
  const name = asString(args.name);
  const newName = asString(args.new_name).trim();
  if (newName === "") {
    return fail("new_name is required.");
  }

  let id: string;
  let realName: string;
  try {
    // `_qualified`: `list_room_files` prints a filed document as
    // "Invoices/q3.pdf", so that string has to work here. The plain matcher
    // searches the name column alone and rejected the exact text it had just
    // shown.
    [id, realName] = findFileLikeQualified(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }

  // Keep the original extension if the model dropped it.
  let finalName: string;
  if (extensionOf(newName) !== "") {
    finalName = newName;
  } else {
    const ext = extensionOf(realName);
    finalName = ext === "" ? newName : `${newName}.${ext}`;
  }

  try {
    renameFile(db, id, finalName);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "file-updated", id);
  effects.wrote = true;
  return ok(`Renamed "${realName}" to "${finalName}".`);
}

// ------------------------------------------------------------ set_in_library

/**
 * Ported from `exec_tool`'s `"set_in_library"` arm.
 *
 * Promotion is an ACT the agent reports, not a side effect it performs.
 * `effects.wrote` marks the room changed, which is what the honesty gate reads
 * before it lets a reply claim to have organised anything; the returned
 * sentence says what actually changed — including that the object stayed where
 * it was, because "added to Library" alone reads like a move.
 *
 * `assistant-organized` is the other half, and it is a SEPARATE event from
 * `room-files-changed` on purpose. That one says the list is stale; this one
 * says who changed what, which is the only form in which Activity can carry
 * it.
 */
export function execSetInLibrary(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn
): OrganizeToolOutcome {
  const name = asString(args.name);
  const linked = asBoolDefault(args.in_library, true);

  let id: string;
  let realName: string;
  try {
    [id, realName] = findFileLikeQualified(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }
  try {
    setLibraryVisibility(db, id, linked);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  emitSafely(emit, "assistant-organized", { id, name: realName, linked });
  effects.wrote = true;
  return ok(
    linked
      ? `Added "${realName}" to the Library. It is still in its own section, and no copy was made.`
      : `Removed "${realName}" from the Library. The object itself is untouched and still in its own section.`
  );
}

// ----------------------------------------------------------------- move_file

/** The vocabulary that means "the top level" rather than a folder — the same
 * words `organize.ts`'s own (private) copy accepts. Re-spelled rather than
 * shared; see the module doc. */
const TOP_LEVEL_WORDS = ["none", "top", "top level", "root", "/"];

function meansTopLevel(name: string): boolean {
  const trimmed = name.trim().toLowerCase();
  return trimmed === "" || TOP_LEVEL_WORDS.includes(trimmed);
}

/** Ported from `exec_tool`'s `"move_file"` arm. */
export function execMoveFile(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn
): OrganizeToolOutcome {
  const name = asString(args.name);
  const folder = asString(args.folder).trim();

  let id: string;
  let realName: string;
  try {
    // Same round-trip fix as `rename_file` above.
    [id, realName] = findFileLikeQualified(db, name);
  } catch (e) {
    return fail(errMessage(e));
  }

  let whereTo: string;
  try {
    // Get-or-create is deliberate: "file this under Invoices" before an
    // Invoices folder exists is what the request means. Everything from
    // resolving the destination to the move itself shares one catch, because
    // Rust `?`-propagates all three of these calls into the same `Err` — a
    // folder that cannot be listed or created is a refusal the model can read,
    // never an exception out of the dispatch.
    let folderId: string | null;
    if (meansTopLevel(folder)) {
      folderId = null;
      whereTo = "the top level";
    } else {
      const lower = folder.toLowerCase();
      const existing = listFolders(db).find((f) => f.name.toLowerCase() === lower);
      folderId = existing !== undefined ? existing.id : createFolder(db, folder).id;
      whereTo = `"${folder}"`;
    }
    moveFileToFolder(db, id, folderId);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  effects.wrote = true;
  return ok(`Moved "${realName}" to ${whereTo}.`);
}

// ------------------------------------------------------------ organize_files

/** Ported from `exec_tool`'s `"organize_files"` arm. */
export function execOrganizeFiles(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn
): OrganizeToolOutcome {
  const entries = parseOrganizeEntries(args.files);
  const make = parseStringArray(args.make_folders);
  const remove = parseStringArray(args.remove_folders);
  const dryRun = asBoolDefault(args.dry_run, false);

  if (entries.length === 0 && make.length === 0 && remove.length === 0) {
    // Refuse rather than reporting a cheerful nothing: an empty plan is a
    // model that misread the schema, and "done!" over it is precisely the
    // false completion `react_verify` exists for.
    return fail("organize_files needs at least one entry in files, make_folders or remove_folders.");
  }

  let report: OrganizeReport;
  try {
    report = organize(db, entries, make, remove, dryRun);
  } catch (e) {
    return fail(errMessage(e));
  }

  if (!dryRun) {
    emitSafely(emit, "room-files-changed", undefined);
    // Only a run that CHANGED something counts as a write — a preview must not
    // arm the undo affordance for edits it never made, and a plan that matched
    // nothing must not either.
    //
    // `||=`, never `=`: the flag belongs to the whole TURN, and a plan that
    // matched nothing used to erase an earlier tool's real write — so a
    // truthful "I created plan.md and tidied up" was handed the "no file was
    // actually changed" correction.
    effects.wrote ||=
      report.moved.length > 0 ||
      report.renamed.length > 0 ||
      report.foldersMade.length > 0 ||
      report.foldersRemoved.length > 0;
  }
  return ok(organizeSentence(report, dryRun));
}

// --------------------------------------------------------------- trash_files

/** Ported from `exec_tool`'s `"trash_files"` arm. */
export function execTrashFiles(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn
): OrganizeToolOutcome {
  const names = parseStringArray(args.names);
  if (names.length === 0) {
    return fail("trash_files needs at least one file name.");
  }

  const [report, misses] = trashNamed(db, names);
  emitSafely(emit, "room-files-changed", undefined);
  // `||=` for the same reason `organize_files` uses it: a name that matched
  // nothing must not un-say an earlier write in this turn.
  effects.wrote ||= bulkReportChangedAnything(report);

  let out = bulkReportSentence(report, "moved to the trash");
  if (misses.length > 0) {
    out += ` Not found: ${misses.map((m) => `"${m.name}"`).join(", ")}.`;
  }
  // Name the way back, every time. The user did not press this button, so the
  // sentence they read has to carry the undo.
  out += " They are recoverable from Library → Trash.";
  return ok(out);
}

// --------------------------------------------------------------- merge_files

/** Ported from `exec_tool`'s `"merge_files"` arm. */
export function execMergeFiles(
  db: Database.Database,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn
): OrganizeToolOutcome {
  const names = parseStringArray(args.names);
  const into = asString(args.into);
  const headings = asBoolDefault(args.headings, true);
  const trashSources = asBoolDefault(args.trash_sources, false);

  let receipt: string;
  try {
    [, receipt] = merge(db, names, into, headings, trashSources);
  } catch (e) {
    return fail(errMessage(e));
  }
  emitSafely(emit, "room-files-changed", undefined);
  effects.wrote = true;
  return ok(receipt);
}

// ------------------------------------------------------ workspace live paths

async function writeWorkspaceGenerated(
  db: Database.Database,
  workspace: WorkspaceService,
  desiredName: string,
  mime: string,
  content: string,
  provenance: Provenance,
  cancel?: { load(): boolean } | null,
): Promise<{ meta: FileMeta; versioned: boolean }> {
  const bytes = Buffer.from(content, "utf8");
  const staged = stageArtifact(db, desiredName, mime, bytes, content, provenance);
  if (cancel?.load() ?? false) {
    discardQuietly(db, staged.id);
    throw new Error(`Stopped before "${staged.name}" was saved — nothing was written to the room.`);
  }
  try {
    const existing = db.prepare(
      `SELECT id, content_sha256 FROM files
       WHERE source = 'generated' AND storage_kind = 'workspace' AND trashed_at IS NULL
         AND (lower(artifact_key) = lower(?)
              OR (artifact_key IS NULL AND lower(name) = lower(?)))
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).get(staged.name, staged.name) as { id: string; content_sha256: string | null } | undefined;
    let id: string;
    let versioned: boolean;
    if (existing !== undefined) {
      await workspace.snapshotVersion(existing.id, "AI regenerated");
      await workspace.writeAtomic(existing.id, Readable.from([bytes]), existing.content_sha256 ?? undefined);
      setFileExtractedText(db, existing.id, content);
      id = existing.id;
      versioned = true;
    } else {
      const entry = await workspace.createFile(availableName(db, staged.name), Readable.from([bytes]), "generated");
      setFileExtractedText(db, entry.fileId, content);
      id = entry.fileId;
      versioned = false;
    }
    db.transaction(() => {
      db.prepare("UPDATE files SET mime_type = ?, provenance = ?, artifact_key = ? WHERE id = ?")
        .run(mime, provenanceToJson(provenance), staged.name, id);
      discardStaged(db, staged.id);
    })();
    return { meta: getFileMeta(db, id), versioned };
  } catch (error) {
    discardQuietly(db, staged.id);
    throw error;
  }
}

export async function execCreateFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  opts: CreateFileOpts = {},
): Promise<OrganizeToolOutcome> {
  const rawName = typeof args.name === "string" ? args.name : "AI note";
  const content = asString(args.content);
  const provenance: Provenance = { tool: "create_file" };
  if (opts.runId !== undefined && opts.runId !== null) provenance.runId = opts.runId;
  try {
    if (isScratchPadName(rawName)) {
      const existing = fileByExactName(db, SCRATCH_PAD_NAME);
      if (existing !== null) {
        if (content.trim() === "") return fail(`Nothing was generated for "${existing.name}" — it was left as it was.`);
        if (opts.cancel?.load() ?? false) {
          return fail(`Stopped before "${existing.name}" was rewritten — nothing was written to the room.`);
        }
        const row = db.prepare("SELECT content_sha256 FROM files WHERE id = ?")
          .get(existing.id) as { content_sha256: string | null };
        await workspace.snapshotVersion(existing.id, "AI edit");
        await workspace.writeAtomic(existing.id, Readable.from([Buffer.from(content)]), row.content_sha256 ?? undefined);
        setFileExtractedText(db, existing.id, content);
        setFileProvenance(db, existing.id, provenanceToJson(provenance));
        effects.wrote = true;
        emitSafely(opts.emit, "room-files-changed", undefined);
        emitSafely(opts.emit, "file-updated", existing.id);
        return ok(`"${existing.name}" already exists — rewrote it instead of creating a duplicate. The previous notes are kept in History.`);
      }
    }
    const name = isScratchPadName(rawName)
      ? SCRATCH_PAD_NAME
      : extensionOf(rawName) === "" ? `${rawName}.html` : rawName;
    const finalContent = extensionOf(name) === "html" ? htmlDocument(name, content) : content;
    const written = await writeWorkspaceGenerated(db, workspace, name, noteMime(name), finalContent, provenance, opts.cancel);
    effects.wrote = true;
    emitSafely(opts.emit, "room-files-changed", undefined);
    return ok(written.versioned
      ? `"${written.meta.name}" already existed — rewrote it instead of creating a duplicate. The previous version is kept in History.`
      : `Created "${written.meta.name}" in the room.`);
  } catch (error) {
    return fail(errMessage(error));
  }
}

function workspaceRow(db: Database.Database, id: string): { relativePath: string; hash: string | null } {
  const row = db.prepare(
    "SELECT relative_path, content_sha256 FROM files WHERE id = ? AND storage_kind = 'workspace' AND trashed_at IS NULL",
  ).get(id) as { relative_path: string; content_sha256: string | null } | undefined;
  if (row === undefined) throw new Error("That normal workspace file is no longer available.");
  return { relativePath: row.relative_path, hash: row.content_sha256 };
}

export async function execRenameFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const newName = asString(args.new_name).trim();
  if (newName === "") return fail("new_name is required.");
  try {
    const [id, realName] = findFileLikeQualified(db, asString(args.name));
    const row = workspaceRow(db, id);
    const finalName = extensionOf(newName) === ""
      ? (extensionOf(realName) === "" ? newName : `${newName}.${extensionOf(realName)}`)
      : newName;
    const parent = path.posix.dirname(row.relativePath);
    await workspace.move(id, parent === "." ? finalName : path.posix.join(parent, finalName), row.hash ?? undefined);
    effects.wrote = true;
    emitSafely(emit, "room-files-changed", undefined);
    emitSafely(emit, "file-updated", id);
    return ok(`Renamed "${realName}" to "${finalName}".`);
  } catch (error) { return fail(errMessage(error)); }
}

export async function execMoveFileWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  try {
    const [id, realName] = findFileLikeQualified(db, asString(args.name));
    const row = workspaceRow(db, id);
    const folder = asString(args.folder).trim();
    const destination = meansTopLevel(folder) ? realName : path.posix.join(folder, realName);
    await workspace.move(id, destination, row.hash ?? undefined);
    effects.wrote = true;
    emitSafely(emit, "room-files-changed", undefined);
    return ok(`Moved "${realName}" to ${meansTopLevel(folder) ? "the top level" : `"${folder}"`}.`);
  } catch (error) { return fail(errMessage(error)); }
}

export async function execTrashFilesWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const names = parseStringArray(args.names);
  if (names.length === 0) return fail("trash_files needs at least one file name.");
  const trashed: string[] = [];
  const missed: string[] = [];
  for (const name of names) {
    try {
      const [id, realName] = findFileLikeQualified(db, name);
      const row = workspaceRow(db, id);
      await workspace.trash(id, row.hash ?? undefined);
      trashed.push(realName);
    } catch { missed.push(name); }
  }
  effects.wrote ||= trashed.length > 0;
  emitSafely(emit, "room-files-changed", undefined);
  let text = trashed.length === 0 ? "Nothing was moved to the trash." : `Moved ${trashed.map((n) => `"${n}"`).join(", ")} to the trash.`;
  if (missed.length > 0) text += ` Not found: ${missed.map((n) => `"${n}"`).join(", ")}.`;
  return ok(`${text} They are recoverable from Library → Trash.`);
}

export async function execOrganizeFilesWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const entries = parseOrganizeEntries(args.files);
  const make = parseStringArray(args.make_folders);
  const remove = parseStringArray(args.remove_folders);
  const dryRun = asBoolDefault(args.dry_run, false);
  if (entries.length === 0 && make.length === 0 && remove.length === 0) {
    return fail("organize_files needs at least one entry in files, make_folders or remove_folders.");
  }
  const report: OrganizeReport = {
    moved: [], renamed: [], foldersMade: [], foldersRemoved: [], failed: [], capped: 0,
  };
  // WorkspaceService creates destination directories as part of a controlled
  // file move. Empty-folder-only changes remain explicit failures instead of
  // bypassing the service with raw filesystem calls.
  for (const folder of make) {
    if (!entries.some((entry) => entry.folder?.trim().toLowerCase() === folder.trim().toLowerCase())) {
      report.failed.push({ name: folder, error: "empty workspace folders are not created by a file tool" });
    }
  }
  for (const folder of remove) {
    report.failed.push({ name: folder, error: "folder removal needs the workspace directory service" });
  }
  for (const entry of entries) {
    try {
      const [id, realName] = findFileLikeQualified(db, entry.name ?? "");
      const row = workspaceRow(db, id);
      let finalName = realName;
      if (entry.newName !== undefined && entry.newName !== null) {
        const wanted = entry.newName.trim();
        if (wanted !== "") {
          finalName = extensionOf(wanted) === "" && extensionOf(realName) !== ""
            ? `${wanted}.${extensionOf(realName)}`
            : wanted;
          report.renamed.push(`"${realName}" → "${finalName}"`);
        }
      }
      const currentParent = path.posix.dirname(row.relativePath);
      const targetParent = entry.folder === undefined || entry.folder === null
        ? currentParent
        : meansTopLevel(entry.folder) ? "." : entry.folder.trim();
      const destination = targetParent === "." ? finalName : path.posix.join(targetParent, finalName);
      if (destination !== row.relativePath) {
        if (entry.folder !== undefined && entry.folder !== null) {
          report.moved.push(`"${realName}" → ${targetParent === "." ? "top level" : `"${targetParent}"`}`);
        }
        if (!dryRun) await workspace.move(id, destination, row.hash ?? undefined);
      }
    } catch (error) {
      report.failed.push({ name: entry.name ?? "", error: errMessage(error) });
    }
  }
  if (!dryRun) {
    effects.wrote ||= report.moved.length > 0 || report.renamed.length > 0;
    emitSafely(emit, "room-files-changed", undefined);
  }
  return ok(organizeSentence(report, dryRun));
}

export async function execMergeFilesWorkspace(
  db: Database.Database,
  workspace: WorkspaceService,
  args: Record<string, unknown>,
  effects: { wrote: boolean },
  emit?: EmitFn,
): Promise<OrganizeToolOutcome> {
  const names = parseStringArray(args.names);
  const resolved: Array<{ id: string; name: string; text: string }> = [];
  for (const name of names) {
    try {
      const [id, realName] = findFileLikeQualified(db, name);
      const text = getFileExtractedText(db, id);
      if (text?.trim()) resolved.push({ id, name: realName, text: text.trim() });
    } catch { /* receipt below gives the usable count */ }
  }
  if (resolved.length < 2) return fail("merge_files needs at least two files with readable text.");
  const headings = asBoolDefault(args.headings, true);
  const content = resolved.map((file) => headings ? `## ${file.name}\n\n${file.text}` : file.text).join("\n\n");
  const requested = asString(args.into).trim();
  const name = availableName(db, requested === "" ? "Merged notes.md" : extensionOf(requested) === "" ? `${requested}.md` : requested);
  try {
    const entry = await workspace.createFile(name, Readable.from([Buffer.from(content)]), "generated");
    setFileExtractedText(db, entry.fileId, content);
    if (asBoolDefault(args.trash_sources, false)) {
      for (const file of resolved) {
        const row = workspaceRow(db, file.id);
        await workspace.trash(file.id, row.hash ?? undefined);
      }
    }
    effects.wrote = true;
    emitSafely(emit, "room-files-changed", undefined);
    return ok(`Merged ${resolved.length} files into "${name}" (${[...content].length} characters)` +
      (asBoolDefault(args.trash_sources, false) ? " and moved the originals to the trash." : " — the originals are untouched."));
  } catch (error) { return fail(errMessage(error)); }
}
