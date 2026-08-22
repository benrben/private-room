/**
 * One run-id token hierarchy: cancellation as a TREE, not a flat map.
 *
 * Ported from `src-tauri/src/cancel.rs` (525 lines). Owner replacement #3,
 * 2026-08-03, with his binding decision attached: "cancelling a parent kills
 * every child AND blocks artifact writes".
 *
 * A run is not one flag: it spawns delegated specialists, background jobs,
 * studio builds and file passes, and each of those used to mint a fresh,
 * unrelated flag (or, in the agent-driven Studio's case, no flag at all).
 * Stop therefore reached the answer and left the work it had started
 * running, which then wrote its artifact into the room minutes after the
 * user was told the run had stopped.
 *
 * The tree fixes that with two rules and nothing else:
 *
 * 1. A child node holds its own flag and its parent holds a link to it, so
 *    cancelling any node walks DOWN and sets every flag beneath it.
 *    Downward and eager, not a parent-chain check on read, because the ~40
 *    places that already poll a bare flag (structured-generation options, a
 *    sidecar-cancellable loop, every job runner) must see the truth without
 *    knowing this module exists. {@link Node.flag} hands them exactly what
 *    they take today.
 * 2. NO CHILD COMMITS WITHOUT CHECKING ITS PARENT — {@link guardCommit},
 *    called immediately before the side effect. A side effect must be gated
 *    at the moment it is COMMITTED, not at the moment it was decided,
 *    because every earlier check guards a model call and the stretch after
 *    the last one is exactly where a Stop lands in practice.
 *
 * Privacy: a node carries a LABEL — "Flashcards", "this answer" — chosen by
 * the code that creates it, never room content. Ids stay opaque handles.
 *
 * =====================================================================
 * CRITICAL PORT DEVIATION — read this before creating a child anywhere
 * =====================================================================
 *
 * Rust's tree prunes itself for free: a parent holds only a `Weak<Node>` to
 * each child, and the child is OWNED by whatever is running it (the
 * `run_studio` call, the job runner's async block). The moment that owner's
 * `Arc` drops, the `Weak` can no longer upgrade and the next walk quietly
 * skips it. No epilogue has to remember to unregister anything.
 *
 * JavaScript has no equivalent free lunch. `WeakRef`/`FinalizationRegistry`
 * give NO TIMING GUARANTEE — the GC may run seconds or minutes after the
 * last strong reference disappears, or, absent memory pressure, not at all
 * before the process exits. Silently reusing a `WeakRef`-style scheme here
 * would make "a finished child leaves nothing to prune" true only
 * EVENTUALLY rather than on the next walk, and — worse — the Rust suite's
 * own `a_finished_child_leaves_nothing_behind_to_cancel` test would not
 * catch the gap: an assertion made microseconds after the child "finishes"
 * runs long before any GC pass, so it would pass whether or not pruning
 * ever happened. A green suite would prove nothing.
 *
 * So this port uses an EXPLICIT lifecycle: whatever creates a child node
 * (the TS equivalent of Rust's `let _done = run.child(...)` going out of
 * scope) MUST call {@link Node.dispose} on it when its own work finishes,
 * which unlinks it from its parent IMMEDIATELY and DETERMINISTICALLY. The
 * discipline is a `try`/`finally`, exactly like `sidecar.ts`'s `busy()`
 * guard is released:
 *
 * ```ts
 * const kid = parent.child("Flashcards");
 * try {
 *   await runTheBuild(kid.flag());
 * } finally {
 *   kid.dispose();
 * }
 * ```
 *
 * EVERY FUTURE BATCH THAT CREATES A CHILD NODE (studio builds, job runners,
 * file passes, delegated specialists) must remember this. Forgetting it does
 * not break cancellation — a leaked node still cancels correctly while it is
 * reachable — it leaks a FINISHED node in its parent's kids list, so
 * {@link Node.stoppedChildren} and {@link Node.cancel}'s report would
 * eventually claim a Stop reached work that had already finished honestly,
 * which is exactly the small lie this module exists to prevent.
 *
 * `dispose()` is about PRUNING finished work, not about the cancel walk —
 * the walk still needs every LIVE child reachable while it runs, which is
 * why `dispose()` only unlinks from the parent and never touches the flag.
 */

import type { StopReport } from "../shared/apiTypes.js";

// ------------------------------------------------------------------- flag

/**
 * The TS stand-in for `Arc<AtomicBool>`. Node is single-threaded, so there
 * is nothing to buy from real atomics (see `quitDoor.ts`'s identical
 * reasoning for its own plain fields); what the tree actually needs is
 * several owners observing the SAME mutable cell, and holding the same
 * object reference gives that for free — no `Arc::clone` step required.
 *
 * The three methods are named for the three `AtomicBool` operations the Rust
 * source uses, and mean exactly what those mean. In particular {@link swap}
 * returns the value the flag held BEFORE the call, which is what lets a
 * second Stop on an already-cancelled node correctly report "stopped
 * nothing"; a method named `set` that quietly returned the previous value
 * would be the kind of thing a later caller reads straight past.
 */
export class CancelFlag {
  private value = false;

  /** `AtomicBool::load` — what the many loops that poll a bare flag call,
   * and what {@link Node.flag} hands them. */
  load(): boolean {
    return this.value;
  }

  /** `AtomicBool::store` — what the room-lock / close drain does by hand to
   * every flag in the flat registries. */
  store(next: boolean): void {
    this.value = next;
  }

  /** `AtomicBool::swap` — set to `next` and return whatever the flag held
   * immediately before, so a caller can tell whether THIS call is the one
   * that actually flipped it. */
  swap(next: boolean): boolean {
    const previous = this.value;
    this.value = next;
    return previous;
  }
}

// ------------------------------------------------------------------- Node

/**
 * One node of a run's cancel tree: a flag the workers poll, a human label
 * for telling the user what was stopped, and links to the children this node
 * has started.
 *
 * See the module doc's CRITICAL PORT DEVIATION section for why those links
 * are plain (strong) references pruned by an explicit {@link Node.dispose}
 * rather than Rust's self-pruning `Weak` links.
 */
export class Node {
  private readonly labelValue: string;
  private readonly flagValue: CancelFlag;
  private readonly kids: Node[] = [];
  /** The parent this node is currently linked into: `null` for a root, and
   * `null` again once {@link dispose} has unlinked it — which is what makes
   * a second `dispose()` a no-op instead of a double-removal. */
  private parent: Node | null;

  private constructor(label: string, flag: CancelFlag, parent: Node | null) {
    this.labelValue = label;
    this.flagValue = flag;
    this.parent = parent;
  }

  /** A root: the run itself. */
  static root(label: string): Node {
    return Node.adopt(label, new CancelFlag());
  }

  /**
   * A root that reuses a flag someone else already made and handed out —
   * how a job whose flag is already in a flat registry joins the tree
   * without a second flag that could disagree with the first.
   */
  static adopt(label: string, flag: CancelFlag): Node {
    return new Node(label, flag, null);
  }

  /**
   * A child of this node. Cancelling `this` (or anything above it) cancels
   * the child; cancelling the child leaves `this` and its siblings running.
   */
  child(label: string): Node {
    return this.adoptChild(label, new CancelFlag());
  }

  /** A child around an existing flag — see {@link Node.adopt}. */
  adoptChild(label: string, flag: CancelFlag): Node {
    const kid = new Node(label, flag, this);
    this.kids.push(kid);
    // Born into an already-stopped parent. `cancel` sets its own flag BEFORE
    // it walks, so a child that registers after the walk has passed still
    // reads `true` here — that ordering is what closes the race, and this
    // line is what acts on it. Without it, the one child unlucky enough to
    // be created during the walk would be the one that writes an artifact
    // into a room the user has already stopped.
    if (this.cancelled()) {
      kid.cancel();
    }
    return kid;
  }

  /** The flag itself, for the many loops that poll a bare {@link CancelFlag}. */
  flag(): CancelFlag {
    return this.flagValue;
  }

  label(): string {
    return this.labelValue;
  }

  cancelled(): boolean {
    return this.flagValue.load();
  }

  /**
   * Stop this node and everything beneath it. Returns what THIS call
   * actually stopped, so the user can be told the truth: a node that was
   * already cancelled is not reported again (it was already stopped, and
   * saying so twice is a claim about this Stop that isn't true).
   */
  cancel(): StopReport {
    const stopped: string[] = [];
    this.cancelInto(stopped);
    return { stopped, known: true };
  }

  private cancelInto(out: string[]): void {
    // Flag first, then the walk — see `adoptChild`.
    if (!this.flagValue.swap(true)) {
      out.push(this.labelValue);
    }
    // Snapshot before recursing, exactly as the Rust version collects under
    // the lock and recurses outside it: a caller that reacts to its own
    // cancellation synchronously (by disposing, or by starting one more
    // child) must not be able to skip or duplicate a sibling mid-walk.
    for (const kid of [...this.kids]) {
      kid.cancelInto(out);
    }
  }

  /** The commit gate — see {@link guardCommit}. */
  guard(what: string): GuardResult {
    return guardCommit(this.flagValue, what);
  }

  /**
   * Labels of the still-live work BENEATH this node that is now stopped.
   *
   * For telling the user what a Stop actually reached, after the fact — the
   * transcript marker is written when the turn unwinds, not when Stop was
   * pressed, so it cannot use the {@link StopReport}. Work that had already
   * FINISHED (and been {@link dispose}d) is not listed: it unlinked its
   * node, and naming it would claim the Stop reached something it did not.
   */
  stoppedChildren(): string[] {
    const out: string[] = [];
    this.collectStoppedKids(out);
    return out;
  }

  private collectStoppedKids(out: string[]): void {
    for (const kid of this.kids) {
      if (kid.cancelled()) {
        out.push(kid.labelValue);
      }
      kid.collectStoppedKids(out);
    }
  }

  /**
   * THE EXPLICIT LIFECYCLE SEAM — see the module doc's CRITICAL PORT
   * DEVIATION section. Unlinks this node from its parent's kids list
   * immediately and deterministically, where Rust's owner would have dropped
   * its `Arc<Node>`. Call it in a `finally` around the work this node
   * represents, and never before that work has actually finished (a disposed
   * node no longer takes part in its former parent's cancel walk).
   *
   * A no-op on a root, and idempotent: the first call clears `parent`, so a
   * second finds nothing to unlink — it can never remove a like-labelled
   * sibling by mistake, because the removal is by identity, not by label.
   */
  dispose(): void {
    const parent = this.parent;
    if (parent === null) {
      return;
    }
    this.parent = null;
    const index = parent.kids.indexOf(this);
    if (index !== -1) {
      parent.kids.splice(index, 1);
    }
  }
}

// --------------------------------------------------------- StopReport helpers

/**
 * The children — everything except the run the user pressed Stop on. `null`
 * when the Stop reached nothing but the run itself, which is the ordinary
 * case and deserves no extra sentence.
 *
 * `StopReport` is reused verbatim from `apiTypes.ts` (already the exact
 * camelCase `{stopped, known}` shape the Rust struct serialized to), so this
 * is a standalone function rather than a method on the `impl StopReport`
 * block's TS equivalent.
 */
export function alsoStopped(report: StopReport): string | null {
  const kids = report.stopped.slice(1);
  return kids.length === 0 ? null : kids.join(", ");
}

// ------------------------------------------------------------------- guard

/** The `Result<(), String>` stand-in `guardCommit`/{@link Node.guard} return. */
export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The one check every write-side effect makes IMMEDIATELY before it commits.
 *
 * `what` names the artifact in the user's words ("the flashcards page"), so
 * a refusal reads as a fact about their room rather than as an internal
 * error. Callers whose protocol already has a stop sentinel (a file-pass
 * runner's own "STOPPED", which parks the job for Resume) use
 * {@link stopped} instead and keep their sentinel — the rule is WHERE the
 * check happens, not what it returns.
 */
export function guardCommit(flag: CancelFlag, what: string): GuardResult {
  if (flag.load()) {
    return { ok: false, error: `Stopped — ${what} was not saved.` };
  }
  return { ok: true };
}

/** The same rule for callers that must return their own sentinel. */
export function stopped(flag: CancelFlag): boolean {
  return flag.load();
}

/** What a `StopReport` calls work that lives in the flat registry only,
 * which stores a flag and no label. */
export const UNLABELLED = "the work you stopped";

// ---------------------------------------------------------------- registry

/**
 * The minimal slice of the (not-yet-ported) `AppState` this module needs:
 * the two flat run-id -> flag registries every long-running loop already
 * polls, plus the by-id tree registry {@link childOfRun}/{@link cancelId}/
 * {@link forget} use to find a run's node. No `Mutex` wrapper — Node has no
 * threads to guard against, so a plain `Map` is the whole story.
 *
 * `cancelTree` holds STRONG references, unlike Rust's
 * `HashMap<String, Weak<Node>>` — see the module doc's CRITICAL PORT
 * DEVIATION section. That is safe here specifically because every path that
 * inserts ({@link registerRun}) has a matching explicit removal path
 * ({@link forget}), which `cancel.rs` already documents as "the eager half"
 * of its own `Weak` decay; this port makes that eager half the ONLY half
 * rather than a belt-and-braces duplicate of a `WeakRef` backstop whose
 * timing nothing here could actually test. A later batch that ports the real
 * `AppState` should have its type satisfy (or replace) this shape rather
 * than inventing a second, divergent notion of "the app's cancel state".
 */
export interface CancelState {
  cancels: Map<string, CancelFlag>;
  jobCancels: Map<string, CancelFlag>;
  cancelTree: Map<string, Node>;
}

/** A fresh, empty registry — the TS equivalent of `AppState::default()` for
 * callers and tests that only care about the cancel tree. */
export function createCancelState(): CancelState {
  return { cancels: new Map(), jobCancels: new Map(), cancelTree: new Map() };
}

/**
 * Register a run's root node: the flag goes into the flat registry every
 * existing drain already flips, the node into the tree so children can find
 * their parent by run id. The caller keeps the returned `Node` for the run's
 * lifetime; a later batch's `CancelGuard` equivalent removes both entries
 * when it returns (see {@link forget}).
 */
export function registerRun(state: CancelState, runId: string, label: string): Node {
  const node = Node.root(label);
  state.cancels.set(runId, node.flag());
  remember(state, runId, node);
  return node;
}

/** Put a node in the by-id tree registry. */
export function remember(state: CancelState, id: string, node: Node): void {
  state.cancelTree.set(id, node);
}

/** The live node for an id, if the work is still running (i.e. has not been
 * {@link forget}ten). */
export function nodeFor(state: CancelState, id: string): Node | undefined {
  return state.cancelTree.get(id);
}

/**
 * A child of `parentRun` when that run is still live, else a root.
 *
 * A root is the honest answer for the fallback case, not a silent downgrade:
 * work started by nobody in particular (a Studio launched from the UI, a job
 * the queue starts long after the ask that asked for it ended) has no parent
 * to inherit a Stop from, and pretending otherwise would attach it to
 * whatever run happened to be open.
 */
export function childOfRun(state: CancelState, parentRun: string | null, label: string): Node {
  const parent = parentRun !== null ? nodeFor(state, parentRun) : undefined;
  return parent !== undefined ? parent.child(label) : Node.root(label);
}

/**
 * Cancel by id: the whole subtree when the id is in the tree, otherwise the
 * single flat flag (recordings, jobs and workflow steps that have not been
 * given a node yet), otherwise nothing. `known` says which happened.
 */
export function cancelId(state: CancelState, id: string): StopReport {
  const node = nodeFor(state, id);
  if (node !== undefined) {
    return node.cancel();
  }
  for (const registry of [state.cancels, state.jobCancels]) {
    const flag = registry.get(id);
    if (flag !== undefined) {
      const first = !flag.swap(true);
      return {
        // The flat registry stores a flag and no label, so this is the most
        // the host can truthfully say about what it just stopped.
        stopped: first ? [UNLABELLED] : [],
        known: true,
      };
    }
  }
  return { stopped: [], known: false };
}

/**
 * Cancel every live node in the tree, subtrees included. Returns how many
 * pieces of work this stopped.
 *
 * For the room-lock / close drain, which flips every flag in `cancels` and
 * `jobCancels` by hand. Those two maps hold ROOTS; a child's flag is its own
 * and lives only in the tree, so without this a Studio build an agent
 * started would keep generating — and then write its page — against a room
 * that is being sealed. The drain still owns the WAIT (it watches those maps
 * empty); this only makes sure nothing is left running that they cannot see.
 */
export function cancelAll(state: CancelState): number {
  let total = 0;
  for (const node of state.cancelTree.values()) {
    total += node.cancel().stopped.length;
  }
  return total;
}

/**
 * Forget an id's node. In Rust this was "the eager half" beside a `Weak`
 * that would also die on its own; here it is the ONLY removal path (see
 * {@link CancelState}'s doc), so whatever registers a run MUST call this
 * when the run ends, in a `finally`, exactly like {@link Node.dispose}.
 */
export function forget(state: CancelState, id: string): void {
  state.cancelTree.delete(id);
}
