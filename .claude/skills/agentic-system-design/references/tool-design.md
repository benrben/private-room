# Tool Design: The Agent-Computer Interface (ACI)

Tools are how a non-deterministic model acts on and observes your deterministic
system — the **contract** between the two. They deserve the same care you'd give a
prompt or a public API. Where UX designers obsess over the human-computer
interface, here you're designing the **agent-computer interface (ACI)**: the tool
names, descriptions, parameters, return shapes, and error messages the model has
to work with. Small improvements here often produce outsized gains in agent
reliability.

This connects directly to the prime directive: **tools are usually where your
deterministic code lives.** A well-built tool lets the model delegate an entire
piece of exact, multi-step work to code in a single call — instead of trying to
reason through it token by token. Good tools *are* how you keep model calls for
the fuzzy parts.

## Contents

- Choosing which tools to build
- Consolidation
- Naming and namespacing
- Writing the description/spec
- Return high-signal, agent-legible context
- Budget tokens deliberately
- Error handling that helps the agent recover
- Evaluating and improving tools (incl. letting the model help)
- Quick checklist

---

## Choosing which tools to build

Don't reflexively wrap every endpoint of an existing API. A thin 1:1 wrapper
around a sprawling API gives the agent dozens of low-level tools and forces it to
orchestrate them itself — slow and error-prone. Instead, build a **small number of
high-impact tools targeted at the specific, high-value workflows** the agent
actually needs. Fewer, better tools are easier for the model to choose among and
easier for you to document and evaluate. Think about what the agent needs to
*accomplish*, then design tools around those jobs — not around your database
schema.

## Consolidation

Prefer tools that **collapse a common multi-step sequence into one call.** If the
agent would otherwise have to call "search," then "get details," then "format," a
single tool that returns the useful end result in one shot is faster, cheaper, and
less error-prone. Consolidating functionality that would span multiple tool calls
into a well-chosen tool is one of the highest-leverage moves in ACI design — and
it's exactly where you push exact, procedural work down into code.

## Naming and namespacing

Names are part of the interface the model reasons over. Make them descriptive and
predictable. When you have many tools across services or resources, **namespace**
them with a consistent prefix (e.g., `calendar_create_event`,
`calendar_list_events`, `docs_search`) so the model can tell related tools apart
and pick the right one. Clear, grouped names measurably reduce wrong-tool errors.

## Writing the description/spec

Write each tool's description as if you're **onboarding a capable new engineer who
has never seen your system.** Don't assume context the model doesn't have. Be
explicit about:

- **What the tool does** and when to use it (and when *not* to).
- **Each parameter**: meaning, type, required/optional, allowed values, **units**
  and **formats** (e.g., "ISO 8601," "USD cents," "must be a value returned by
  `list_projects`"). Ambiguous parameter names cause silent misuse.
- **What it returns** and any **side effects** (does it write? is it
  irreversible?).

Use unambiguous parameter names (`user_id`, not `id`; `start_time_iso`, not
`time`). Investing here pays back repeatedly — clarifying tool descriptions is one
of the cheapest, most effective ways to improve an agent.

## Return high-signal, agent-legible context

What a tool returns is as important as what it does. The response feeds straight
back into the model's limited context window, so:

- Return **high-signal** information the agent needs for its next decision — not a
  raw data dump.
- Prefer **human-legible identifiers** (names, titles, slugs) over opaque UUIDs
  and internal codes where you can. Meaningful strings let the model reason and
  keep working; cryptic IDs get mis-copied and waste tokens.
- Offer **response formats matched to need** — e.g., a concise mode for routine
  use and a detailed mode when the agent needs everything. Don't force the agent
  to swim through verbosity it didn't ask for.

## Budget tokens deliberately

Tool outputs are a major consumer of the context window; treat tokens as a
budget. Build in **pagination, filtering, and sensible truncation with clear
defaults** so a single call can't flood the context. Make it easy for the agent to
ask for *less* (a filter, a page, a summary) and to fetch more only when needed.
An agent that can request exactly the slice it needs stays fast and focused.

## Error handling that helps the agent recover

Errors are part of the interface — the agent reads them and decides what to do
next. Return **clear, actionable, natural-language errors that steer the model
toward a fix**: what went wrong, and ideally what to try instead ("`project_id`
not found; call `list_projects` to get valid IDs"). A good error turns a dead end
into a self-correction. Cryptic stack traces or bare codes just make the agent
guess.

## Evaluating and improving tools (including letting the model help)

Treat tools as something you **test and iterate on**, not set-and-forget.

- **Build evals with realistic tasks** the agent will actually face, and run them.
- **Measure beyond success**: track tokens consumed, number of tool calls, and
  error rates — a tool can "work" while being wildly inefficient.
- **Read the transcripts.** Watch where the agent fumbles a tool, misreads a
  return, or loops. Those moments point straight at the description, the return
  shape, or the error text to fix.
- **Let the model improve the tools.** Feed failing transcripts and the tool spec
  back to a model and ask what's ambiguous, what parameters it wanted, or how the
  description could be clearer. Using the model to refine its own tool descriptions
  is remarkably effective and is the seed of **self-evolving tools** — a meta-tool
  where agents help shape their own ergonomics. This should complement, not
  replace, your own reading of the transcripts.

## Quick checklist

Before shipping a tool, confirm:

- [ ] It targets a real, high-value job — not just a raw API endpoint.
- [ ] It consolidates the common multi-step path into one call where sensible.
- [ ] Its name is descriptive and namespaced among siblings.
- [ ] Its description would let a new engineer use it correctly with no extra
      context; every parameter states type, units, format, and constraints.
- [ ] Side effects and irreversibility are stated.
- [ ] It returns high-signal, human-legible output, with concise/detailed options.
- [ ] It supports pagination/filtering/truncation so it can't flood the context.
- [ ] Its errors are actionable and point toward a fix.
- [ ] It has at least one realistic eval, and you've read a real transcript of the
      agent using it.
