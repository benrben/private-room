# Build & Iterate Playbook

The end-to-end process once you've decided *what* to build: scope it, build the
core, make the model's world coherent, test it, earn user trust, and know when
(and how) to go multi-agent. Ends with the open frontier and the source list.

## Contents

- [The build loop](#the-build-loop)
- [Keep it simple: build three components first](#keep-it-simple-build-three-components-first)
- [Think like your agent](#think-like-your-agent)
- [Use the model to debug the model](#use-the-model-to-debug-the-model)
- [Testing and evaluation](#testing-and-evaluation)
- [Earning user trust](#earning-user-trust)
- [Optimizations (after it works)](#optimizations-after-it-works)
- [Debugging a misbehaving agent: symptom to lever](#debugging-a-misbehaving-agent-symptom-to-lever)
- [Multi-agent: when it's worth it](#multi-agent-when-its-worth-it)
- [The open frontier](#the-open-frontier)
- [References](#references)

---

## The build loop

1. **Decide the architecture.** Run `decision-framework.md`. Land on single call,
   a specific workflow pattern, or an agent. Bias toward the simplest rung and
   toward code over model calls.
2. **Build the smallest real version.** For a workflow, wire the pattern with
   placeholder-quality prompts. For an agent, stand up the three components
   (environment, tools, system prompt) and nothing else.
3. **Make the model's context coherent.** Get into its context window; fix what's
   ambiguous or missing (see "Think like your agent").
4. **Test against realistic tasks.** Read transcripts, not just outputs. Measure
   success *and* cost (tokens, tool calls, latency, errors).
5. **Iterate on the three components / the prompts and tools.** Change one thing
   at a time; keep what the transcripts show is working.
6. **Only then optimize** for cost/latency/trust.
7. **Widen scope and autonomy gradually**, gated by evidence.

The meta-rule: **any complexity you add up front kills iteration speed.** Iterating
on a few simple components gives by far the highest return; clever optimizations
can wait until the behavior is right.

---

## Keep it simple: build three components first

For an agent, resist frameworks, abstractions, and elaborate scaffolding at the
start. An agent is a model, a set of tools, and a system prompt, called in a loop
over an environment. Three design decisions carry most of the outcome:

1. **Environment** — what system the agent works in and what feedback it gets.
2. **Tools** — what actions it can take and what it observes back (design these
   with `tool-design.md`).
3. **System prompt** — its goals, constraints, and the behavior you want.

Very different products — a coding agent, a search agent, a computer-use agent —
share almost the same backbone; they differ mainly in these three choices. Get
them right on the simplest possible version first. Starting with the raw model API
(rather than a framework that hides the prompts and calls) keeps everything
visible while you learn the task; add a framework later if you need one.

---

## Think like your agent

The single most useful debugging habit. At every step, the model is just running
inference over a **limited context window** — often ~10–20k tokens. *Everything*
it knows about the current state of the world is in there. Sophisticated-looking
behavior is still just next-step inference over that limited context.

So put yourself inside that window and ask: **is this actually sufficient and
coherent to make the next decision?** A vivid way to feel it — the computer-use
agent's experience:

- You get a single static screenshot and a terse task description.
- You can reason all you like, but only your **tools** change anything.
- You call a tool and then wait — effectively **closing your eyes for a few
  seconds** while it executes. When you open them, a new screenshot appears. It
  might have worked, or you might have wrecked the environment. You don't know
  until you look.

Doing a full task from the agent's point of view like this is uncomfortable and
extremely clarifying. It surfaces exactly what context the agent was missing —
e.g., a computer-use agent obviously needs the **screen resolution** to click
accurately, and benefits from **recommended actions and explicit limitations** so
it doesn't waste steps exploring blindly. Run this exercise for your own use case
and give the agent the context you'd have wanted.

---

## Use the model to debug the model

You're building systems that speak your language, so ask the model to help you
understand the model. Three high-value moves:

- **Audit the prompt.** Paste your system prompt and ask: is anything here
  ambiguous? Does it make sense? Can you follow it? Fix what it flags.
- **Audit the tools.** Give it a tool description and ask whether it knows how to
  use the tool, and whether it wants more or fewer parameters. Tighten the spec.
- **Audit a trajectory.** Drop a full agent trajectory in and ask, "why did you
  make *this* decision here, and what would have helped you decide better?"

This complements — never replaces — your own reading of the context, but it gets
you much closer to the model's-eye view.

---

## Testing and evaluation

- **Use realistic tasks.** Evaluate on the messy inputs the system will actually
  meet, not tidy demos.
- **Read the transcripts.** The failure is usually visible in *how* the model got
  there — a misread tool result, an ambiguous instruction, a needless loop.
- **Measure cost, not just correctness.** Track tokens, tool-call counts, latency,
  and error rates. A system can be "right" and still be too slow or too expensive
  to ship.
- **Prefer objective checks where they exist.** If part of the output is
  verifiable in code (compiles, matches schema, passes a unit test), check it in
  code — cheaper and more reliable than a model grader, and it doubles as the
  agent's verification signal. Look hard for a "tests and CI" analogue for your
  domain; if you have one, higher autonomy becomes far safer.

---

## Earning user trust

Autonomy is only useful if people trust it. The levers:

- **Transparency.** Show the plan and the steps as they happen (stream them).
  Users forgive a system they can watch and understand far more than a black box.
- **Progress visibility.** Surface what the agent is doing and why — essential for
  longer-running tasks.
- **Human-in-the-loop.** Require approval before high-stakes or irreversible
  actions, and give the agent a clean way to hand off when blocked.
- **Read-only and limited scope.** Start with the least powerful, most
  reversible version. Read-only access and a narrow scope make early mistakes
  cheap — then widen as evidence accrues.
- **Stopping conditions.** Budgets and iteration caps reassure everyone that a
  confused agent can't run away.

These trust measures also *limit scale* (a human gate is a bottleneck; read-only
can't act). That tradeoff is the point: ramp autonomy up only as your verification
and track record justify it.

---

## Optimizations (after it works)

Once behavior is right, then optimize — matched to the bottleneck:

- **Cost** → prompt/result **caching**; trimming context; routing easy sub-steps
  to smaller models; and, most fundamentally, **moving deterministic steps out of
  model calls into code**.
- **Latency** → run independent **tool calls in parallel**; overlap work; cache
  hot paths.
- **Trust** → progress UI, streaming, clearer summaries of what happened.

Don't pay these complexity costs before the behavior is solid — premature
optimization is exactly the up-front complexity that slows iteration.

---

## Debugging a misbehaving agent: symptom to lever

When an agent is slow, expensive, looping, or unreliable, the fix is almost always
one of a small set of levers. Start by reading a real transcript and thinking like
your agent, then map the symptom:

- **Loops / repeats the same action** → It can't tell it already did the thing:
  make tool results high-signal and legible so prior steps register, keep a
  running record of what's been tried in context, and add a **stopping condition**
  so it can't spin forever. (See "think like your agent" + `tool-design.md`.)
- **Burns tokens / too expensive** → Move deterministic steps out of model calls
  into code; enforce a **token/step/dollar budget**; trim context and tool-return
  verbosity (pagination, filtering); consider dropping to a workflow if the path
  was actually predictable.
- **Too slow** → Run independent tool calls in parallel; cache hot paths;
  shorten the loop by consolidating multi-step tool sequences into single tools.
- **Wrong or low-quality actions** → Usually a context problem: the model is
  missing something it needed at that step. Audit the prompt and tool specs for
  ambiguity (ask a model to critique them); add the missing context; tighten tool
  descriptions and parameter definitions.
- **Picks the wrong tool** → Names/descriptions aren't distinguishing enough:
  namespace related tools, clarify when to use each, and reduce overlapping tools.
- **Fails silently / you can't tell what happened** → Add transparency: stream the
  plan and steps, and make tools return actionable errors that state what went
  wrong and what to try instead.
- **Does something harmful or irreversible** → Tighten guardrails: read-only where
  possible, narrower scope, and a human-in-the-loop approval before high-stakes
  actions.

If several of these are true at once, the deeper signal is often that the task
wasn't a good agent fit — revisit `decision-framework.md` and consider reducing
scope or dropping to a workflow.

---

## Multi-agent: when it's worth it

Splitting work across a lead agent and sub-agents can help when a task is
**parallelizable** and benefits from **separation of concerns** — and sub-agents
with their **own context windows** keep exploration from polluting the lead
agent's context. On broad, breadth-first problems this can substantially
outperform a single agent (Anthropic reported a large lift on an internal research
eval for a lead-plus-subagents design).

But the cost is real and steep: a multi-agent system can consume on the order of
**~15× the tokens** of a single chat, and it adds coordination complexity, more
places for errors to compound, and harder evaluation. So multi-agent is justified
mainly when the task's **value is high and the work genuinely parallelizes** — the
same value-vs-cost logic as the agent decision itself, scaled up. Don't reach for
it to make a simple task feel sophisticated.

A big open question hangs over this space: agents today mostly communicate through
rigid, synchronous, user/assistant-style turns. Richer **asynchronous
communication** and clearer **roles** between agents are still being figured out.

---

## The open frontier

Worth watching (and worth designing toward), from Zhang's musings and Anthropic's
guidance:

- **Budget-aware agents.** Unlike workflows, agents give you little native control
  over cost and latency. First-class, enforced budgets — in **time, money, and
  tokens** — would unlock many production use cases by making spend predictable.
  Open question: the best way to define and enforce those budgets.
- **Self-evolving tools.** We already use models to refine tool descriptions; this
  generalizes to a **meta-tool** where an agent designs and improves its own tool
  ergonomics, adapting its toolset per use case. Ties directly to `tool-design.md`.
- **Multi-agent collaboration.** Expect more of it in production. The unsolved part
  is how agents **communicate** — moving beyond synchronous turns toward
  asynchronous messaging and defined roles so agents can coordinate, delegate, and
  recognize one another.

---

## References

Primary sources this skill distills. Go to them for the original framing,
diagrams, and code.

- **Anthropic — *Building Effective Agents*** (engineering blog): the workflow-vs-
  agent distinction, the augmented-LLM building block, the five workflow patterns,
  the autonomous agent, and the core principles (simplicity, transparency,
  well-crafted ACI). https://www.anthropic.com/engineering/building-effective-agents
- **Barry Zhang — *How we build effective agents*** (AI Engineer Summit talk):
  "don't build agents for everything" and the four-question checklist; "keep it
  simple" (the three components); "think like your agent" (the context-window and
  computer-use exercises); and the open questions (budget-aware agents,
  self-evolving tools, multi-agent communication). Video:
  https://youtu.be/D7_ipDqhtwk
- **Anthropic / Claude blog — *Common workflow patterns for AI agents and when to
  use them***: pattern-by-pattern guidance with examples and when-to-use notes.
  https://claude.com/blog/common-workflow-patterns-for-ai-agents-and-when-to-use-them
- **LangChain — *Workflows and agents* (LangGraph docs)**: one concrete example of
  implementing every pattern via steps, control flow, and shared state, plus
  persistence/checkpointing, human-in-the-loop, and streaming. Useful as an
  illustration even if you use a different stack — the concepts generalize.
  https://docs.langchain.com/oss/python/langgraph/workflows-agents
- **Anthropic — *Writing tools for agents* (engineering blog)**: choosing and
  consolidating tools, naming/namespacing, writing descriptions, returning
  high-signal context, token budgeting, error handling, and evaluating/improving
  tools (including letting the model help).
  https://www.anthropic.com/engineering/writing-tools-for-agents

Note on recency: specific figures cited here (e.g., token-cost multiples and
internal eval lifts) come from the sources above and reflect their publication
dates; treat them as directional and re-check the originals for current numbers.
