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
 * SCOPED TO WHAT `file_pass.rs` ACTUALLY CALLS: `new`, `by`, `duringRun`,
 * `fromFiles`, `cancelWith`, `commit`. The Rust struct also carries
 * `indexed_as` (index a drawing's derived text instead of its raw JSON),
 * `note` (the extension-defaulting Markdown constructor), `via_tool` and
 * `cancel_maybe` — none of which `file_pass.rs` uses, so none are ported
 * here. A future batch that needs one of those (the sketch/create pages,
 * ordinary tool-driven file writes) extends this file rather than
 * reinventing the funnel a second time.
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

  /** An artifact with an explicit mime (a generated HTML page, a CSV). */
  constructor(name: string, mime: string, content: string) {
    this.name = name;
    this.mime = mime;
    this.content = content;
  }

  static new(name: string, mime: string, content: string): Artifact {
    return new Artifact(name, mime, content);
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
    const staged = stageArtifact(db, this.name, this.mime, bytes, this.content, this.prov);
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
