# Decision Framework: Single Call → Workflow → Agent

Use this when the architecture isn't already decided. The goal is to build the
*least* autonomous system that clears your quality bar — autonomy buys capability
but costs money, latency, predictability, and trust.

## Contents

- The default ladder (start simple, climb only when forced)
- The programmatic-first test (apply at every rung)
- The four-question checklist: should this be an agent? (from Zhang's talk)
- Worked example: why coding is an ideal agent use case
- A short scoping worksheet
- Common anti-patterns

---

## The default ladder

Start at the bottom. Only climb when the current rung demonstrably can't hold the
quality bar — and when you climb, prove it was necessary.

1. **One augmented LLM call.** A single call, optionally with retrieval, a tool or
   two, and structured output. Astonishingly often enough. Cheapest, fastest,
   easiest to evaluate. **Always try this first.**
2. **A workflow.** When a single call can't sustain quality, compose several calls
   in a *fixed structure you design*. You get better results by giving each step a
   narrower job — at the cost of more latency and tokens. Choose the pattern that
   matches the task's shape (see `workflow-patterns.md`).
3. **An autonomous agent.** Only when you genuinely can't predetermine the path:
   the number and order of steps depends on what's discovered along the way. This
   is the most capable and the most expensive/unpredictable option.

A blunt but useful rule: **if you can draw the entire decision tree in advance,
build that tree explicitly as a workflow and optimize each node.** It will be
cheaper, faster, and far more controllable than an agent. Save the agent for the
parts of the problem you truly can't chart ahead of time.

Note that frameworks can make it easy to jump straight to rung 3. Resist. When
starting, use the model API directly if you can — layers that hide the underlying
prompts and calls make it harder to see what's happening and harder to debug. Add
a framework once you understand what you're building.

---

## The programmatic-first test (apply at every rung)

Before *and within* any design, ask of each step: **does this step actually
require a language model, or am I using one out of habit?**

A model call is warranted only when the step needs one of:

- **Understanding messy natural language** (free-form user input, unstructured
  documents).
- **Generating fluent language** (prose, summaries, explanations, code).
- **Open-ended judgment in an ambiguous space** where you can't enumerate the
  rules.

If a step is none of those — it's a lookup, a calculation, a transformation, a
validation, an exact-match branch, a sort, a merge — it belongs in **code**. Code
is deterministic, free, instant, reproducible, and unit-testable; a model call is
none of those. Every call you *don't* add is a class of bug you'll never have to
debug.

Practical consequences:

- Prefer a workflow over an agent for any well-understood task, because a workflow
  lets you place model calls *only* at the ambiguous nodes and do everything else
  in code.
- Within a prompt, don't ask the model to do arithmetic, enforce a schema, sort a
  list, or apply a deterministic rule — do those in code around the call.
- Make routing/gating/aggregation code whenever the rule is exact; use a model for
  classification only when the categories are genuinely fuzzy.
- Have models emit **structured output** so downstream code can take over
  deterministically.

The opposite mistake exists and matters: don't try to hardcode logic for input
that is *actually* ambiguous — that produces brittle rule-thickets and is the
signal you needed a model (or an agent) after all. Match the tool to the task. The
default just leans toward code.

---

## The four-question checklist: should this be an agent?

Once you're considering rung 3, pressure-test it against four questions (this
checklist comes from Barry Zhang's *How we build effective agents* talk — see the
References in `playbook.md`). Any one of them can send you back down to a workflow.

### 1. How complex / ambiguous is the task?

Agents earn their keep in **ambiguous problem spaces** where the path can't be
mapped ahead of time. If you *can* map the decision tree, build it explicitly —
you'll get more control and lower cost. Ambiguity is the core thing an agent buys
you; if the task doesn't have it, an agent is overkill.

### 2. Is the task valuable enough to justify the cost?

Agentic exploration burns tokens. The task's value has to cover it. A concrete
gauge: at roughly a 10¢ budget per task, you have only ~30–50k tokens to work
with. High-volume, low-value tasks (e.g., mass customer-support triage) usually
can't afford real exploration — use a workflow to nail the common cases and
capture most of the value cheaply. Reserve agents for tasks where the outcome is
worth a lot more than the tokens spent.

### 3. Are the critical capabilities solid? (de-risk the bottlenecks)

Walk the agent's likely trajectory and check that it can actually do each pivotal
sub-skill. For a coding agent: can it write correct code, debug, and recover from
its own errors? A weak link won't necessarily make the agent fail outright, but it
**multiplies cost and latency** as the agent flails. If you find a bottleneck, the
usual fix is to **reduce scope, simplify the task, and try again** rather than
hope the model muscles through.

### 4. What is the cost of errors — and how discoverable are they?

If mistakes are **high-stakes and hard to detect**, it's hard to trust the agent
with autonomy or with taking actions on your behalf. You can lower this risk with
**read-only access, tighter scope, and human-in-the-loop checkpoints** — but those
same measures limit how far the agent can scale. Easily-verified outputs (there's
a test, a checksum, a reviewer) are what make higher autonomy safe.

---

## Worked example: why coding is an ideal agent use case

Coding is the poster child for agents because it scores well on every question:

- **Ambiguous & complex** — going from a design doc to a finished pull request has
  no fixed path; it demands exploration.
- **High value** — working software is worth a lot, so the token spend is easily
  justified.
- **Capabilities are strong** — current models are already good at many parts of
  the coding loop (writing, reading, debugging code).
- **Errors are cheaply discoverable** — unit tests and CI verify the output
  automatically, so mistakes surface fast and cheaply.

That last property — easy, automatic verification — is what makes trusting the
agent tractable, and it's why so many successful coding agents exist. When you
evaluate your own use case, look hard for an equivalent of "unit tests and CI": a
cheap, reliable way to check the agent's work. If you don't have one, consider
building one, narrowing scope, or keeping a human in the loop.

---

## Scoping worksheet

Answer these before building. They convert the principles above into a go/no-go.

1. **Shape:** Can I draw the full decision tree for this task? → *Yes:* build a
   workflow (pick a pattern). *No:* an agent may be justified; continue.
2. **Step audit:** List the steps. For each, mark `CODE` or `MODEL` using the
   programmatic-first test. Are the `MODEL` steps really irreducible? Move
   everything you can to `CODE`.
3. **Value vs. budget:** What is one successful task worth, and what's my token/
   dollar budget per task? Does the value clear the budget with room to spare?
4. **Bottlenecks:** What are the 2–3 pivotal capabilities? Is the model reliably
   good at each? If not, how will I reduce scope?
5. **Error profile:** What's the worst realistic mistake, and how would I catch
   it? What's my automatic check (the "tests and CI" analogue)? If none, what
   guardrail replaces it (read-only, approvals, scope limits)?
6. **Trust ramp:** What's the smallest, most read-only version I can ship first,
   and what evidence would let me widen autonomy later?

If steps 3–5 look shaky, drop to a workflow or a single call. That's a success,
not a compromise.

---

## Common anti-patterns

- **Agent-by-default.** Reaching for an agent because it's exciting, when a
  workflow or single call would be cheaper, faster, and more reliable.
- **LLM-for-everything.** Using model calls for deterministic glue (parsing,
  math, exact routing, schema checks) instead of code. Slow, costly, flaky.
- **Framework-first.** Adopting a heavy agent framework before you understand the
  problem, obscuring the prompts and calls you most need to see while iterating.
- **Skipping the bottleneck audit.** Shipping an agent whose pivotal capability
  is weak, then paying for it in runaway cost and latency.
- **Autonomy without verification.** Granting write access and independence with
  no cheap way to catch errors and no human checkpoint.
- **Over-hardcoding.** The reverse failure: forcing brittle rules onto genuinely
  ambiguous input, when a model (or agent) is what the task needed.
