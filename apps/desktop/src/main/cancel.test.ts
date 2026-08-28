import { describe, expect, it } from "vitest";
import {
  CancelFlag,
  Node,
  UNLABELLED,
  alsoStopped,
  cancelAll,
  cancelId,
  childOfRun,
  createCancelState,
  forget,
  guardCommit,
  nodeFor,
  registerRun,
  remember,
  stopped,
} from "./cancel.js";

// Port of src-tauri/src/cancel.rs's `#[cfg(test)] mod tests` (lines 319-525).
// Every test in the first block is named after its Rust counterpart. Wherever
// the Rust test relied on a `let _x = ...` binding dropping at the end of a
// scope to prune a finished child, this port calls `.dispose()` explicitly at
// that same point — see cancel.ts's module doc for why (JS has no
// deterministic-drop equivalent of Rust's ownership, and a GC-timing-based
// port would make these very assertions vacuous).

describe("cancel tree (1:1 with cancel.rs's own tests)", () => {
  it("cancelling_a_parent_cancels_its_whole_subtree", () => {
    const run = Node.root("this answer");
    const studio = run.child("Flashcards");
    const pass = studio.child("Full pass");
    // The flag the workers actually poll — handed out before the Stop,
    // exactly as `run_studio_core` receives one.
    const handedOut = pass.flag();

    expect(pass.cancelled()).toBe(false);
    const report = run.cancel();

    expect(run.cancelled()).toBe(true);
    expect(studio.cancelled()).toBe(true);
    expect(pass.cancelled()).toBe(true);
    expect(handedOut.load()).toBe(true); // the flag a worker already holds must see it
    expect(report.stopped).toEqual(["this answer", "Flashcards", "Full pass"]);
    expect(alsoStopped(report)).toBe("Flashcards, Full pass");
  });

  it("cancelling_a_child_leaves_the_parent_and_its_siblings_running", () => {
    const run = Node.root("this answer");
    const a = run.child("Flashcards");
    const b = run.child("Mind map");

    const report = a.cancel();

    expect(a.cancelled()).toBe(true);
    expect(b.cancelled()).toBe(false); // a sibling was stopped by someone else's Stop
    expect(run.cancelled()).toBe(false); // cancellation walked UP the tree
    expect(report.stopped).toEqual(["Flashcards"]);
    expect(alsoStopped(report)).toBeNull();
  });

  it("a_child_born_after_the_stop_is_born_cancelled", () => {
    // The race the whole ordering exists for: the walk has already passed,
    // and a tool call in flight registers one more child. It must not get to
    // run — it would write into a room whose run is already stopped.
    const run = Node.root("this answer");
    run.cancel();

    const late = run.child("Flashcards");

    expect(late.cancelled()).toBe(true); // a child created after the Stop escaped it
    expect(late.guard("the flashcards page").ok).toBe(false);
  });

  it("a_cancelled_run_refuses_the_commit_and_names_what_was_not_saved", () => {
    const run = Node.root("this answer");
    const studio = run.child("Flashcards");

    // Before the Stop the commit is allowed — the gate must not be a blanket
    // refusal, or nothing would ever save.
    expect(studio.guard("the flashcards page").ok).toBe(true);

    run.cancel();

    const result = studio.guard("the flashcards page");
    expect(result.ok).toBe(false);
    const err = result.ok ? "" : result.error;
    expect(err).toContain("flashcards page");
    expect(err.startsWith("Stopped")).toBe(true);
    // The sentinel half of the same rule, for the file-pass runner.
    expect(stopped(studio.flag())).toBe(true);
  });

  it("a_child_already_committing_is_not_reported_stopped_twice", () => {
    // Stop pressed twice (or Stop + close_room) must not tell the user the
    // same work was stopped again — and, more importantly, must not read as a
    // second commit having been prevented. The first Stop is the one that
    // stopped it.
    const run = Node.root("this answer");
    const studio = run.child("Flashcards");
    studio.cancel();

    const report = run.cancel();

    expect(report.stopped).toEqual(["this answer"]); // the child must not be re-reported
    expect(run.cancel().stopped).toEqual([]); // a second Stop stopped nothing
  });

  it("the_transcript_can_name_what_else_was_stopped_but_not_what_finished", () => {
    const run = Node.root("this answer");
    const stoppedChild = run.child("Flashcards");
    {
      // Finished before the Stop: dispose() is this port's equivalent of the
      // Rust scope-block dropping `_finished`'s `Arc<Node>`. Claiming the
      // Stop stopped it would be a small lie about the user's own room — the
      // page it produced is in the library.
      const finished = run.child("Mind map");
      finished.dispose();
    }
    run.cancel();

    expect(run.stoppedChildren()).toEqual(["Flashcards"]);
    expect(stoppedChild.cancelled()).toBe(true);
    // Nothing was stopped under the child itself.
    expect(stoppedChild.stoppedChildren()).toEqual([]);
  });

  it("a_finished_child_leaves_nothing_behind_to_cancel", () => {
    const run = Node.root("this answer");
    {
      const done = run.child("Flashcards");
      done.dispose();
    }
    // The child's work returned and it disposed itself SYNCHRONOUSLY — not
    // eventually once some GC pass happens to run — so this assertion, made
    // microseconds later, actually proves the pruning rather than merely
    // failing to catch its absence.
    expect(run.cancel().stopped).toEqual(["this answer"]);
  });

  it("the_registry_finds_a_run_by_id_and_stops_its_children", () => {
    const state = createCancelState();
    const run = registerRun(state, "ask-1", "this answer");
    // What the agent's Studio tool does with the turn's run id.
    const studio = childOfRun(state, "ask-1", "Flashcards");

    // Registered in BOTH: the flat map every existing drain flips…
    expect(state.cancels.has("ask-1")).toBe(true);
    // …and the tree, so the child could find its parent at all.
    const report = cancelId(state, "ask-1");

    expect(report.known).toBe(true);
    expect(report.stopped).toEqual(["this answer", "Flashcards"]);
    expect(studio.cancelled()).toBe(true); // the child must not ignore its parent's Stop
    expect(run.cancelled()).toBe(true);
  });

  it("work_with_no_live_parent_gets_a_root_rather_than_someone_elses_run", () => {
    const state = createCancelState();
    registerRun(state, "ask-1", "this answer");

    // The queue starting a job long after its ask ended, and the UI's own
    // Studio button: neither may inherit an unrelated run's Stop.
    const orphan = childOfRun(state, null, "Flashcards");
    const stale = childOfRun(state, "ask-gone", "Mind map");
    cancelId(state, "ask-1");

    expect(orphan.cancelled()).toBe(false);
    expect(stale.cancelled()).toBe(false);
  });

  it("locking_the_room_stops_children_the_flat_registry_cannot_see", () => {
    // The room-lock drain flips every flag in `cancels`/`jobCancels`. Those
    // are ROOTS; the Studio build an agent started has its own flag and is
    // reachable only through the tree. Left running, it writes its page into
    // a room that is being sealed.
    const state = createCancelState();
    const run = registerRun(state, "ask-1", "this answer");
    const studio = childOfRun(state, "ask-1", "Flashcards");
    // What the drain does by hand — and what it misses.
    for (const flag of state.cancels.values()) {
      flag.store(true);
    }
    expect(run.cancelled()).toBe(true);
    expect(studio.cancelled()).toBe(false); // precondition: roots only

    expect(cancelAll(state)).toBe(1); // only the child was still running

    expect(studio.cancelled()).toBe(true); // the lock must not leave a child writing into a sealed room
  });

  it("an_unknown_id_stops_nothing_and_says_so", () => {
    const state = createCancelState();
    const report = cancelId(state, "never-existed");
    expect(report.known).toBe(false); // a Stop that stopped nothing must not claim it did
    expect(report.stopped).toEqual([]);
  });

  it("a_flat_registry_flag_is_still_stopped_by_id", () => {
    // Everything not yet given a node — recordings, workflow steps — must
    // keep working exactly as it does today.
    const state = createCancelState();
    const flag = new CancelFlag();
    state.jobCancels.set("job-1", flag);

    const report = cancelId(state, "job-1");
    expect(report.known).toBe(true);
    expect(report.stopped).toEqual([UNLABELLED]);
    expect(flag.load()).toBe(true);
    // A second Stop on the same flat flag stopped nothing, same as a node.
    expect(cancelId(state, "job-1").stopped).toEqual([]);
  });

  it("forgetting_a_run_unhooks_new_children_but_not_the_ones_it_started", () => {
    const state = createCancelState();
    const run = registerRun(state, "ask-1", "this answer");
    const started = childOfRun(state, "ask-1", "Flashcards");
    forget(state, "ask-1");

    // The run is over: new work is nobody's child…
    expect(childOfRun(state, "ask-1", "Mind map").cancelled()).toBe(false);
    // …but the tree it already built is intact, so a late close_room drain
    // through the still-held node reaches everything it started.
    run.cancel();
    expect(started.cancelled()).toBe(true);
  });
});

describe("CancelFlag", () => {
  it("load/store/swap mean exactly what AtomicBool's load/store/swap mean", () => {
    const flag = new CancelFlag();
    expect(flag.load()).toBe(false);
    // swap returns the PREVIOUS value — the whole basis of "was this Stop the
    // one that stopped it?".
    expect(flag.swap(true)).toBe(false);
    expect(flag.load()).toBe(true);
    expect(flag.swap(true)).toBe(true);
    flag.store(false);
    expect(flag.load()).toBe(false);
  });

  it("a flag handed to two holders is ONE cell, the way an Arc clone is", () => {
    const node = Node.root("this answer");
    const workerCopy = node.flag();
    const otherCopy = node.flag();
    node.cancel();
    expect(workerCopy.load()).toBe(true);
    expect(otherCopy.load()).toBe(true);
  });
});

describe("guardCommit / stopped (free functions)", () => {
  it("refuses once the flag is set and names what was not saved", () => {
    const flag = new CancelFlag();
    expect(guardCommit(flag, "the flashcards page").ok).toBe(true);
    flag.store(true);
    const result = guardCommit(flag, "the flashcards page");
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toBe("Stopped — the flashcards page was not saved.");
    expect(stopped(flag)).toBe(true);
  });
});

describe("nodeFor / remember / UNLABELLED", () => {
  it("nodeFor returns the same node remember() stored, and nothing once forgotten", () => {
    const state = createCancelState();
    const node = Node.root("this answer");
    remember(state, "ask-1", node);
    expect(nodeFor(state, "ask-1")).toBe(node);
    forget(state, "ask-1");
    expect(nodeFor(state, "ask-1")).toBeUndefined();
  });

  it("UNLABELLED names the flat registry's Stop with something a user can read", () => {
    expect(UNLABELLED).toBe("the work you stopped");
  });
});

// ---------------------------------------------------------------------------
// The disposal seam itself. Rust has nothing to test here because the drop is
// implicit; in this port it is the one genuinely new discipline, so it gets
// its own coverage.
// ---------------------------------------------------------------------------

describe("Node.dispose (this port's replacement for Rust's Weak pruning)", () => {
  it("removes a child from its parent's kids list SYNCHRONOUSLY, not eventually", () => {
    const run = Node.root("this answer");
    const child = run.child("Flashcards");

    expect(run.stoppedChildren()).toEqual([]);
    child.dispose();

    // If dispose() were a no-op — or merely eventual, the way an unguarded
    // WeakRef port would be — this would report ["this answer", "Flashcards"].
    // cancel() is the tree's one authoritative walk, so asserting through it
    // is what makes this test able to fail.
    expect(run.cancel().stopped).toEqual(["this answer"]);
  });

  it("is idempotent — a second dispose() is a harmless no-op", () => {
    const run = Node.root("this answer");
    const child = run.child("Flashcards");
    child.dispose();
    expect(() => child.dispose()).not.toThrow();
    expect(run.cancel().stopped).toEqual(["this answer"]);
  });

  it("removes by identity, so it never unlinks a sibling that shares its label", () => {
    // Two Studio builds of the same kind in one turn is ordinary; an
    // indexOf-by-label prune would silently detach the wrong one and let it
    // write into a stopped room.
    const run = Node.root("this answer");
    const first = run.child("Flashcards");
    const second = run.child("Flashcards");
    first.dispose();

    run.cancel();

    expect(second.cancelled()).toBe(true);
    expect(run.stoppedChildren()).toEqual(["Flashcards"]);
  });

  it("removes the SECOND of two like-labelled siblings when it is the second one that finished", () => {
    // The case above cannot actually tell identity from label: disposing the
    // FIRST like-labelled sibling, a `findIndex(kid => kid.label() === …)`
    // prune finds that very node and removes exactly the right one, so it
    // passes against the wrong implementation. Only disposing the LATER
    // duplicate separates them — a label prune unlinks the first one instead
    // and leaves the finished build still listed while the running one
    // silently escapes its parent's Stop, which is both halves of the lie this
    // module exists to prevent, in one move.
    const run = Node.root("this answer");
    const stillRunning = run.child("Flashcards");
    const finished = run.child("Flashcards");
    finished.dispose();

    const report = run.cancel();

    expect(stillRunning.cancelled()).toBe(true); // the wrong sibling was unlinked
    expect(finished.cancelled()).toBe(false); // finished work was reported stopped
    expect(report.stopped).toEqual(["this answer", "Flashcards"]);
    expect(run.stoppedChildren()).toEqual(["Flashcards"]);
  });

  it("is a no-op on a root, which has no parent to unlink from", () => {
    const run = Node.root("this answer");
    expect(() => run.dispose()).not.toThrow();
    expect(run.cancel().stopped).toEqual(["this answer"]);
  });

  it("leaves the disposed node's own flag and cancellation untouched", () => {
    // Pruning is about the PARENT's bookkeeping, not the child's own state.
    const run = Node.root("this answer");
    const child = run.child("Flashcards");
    child.dispose();

    run.cancel();
    expect(child.cancelled()).toBe(false); // its former parent can no longer reach it

    child.cancel();
    expect(child.cancelled()).toBe(true); // but it still cancels when held directly
    expect(guardCommit(child.flag(), "the flashcards page").ok).toBe(false);
  });

  it("a DEEP tree disposed OUT OF ORDER stops exactly the live descendants and names only those", () => {
    // The Rust suite's `the_transcript_can_name_what_else_was_stopped_but_not
    // _what_finished` proves the idea at depth ONE with a single finished
    // sibling. A real turn is neither: a run dispatches a specialist, which
    // starts a Studio build, which starts a file pass, and they finish in
    // whatever order they finish in — leaf-first for a well-behaved
    // try/finally, but not in creation order and not all at once. A prune that
    // was subtly index-based (or that spliced while walking) survives the
    // shallow test and loses a node here.
    //
    //   run ─┬─ specialist ── studio ── pass ── page   (page, pass disposed)
    //        └─ transcription ── chunk                 (chunk, transcription
    //                                                   disposed)
    const run = Node.root("this answer");
    const specialist = run.child("Research");
    const studio = specialist.child("Flashcards");
    const pass = studio.child("Full pass");
    const page = pass.child("Page 3");
    const transcription = run.child("Transcription");
    const chunk = transcription.child("Chunk 7");

    // Finished, in an order that is neither creation order nor reverse
    // creation order — the innermost of one branch, then the whole other
    // branch from the inside out.
    page.dispose();
    chunk.dispose();
    pass.dispose();
    transcription.dispose();

    const report = run.cancel();

    // Depth-first, root first — the order `alsoStopped` slices, so it is part
    // of the contract and not an implementation detail.
    expect(report.stopped).toEqual(["this answer", "Research", "Flashcards"]);
    expect(alsoStopped(report)).toBe("Research, Flashcards");
    expect(run.stoppedChildren()).toEqual(["Research", "Flashcards"]);

    // The live ones really were stopped…
    expect(specialist.cancelled()).toBe(true);
    expect(studio.cancelled()).toBe(true);
    // …and every disposed one was left alone: claiming a Stop reached work
    // that had already finished honestly is the exact lie this module exists
    // to prevent, and its page is in the library.
    for (const finished of [page, chunk, pass, transcription]) {
      expect(finished.cancelled()).toBe(false);
    }
  });

  it("disposing a node whose children are still live orphans them, exactly as dropping its Arc does", () => {
    // The pathological ordering, pinned deliberately rather than left to be
    // rediscovered: `dispose()` unlinks only the node itself, so a node
    // disposed while its own children are still running takes their whole
    // subtree out of the ancestor's reach. That is not a port defect — it is
    // precisely what Rust does, where the children hold no reference back and
    // dropping the middle `Arc<Node>` frees the `kids` vec that was the only
    // path to them. It is also why the discipline is "dispose when YOUR work
    // finishes", which is after your children's.
    const run = Node.root("this answer");
    const specialist = run.child("Research");
    const studio = specialist.child("Flashcards");
    const pass = studio.child("Full pass");

    specialist.dispose(); // out of order: its subtree is still running

    expect(run.cancel().stopped).toEqual(["this answer"]);
    expect(studio.cancelled()).toBe(false);
    expect(pass.cancelled()).toBe(false);

    // The subtree is unreachable from the run, not gone: whoever still holds
    // the specialist can stop it, and that Stop still walks all the way down.
    expect(specialist.cancel().stopped).toEqual(["Research", "Flashcards", "Full pass"]);
    expect(pass.cancelled()).toBe(true);
  });

  it("a child disposed DURING its parent's cancel walk cannot skip a sibling", () => {
    // The walk snapshots `kids` before recursing precisely so a node that
    // reacts to its own cancellation by disposing cannot shift the array out
    // from under the iteration and leave the next sibling running.
    const run = Node.root("this answer");
    const first = run.child("Flashcards");
    const second = run.child("Mind map");
    const flag = first.flag();
    const realSwap = flag.swap.bind(flag);
    flag.swap = (next: boolean): boolean => {
      const previous = realSwap(next);
      first.dispose();
      return previous;
    };

    const report = run.cancel();

    expect(report.stopped).toEqual(["this answer", "Flashcards", "Mind map"]);
    expect(second.cancelled()).toBe(true);
  });
});
