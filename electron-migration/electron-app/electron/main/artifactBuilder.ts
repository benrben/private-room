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
  stageArtifact,
  type Provenance,
} from "./db-host/artifacts.js";
import type { FileMeta } from "./db-host/files.js";
import { noteMime } from "./docsHtml.js";

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
   * tool dispatched by the persistent room bridge runs behind no ask. */
  duringRun(runId: string | null): this {
    if (runId !== null) {
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
    if (this.cancel !== null && this.cancel.load()) {
      // Discarding is best-effort — the sweep on the next room open is the
      // backstop — but the REPORT must be exact: nothing was saved.
      try {
        discardStaged(db, staged.id);
      } catch {
        // best-effort, mirrors the Rust `let _ = db::discard_staged(..)`
      }
      throw new Error(
        `Stopped before "${staged.name}" was saved — nothing was written to the room.`
      );
    }
    try {
      const [meta, versioned] = commitStaged(db, staged.id);
      return { meta, versioned };
    } catch (err) {
      try {
        discardStaged(db, staged.id);
      } catch {
        // best-effort, mirrors the Rust `let _ = db::discard_staged(..)`
      }
      throw err;
    }
  }
}
