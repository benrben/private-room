# Workflow Patterns (and the Agent Loop)

Detailed write-ups of the five canonical workflow patterns plus the autonomous
agent. For each: what it is, when to use it, the tradeoffs, where deterministic
code should replace model calls, and a structural sketch. These are architectural
shapes, not tied to any language or framework — see *Implementing across any
stack* at the end for how they map onto whatever you build in.

All of these are built from the same block — an **augmented LLM** (model + tools +
retrieval + memory). The patterns differ only in how you wire those calls together
and how much control you hand to the model.

## Contents

- [Building block: the augmented LLM](#building-block-the-augmented-llm)
- [1. Prompt chaining](#1-prompt-chaining)
- [2. Routing](#2-routing)
- [3. Parallelization: sectioning and voting](#3-parallelization-sectioning-and-voting)
- [4. Orchestrator-workers](#4-orchestrator-workers)
- [5. Evaluator-optimizer](#5-evaluator-optimizer)
- [The autonomous agent loop](#the-autonomous-agent-loop)
- [Choosing between them](#choosing-between-them)
- [Implementing across any stack](#implementing-across-any-stack)

---

## Building block: the augmented LLM

Before composing anything, get one augmented call working well: the model, the
retrieval it needs, the tools it can call, and — often overlooked — **structured
output** so downstream code can consume the result deterministically. Tailor these
to your use case and make sure the model can actually use them (see
`tool-design.md`). Every pattern below is just a particular arrangement of this
block.

---

## 1. Prompt chaining

**What it is.** Decompose a task into a fixed sequence of steps, where each model
call works on the previous step's output. Between steps you can place
deterministic **gates** — code checks that validate the intermediate result and
decide whether to proceed, retry, or stop.

**When to use it.** The task cleanly and *predictably* breaks into subtasks whose
order you know in advance. Splitting it lets each call do one narrow thing well,
raising accuracy at the cost of extra latency. Classic uses: generate an outline,
check it, then write the document; or translate, then localize, then polish.

**Tradeoffs.** More calls = more latency and tokens. Worth it when the accuracy
gain from decomposition is real. If a single call already nails it, don't chain.

**Programmatic-code notes.** The **gates** are pure code — the whole point is to
catch failures cheaply without another model call. Anything deterministic between
steps (formatting, validation, extracting a field, deciding to continue) is code.
Have each step emit structured output so the next step and the gates can consume
it reliably.

**Structural sketch.**
```
input → [LLM: step 1] → (code gate: ok?) → [LLM: step 2] → (code gate) → output
                              │ fail
                              └→ retry / stop / fallback
```

---

## 2. Routing

**What it is.** Classify an incoming input, then dispatch it to a specialized
downstream handler (a dedicated prompt, workflow, or tool) built for that
category. Separates concerns so each handler stays focused.

**When to use it.** Inputs fall into **distinct categories that are better handled
separately**, and lumping them into one do-everything prompt hurts quality.
Examples: sending refund vs. technical vs. billing support queries to different
flows; routing easy queries to a small/cheap model and hard ones to a large one.

**Tradeoffs.** Adds a classification step and the operational overhead of multiple
handlers. Pays off when specialization meaningfully improves each category and/or
saves cost by matching model size to difficulty.

**Programmatic-code notes.** Route with **code** whenever the rule is exact —
match on a field, a regex, an enum, a threshold. Use a **model classifier only
when the categories are genuinely fuzzy** (natural-language intent). Even then,
constrain the classifier to a structured label so the dispatch itself is a plain
`switch` in code, not another open-ended call.

**Structural sketch.**
```
                 ┌─ code rule matches? → handler A
input → classify ┼─────────────────────→ handler B
   (code or LLM) └─────────────────────→ handler C
```

---

## 3. Parallelization: sectioning and voting

**What it is.** Run multiple model calls at the same time and combine their
outputs. Two distinct flavors:

- **Sectioning** — split the task into **independent subtasks** you know in
  advance, run them concurrently, then merge. (E.g., analyze tone, factuality,
  and policy-compliance of a text in parallel; or process many documents at once.)
- **Voting** — run the **same task multiple times** to get diverse attempts, then
  take a consensus / majority / best-of. (E.g., check code for a vulnerability
  several times and flag it if any run does; grade with multiple passes.)

**When to use it.** *Sectioning* when subtasks are independent and you want speed,
or when separating concerns into focused calls improves quality. *Voting* when
multiple attempts raise confidence or catch rare failures, or when you want to
reduce single-shot variance.

**Tradeoffs.** More total tokens (you're doing more calls), but *lower latency*
for sectioning since calls run concurrently, and *higher reliability* for voting.
Watch cost — voting multiplies token spend by the number of runs.

**Programmatic-code notes.** The fan-out, the concurrency, and the **aggregation**
(majority vote, min/max, concatenation, thresholding) are all **code**. Reach for
a model in the merge step only if combining requires genuine synthesis in language;
otherwise a reducer function is faster and deterministic.

**Structural sketch.**
```
              ┌→ [LLM: subtask/attempt 1] ┐
input → split ┼→ [LLM: subtask/attempt 2] ┼→ (code: aggregate) → output
              └→ [LLM: subtask/attempt 3] ┘
```

---

## 4. Orchestrator-workers

**What it is.** A central **orchestrator** model **dynamically** decides what the
subtasks are for this particular input, delegates each to a **worker** model, and
then synthesizes the workers' results. The number and nature of subtasks are
determined at runtime.

**When to use it.** Tasks where you **can't predetermine the subtasks** — they
depend on the input. This is the key difference from parallelization sectioning:
in sectioning you know the splits up front; here you don't. Example: a coding
change that touches an unknown set of files, where the orchestrator decides which
files to edit and dispatches an edit per file; or research that fans out into
sub-questions discovered along the way.

**Tradeoffs.** More flexible than sectioning, but you've handed the model control
over decomposition — more power, less predictability, more tokens. It sits on the
border between workflow and agent: fixed *shape* (orchestrate → delegate →
synthesize), dynamic *content*.

**Programmatic-code notes.** The dispatch machinery, result collection, and
synthesis scaffolding are code; the orchestrator's *decision* about how to split
and each worker's actual work are the model steps. Constrain the orchestrator's
plan to a structured list of subtasks so the dispatch loop stays deterministic.

**Structural sketch.**
```
input → [LLM orchestrator: decide subtasks] → for each subtask (code loop):
              → [LLM worker] ─┐
              → [LLM worker] ─┼→ [LLM: synthesize] → output
              → [LLM worker] ─┘
```

---

## 5. Evaluator-optimizer

**What it is.** A loop of two roles: a **generator** model produces a candidate,
an **evaluator** model judges it against criteria and returns concrete feedback,
and the generator revises. Repeat until the evaluator passes it or you hit a
stopping condition.

**When to use it.** You have **clear evaluation criteria**, and responses
**measurably improve with feedback**. Good sign: a human giving the same feedback
would improve the output. Examples: literary translation where nuance is caught on
review; multi-round research or writing that gets sharper with critique.

**Tradeoffs.** Each loop is (at least) two calls, so cost and latency scale with
iterations. Cap the loop count. Only worth it when the refinement genuinely lifts
quality — otherwise it's expensive spinning.

**Programmatic-code notes.** The loop control, the stopping condition (max
iterations, "passed" flag), and any objective checks belong in **code**. If part
of the evaluation is deterministic (does it compile? does it match the schema? is
it under the length limit?), do that in code *before* spending a model call on the
subjective evaluation.

**Structural sketch.**
```
        ┌───────────────────────────────┐
        ▼                               │ feedback
input → [LLM: generate] → [LLM: evaluate] ── pass? ──(code)──► output
                                          │ fail (and under max loops)
                                          └──────────────────────────┘
```

---

## The autonomous agent loop

**What it is.** A model **using tools in a loop**, driving its own trajectory.
It typically starts from a command or a short interactive clarification with a
human; once the task is clear, it plans and works **independently**, taking an
action via a tool, reading the **ground-truth** result from the environment, and
deciding the next action — looping until it judges the task done or hits a stopping
condition. It may pause to check in with a human at a checkpoint or when blocked.

**When to use it.** Open-ended problems where the path can't be predetermined, the
task is valuable enough to justify open-ended token spend, the pivotal
capabilities are solid, and errors are affordable and discoverable (see
`decision-framework.md`). If those don't hold, use a workflow.

**The three components to get right first.** An agent is just:

1. **Environment** — the system it acts in and gets feedback from.
2. **Tools** — its interface for taking actions and observing results.
3. **System prompt** — its goals, constraints, and the behavior you want.

Nail these three before optimizing anything. Premature complexity destroys
iteration speed; optimizations (prompt caching to cut cost, parallel tool calls to
cut latency, a progress UI to build trust) come *after* the behavior works.

**Guardrails (non-negotiable for real deployments).**

- **Stopping conditions** — max iterations and/or a token/time/dollar budget so a
  confused agent can't run forever.
- **Sandboxing & least privilege** — run in an isolated environment; grant the
  narrowest tool access that does the job; prefer **read-only** where you can.
- **Verification** — an automatic check on the agent's work (the "tests and CI"
  analogue) wherever possible.
- **Human-in-the-loop** — approvals before high-stakes/irreversible actions, and a
  clean way for the agent to hand off when it hits a blocker.
- **Transparency** — show the plan and steps so a human can follow and intervene.

**Structural sketch.**
```
human command/clarification
        ▼
   [LLM: plan/decide next action]
        ▼
   [call tool] → environment → (ground-truth result)
        ▼
   stop? (done / budget / blocker / needs human)  ──no──► loop back
        │ yes
        ▼
   result (optionally via human review)
```

---

## Choosing between them

- **Fixed, known steps in order** → prompt chaining.
- **Distinct input categories, handled separately** → routing.
- **Known independent subtasks, want speed** → parallelization (sectioning).
- **Want confidence via repeated attempts** → parallelization (voting).
- **Subtasks unknown until you see the input** → orchestrator-workers.
- **Clear criteria + feedback improves output** → evaluator-optimizer.
- **Path can't be charted at all, errors are recoverable/verifiable** → agent.

And the overarching rule from `decision-framework.md`: if you can draw the whole
tree, build the workflow. Only the genuinely unpredictable parts justify an agent.
Patterns also compose — a node inside a workflow can itself be another pattern (or
a small agent), and an agent can call a workflow as a tool.

**Telling look-alike patterns apart** (these get confused most):

- **Prompt chaining vs. evaluator-optimizer** — both "generate then check." It's
  *chaining* if the check runs a fixed number of times (e.g. generate → validate →
  fix, done). It's *evaluator-optimizer* if it **loops until a quality bar is
  met**, with the evaluator's feedback driving each revision. Loop = optimizer;
  fixed pass = chain.
- **Sectioning vs. orchestrator-workers** — both fan work out to parallel calls.
  It's *sectioning* if **you** can list the subtasks before seeing the input; it's
  *orchestrator-workers* if the **model** must decide the subtasks per input.
  Known splits = sectioning; discovered splits = orchestrator.
- **Routing vs. orchestrator-workers** — *routing* picks **one** handler for the
  input; *orchestrator-workers* runs **several** subtasks and synthesizes. One-of
  = routing; many-and-merge = orchestrator.
- **Voting vs. sectioning** — both run parallel calls, but *voting* runs the
  **same** task for consensus, while *sectioning* runs **different** subtasks.
  Same task = voting; different tasks = sectioning.

---

## Implementing across any stack

These patterns are architectural shapes, independent of language, SDK, or agent
framework. Whatever you build in, you express them with the same handful of
primitives — whatever they happen to be named locally:

- **Step** (a *node* in graph frameworks) — a unit of work: a model call, a tool
  call, or **plain deterministic code**. This last option is the important one: a
  node is not synonymous with an LLM call. In a well-built system the **majority of
  nodes are ordinary code** — parsing, validation, branching, lookups, aggregation
  — and the model nodes are the minority you reserve for the genuinely fuzzy work.
  Assuming every node must be a model call is exactly what produces the
  LLM-for-everything anti-pattern.
- **Control flow** — how you move between steps: sequential, conditional
  (branching), parallel (fan-out / fan-in), and loops. Routing and iteration are
  just control flow — and they're deterministic code, not model calls, whenever
  the rule is exact.
- **Shared state** — the data passed between steps and updated as you go.
- **Persistence** (optional, valuable) — saving state between steps so a run can
  pause, resume, be inspected, or wait for a human.
- **Streaming** (optional) — emitting steps or tokens as they happen, for
  transparency.
- **Structured output** — constraining model results to a schema so surrounding
  code can consume them deterministically.

Every framework offers these under some vocabulary — graphs and nodes, chains,
pipelines, tasks, actors, DAGs, state machines. The pattern is what matters; the
API is a detail. Each pattern maps to a control-flow shape you can build anywhere:
prompt chaining is a sequence with checks between steps; routing is a branch;
parallelization is fan-out then fan-in; orchestrator-workers is a
dynamically-sized fan-out with a synthesis step; evaluator-optimizer is a loop
with an exit condition; the agent is a model-then-tool cycle that continues while
the model keeps requesting tools.

Two rules travel with you regardless of stack:

1. Keep the deterministic glue in code steps; reserve model steps for the fuzzy
   work. (The prime directive, expressed structurally.)
2. You don't need a framework to start. Direct model-API calls keep the prompts
   and control flow fully visible while you learn the task — add a framework only
   once the shape is clear and you feel the specific pain a framework removes.
