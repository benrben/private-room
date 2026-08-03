//! One run-id token hierarchy: cancellation as a TREE, not a flat map.
//!
//! Owner replacement #3, 2026-08-03, with his binding decision attached:
//! "cancelling a parent kills every child AND blocks artifact writes".
//!
//! What was here before is still here — `AppState::cancels` and
//! `AppState::job_cancels` remain the flat `id -> Arc<AtomicBool>` registries
//! every long loop already polls, and `close_room`'s drain still flips all of
//! them. This module adds the missing SHAPE. A run is not one flag: it spawns
//! delegated specialists, background jobs, studio builds and file passes, and
//! each of those was minting a fresh, unrelated flag (or, in the agent-driven
//! Studio's case, no flag at all — `run_studio(..., op_id: None)`). Stop
//! therefore reached the answer and left the work it had started running, which
//! then wrote its artifact into the room minutes after the user was told the run
//! had stopped.
//!
//! The tree fixes that with two rules and nothing else:
//!
//! 1. A child node holds its own flag and its parent holds a `Weak` to it, so
//!    cancelling any node walks DOWN and sets every flag beneath it. Downward
//!    and eager, not a parent-chain check on read, because the ~40 places that
//!    already poll a bare `Arc<AtomicBool>` (`ollama::StructuredOpts`,
//!    `sidecar_json_cancellable`, every job runner) must see the truth without
//!    knowing this module exists. `Node::flag()` hands them exactly what they
//!    take today.
//! 2. NO CHILD COMMITS WITHOUT CHECKING ITS PARENT — [`guard_commit`], called
//!    immediately before the side effect. This generalises the one check
//!    `studios.rs` grew on 2026-08-03 ("Studio can create files after the UI
//!    says the run stopped"): a side effect must be gated at the moment it is
//!    COMMITTED, not at the moment it was decided, because every earlier check
//!    guards a model call and the stretch after the last one is exactly where a
//!    Stop lands in practice.
//!
//! Privacy: a node carries a LABEL — "Flashcards", "this answer" — chosen by
//! the code that creates it, never room content. Ids stay opaque handles, as in
//! `obs`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::commands::AppState;

/// One node of a run's cancel tree: a flag the workers poll, a human label for
/// telling the user what was stopped, and `Weak` links to the children this
/// node has started.
///
/// The links are `Weak` on purpose. A child is OWNED by whatever is running it
/// (the `run_studio` call, the job runner's async block), so a finished child
/// simply drops and its slot is pruned on the next walk — a long turn that
/// dispatches dozens of specialists cannot pile up dead nodes, and no epilogue
/// has to remember to unregister anything.
pub struct Node {
    label: String,
    flag: Arc<AtomicBool>,
    kids: Mutex<Vec<Weak<Node>>>,
}

impl Node {
    /// A root: the run itself.
    pub fn root(label: impl Into<String>) -> Arc<Self> {
        Self::adopt(label, Arc::new(AtomicBool::new(false)))
    }

    /// A root that reuses a flag someone else already made and handed out —
    /// how a job whose `Arc<AtomicBool>` is already in `job_cancels` joins the
    /// tree without a second flag that could disagree with the first.
    pub fn adopt(label: impl Into<String>, flag: Arc<AtomicBool>) -> Arc<Self> {
        Arc::new(Self {
            label: label.into(),
            flag,
            kids: Mutex::new(Vec::new()),
        })
    }

    /// A child of this node. Cancelling `self` (or anything above it) cancels
    /// the child; cancelling the child leaves `self` and its siblings running.
    pub fn child(self: &Arc<Self>, label: impl Into<String>) -> Arc<Self> {
        self.adopt_child(label, Arc::new(AtomicBool::new(false)))
    }

    /// A child around an existing flag — see [`Node::adopt`].
    pub fn adopt_child(self: &Arc<Self>, label: impl Into<String>, flag: Arc<AtomicBool>) -> Arc<Self> {
        let kid = Node::adopt(label, flag);
        {
            let mut kids = self.kids.lock().unwrap_or_else(|e| e.into_inner());
            kids.retain(|w| w.strong_count() > 0);
            kids.push(Arc::downgrade(&kid));
        }
        // Born into an already-stopped parent. `cancel` sets its own flag BEFORE
        // it walks, so a child that registers after the walk has passed still
        // reads `true` here — that ordering is what closes the race, and this
        // line is what acts on it. Without it, the one child unlucky enough to
        // be created during the walk would be the one that writes an artifact
        // into a room the user has already stopped.
        if self.cancelled() {
            kid.cancel();
        }
        kid
    }

    /// The flag itself, for the many loops that poll a bare `Arc<AtomicBool>`.
    pub fn flag(&self) -> Arc<AtomicBool> {
        self.flag.clone()
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Stop this node and everything beneath it. Returns what THIS call
    /// actually stopped, so the user can be told the truth: a node that was
    /// already cancelled is not reported again (it was already stopped, and
    /// saying so twice is a claim about this Stop that isn't true).
    pub fn cancel(&self) -> StopReport {
        let mut stopped = Vec::new();
        self.cancel_into(&mut stopped);
        StopReport { stopped, known: true }
    }

    fn cancel_into(&self, out: &mut Vec<String>) {
        // Flag first, then the walk — see `adopt_child`.
        if !self.flag.swap(true, Ordering::SeqCst) {
            out.push(self.label.clone());
        }
        // Collect under the lock, recurse outside it: a child's own `kids` lock
        // is a different mutex, but holding one lock across a recursive walk is
        // how a future sibling link turns into a deadlock nobody can reproduce.
        let kids: Vec<Arc<Node>> = {
            let mut kids = self.kids.lock().unwrap_or_else(|e| e.into_inner());
            kids.retain(|w| w.strong_count() > 0);
            kids.iter().filter_map(Weak::upgrade).collect()
        };
        for kid in kids {
            kid.cancel_into(out);
        }
    }

    /// The commit gate — see [`guard_commit`].
    pub fn guard(&self, what: &str) -> Result<(), String> {
        guard_commit(&self.flag, what)
    }

    /// Labels of the still-live work BENEATH this node that is now stopped.
    ///
    /// For telling the user what a Stop actually reached, after the fact — the
    /// transcript marker is written when the turn unwinds, not when Stop was
    /// pressed, so it cannot use the `StopReport`. Work that had already
    /// FINISHED is not listed: it dropped its node, and naming it would claim
    /// the Stop reached something it did not.
    pub fn stopped_children(&self) -> Vec<String> {
        let mut out = Vec::new();
        self.collect_stopped_kids(&mut out);
        out
    }

    fn collect_stopped_kids(&self, out: &mut Vec<String>) {
        let kids: Vec<Arc<Node>> = {
            let mut kids = self.kids.lock().unwrap_or_else(|e| e.into_inner());
            kids.retain(|w| w.strong_count() > 0);
            kids.iter().filter_map(Weak::upgrade).collect()
        };
        for kid in kids {
            if kid.cancelled() {
                out.push(kid.label.clone());
            }
            kid.collect_stopped_kids(out);
        }
    }
}

/// What one Stop actually stopped. Handed to the UI (`cancel_ask`) and to the
/// host log, so "Stop" stops being a button that reports nothing.
#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopReport {
    /// Labels, root first, of the nodes this call moved from running to
    /// stopped. Empty when the id was unknown or everything was already stopped.
    pub stopped: Vec<String>,
    /// Did the host still know this run? `false` is not an error (the run may
    /// have just finished) but it is the difference between "stopped" and
    /// "stopped nothing", which the UI and the log both need.
    pub known: bool,
}

impl StopReport {
    /// The children — everything except the run the user pressed Stop on.
    /// `None` when the Stop reached nothing but the run itself, which is the
    /// ordinary case and deserves no extra sentence.
    pub fn also_stopped(&self) -> Option<String> {
        let kids = self.stopped.get(1..).unwrap_or_default();
        match kids {
            [] => None,
            _ => Some(kids.join(", ")),
        }
    }
}

/// The one check every write-side effect makes IMMEDIATELY before it commits.
///
/// `what` names the artifact in the user's words ("the flashcards page"), so a
/// refusal reads as a fact about their room rather than as an internal error.
/// Callers whose protocol already has a stop sentinel (the file-pass runner's
/// `"STOPPED"`, which parks the job for Resume) use [`stopped`] instead and keep
/// their sentinel — the rule is where the check happens, not what it returns.
pub fn guard_commit(flag: &AtomicBool, what: &str) -> Result<(), String> {
    if flag.load(Ordering::SeqCst) {
        return Err(format!("Stopped — {what} was not saved."));
    }
    Ok(())
}

/// The same rule for callers that must return their own sentinel.
pub fn stopped(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

/// What a `StopReport` calls work that lives in the flat registry only, which
/// stores a flag and no label.
pub(crate) const UNLABELLED: &str = "the work you stopped";

/// Register a run's root node: the flag goes into the flat registry every
/// existing drain already flips, the node into the tree so children can find
/// their parent by run id. The caller keeps the returned `Arc` for the run's
/// lifetime; `CancelGuard` removes both entries when it returns.
pub fn register_run(state: &AppState, run_id: &str, label: &str) -> Arc<Node> {
    let node = Node::root(label);
    state
        .cancels
        .lock()
        .unwrap()
        .insert(run_id.to_string(), node.flag());
    remember(state, run_id, &node);
    node
}

/// Put a node in the by-id tree registry, pruning whatever has since finished.
pub fn remember(state: &AppState, id: &str, node: &Arc<Node>) {
    let mut tree = state.cancel_tree.lock().unwrap_or_else(|e| e.into_inner());
    tree.retain(|_, w| w.strong_count() > 0);
    tree.insert(id.to_string(), Arc::downgrade(node));
}

/// The live node for an id, if the work is still running.
pub fn node_for(state: &AppState, id: &str) -> Option<Arc<Node>> {
    state
        .cancel_tree
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(id)
        .and_then(Weak::upgrade)
}

/// A child of `parent_run` when that run is still live, else a root.
///
/// A root is the honest answer for the fallback case, not a silent downgrade:
/// work started by nobody in particular (a Studio launched from the UI, a job
/// the queue starts long after the ask that asked for it ended) has no parent
/// to inherit a Stop from, and pretending otherwise would attach it to whatever
/// run happened to be open.
pub fn child_of_run(state: &AppState, parent_run: Option<&str>, label: &str) -> Arc<Node> {
    match parent_run.and_then(|id| node_for(state, id)) {
        Some(parent) => parent.child(label),
        None => Node::root(label),
    }
}

/// Cancel by id: the whole subtree when the id is in the tree, otherwise the
/// single flat flag (recordings, jobs and workflow steps that have not been
/// given a node yet), otherwise nothing. `known` says which happened.
pub fn cancel_id(state: &AppState, id: &str) -> StopReport {
    if let Some(node) = node_for(state, id) {
        return node.cancel();
    }
    for registry in [&state.cancels, &state.job_cancels] {
        if let Some(flag) = registry.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            let first = !flag.swap(true, Ordering::SeqCst);
            return StopReport {
                // The flat registry stores a flag and no label, so this is the
                // most the host can truthfully say about what it just stopped.
                stopped: if first { vec![UNLABELLED.into()] } else { Vec::new() },
                known: true,
            };
        }
    }
    StopReport::default()
}

/// Cancel every live node in the tree, subtrees included. Returns how many
/// pieces of work this stopped.
///
/// For the room-lock / close drain, which flips every flag in `cancels` and
/// `job_cancels` by hand. Those two maps hold ROOTS; a child's flag is its own
/// and lives only in the tree, so without this a Studio build an agent started
/// would keep generating — and then write its page — against a room that is
/// being sealed. The drain still owns the WAIT (it watches those maps empty);
/// this only makes sure nothing is left running that they cannot see.
pub fn cancel_all(state: &AppState) -> usize {
    let live: Vec<Arc<Node>> = {
        let mut tree = state.cancel_tree.lock().unwrap_or_else(|e| e.into_inner());
        tree.retain(|_, w| w.strong_count() > 0);
        tree.values().filter_map(Weak::upgrade).collect()
    };
    live.iter().map(|n| n.cancel().stopped.len()).sum()
}

/// Forget an id's node. The `Weak` would die on its own when the work drops it;
/// this is the eager half, called from `CancelGuard` beside the `cancels` entry
/// it already removes.
pub fn forget(state: &AppState, id: &str) {
    if let Ok(mut tree) = state.cancel_tree.lock() {
        tree.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancelling_a_parent_cancels_its_whole_subtree() {
        let run = Node::root("this answer");
        let studio = run.child("Flashcards");
        let pass = studio.child("Full pass");
        // The flag the workers actually poll — a clone handed out before the
        // Stop, exactly as `run_studio_core` receives one.
        let handed_out = pass.flag();

        assert!(!pass.cancelled());
        let report = run.cancel();

        assert!(run.cancelled() && studio.cancelled() && pass.cancelled());
        assert!(handed_out.load(Ordering::SeqCst), "the flag a worker already holds must see it");
        assert_eq!(report.stopped, vec!["this answer", "Flashcards", "Full pass"]);
        assert_eq!(report.also_stopped().as_deref(), Some("Flashcards, Full pass"));
    }

    #[test]
    fn cancelling_a_child_leaves_the_parent_and_its_siblings_running() {
        let run = Node::root("this answer");
        let a = run.child("Flashcards");
        let b = run.child("Mind map");

        let report = a.cancel();

        assert!(a.cancelled());
        assert!(!b.cancelled(), "a sibling was stopped by someone else's Stop");
        assert!(!run.cancelled(), "cancellation walked UP the tree");
        assert_eq!(report.stopped, vec!["Flashcards"]);
        assert_eq!(report.also_stopped(), None);
    }

    #[test]
    fn a_child_born_after_the_stop_is_born_cancelled() {
        // The race the whole ordering exists for: the walk has already passed,
        // and a tool call in flight registers one more child. It must not get to
        // run — it would write into a room whose run is already stopped.
        let run = Node::root("this answer");
        run.cancel();

        let late = run.child("Flashcards");

        assert!(late.cancelled(), "a child created after the Stop escaped it");
        assert!(late.guard("the flashcards page").is_err());
    }

    #[test]
    fn a_cancelled_run_refuses_the_commit_and_names_what_was_not_saved() {
        let run = Node::root("this answer");
        let studio = run.child("Flashcards");

        // Before the Stop the commit is allowed — the gate must not be a
        // blanket refusal, or nothing would ever save.
        assert!(studio.guard("the flashcards page").is_ok());

        run.cancel();

        let err = studio.guard("the flashcards page").unwrap_err();
        assert!(err.contains("flashcards page"), "{err:?}");
        assert!(err.starts_with("Stopped"), "{err:?}");
        // The sentinel half of the same rule, for the file-pass runner.
        assert!(stopped(&studio.flag()));
    }

    #[test]
    fn a_child_already_committing_is_not_reported_stopped_twice() {
        // Stop pressed twice (or Stop + close_room) must not tell the user the
        // same work was stopped again — and, more importantly, must not read as
        // a second commit having been prevented. The first Stop is the one that
        // stopped it.
        let run = Node::root("this answer");
        let studio = run.child("Flashcards");
        studio.cancel();

        let report = run.cancel();

        assert_eq!(report.stopped, vec!["this answer"], "the child was re-reported");
        assert_eq!(run.cancel().stopped, Vec::<String>::new(), "a second Stop stopped nothing");
    }

    #[test]
    fn the_transcript_can_name_what_else_was_stopped_but_not_what_finished() {
        let run = Node::root("this answer");
        let stopped_child = run.child("Flashcards");
        {
            // Finished before the Stop: its node is gone, and claiming the Stop
            // stopped it would be a small lie about the user's own room — the
            // page it produced is in the library.
            let _finished = run.child("Mind map");
        }
        run.cancel();

        assert_eq!(run.stopped_children(), vec!["Flashcards"]);
        assert!(stopped_child.cancelled());
        // Nothing was stopped under the child itself.
        assert!(stopped_child.stopped_children().is_empty());
    }

    #[test]
    fn a_finished_child_leaves_nothing_behind_to_cancel() {
        let run = Node::root("this answer");
        {
            let _done = run.child("Flashcards");
        }
        // The child dropped when its work returned; the parent's link is dead
        // and is pruned rather than reported as something this Stop stopped.
        assert_eq!(run.cancel().stopped, vec!["this answer"]);
    }

    #[test]
    fn the_registry_finds_a_run_by_id_and_stops_its_children() {
        let state = AppState::default();
        let run = register_run(&state, "ask-1", "this answer");
        // What the agent's Studio tool does with the turn's run id.
        let studio = child_of_run(&state, Some("ask-1"), "Flashcards");

        // Registered in BOTH: the flat map every existing drain flips…
        assert!(state.cancels.lock().unwrap().contains_key("ask-1"));
        // …and the tree, so the child could find its parent at all.
        let report = cancel_id(&state, "ask-1");

        assert!(report.known);
        assert_eq!(report.stopped, vec!["this answer", "Flashcards"]);
        assert!(studio.cancelled(), "the child ignored its parent's Stop");
        assert!(run.cancelled());
    }

    #[test]
    fn work_with_no_live_parent_gets_a_root_rather_than_someone_elses_run() {
        let state = AppState::default();
        register_run(&state, "ask-1", "this answer");

        // The queue starting a job long after its ask ended, and the UI's own
        // Studio button: neither may inherit an unrelated run's Stop.
        let orphan = child_of_run(&state, None, "Flashcards");
        let stale = child_of_run(&state, Some("ask-gone"), "Mind map");
        cancel_id(&state, "ask-1");

        assert!(!orphan.cancelled());
        assert!(!stale.cancelled());
    }

    #[test]
    fn locking_the_room_stops_children_the_flat_registry_cannot_see() {
        // The room-lock drain flips every flag in `cancels`/`job_cancels`. Those
        // are ROOTS; the Studio build an agent started has its own flag and is
        // reachable only through the tree. Left running, it writes its page into
        // a room that is being sealed.
        let state = AppState::default();
        let run = register_run(&state, "ask-1", "this answer");
        let studio = child_of_run(&state, Some("ask-1"), "Flashcards");
        // What the drain does by hand — and what it misses.
        for f in state.cancels.lock().unwrap().values() {
            f.store(true, Ordering::SeqCst);
        }
        assert!(run.cancelled());
        assert!(!studio.cancelled(), "precondition: roots only");

        assert_eq!(cancel_all(&state), 1, "only the child was still running");

        assert!(studio.cancelled(), "the lock left a child writing into a sealed room");
    }

    #[test]
    fn an_unknown_id_stops_nothing_and_says_so() {
        let state = AppState::default();
        let report = cancel_id(&state, "never-existed");
        assert!(!report.known, "a Stop that stopped nothing must not claim it did");
        assert!(report.stopped.is_empty());
    }

    #[test]
    fn a_flat_registry_flag_is_still_stopped_by_id() {
        // Everything not yet given a node — recordings, workflow steps — must
        // keep working exactly as it does today.
        let state = AppState::default();
        let flag = Arc::new(AtomicBool::new(false));
        state
            .job_cancels
            .lock()
            .unwrap()
            .insert("job-1".into(), flag.clone());

        assert!(cancel_id(&state, "job-1").known);
        assert!(flag.load(Ordering::SeqCst));
    }

    #[test]
    fn forgetting_a_run_unhooks_new_children_but_not_the_ones_it_started() {
        let state = AppState::default();
        let run = register_run(&state, "ask-1", "this answer");
        let started = child_of_run(&state, Some("ask-1"), "Flashcards");
        forget(&state, "ask-1");

        // The run is over: new work is nobody's child…
        assert!(!child_of_run(&state, Some("ask-1"), "Mind map").cancelled());
        // …but the tree it already built is intact, so a late close_room drain
        // through the still-held node reaches everything it started.
        run.cancel();
        assert!(started.cancelled());
    }
}
