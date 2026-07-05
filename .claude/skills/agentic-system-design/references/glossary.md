# Glossary

Shared vocabulary for talking about agentic systems. Terms are grouped by theme;
skim the group you need.

## Core system types

**Agentic system** — Umbrella term for any system where one or more LLMs are used
with tools to accomplish a task. Splits into *workflows* and *agents*.

**Workflow** — An agentic system where LLMs and tools are orchestrated through
**predefined code paths** that you wrote. The structure is fixed; the model fills
in fuzzy steps at known points. Predictable, cheaper, easier to debug.

**Agent** — An agentic system where the **LLM dynamically directs its own process
and tool use**, deciding what to do next based on feedback from the environment,
until it judges the task complete. Flexible and powerful; less predictable and
more expensive.

**Augmented LLM** — The basic building block of everything here: a model enhanced
with **tools**, **retrieval**, and **memory**. It can generate its own queries,
choose which tools to call, and decide what to keep. Both workflows and agents are
built out of augmented LLMs.

**Single call / single LLM call** — One model invocation (optionally augmented)
that produces the whole answer. The simplest option and the one to try first.

## Flow-control and pattern terms

**Prompt chaining** — A workflow that decomposes a task into a fixed sequence of
steps, each model call operating on the previous call's output.

**Gate / programmatic check** — A deterministic code check placed between steps
(e.g., in a chain) that validates output and decides whether to continue, retry,
or bail. A cheap way to catch errors early without another model call.

**Routing** — A workflow that classifies an input and dispatches it to a
specialized downstream handler/prompt. Enables separation of concerns.

**Parallelization** — A workflow that runs multiple model calls at the same time.
Two flavors below.

**Sectioning** — Parallelization where a task is split into **independent
subtasks** that run concurrently, then combined. You know the subtasks up front.

**Voting** — Parallelization where the **same task** runs several times to get
diverse attempts or a consensus/majority answer, improving confidence.

**Orchestrator-workers** — A workflow where a central "orchestrator" model
**dynamically** decides what the subtasks are, delegates them to "worker" models,
and synthesizes the results. Differs from sectioning in that the subtasks are
*not* known in advance.

**Evaluator-optimizer** — A workflow loop where one model **generates** a
response and another **evaluates** it and returns feedback, repeating until the
output passes. Best when evaluation criteria are clear and feedback measurably
improves results.

**Autonomous agent (loop)** — A model using tools in a loop: it plans, acts via a
tool, reads the result from the environment, and repeats, deciding for itself when
it's done. Usually bounded by stopping conditions.

## Agent-anatomy terms

**Environment** — The system the agent operates in and gets feedback from (a
codebase, a browser, a filesystem, an API surface, a database).

**Tool** — A function the model can call to take an action or get information; the
model's only way to actually affect or observe the environment. See the
`tool-design.md` reference.

**System prompt** — The instructions defining the agent's goals, constraints, and
ideal behavior in its environment. One of the three components you iterate on
first (environment, tools, system prompt).

**Agent-computer interface (ACI)** — By analogy to a human UI (HCI), the interface
between the model and its tools: the tool names, descriptions, parameters, return
formats, and error messages. Designing the ACI well is as important as prompt
engineering.

**Ground truth** — Real feedback from the environment (a tool result, a test
outcome, a compiler error) that tells the agent what actually happened, as opposed
to what it predicted. Agents self-correct by pulling ground truth each step.

**Context window** — The bounded set of tokens the model can see at one step
(often ~10–20k tokens of working state for an agent). Everything the model "knows"
about the current world state lives here — the basis for the "think like your
agent" principle.

**Trajectory** — The full sequence of an agent's steps for a task (its
messages, tool calls, and tool results). Useful to feed back to a model to ask why
it made a given decision.

**Stopping condition** — A rule that ends the loop to keep control: a max number
of iterations, a token/time/dollar budget, a success signal, or a detected
blocker.

**Guardrail** — Any safety constraint on an agent: sandboxing, limited scope,
read-only access, allow-lists, required approvals, budgets.

**Human-in-the-loop (HITL)** — A person reviewing, approving, or correcting the
system at defined points — before a risky action, at a checkpoint, or when the
agent hits a blocker. The main lever for making higher-stakes autonomy trustworthy.

## Multi-agent terms

**Multi-agent system** — A system where multiple agents collaborate, often a lead
agent coordinating several sub-agents.

**Orchestrator / lead agent** — The coordinating agent that decomposes the goal
and delegates to sub-agents (distinct from the workflow *orchestrator-workers*
pattern, though the idea rhymes).

**Sub-agent** — A subordinate agent handling a delegated slice of the task, often
with its **own isolated context window** so exploration doesn't pollute the lead
agent's context.

**Separation of concerns** — Splitting responsibilities across agents/tools so
each has a focused job and a cleaner context — a main reason to reach for
multi-agent designs.

## Implementation concepts (framework-agnostic)

These appear in almost every stack under different names; the concept is what
matters, not any one framework's API.

**Step (a.k.a. node)** — A single unit of work in a composed system: a model call,
a tool call, or **plain deterministic code**, typically updating the shared state.
Graph frameworks call these *nodes* — and a node is not the same thing as an LLM
call. Most steps in a well-designed system are ordinary code; the model steps are
the minority reserved for genuinely fuzzy work.

**Control flow** — How execution moves between steps: sequential, conditional
(branching), parallel, or looping. Routing and loops are just control flow.

**Shared state** — The data passed between steps and updated as the system runs;
its working memory for a task.

**Fan-out / fan-in** — Splitting into parallel branches (fan-out) and merging
their results back together (fan-in) — how sectioning and voting are wired.

**Orchestration structure (graph / DAG / pipeline / chain / state machine)** —
Common names for the composed arrangement of steps and control flow. Different
vocabulary, same idea.

**Persistence / checkpointing** — Saving state at each step so a run can be
paused, resumed, replayed, or inspected — and so a human can step in.

**Streaming** — Emitting tokens or step updates as they happen, so users can watch
progress — a key transparency mechanism.

**Structured output** — Constraining a model to return a specific schema (e.g.,
JSON) so downstream *code* can consume it deterministically. Central to keeping
the glue programmatic.

## Economics / evaluation terms

**Budget-aware agent** — An agent with explicit, enforced limits on time, money,
or tokens per task — an open frontier for making agents production-safe.

**Self-evolving tools** — Using a model to analyze failures and improve its own
tool descriptions/ergonomics; a meta-tool that lets agents adapt their toolset.

**Eval (evaluation)** — A repeatable test measuring how well a system does a task.
Good agent evals track not just success but tokens, tool-call counts, and error
rates, and involve reading transcripts.

**Cost of error / error discovery** — How damaging a mistake is, and how hard it
is to notice. High-stakes, hard-to-detect errors argue against autonomy (or for
strong guardrails). One of the four decision-checklist questions.
