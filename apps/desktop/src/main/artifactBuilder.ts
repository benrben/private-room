/**
 * ART-1: the artifact write funnel's caller-facing builder. Ported from
 * `src-tauri/src/commands/artifact.rs` (346 lines, read in full, including
 * its `#[cfg(test)] mod tests`) — the `Artifact`/`Written` pair that sits on
 * top of `db-host/artifacts.ts`'s already-ported `stageArtifact`/
 * `commitStaged`/`discardStaged` funnel.
 *
 * Genuinely missing dependency, not a re-port: `commands/jobs/file_pass.rs`'s
 * `publish` step builds every fresh deliverable through
 * `Artifact::new(..).by(..).during_run(..).from_files(..).cancel_with(..).commit(..)`,
 * and nothing in this migration had ported that builder yet — `artifacts.ts`
 * itself only ports the DB-level staging primitives, not this fluent
 * caller-facing shape. New `_b`-suffixed file, not a change to any file this
 * batch did not create.
 *
 * SCOPED TO WHAT `file_pass.rs` ACTUALLY CALLED AT THE TIME: `new`, `by`,
 * `duringRun`, `fromFiles`, `cancelWith`, `commit`. `via_tool`/`cancel_maybe`
 * are still unported — nothing in this tree has called for them yet.
 *
 * EXTENDED, as this file's own doc above invited, by the
 * `chat_commands/generate.rs` batch (2026-08): {@link Artifact.indexedAs}
 * (`indexed_as` — index a drawing's derived text instead of its raw JSON,
 * needed by `#sketch`) and the static {@link Artifact.note} (the
 * extension-defaulting Markdown constructor, needed by `#minutes`/
 * `#to-sheet`/`#translate`). Both are ported verbatim from `artifact.rs`.
 * `commit`'s call to `stageArtifact` now passes `indexedText ?? content` as
 * the separately-indexed `text` argument — previously always `content` twice
 * over, which was simply what `indexedAs` had no caller to exercise yet.
 *
 * Why the check-then-commit split matters, verbatim from the Rust doc: "The
 * cancel check sits between staging and committing on purpose. Checking
 * earlier would leave a window in which a Stop is honoured everywhere except
 * the write; checking after the commit could only ever report a file that is
 * already in the library as if it were not."
 */

import type Database from "better-sqlite3-multiple-ciphers";
import type { CancelFlag } from "./cancel.js";
import {
  commitStaged,
  discardStaged,
  provenanceToJson,
  stageArtifact,
  type Provenance,
  type Staged,
} from "./db-host/artifacts.js";
import type { FileMeta } from "./db-host/files.js";
import { availableName, getFileMeta, setFileExtractedText } from "./db-host/files.js";
import { noteMime } from "./docsHtml.js";
import { Readable } from "node:stream";
import type { WorkspaceService } from "./workspace/workspaceService.js";

/** `extraction::extension_of` — a bare local copy, matching `docsHtml.ts`'s
 * own (its module doc explains why: `extraction::extension_of` is external to
 * every Rust file that has needed it so far, and this rewrite has no
 * `extraction.ts` yet for either copy to import instead). Used only to decide
 * whether {@link Artifact.note}'s name already carries an extension. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name;
  const idx = base.lastIndexOf(".");
  return idx <= 0 ? "" : base.slice(idx + 1).toLowerCase();
}

interface GeneratedArtifactRow {
  id: string;
  storage_kind: string;
}

interface WorkspaceArtifactWrite {
  id: string;
  versioned: boolean;
}

function cancelRequested(cancel: CancelFlag | null): boolean {
  return cancel !== null && cancel.load();
}

function discardStagedBestEffort(db: Database.Database, stagedId: string): void {
  try {
    discardStaged(db, stagedId);
  } catch {
    // The sweep on the next room open is the backstop.
  }
}

function throwStoppedBeforeSave(db: Database.Database, staged: Staged): never {
  discardStagedBestEffort(db, staged.id);
  throw new Error(`Stopped before "${staged.name}" was saved — nothing was written to the room.`);
}

function commitStagedOrDiscard(db: Database.Database, staged: Staged): Written {
  try {
    const [meta, versioned] = commitStaged(db, staged.id);
    return { meta, versioned };
  } catch (error) {
    discardStagedBestEffort(db, staged.id);
    throw error;
  }
}

function existingGeneratedArtifact(db: Database.Database, name: string): GeneratedArtifactRow | undefined {
  return db.prepare(
    `SELECT id, storage_kind FROM files
     WHERE source = 'generated' AND trashed_at IS NULL
       AND (lower(artifact_key) = lower(?)
            OR (artifact_key IS NULL AND lower(name) = lower(?)))
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).get(name, name) as GeneratedArtifactRow | undefined;
}

async function replaceGeneratedWorkspaceArtifact(
  workspace: WorkspaceService,
  existing: GeneratedArtifactRow,
  bytes: Buffer,
  text: string,
): Promise<string> {
  if (existing.storage_kind !== "workspace") {
    await workspace.materializeLiveBlobFile(existing.id);
  }
  const current = workspace.db.prepare("SELECT content_sha256 FROM files WHERE id = ?")
    .get(existing.id) as { content_sha256: string | null };
  await workspace.snapshotVersion(existing.id, "AI regenerated");
  await workspace.writeAtomic(existing.id, Readable.from([bytes]), current.content_sha256 ?? undefined);
  setFileExtractedText(workspace.db, existing.id, text);
  return existing.id;
}

async function createGeneratedWorkspaceArtifact(
  workspace: WorkspaceService,
  name: string,
  bytes: Buffer,
  text: string,
): Promise<string> {
  const free = availableName(workspace.db, name);
  const entry = await workspace.createFile(free, Readable.from([bytes]), "generated");
  setFileExtractedText(workspace.db, entry.fileId, text);
  return entry.fileId;
}

async function writeWorkspaceArtifact(
  workspace: WorkspaceService,
  name: string,
  bytes: Buffer,
  text: string,
): Promise<WorkspaceArtifactWrite> {
  const existing = existingGeneratedArtifact(workspace.db, name);
  if (existing !== undefined) {
    return { id: await replaceGeneratedWorkspaceArtifact(workspace, existing, bytes, text), versioned: true };
  }
  return { id: await createGeneratedWorkspaceArtifact(workspace, name, bytes, text), versioned: false };
}

function finishWorkspaceArtifact(
  db: Database.Database,
  staged: Staged,
  id: string,
  mime: string,
  provenance: string | null,
): void {
  db.transaction(() => {
    db.prepare("UPDATE files SET mime_type = ?, provenance = ?, artifact_key = ? WHERE id = ?")
      .run(mime, provenance, staged.name, id);
    discardStaged(db, staged.id);
  })();
}

/** What a committed artifact turned out to be. `versioned` is true when this
 * write became a new version of an artifact that was already there. */
export interface Written {
  meta: FileMeta;
  versioned: boolean;
}

/** One AI-generated artifact on its way into the room. Built at the call
 * site, then {@link Artifact.commit}ted — there is no way to get generated
 * bytes into `files` without going through the staging step, which is the
 * point. Mirrors the Rust `Artifact<'a>` builder (a fluent, chainable API —
 * every setter returns `this`, matching Rust's `mut self -> Self`). */
export class Artifact {
  private readonly name: string;
  private readonly mime: string;
  private readonly content: string;
  private readonly prov: Provenance = {};
  private cancel: CancelFlag | null = null;
  private indexedText: string | null = null;

  /** An artifact with an explicit mime (a generated HTML page, a CSV). */
  constructor(name: string, mime: string, content: string) {
    this.name = name;
    this.mime = mime;
    this.content = content;
  }

  static new(name: string, mime: string, content: string): Artifact {
    return new Artifact(name, mime, content);
  }

  /** A generated note — Markdown by default, mime derived from the name. The
   * extension default lives here so every `#command` that writes a note
   * shares it rather than risking two callers disagreeing about what an
   * extension-less name means. Ported verbatim from `Artifact::note`. */
  static note(name: string, content: string): Artifact {
    const named = extensionOf(name) === "" ? `${name}.md` : name;
    return new Artifact(named, noteMime(named), content);
  }

  /** Index this artifact as `text` rather than as its own bytes — a `.sketch`
   * is a JSON document, and indexing that source would put coordinates and
   * colour names into search results and the model's retrieved context.
   * Ported verbatim from `Artifact::indexed_as`. */
  indexedAs(text: string): this {
    this.indexedText = text;
    return this;
  }

  /** Which agent or command produced it. */
  by(agent: string): this {
    this.prov.agent = agent;
    return this;
  }

  /** The run this write belongs to (an ask id, a job id). Optional because a
   * tool dispatched by the persistent room bridge runs behind no ask.
   *
   * `null` CLEARS rather than being ignored: Rust's `during_run` is an
   * unconditional `self.prov.run_id = run_id.map(str::to_string)`, so passing
   * `None` after a run id had been set removes it. Ignoring `null` instead
   * left a file credited to a run it did not come from — the one kind of
   * untruth this whole funnel exists to prevent. `delete` rather than
   * `= undefined` so the serialized provenance omits the key entirely,
   * matching `#[serde(skip_serializing_if = "Option::is_none")]`. */
  duringRun(runId: string | null): this {
    if (runId === null) {
      delete this.prov.runId;
    } else {
      this.prov.runId = runId;
    }
    return this;
  }

  /** The room files this artifact was made FROM — ids, never their contents. */
  fromFiles(ids: readonly string[]): this {
    this.prov.sourceFileIds = [...ids];
    return this;
  }

  /** The run's cancel flag. Read once, immediately before the commit. */
  cancelWith(flag: CancelFlag): this {
    this.cancel = flag;
    return this;
  }

  /**
   * Stage -> validate -> check the cancel token -> commit.
   *
   * The cancel check sits between staging and committing on purpose — see
   * this module's own doc comment for why.
   */
  commit(db: Database.Database): Written {
    const bytes = Buffer.from(this.content, "utf8");
    const staged = stageArtifact(db, this.name, this.mime, bytes, this.indexedText ?? this.content, this.prov);
    if (cancelRequested(this.cancel)) throwStoppedBeforeSave(db, staged);
    return commitStagedOrDiscard(db, staged);
  }

  /**
   * Commit an accepted artifact into a hybrid room. Staging and cancellation
   * remain private database state, but the accepted bytes become a normal
   * workspace file. Regenerating the same generated artifact replaces it only
   * after WorkspaceService has saved an encrypted history snapshot.
   */
  async commitToWorkspace(workspace: WorkspaceService): Promise<Written> {
    const db = workspace.db;
    const bytes = Buffer.from(this.content, "utf8");
    const text = this.indexedText ?? this.content;
    const staged = stageArtifact(db, this.name, this.mime, bytes, text, this.prov);
    if (cancelRequested(this.cancel)) throwStoppedBeforeSave(db, staged);
    try {
      const provenance = provenanceToJson(this.prov);
      const written = await writeWorkspaceArtifact(workspace, staged.name, bytes, text);
      finishWorkspaceArtifact(db, staged, written.id, this.mime, provenance);
      return { meta: getFileMeta(db, written.id), versioned: written.versioned };
    } catch (error) {
      discardStagedBestEffort(db, staged.id);
      throw error;
    }
  }
}
