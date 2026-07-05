---
name: agentic-system-design
description: >-
  Decide whether a task needs a single LLM call, a workflow, or an autonomous
  agent — then design, build, and iterate on the chosen system using the
  effective-agents principles. Use this whenever the user is architecting,
  building, reviewing, or debugging any LLM-powered system: agents, sub-agents,
  multi-agent setups, tool-calling loops, RAG or retrieval pipelines, prompt
  chains, routing/classification flows, orchestrator-worker or evaluator-optimizer
  setups, or any multi-step "agentic" feature. Trigger it even when the user
  hasn't decided on an architecture yet ("should this be an agent?"), when they're
  designing tools/functions for a model to call, or when an existing agent is
  slow, expensive, looping, or unreliable. The guidance is stack-agnostic —
  concepts and judgment, not any one language, SDK, or framework. Core stance:
  prefer deterministic code over model calls wherever a step doesn't truly need
  language understanding — keep the model for the genuinely fuzzy parts.
---

# Agentic System Design

A decision-and-design guide for building on top of LLMs: knowing when to build an
agent versus a workflow versus a plain call, choosing the right pattern, designing
the tools, and iterating without over-engineering. It distills the core public
guidance on effective agents, tool-writing, and workflow-vs-agent design into one
playbook.

This skill is deliberately **stack-agnostic**. It's about architecture and
judgment — the shapes, the tradeoffs, the decision criteria — not any particular
language, SDK, or agent framework. Translate the concepts into whatever you build
in; the reasoning transfers unchanged.

## Quick reference (the whole skill on one screen)

**Default to code.** A step that can be done with deterministic code should be —
reserve model calls for messy language, fluent generation, and open-ended
judgment. This is the lens for everything below.

**Choose the simplest rung that clears your quality bar:**
1. One augmented LLM call → 2. A workflow (fixed control flow) → 3. An autonomous
agent (model drives the loop). *If you can draw the whole decision tree in advance,
build a workflow — only the parts you can't chart justify an agent.*

**Before committing to an agent, all four should hold** (any "no" → drop a rung):
task is genuinely ambiguous · its value covers open-ended token spend · pivotal
capabilities are reliable · errors are affordable and discoverable.

**Pick a workflow pattern by task shape:** fixed ordered steps → *prompt chaining*
· distinct input types → *routing* · known independent subtasks → *parallelization
(sectioning)* · repeated attempts for confidence → *parallelization (voting)* ·
subtasks unknown until runtime → *orchestrator-workers* · refine-until-it-passes →
*evaluator-optimizer*.

**Then:** design a few high-signal tools (not endpoint wrappers) · build the three
agent components first (environment, tools, system prompt) · think like your agent
(is its context sufficient?) · earn trust (transparency, human-in-the-loop,
read-only, budgets) · optimize only after the behavior works.

Depth for each of these is in the reference files (see navigation at the end).

## The one mental model to hold

Every system here is built from one block: an **augmented LLM** — a model with
tools, retrieval, and memory that can decide what to call and what to remember.
Everything else is a question of *who controls the flow*:

- **Workflow** — the control flow is fixed in code you wrote. The model fills in
  the fuzzy parts at specific, predetermined points. Predictable, cheap,
  debuggable.
- **Agent** — the model controls the flow. It decides what to do next in a loop,
  using tool results from the environment as ground truth, until it judges the
  task done. Flexible, powerful, more expensive and less predictable.

"Agentic system" is the umbrella term for both. Most production value today comes
from **workflows and single calls**, not fully autonomous agents. Reach for an
agent when the task genuinely demands it — not by default.

## Prime directive: prefer code over model calls

This is the lens for every decision below. **A step that can be done with
deterministic code should be done with deterministic code, not an LLM call.**

Every model call you add is latency, dollars, and — most importantly — a point of
nondeterminism where the system can silently go wrong. Deterministic code is fast,
free, reproducible, and testable. So:

- Don't ask a model to do what a parser, a lookup, an API call, a calculation, a
  sort, a schema check, or a conditional can do.
- Push logic *out of the prompt and into code* whenever that logic is
  deterministic. The prompt should carry the judgment, not the bookkeeping.
- The "glue" around your model calls — routing on an exact rule, fanning out,
  collecting results, validating output — should be code, not more model calls,
  whenever the glue is deterministic.
- Reserve the model for what only a model can do: understanding messy natural
  language, generating fluent language, and making genuinely open-ended judgment
  calls in an ambiguous space.

Put in graph terms: **a node is not the same thing as a model call.** Nodes can —
and mostly should — be plain deterministic code; the model nodes are the few you
reserve for the fuzzy work. If your mental picture is "every node is an LLM call,"
that picture is the LLM-for-everything anti-pattern.

This is *the* reason workflows beat agents for well-understood tasks: a fixed code
path with a few targeted model calls at the ambiguous nodes is cheaper, faster,
and more reliable than handing the whole problem to a model in a loop. The mirror
failure is real too — don't hardcode brittle logic for input that is genuinely
ambiguous. The skill is matching the tool to the task, and the default leans
toward code.

## Three principles that govern everything

1. **Don't build agents for everything.** Agents scale complex, high-value,
   hard-to-script tasks — they aren't a drop-in upgrade for every feature. Run the
   four-question check (task complexity, task value, critical-capability risk,
   cost of errors) before committing. → `references/decision-framework.md`
2. **Keep it simple for as long as possible.** An agent is just a model, a set of
   tools, and a system prompt, called in a loop over an environment. Get those
   three right first; premature complexity kills iteration speed. Optimize
   (caching, parallel tool calls, progress UI) only after the behavior works.
   → `references/playbook.md`
3. **Think like your agent.** At each step the model only knows what's in its
   context window. Put yourself in that window and ask whether it's sufficient and
   coherent. Feed your prompt, tool specs, or a full trajectory back to a model
   and ask what's ambiguous or missing. → `references/playbook.md`

## How to choose (fast path)

Climb this ladder and stop at the first rung that clears your quality bar:

1. **One LLM call** (optionally augmented with retrieval/tools). Try this first.
2. **A workflow** — compose several calls in a fixed structure when one call can't
   hold the quality bar. Pick the pattern that fits the task shape.
3. **An autonomous agent** — only when the path can't be predetermined, the task
   is valuable enough to justify open-ended token spend, the needed capabilities
   are solid, and errors are affordable and discoverable.

The north-star rule: **if you can draw the whole decision tree in advance, build
it explicitly as a workflow.** Only the parts you genuinely can't chart ahead of
time justify an agent. Full criteria, the four-question checklist, a worked
example, and a scoping worksheet are in **`references/decision-framework.md`**.

## The workflow patterns (pick by task shape)

Detailed write-ups — what each is, when to use it, tradeoffs, the
code-vs-model-call notes, and a structural sketch — are in
**`references/workflow-patterns.md`**. Quick index:

- **Prompt chaining** — fixed sequence of steps, each call using the last one's
  output; add code "gates" between steps. For tasks that cleanly decompose.
- **Routing** — classify the input, then send it to a specialized handler. For
  distinct input categories better handled separately. (Route with code when the
  rule is exact; use a model only for fuzzy classification.)
- **Parallelization** — run calls at the same time, either **sectioning**
  (independent subtasks) or **voting** (same task several times for consensus).
  For speed or for confidence through multiple attempts.
- **Orchestrator-workers** — a lead call dynamically decides the subtasks and
  delegates them, then synthesizes. Like sectioning, but you *can't* know the
  subtasks in advance.
- **Evaluator-optimizer** — one call generates, another critiques, loop until it
  passes. For tasks with clear evaluation criteria where feedback measurably
  helps.

Patterns compose: a step inside one can be another pattern, or a small agent.

## Designing the tools (the agent-computer interface)

Tools are the contract between your deterministic system and the non-deterministic
model, and they deserve as much design care as a prompt — and they're usually
*where your deterministic code lives*. Build a few high-impact tools rather than
wrapping every API endpoint; consolidate multi-step actions into one call; return
high-signal, human-legible context; budget tokens with pagination and filtering;
and write tool descriptions as if onboarding a new engineer. Full guidance and a
checklist: **`references/tool-design.md`**.

## Building and iterating (the actual loop)

The end-to-end process — scoping, building the three components, testing and
evaluation, earning user trust (transparency, progress, human-in-the-loop,
read-only, scope limits), plus multi-agent tradeoffs and the open frontier
(budget-aware agents, self-evolving tools, agent-to-agent communication) — is in
**`references/playbook.md`**.

## Vocabulary

Unsure what a term means (ACI, augmented LLM, sectioning vs voting, ground truth,
orchestrator, human-in-the-loop, checkpointing, etc.)? See
**`references/glossary.md`**.

## How to navigate this skill

- Deciding *whether/what* to build → `references/decision-framework.md`
- Choosing and understanding a *pattern* → `references/workflow-patterns.md`
- Designing *tools* → `references/tool-design.md`
- *Building, testing, trusting, scaling* → `references/playbook.md`
- *Terms* → `references/glossary.md`
- *Sources* → the References section of `references/playbook.md`

Read the specific reference file when you're in that part of the work rather than
loading everything at once.
