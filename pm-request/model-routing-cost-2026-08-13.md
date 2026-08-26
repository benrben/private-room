# Model routing, cost awareness & the spend dashboard — research + design

**Date:** 2026-08-13 · **Status:** research + proposal, nothing built
**Ask:** can we know what each model costs, capture real usage/cost figures per call, and let the user pick a routing strategy — with a consumption dashboard in Settings?

**Amended 2026-08-16 (owner decision).** The strategy layer is **two modes, not three presets**:
**Pinned** (you choose a model, it is always used) and **Economy** (you choose a level 0–10, the app
chooses the model). Economy mode **excludes the local model entirely** — the dial buys quality with
money, and local is not on that axis. §3.3 is rewritten accordingly; the superseded preset design is
kept collapsed at the end of that section. Parts 1 and 2 (the provider research and the gap
analysis) are unaffected — they were about measurement, which both designs need identically.

**Short answer: yes, and most of the raw material already exists in the app.** Prices are already fetched (and discarded), per-call usage is already captured (input side only), and Claude's per-call dollar figure is one unread JSON field away. What's genuinely new: an output-token + cost ledger, a "wallet" abstraction per provider, the routing policy layer, and the Settings section.

---

## Part 0 — In plain English

*Added 2026-08-16. Same content as the rest of the document, without the jargon. Nothing below it
changed. If you read one section, read this one.*

### The problem, in one paragraph

You pay for AI four different ways at once: OpenRouter takes **real prepaid dollars** by the word;
Claude Max ($200/mo) and Codex Plus ($20/mo) are **flat subscriptions** where each call costs you
nothing extra until you hit a usage limit and everything stops; and the model on your own Mac is
free but slower. The app currently tracks **none of this**. It doesn't know what anything costs,
it never writes down what it spent, and it can't tell a cheap job from an expensive one. So every
request goes to whatever model the room happens to be set to — a one-line "make a title for this
chat" gets the same expensive model as a hard piece of reasoning.

Two things follow from that. You can't see where your money went. And you're overpaying, quietly,
on the easy stuff.

### The good news

Most of the information is already flowing through the app — we just throw it away:

- **Prices are already downloaded.** OpenRouter tells us what every model costs; we show it in the
  model picker and then drop it on the floor. Nothing keeps it.
- **OpenRouter already tells us the exact charge for every request.** Not an estimate — the real
  amount. We don't read the field.
- **Claude already tells us the dollar value of every call.** That number appears in the response
  we already parse. It appears zero times anywhere else in our code.
- **We already count tokens** — but only the ones going *in*, never the ones coming *out*. Output
  is the expensive half.

So a good chunk of phase 1 is reading fields we're already receiving.

### The one idea that makes the rest work: a wallet

Four providers, four completely different meanings of "expensive". Comparing them needs one shared
idea, and that idea is a **wallet**: a thing you spend from, that can run out.

| Wallet | What it spends | When it hurts | What "empty" looks like |
|---|---|---|---|
| OpenRouter | real dollars | every single call | account hits zero, requests refused |
| Claude Max | a 5-hour and a weekly allowance | only when you hit the ceiling | "you've hit your limit", back at a stated time |
| Codex Plus | same, plus credits | same | same |
| Your Mac | time, battery, memory | never, in money | n/a |

Each wallet gets one number: **how close to empty, 0 to 1.** That single number is what lets the
app compare a subscription to a prepaid balance, and it's what the dashboard cards show you.

**One conclusion falls straight out of this, and it's the money-saver:** when you're trying to
spend less, the app should use the **subscriptions first**, because you already paid for them and
the next call is free. Local for the easy jobs. And **real dollars last**. Today's app has no idea
this distinction exists.

Two honesty rules go with it. Claude's dollar figure is a *value* number, not a charge — on Max
nothing is billed, so it must never be shown as money spent. And where a price simply isn't known,
the app says "no price data" rather than showing $0 — the community price list we'd fall back on
reports missing models as free, which would quietly understate your spending.

### The two modes, in everyday words

*Owner decision, 2026-08-16 — this replaces the earlier three-preset design. The full version is
§3.3.*

There are exactly **two** modes, and you're always in one of them:

**1. Pinned.** You choose a model, and everything uses that model. Local, cloud, whatever you
picked. Nothing is ever swapped behind your back. This is the app as it works today, made explicit.

**2. Economy.** You don't choose a model — you choose a **number from 0 to 10**, and the app picks
the model for every job. 10 means "best available, spend what it takes". 0 means "cheapest thing
that can do it". Everything in between scales smoothly.

**Economy mode does not use the model on your Mac at all.** That is deliberate: the point of the
dial is to buy quality with money, and the local model isn't on that scale — it's free but weak,
so it would sit stuck at the bottom and never move as you turn the dial. If you want local, pin it
in mode 1.

### What the number actually does

It sets a **price ceiling** — the most the app may pay, per million words of output. Turning the
dial up raises the ceiling, which lets stronger models in.

| Dial | Ceiling | What that buys |
|---|---|---|
| 0 | $1.50 | the cheapest usable cloud models |
| 3 | $6 | small models from the big labs (Haiku, GPT-5.4 mini) |
| 5 | $13 | solid mid-range (Terra) |
| 6 | $17 | Sonnet-class |
| 8 | $28 | Opus-class |
| 10 | no ceiling | anything, best available |

A ceiling rather than a list of tiers, because prices are continuous and models keep changing. Ten
named tiers would be made up; a ceiling stays honest on its own, and a new model released next
month slots in without anyone editing a table.

### How your subscriptions fit in

Claude Max and Codex Plus are already paid for, so each call on them costs you **nothing extra** —
right up until the window runs out and they stop entirely.

That gives them a special place: they count as **$0 against the ceiling, so they're allowed at every
dial setting**, but their quota is still tracked and spent. Which means the app prefers them
wherever they're a fair match for the level you asked for — and *doesn't* squander a 5-hour Claude
window on generating chat titles, because at dial 0 a $0.20 cloud model does that job and leaves
the good quota for the work that needs it.

So: the dial decides **how good**. The wallets decide **who pays**. Two separate questions, kept
separate on purpose — merge them and the "free" subscription wins everything at every setting, and
the dial stops meaning anything until the moment Claude blocks.

### The one thing dropping local costs you — and it isn't money

Today, chat titles, small summaries, routing decisions and the privacy guard itself run on your
Mac. Nothing about them leaves the machine.

In economy mode, all of that becomes an outbound call to a paid provider. Your spending goes up
only trivially — these are tiny jobs on cheap models — but **traffic that never used to leave the
Mac now leaves it**, and the redaction step gets exercised on all of it. In an app whose whole
pitch is a private room, the mode needs to say that on screen, in its own description, before you
switch it on. It's a real trade, not a footnote.

Two behaviours run underneath both modes:

- **If a cheap model visibly botches a job** — broken output, gives up, comes back empty — it is
  retried once on a better model, **but never above your ceiling**. If it's already at your ceiling
  and still failing, the app says so rather than quietly spending more than the number you set. The
  number you set is the number.
- **If a provider hits its limit**, the app moves to the next one and *tells you*: "Claude hit its
  5-hour limit — using Codex until 14:30." In pinned mode it never swaps your model silently; it
  asks.

Also: a conversation keeps the model it started with. Switching mid-chat costs quality *and* money
— the new model has to re-read the whole conversation from cold, and you pay for that again. So the
dial applies when a chat *starts*; moving it doesn't rewire a conversation already in flight.

**A note on the dial, against the prior art.** The research below (§1.6) found that named presets
beat sliders commercially — OpenAI shipped fully automatic routing, had to walk it back, and added
visible switches. A 0–10 dial is a slider, so it inherits that risk: a number with no meaning is
worse than three words with meaning. What makes it safe here is that **this dial isn't a vibe, it's
a price ceiling** — so it can always be shown as what it actually buys ("up to $17 per million —
Sonnet-class and below"), with a live example of which models it lets in given the providers you've
connected. A slider you can read is fine. A slider labelled "quality: 7" is the thing that failed
elsewhere.

### What we'd build, in order

**Phase 1 — see the money. No routing at all.**
Count the tokens going both ways, read the cost figures already arriving, remember the prices, and
write every call into a ledger. Then a new Settings section: a card per provider showing what's
left, a 30-day chart of spend, a breakdown by feature (chat / agents / images / file passes), and
a top-models table. Budgets here are just a display — a number you set and a bar you watch.

*Why this first: it changes no behaviour, so it can't break anything, and on day one you can
finally see where the money goes. Everything else needs this data to exist.*

**Phase 2 — the two modes.**
The dial, and the ability to give different jobs different models. This is where the genuinely new
plumbing lives: today the whole room shares **one model**, so "the planner gets a stronger model
than the workers" is a real change, not a config tweak. Pinned mode comes free here — it's what the
app already does, now with a name. Failover-when-blocked lands here too.

**Phase 3 — the smart parts.**
The planner's easy/normal/hard tags start nudging jobs up and down within your ceiling, the
retry-on-failure cascade turns on, and when a wallet runs low the app changes *who serves* a level
rather than lowering it — the number you set is never moved by the app, only by you.

### What happens when a piece breaks

Every new thing that talks to the outside world has a decided answer, written down before the code
(the full list is §3.7). The rules underneath them all:

- **Accounting never breaks your chat.** If the app can't save a spend record, your answer still
  arrives. The cost data is the *second* most important thing on that screen, always.
- **But a gap is never hidden.** A missing record shows as "some calls in this period weren't
  recorded", not as a smaller number. A spend report that quietly undercounts is worse than one
  with a visible hole in it.
- **"We don't know" is shown as not knowing.** A failed balance check shows the last figure with a
  timestamp, never a zero. Claude's quota genuinely has no API, so that card says "measured by
  Arcelle" rather than pretending to quote Claude.
- **The app never quietly spends above your number.** If your level admits no model that can do the
  job, it says so and stops. It does not "just this once" reach for something dearer.

### The traps, in plain words

Written down so nobody has to rediscover them:

- **There are two separate places in the code that call these CLI tools.** A change made in one
  and not the other looks like it works and silently records nothing.
- **A big share of calls are currently invisible.** Summaries, AI actions, whole-file passes,
  studio pieces and workflow generation all run without asking for machine-readable output, so
  they report no usage at all. Until that's fixed the dashboard would undercount, badly.
- **Two of OpenRouter's own price fields use different units** — one is per token, the other per
  million. Mixing them up is a factor-of-a-million error.
- **Codex's remaining-quota endpoint is undocumented** and has already changed shape between
  versions. Read it defensively, show "unknown" when it fails, and never make a routing decision
  depend on it.
- **Seeing your real OpenRouter balance needs a second, different key** from the one used for
  requests. Without it we can still show per-key usage — offer a paste box, don't demand it.
- **Never invent a price for an image.** Per-token maths doesn't apply to pictures; show only what
  the provider actually charged. The Create page already refuses to guess here.
- **Model names chosen by the router end up on a command line.** Everything the routing layer emits
  goes through the existing validators — this is a security boundary, not a formality.
- **Privacy:** the ledger lives in the encrypted room database. The balance checks are outbound
  calls that send your key and no room content, but they still belong on the privacy screen's list
  of things that leave the Mac.

### Words this document uses

| Word | What it means here |
|---|---|
| **token** | a chunk of text, roughly ¾ of a word. Everything is priced per million of them |
| **input / output tokens** | text sent to the model / text it writes back. Output usually costs 3–5× more |
| **cache read/write** | re-sending the same context cheaply. Switching models throws the cache away and you pay full price again |
| **ledger** | the running list of every call and what it cost — the thing that doesn't exist today |
| **wallet** | one provider seen as a pot you spend from (see above) |
| **pressure** | one number, 0 to 1, for how close a wallet is to empty |
| **tier** | how strong/expensive a model is: S (top) → A → B → local (free) |
| **routing** | choosing which model handles a given job |
| **failover** | moving to another provider when one is out |
| **escalation** | retrying a botched job on a better model |
| **orchestrator / planner** | the agent that decides the steps |
| **worker** | an agent that carries one step out |
| **≈ (the squiggle)** | this number was calculated by us, not reported by the provider |

---

## Part 1 — What each provider actually exposes (verified 2026-08-13)

> **In plain words:** this part is the homework — what each of the four services will actually tell
> us, checked against the live APIs on 2026-08-13. The short version: **OpenRouter** tells us
> everything, including the exact charge per request. **Claude** tells us a dollar value per call
> but will not tell us how much of your allowance is left — no API exists, so we can only measure
> our own use and watch for the "you've hit your limit" message. **Codex** tells us tokens but no
> cost (we price it ourselves), and its remaining-quota check works but is undocumented and shifts
> between versions. **Local** is free. The last sub-section is prior art: three named modes beat a
> slider, the strongest routing trick is simply giving the planner and the workers different
> models, and the clever machine-learned routers aren't worth building — their savings collapse
> outside the data they were tuned on.

### 1.1 OpenRouter (your prepaid credits — real dollars)

| Need | Surface | Notes |
|---|---|---|
| Per-model prices | `GET /api/v1/models` → `pricing` | Sparse map of **strings, USD per single token** (`"prompt": "0.000003"` = $3/M). Fields seen live: `prompt`, `completion`, `input_cache_read`, `input_cache_write`, `input_cache_write_1h`, `web_search`, `image`, `image_output`, `audio`, `internal_reasoning`, and `overrides` (conditional tiers, e.g. different price above 200k prompt tokens). Absent field = 0/N.A. — parser must not require fields. We already parse `prompt`/`completion` (`providers.rs:357-358`) and drop the rest. |
| Real cost per request | response `usage.cost` | **Now always included — the old `usage: {include: true}` opt-in is deprecated and a no-op.** Streaming: arrives in the last SSE message. Also `cost_details.upstream_inference_cost` (BYOK), `prompt_tokens_details.cached_tokens`/`cache_write_tokens`, `completion_tokens_details.reasoning_tokens`. Token counts are now the model's **native** tokenizer. This is the actual amount charged — no computation needed. |
| Reconciliation | `GET /api/v1/generation?id=` | Full record (`total_cost`, `cache_discount`, native token counts, latency, provider). Needs ~1–2 s propagation retry. Nice-to-have, not required. |
| Spend / balance | `GET /api/v1/key` (normal key) | `usage`, `usage_daily`, `usage_weekly`, `usage_monthly`, `limit`, `limit_remaining`, `is_free_tier`. **Per-key**, not account balance. |
| Account balance | `GET /api/v1/credits` | **Now requires a "management key"** (403 with an inference key) — shape `{total_credits, total_usage}`. UI: optional "paste a management key to see your real balance"; otherwise show per-key numbers from `/key`. Probe at runtime, degrade gracefully. |
| Price control levers | request `provider` object | `max_price: {prompt, completion}` — **USD per MILLION here, opposite convention from /models!** — plus `sort: "price"` (== `:floor` suffix), `order`, `allow_fallbacks`. Their Auto Router (`openrouter/auto`) takes `cost_tier: low…max`, no markup, returns served model in `response.model`. |
| Exhaustion signal | HTTP **402** | Negative balance → 402 even on free models. Per-key `limit_remaining` exhaustion also blocks. Clean failover trigger. |

### 1.2 Claude Code CLI (your $200 Max plan — prepaid subscription)

| Need | Surface | Notes |
|---|---|---|
| Per-call usage + cost | `claude -p --output-format json` / `stream-json` result event | `total_cost_usd`, `usage` (input / output / cache_read / cache_creation), `modelUsage` per-model breakdown, `num_turns`, `duration_ms`. **We already parse this envelope** (`external_llm.py:598-638`) and read only input tokens + context window. `total_cost_usd` has zero grep hits repo-wide. |
| Meaning of the $ figure | — | On Max it's a **list-price equivalent computed locally** — nothing is billed. Perfect for a "subscription value consumed" metric; label it as such, never as a charge. |
| Remaining quota (5h window / weekly) | **None.** | `/usage` is interactive-only; no API, no file, no Admin API for consumer Max. The dashboard can only show *our own* measured consumption + last-known limit events. |
| Exhaustion signal | error text | "You've hit your session limit" / "…weekly limit" (+ reset time). Reliable failover trigger; no dedicated exit code. |
| Per-call cost ceiling | `--max-budget-usd` (SDK `maxBudgetUsd`) | Result `subtype: "error_max_budget_usd"` when hit. Lets Arcelle hand every invocation a hard ceiling. |
| Model quota weighting | — | Session/weekly limits are **model-agnostic** on Max — Opus does not burn quota faster per token. (Tokens differ per task, of course.) Fable 5 may need separate usage credits. |

### 1.3 Codex CLI (your $20 Plus plan — prepaid subscription, credit-metered)

| Need | Surface | Notes |
|---|---|---|
| Per-call usage | `codex exec --json` → `turn.completed.usage` | `input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens` (the last two need a 2026-04-24+ CLI build). **No cost field** — we price it ourselves. We currently read only `input_tokens` (`external_llm.py:676-708`). |
| Remaining quota | `codex app-server --stdio` JSON-RPC **`account/rateLimits/read`** | Returns `RateLimitSnapshot`: `primary`/`secondary` windows (`used_percent`, `window_minutes` ≈ 300 / 10079, `resets_at`), `credits {balance, unlimited}`, `plan_type`. **Undocumented/unstable** (older builds: `resets_in_seconds`) — wrap defensively, treat as best-effort. Passive fallback: newest `token_count` event in `~/.codex/sessions/**/rollout-*.jsonl` carries the same `rate_limits` (stale but free; absent under `--ephemeral`, which we use — so the app-server path is the real one). |
| Quota structure | 5-hour + weekly windows, token-metered "credits" (~$0.04/credit) | Plus: e.g. GPT-5.6 Sol 10–100 msgs, Terra 25–200, Luna 250–2,000 per 5h window. (5h limit temporarily lifted July 2026 — volatile, don't hardcode.) |
| Exhaustion signal | stable message prefix | **"You've hit your usage limit"** (match the prefix; suffixes vary). Surfaces as `turn.failed`/`error` in `--json`. API-key mode instead gives HTTP 429 `rate_limit_exceeded`. |
| API pricing (for $-equivalent display) | rate card × $0.04/credit | GPT-5.6 Sol **$5/$30** per M in/out, Terra **$2/$12**, Luna **$0.20/$1.20**, GPT-5.4 mini $0.75/$4.50 (cached input = 10% of input). Cross-validated against the official credit rate card. |

### 1.4 Local Ollama + `:cloud`

- **Local:** $0 marginal cost. Its "price" is latency, RAM pressure and battery/wattage. Treat as a free tier that the router prefers for utility work; capability is the constraint, not money.
- **Ollama `:cloud`:** flat-subscription relay, no per-call cost surface. Count tokens, display as its own wallet with unknown quota; on 429/relay errors, fail over like any other engine.

### 1.5 Anthropic / reference prices for models with no self-reported price

- Claude API list prices (for the "value consumed" math the CLI already does for us): Opus 5 $5/$25, Sonnet 5 $3/$15, Haiku 4.5 $1/$5, Fable 5 $10/$50 per MTok; cache reads ≈0.1×, cache writes 1.25× (5m TTL).
- **LiteLLM's `model_prices_and_context_window.json`** (github.com/BerriAI/litellm) is the de-facto community price map — thousands of models, `input_cost_per_token`/`output_cost_per_token`. **Bundle a snapshot** as the offline fallback price source for anything whose provider reports no price (Codex models, Claude CLI models, exotic OpenRouter gaps). Known footgun: missing models are $0 there — flag "no price known" instead of silently zero.

### 1.6 Routing prior art — what's proven, what to avoid

- **Presets beat sliders.** NotDiamond ships quality/cost/latency modes; OpenRouter ships `cost_tier` bands; OpenAI had to walk back fully-automatic GPT-5 routing and add user-facing Auto/Fast/Thinking toggles. Three named modes + always-available manual override is the commercially validated UX.
- **Role→tier mapping is the strongest zero-cost router.** Claude Code's `opusplan` (Opus plans, Sonnet executes) and aider's architect/editor split (SOTA on their bench at 30–50% lower cost) both ship it in production. The orchestrator/worker split *is* the router.
- **Learned routers (RouteLLM-style) are not worth building here.** RouteLLM's own numbers collapse out-of-domain (14% savings on MMLU vs 85% in-domain); NotDiamond needs per-customer eval training. Skip.
- **FrugalGPT's cascade insight, minus the trained scorer:** in an agent app the quality signal is free — malformed tool call, failed task, parse error, explicit "I can't" → retry one tier up, capped. LiteLLM's fallback chains are the same idea productized.
- **Budget model to copy (LiteLLM):** `max_budget` + `budget_duration` reset per scope, spend ledger, hard refusal at cap. Our differentiator: **degrade gracefully** (bias tiers down as the cap approaches) before hard-blocking.
- **Stickiness matters:** don't switch models mid-conversation without cause — quality consistency and prompt-cache economics (a model switch re-bills the whole context cold).

---

## Part 2 — What Arcelle has today (gap analysis)

> **In plain words:** the app is closer than it looks and further than it looks, in different
> places. **Closer:** prices arrive and are shown, usage is already saved next to every message,
> and both cost figures we need are sitting unread in responses we already parse. **Further:** the
> whole room runs on one model, so "a different model per role" is new plumbing rather than a
> setting; a large share of calls currently report no usage at all; and there is no notion of a
> model being cheap or strong anywhere in the code — the entire idea is one true/false flag meaning
> "is this the local one". Two facts to keep in view: there are **two** places that call the
> external tools, so every change has to land in both, and the routing layer's output ends up on a
> command line, which makes it a security surface.

The full recon map is long; these are the load-bearing facts:

| Fact | Where | Consequence |
|---|---|---|
| **One model per room.** Manager + every worker share a single `ChatModel` per `/run`. | `server.py:114-140`, `graph.py:309/1047` | Per-role routing is a new seam, not a config change. |
| Prices fetched, rendered in the picker (`$X/M`), then **discarded** — `ModelRuntimeFacts` has no price field; nothing crosses to the sidecar. | `providers.rs:33-45, 357-358`; `EngineModelPicker.tsx:353-388` | Cost-per-call is currently uncomputable at the point of the call. |
| `RoundUsage` deliberately carries **input tokens only**; Claude's `total_cost_usd` and `output_tokens` unread; Codex's output/cached/reasoning tokens unread. | `chat.py:97-115`, `external_llm.py:598-708` | The ledger needs a small, load-bearing schema change at exactly one struct. |
| **The one-shot path is blind.** `build_cmdline` (summaries, AI actions, file-pass compose, studio, workflow generate) runs the CLIs with **no** JSON output flag → zero usage captured. | `external_llm.py:711-729` | A large fraction of calls are invisible to accounting until this is fixed. |
| Usage **is** persisted per message (`messages.effects.usage`) but never aggregated; no usage/cost/spend table exists. | `agent.rs:1368-1396`, `db/schema.rs` | Historical backfill partially possible; a real ledger table is needed. |
| Two CLI invocation paths (sidecar + Rust `run_external`) with drifting flags. | `external_llm.py:462-530` vs `external.rs:797-807` | Capture must land in **both** or silently no-op on one. |
| No failover, no tiers, no difficulty signal. The entire capability-tier concept is one boolean (`small_model` = "is local Ollama"). | `graph.py:3034` | Policy layer is greenfield. |
| Workflow nodes already have the only per-task selector: `auto | local | cloud | literal`. | `jobs/workflow.rs:917-939` | Natural place to grow `tier:cheap|smart` semantics. |
| Model strings reach a shell; two validators exist and must gate any new routing config. | `external_llm.py:453`, `external.rs:25-47` | Routing output = attack surface on shared `.roomai` files. |
| Binding QA decisions (2026-08-03): provider capability → **one declared record per provider**; dispatch → **Arcelle-built plan**; token meter scoped to chat. | qa decisions memory | Pricing/tier metadata belongs in that provider record; the Arcelle-built plan is where difficulty tagging lives. |
| Image models: per-token price ≠ per-picture cost — the Create page deliberately renders no invented price. | `create.rs:42-46` | Spend UI shows **provider-reported** cost for media (OpenRouter's `usage.cost` covers image gen), never a computed per-image figure. |

---

## Part 3 — Design

### 3.1 Concept: every provider is a *wallet* with a different currency

> **In plain words:** see Part 0, "the one idea that makes the rest work". Four providers, four
> meanings of "expensive"; one shared number — how close to empty — makes them comparable, and it
> is what tells the saver mode to drain the subscriptions you already paid for before it touches
> real dollars.

The user's real situation: OpenRouter burns **prepaid dollars**; Claude Max and Codex Plus are **sunk-cost subscriptions** that burn *window quota*, not money; local burns **time/watts**. Normalizing these into one abstraction is the key design move:

```
Wallet {
  provider:    openrouter | claude-cli | codex-cli | ollama-cloud | ollama-local
  kind:        metered-credits | subscription-window | flat-relay | free-local
  pressure:    0.0–1.0        // how close to exhaustion
  blocked:     bool           // hard stop observed (402 / limit message / 429)
  cost_kind:   billed | equivalent | none
}
```

- **OpenRouter pressure** = monthly spend ÷ user-set budget (or `limit_remaining` when a key limit exists; balance when a management key is provided).
- **Codex pressure** = max(`primary.used_percent`, `secondary.used_percent`) / 100 from `account/rateLimits/read`, refreshed opportunistically; falls back to "unknown until blocked".
- **Claude pressure** = unknown-until-blocked (no API) — tracked as *our measured value-consumed* against a user-editable "expected window value", plus the blocked flag with reset time parsed from the limit message.
- **Local pressure** = 0 (optionally reflect RAM/thermal state later).

This gives the router one comparable number per provider, and gives the dashboard its wallet cards. **A key routing consequence:** *subscriptions outrank metered credits at equal capability* — Claude/Codex marginal cost is $0 until their windows tighten, so economy mode prefers them wherever they are eligible, and touches OpenRouter credits when they are not, when pressure is high, or when the level asked for is far below what the subscription's model actually is (§3.3). **Amended 2026-08-16:** the local lane no longer appears in this ordering — economy mode excludes local by definition, and pinned mode has no ordering to make. Local's `pressure = 0` still matters for the dashboard, not for routing.

### 3.2 The cost ledger (foundation — everything else sits on it)

> **In plain words:** six pieces of work, and they're the foundation for everything else. Widen the
> one structure that records usage so it carries output tokens and a dollar figure. Fill it in at
> each of the four provider seams — real charges from OpenRouter, Claude's value figure, computed
> figures for Codex (marked ≈), tokens only for local. Fix the calls that currently report nothing.
> Keep the prices instead of dropping them, and mark anything with no known price as *unknown*
> rather than free. Save one row per call in the encrypted room database. And check what's left in
> each wallet occasionally, treating failure to check as "unknown" rather than as zero.

1. **Widen `RoundUsage`** (`chat.py`): add `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `cost_usd: float | None`, `cost_kind: "billed"|"equivalent"|"computed"|None`, `model_id`, `engine`. One struct, all four engines funnel through it.
2. **Capture at each engine seam** (all already parse the right object):
   - OpenRouter: `usage.cost` + `completion_tokens` (+ cached/reasoning details) in `provider_api.py` → `cost_kind: billed`.
   - Claude CLI: `total_cost_usd`, `output_tokens`, cache fields from the envelope in `external_llm.py` **and** `external.rs` → `cost_kind: equivalent`.
   - Codex CLI: full `turn.completed.usage`; cost computed = tokens × price book → `cost_kind: computed` (labeled ≈).
   - Ollama local: tokens only, cost 0, `cost_kind: none`.

   **The two-path problem, and the only honest answer to it.** The Claude and Codex envelopes are
   parsed in **both** `external_llm.py` (Python) and `external.rs` (Rust). The shared idea — invoke
   a CLI, parse its envelope, extract usage — is genuinely one domain rule, but it straddles a
   language boundary, so it cannot be extracted; *practicality beats purity*. What can be shared is
   a **contract and a fixture**: one directory of recorded envelopes (a Claude result event, a
   Codex `turn.completed`, one truncated and one malformed) and a **parity test asserting both
   paths produce byte-identical `RoundUsage` for each fixture**. Duplication proven equivalent is
   fine; duplication merely *hoped* equivalent is the drift the recon already found. The parity
   test is the thing that makes the duplication safe, and it is not optional — without it, every
   future capture change silently no-ops on one side.
3. **Close the blind path:** `build_cmdline` gains `--output-format json` / `--json` so one-shot generation reports usage like agent rounds. (Parse-failure fallback: return raw text, usage None — never break generation for accounting.)
4. **Price book:** persist OpenRouter `pricing` (all fields incl. cache + `overrides`) into `ModelRuntimeFacts` + hand the active model's prices to the sidecar in `ProviderRuntimeConfig`. Bundle a LiteLLM-snapshot fallback table for CLI models. Explicit `price_unknown` state — never invent $0.

   **Units live in the names, not in comments.** OpenRouter reports `/models` prices as USD **per
   token** and accepts `max_price` as USD **per million** — opposite conventions inside one
   integration, where a mix-up is a silent factor-of-10⁶ error in a feature whose entire job is
   reporting money. So: no bare `price` / `cost` floats crossing a boundary. Every carrier says its
   unit — `price_usd_per_token`, `ceiling_usd_per_mtok_out` — and the one conversion lives in one
   named function with a proven-red test over real rate-card values (Luna $1.20/M out, Opus 5 $25/M
   out), not a `* 1_000_000` inline at each call site. A name that needs a comment is unfinished
   work; here it is also a money bug.

   **Retire `small_model` in the same change.** Today's entire capability notion is one boolean
   (`graph.py:3034`) that *means* "is local Ollama" and is *used as* "is weak". Once the price book
   lands there are two answers to one question, and two answers drift. The boolean is two functions
   wearing one name — replace its call sites with the capability they actually wanted (`is_local`
   for the privacy/latency decisions, price-derived strength for the routing ones) rather than
   parking a second concept beside it. This is a precondition for phase 2, not a cleanup for later.
5. **Ledger table** (in the encrypted room DB, so privacy is inherited):
   ```sql
   CREATE TABLE spend_events (
     id INTEGER PRIMARY KEY, ts INTEGER NOT NULL,
     chat_id INTEGER, run_id TEXT, feature TEXT NOT NULL,   -- chat|agent|command|file_pass|summary|imagegen|workflow|studio
     engine TEXT NOT NULL, model TEXT NOT NULL,
     tokens_in INTEGER, tokens_out INTEGER, tokens_cache_read INTEGER, tokens_cache_write INTEGER,
     cost_usd REAL, cost_kind TEXT NOT NULL, estimated INTEGER NOT NULL DEFAULT 0
   );
   ```
   Written once per round/one-shot next to the existing `messages.effects` write. Day/model/engine/feature rollups are simple queries. (Chat-scoped token meter stays as-is — this is the *room-level* time series.)

   **The ledger write may never fail a turn.** Accounting is the secondary feature; generating the
   user's answer is the primary path, and a secondary feature never breaks a primary one. A locked
   database, a failed insert, a schema mismatch — none of them may propagate into the chat. The
   write is fire-and-log: failure lands in the app's own problem channel (the same one the voice and
   privacy seams report to), the turn completes normally, and the dashboard shows a gap rather than
   a lie. **But not silently** — a dropped row means the totals are wrong, so the dashboard carries
   a "some calls in this period were not recorded" note whenever a write failed in the window. An
   invisible undercount in a spend report is worse than a visible hole in it.
6. **Wallet probes** (host-side, lazy + cached):
   - OpenRouter `GET /key` on Settings open + every N minutes while the dashboard is visible; optional management key (Keychain, next to the inference key) unlocks `/credits` balance.
   - Codex `codex app-server` one-shot JSON-RPC `account/rateLimits/read`, schema-tolerant (`resets_at` **or** `resets_in_seconds`), cached ~5 min, failure = "unknown".
   - Claude: maintain `last_blocked_at` + parsed reset time from limit messages; show measured value-consumed for the current 5h/7d windows from our own ledger.

### 3.3 Two modes: Pinned, and Economy on a 0–10 dial

> *Rewritten 2026-08-16 on the owner's decision. This replaces the earlier three-preset design
> (Best quality / Hybrid / Cost saver + Custom), which is kept at the end of this section for the
> record. See Part 0 for the plain-English version.*

**Exactly two modes**, stored as one setting (`routing_mode: "pinned" | "economy"`) plus
`economy_level: 0..10`. There is no Custom and no third preset — the dial *is* the customization.

#### Mode 1 — Pinned (today's behaviour, made explicit)

The user picks one model; every role uses it. Local or cloud, no substitution, ever. Failover still
*offers* an alternative when the provider blocks, but never takes it silently (§"Failover" below).
This mode needs no new routing plumbing — it is the current app with a name.

#### Mode 2 — Economy (no local, dial 0–10)

The user picks **no model at all**. They pick a number. The app selects per call.

**`economy_level` maps to a price ceiling, not a tier list.** The ceiling is USD per million
*output* tokens (output dominates cost and correlates with capability far better than input price).
Log-spaced so every notch moves something:

| Level | Ceiling $/M out | Reaches, at today's rate cards |
|---|---|---|
| 0 | 1.50 | cheapest OpenRouter, Luna ($1.20) |
| 1 | 2.50 | |
| 2 | 4.00 | |
| 3 | 6.00 | GPT-5.4 mini ($4.50), Haiku 4.5 ($5) |
| 4 | 9.00 | |
| 5 | 13.00 | Terra ($12) |
| 6 | 17.00 | Sonnet 5 ($15) |
| 7 | 22.00 | |
| 8 | 28.00 | Opus 5 ($25) |
| 9 | 40.00 | GPT-5.6 Sol ($30) |
| 10 | ∞ | anything available, incl. Fable 5 ($50) |

A ceiling rather than eleven named tiers, for three reasons: prices are continuous and tiers are
not (there are ~4 real tiers, so 11 named ones would be fiction); the mapping stays correct when a
new model ships without anyone editing a table; and it is directly explainable on screen — "up to
$17/M — Sonnet-class and below" — which is what defuses the presets-beat-sliders finding in §1.6.

**The curve is eleven constants, not derived machinery.** An earlier draft of this section proposed
deriving the ceilings from the connected catalogue at build time so no notch is ever dead. That
fails its own test: *abstractions earn their place on concrete triggers — a second caller, a second
implementation — not on diagrams.* There is one catalogue, and no evidence the constants are wrong.
So: ship the table above as constants, and guard it with a test that **every notch admits at least
one model the previous notch did not**, run against the bundled rate cards. If that test ever goes
red, the catalogue has moved and *that* is the concrete trigger for deriving the curve. Imagined
requirements deserve no real complexity.

**Local Ollama is excluded from this mode by design.** Not a filter, a definition: the dial buys
quality with money, and the local model is not on that axis — free, fixed, and weak — so including
it would peg levels 0–2 to the same local model and make three notches do nothing. Users who want
local pin it in mode 1. *The privacy consequence is real and must be surfaced in the mode's own
description, not buried:* utility work that is local today (titles, small summaries, routing
shaping, the privacy guard's own model calls) becomes outbound traffic in this mode. Every one of
those calls goes through the existing redaction door, but the door starts carrying traffic that
never crossed it before, and the privacy screen's outbound inventory must list them.

#### The dial decides *how good*; the wallet decides *who pays*

Two separate resolutions, deliberately not merged:

1. **Eligibility** — every model whose output price ≤ ceiling, from any connected provider.
2. **Selection among the eligible** — cheapest *effective* cost, where subscriptions price at
   **$0 marginal** but carry their `pressure` (§3.1).

Subscriptions therefore compete at **every** level, which is the owner's stated intent ("combined
with Claude or Codex for the cheaper models"). What stops them winning everything and rendering the
dial inert is that quota is finite and tracked: selection prefers a subscription only when the job's
required level is within a notch or two of what that subscription's model actually is. A dial-0
chat title does not spend a Claude Max window when a $1.20/M OpenRouter model is eligible and
genuinely free of quota consequence.

Concretely, per call: `eligible = {m : price_out(m) ≤ ceiling(level)}`; prefer subscription models
inside `eligible` while `pressure < 0.8`; above 0.8 they fall behind metered models of the same
tier; when `blocked`, they leave `eligible` entirely until the reset time.

**Two edges sit just past that boundary, and both need deciding before it is written, not after:**

- **A model with no known price cannot be ranked against a ceiling.** `price_unknown` is already
  correctly refused as $0 in the ledger (§3.2.4) — the same refusal has to reach selection. A
  priceless model is **excluded from automatic selection in economy mode** (you cannot honour a
  ceiling you cannot compute) and **stays fully available in pinned mode**, where the user's own
  choice is the authority. The Settings model list says why — "no price data, not used in economy
  mode" — rather than the model quietly not appearing, which reads as a bug and gets reported as one.
- **`pressure` has three states, not two.** The probes are explicitly allowed to fail (§3.2.6), so
  unknown is a real, expected value — but "prefer while `pressure < 0.8`" silently treats it as
  either 0 or 1 depending on how someone writes the comparison, and those two readings behave in
  opposite ways: as 0 we keep hammering a possibly-exhausted subscription; as 1 a flaky Codex probe
  quietly retires a wallet the user is paying for. **Decided: unknown is eligible but loses ties.**
  It never gains preference from a number nobody measured, and it never loses access on a number
  nobody measured either. Safety comes from the *blocked* signal (402, limit message, 429), which is
  observed rather than probed and is therefore the honest place to carry that weight. In the face of
  ambiguity, refuse the temptation to guess a number — model the absence.

#### The selection boundary: one pure function

Routing is domain logic and must not be smeared through the provider adapters. The whole decision is
one pure function with no I/O:

```
choose_model(level, roles_offset, catalogue, wallets, difficulty) -> Choice { model, engine, why }
```

No HTTP inside it, no SQLite, no CLI. The catalogue and the wallet snapshots are passed **in** as
plain data; the reason for the choice comes **out** as data, which is what the routing log and the
"why did it pick this" line in the activity feed render — rather than each of them re-deriving it.
*Dependencies point inward: the database is a detail, the provider APIs are details.*

This is the call that makes everything above testable without a network: every rule in this section
— the ceiling, the subscription preference, unknown pressure, the priceless model, the role offsets,
the escalation clamp — becomes a table-driven test over literal inputs. Put the same logic inside
`provider_api.py` and `external_llm.py` and it is testable only by standing up two providers, which
in practice means it is never tested at all.

Two consequences worth naming now, so they are not discovered later:

- **The function answers; the caller acts.** `choose_model` returns a choice and writes nothing —
  no ledger row, no wallet mutation, no setting. *A function answers a question or changes the
  world, never both.* The caller performs the call and records the spend.
- **The wallet snapshot passed in is a value, not a live handle.** One decision reads one consistent
  set of pressures; probes refreshing mid-decision cannot change an answer halfway through.

**Role offsets stay** — they were the strongest zero-cost router in the prior art (§1.6) and cost
nothing here: **Orchestrator = level + 1**, **Workers = level**, **Utility = level − 1**, each
clamped to 0–10. So one dial still produces the opusplan/architect-editor split that is proven in
production, without the user managing three settings.

**The difficulty signal still applies, now inside the ceiling.** The Arcelle-built plan (binding QA
decision #2) tags each step `easy | normal | hard` at zero marginal cost — the planner was running
anyway. In economy mode those tags move a step ±1 level *within* the ceiling rather than choosing a
tier outright. Fallback when no plan exists (plain chat): task-type rules (summarize/extract/format
→ down; plan/debug/synthesize → up) + context-size proxies.

**Escalation is clamped by the ceiling.** A worker that observably fails — malformed/empty tool
call, structured-output parse failure after the existing retry, task marked failed, "I can't" —
reruns once at a higher level, **never above the user's dial**. Already at the ceiling and still
failing → report it ("this needed a stronger model than level 5 allows"), do not silently exceed
the number the user set. The alternative (allow one crossing, logged) is defensible and was
rejected: a ceiling that leaks is not a ceiling, and the whole point of a number is that it holds.
Escalation is logged in the run activity either way.

**Wallet pressure biases within the mode, never against the dial:** as a wallet passes 0.8 the app
reorders *who serves* a level, and notifies; it does not lower the level. Only a user moves the
dial. (This is a change from the old design, where "cost saver" quietly biased tiers down.)

**Failover (both modes, always on):** provider-blocked signals (OpenRouter 402, Claude/Codex limit
messages, relay 429) mark the wallet `blocked` with a reset time. In economy mode, selection simply
reroutes within the ceiling and says so ("Claude hit its 5-hour limit — using Codex until 14:30").
In pinned mode it never substitutes silently — it surfaces a choice (the "no silent substitution"
principle already established in the vision-model work).

**Stickiness:** a conversation keeps its chosen model until the chat ends, the wallet blocks, or
the user overrides. Moving the dial affects *new* chats and new runs — it does not rewire a
conversation in flight, because a mid-chat switch re-bills the entire context cold.

**Transparency:** every economy decision is inspectable — the run activity shows
`step 3 → luna (easy, level 4→3, $0.002)`, and the Settings dial shows which models it currently
admits given the connected providers.

**Media (image/video) is out of scope for the dial** — per-token ceilings are meaningless for
per-picture pricing (`create.rs:42-46`). The user's picked model stands; economy mode may warn when
a per-call provider-reported `usage.cost` exceeds a threshold.

#### What this removes from the build

The two-mode design is **cheaper to build than the three-preset one**: no policy-bundle structure,
no Custom JSON schema, no per-role model pickers in Settings, and no tier ladder as a stored
concept (the ceiling test replaces it — a model needs a *price*, which the price book already has,
not a *tier*, which someone would have to curate). One integer setting replaces a policy object.

<details>
<summary><strong>Superseded — the original three-preset design (kept for the record)</strong></summary>

Three presets + Custom, stored as one setting (`routing_mode`) plus a small JSON policy for Custom. Each preset is a *policy bundle* over three roles — **Orchestrator** (the Main agent / planner), **Workers** (dispatched specialists), **Utility** (titles, routing shaping, small summaries, privacy guard — today mostly local already):

| | **Best quality** | **Hybrid / Auto** (default) | **Cost saver** |
|---|---|---|---|
| Orchestrator | strongest available (tier S) | tier S | tier A, prefer subscription/local |
| Workers | tier S | **planner-tagged**: easy→LOCAL/B, normal→A, hard→S | LOCAL/B, prefer subscriptions |
| Utility | tier A | LOCAL | LOCAL |
| Escalate on failure | n/a (already at top) | +1 tier, max 2 per task | +1 tier, max 1 per task |
| Wallet pressure | ignored | bias tiers down as pressure > 0.8; notify | subscriptions → local → credits, hard prefer-free |
| Media (image/video gen) | user's picked model | user's picked model | warn if per-call `usage.cost` > threshold |

**Tier ladder** = derived, not hardcoded: every known model gets a tier from its price book entry + capability record (the QA-#6 "one declared record per provider" grows `tier` + `prices`). Roughly: S ≥ $4/M in (Opus, GPT-5.6 Sol, big OpenRouter), A ≈ $1–4/M (Sonnet, Terra), B < $1/M (Haiku, Luna, cheap OpenRouter), LOCAL = free. User's connected engines determine what's actually available in each tier; the room's explicitly-picked model always wins when the user picked one (mode governs *auto* choices only).

**Why it was replaced:** the owner wanted a single continuous control rather than named bundles, and local excluded from automatic selection entirely. The difficulty signal, escalation, failover, stickiness and transparency all survived into the design above — only the preset structure and the tier ladder were dropped.

</details>

### 3.4 Settings: "Models & Spend" section

> **In plain words — one new Settings page, read top to bottom:** first, pick your mode (two
> cards, each with a one-line "here's what this actually does to your app"). Then a card per
> provider showing what's left in it — dollars for OpenRouter with a monthly cap you can set,
> window meters for Claude and Codex, a "free" badge for local. Then the charts: 30 days of daily
> spend, split by which feature spent it, and a table of your most-used models. Anything the app
> worked out itself carries a ≈; images show only what the provider actually charged. The fiddly
> policy switches hide behind a "more" disclosure, and at the bottom sits a short log of the last
> 20 automatic choices with the reason for each — so the routing is inspectable rather than magic.

Home: **AI & behavior** group (`Settings.tsx` `SETTINGS_GROUPS[0]`), new id `set-models-spend`, between `set-model` and `set-support-matrix`. Follows the `AiProvidersSection` pattern (self-fetching section). Layout, top to bottom:

1. **Mode picker — two cards** (radio semantics), per the 2026-08-16 decision:
   - **Pinned** — expands to today's `EngineModelPicker`. "Everything uses the model you choose."
   - **Economy** — expands to the 0–10 dial. Under it, always visible and always live:
     - the ceiling in words and dollars — *"level 6 · up to $17 per million · Sonnet-class and below"*;
     - **which models this admits right now**, from the connected providers only (the thing that
       makes a slider readable rather than a vibe — §1.6's presets-beat-sliders risk);
     - a rough monthly estimate from the ledger's last 30 days re-priced at this level, marked ≈;
     - the privacy line, not in small print: *"Economy mode does not use the model on your Mac.
       Chat titles and summaries that stay local today will be sent to a paid provider."* with a
       link to the privacy screen's outbound inventory.
   - No Custom card and no per-role pickers — role offsets (orchestrator +1 / utility −1) are
     implicit and shown in the routing log, not configured.
2. **Wallet cards** (one per connected provider):
   - *OpenRouter*: this month $ (ledger), daily/weekly/monthly from `/key`, `limit_remaining`, balance if management key present; budget input ("monthly cap $__") + hard/soft toggle.
   - *Claude Max*: value consumed this window / this week (≈$, labeled "plan value used, not billed"); blocked state + reset countdown when known.
   - *Codex Plus*: 5h + weekly meters (`used_percent`, resets), credits balance; "meter unavailable" state when the probe fails.
   - *Local*: calls + tokens, "free" badge. (In economy mode this card shows zero by definition —
     worth stating on the card rather than looking broken.)
3. **Consumption dashboard**: 30-day stacked daily bars (by engine), spend-by-feature split (chat / agents / images / file passes / commands), top-models table (calls, tokens, $, ≈ flags). Every computed figure carries the ≈ mark; media shows provider-reported cost only.
4. **Policy details** (in a `set-more` disclosure): escalation on/off + cap, subscriptions-before-credits toggle, budget-pressure behavior (notify-only vs hard stop — *not* "bias down", see §3.3: pressure never moves the user's dial), per-call ceiling for Claude (`--max-budget-usd`).
5. **Routing log** (small): last 20 auto decisions with reasons.

Mockup: see the published artifact ("Arcelle — Models & Spend settings mockup").

### 3.5 Phasing

- **Phase 1 — Ledger + dashboard (no routing).** RoundUsage widening, both CLI paths **plus the envelope parity test that keeps them honest**, blind-path fix, price book with units in the names, `spend_events` (write can never fail a turn), wallet probes, the Settings section with wallets + dashboard, budgets as *display-only* thresholds. Value on day one: the user finally sees where tokens/dollars go. Low risk — no behavior change to model selection. **The blind-path fix is not optional inside this phase:** summaries, AI actions, file passes, studio and workflow-generate currently record nothing, so shipping the dashboard without it produces a confident, wrong number — which is worse than no dashboard.
- **Phase 2 — The two modes on existing seams.** `routing_mode` + `economy_level` settings; the
  per-role model resolution seam (orchestrator vs worker vs utility `ChatModel`s — the genuinely
  new plumbing, and the only hard part); the ceiling test over the price book; subscription-aware
  selection; failover-on-blocked; the Settings mode picker with the live "admits these models"
  readout. **Pinned mode ships for free here** — it is the current behaviour named. Workflow node
  lanes grow a level override.
- **Phase 3 — The smart parts.** Difficulty tags from the Arcelle-built plan moving steps ±1 within
  the ceiling (lands with the dispatch replacement anyway), escalation cascade, wallet-pressure
  reordering, routing log.

Phase 2 no longer waits on anything: the ceiling test needs only the price book from phase 1, and
the difficulty signal it would have needed is now a phase-3 refinement rather than the mechanism.
That is a direct consequence of the dial replacing the presets — a price ceiling is computable from
data we already have, whereas "hybrid/auto" needed the planner's tags to mean anything at all.

### 3.6 Risks & sharp edges (from the recon — don't relearn these)

- **Two CLI invocation paths** — every capture change lands in `external_llm.py` *and* `external.rs`, or it silently no-ops on one. The boundary is a language boundary, so this duplication cannot be extracted away; it is made safe by the **envelope parity test** in §3.2.2 instead. Without that test this bullet is a warning nobody will remember; with it, the drift is caught mechanically.
- **Routing emits model strings that reach a shell** — all policy output goes through `_SAFE_CLI_ARG` / `check_cli_slug`; failure is a hard error, never a dropped flag. Shared `.roomai` files make this real.
- **Codex quota API is undocumented** — schema-tolerant parsing, best-effort display, never a routing *hard* dependency (pressure=unknown is a valid state).
- **`/credits` needs a management key** — probe, degrade to `/key`, offer the paste box.
- **Don't invent media prices** — per-token ≠ per-picture (the Create page already encodes this); show provider-reported `usage.cost` only.
- **Claude catalog = 230 MB byte-scan, Codex catalog = subprocess** — both process-cached; never put a routing decision behind a fresh catalog read.
- **LiteLLM map gaps read as $0** — model without a price = `price_unknown`, shown as "no price data", excluded from totals with a footnote.
- **Token bar hides below 70% fill** (`TOKEN_METER_VISIBLE_PCT`) — a spend chip reusing that row inherits the gate unless excluded.
- **Privacy:** the ledger lives in the encrypted room DB; wallet probes are metadata-only outbound calls (key → provider, no room content) but should still be listed on the privacy door's inventory of outbound calls. **Economy mode adds a second, larger privacy delta:** utility work that runs local today (titles, small summaries, routing shaping, the privacy guard's own model calls) becomes outbound. Same door, materially more traffic — the inventory and the mode's own description both have to say so (§3.3, §3.4).

### 3.7 Decided failure behaviour, and the tests that prove it

*Added 2026-08-16. Every new I/O path gets a decided failure behaviour, written before the code —
a secondary feature never breaks the primary path, and degraded success beats total failure.*

| New path | When it fails | What happens | Where the user sees it |
|---|---|---|---|
| Usage parse (any engine) | envelope missing / malformed / CLI too old | generation returns normally, `usage = None`, row still written with null tokens | dashboard footnote: calls not fully recorded |
| **Ledger write** | DB locked, insert fails | **the turn completes** — write is fire-and-log, never in the turn's error path | "some calls in this period were not recorded" on the affected range |
| OpenRouter `/key` probe | network, 401, rate limit | wallet shows last known + "as of HH:MM"; pressure = **unknown** | greyed figure with a timestamp, not a zero |
| OpenRouter `/credits` | no management key (403) | degrade to `/key` numbers; offer the paste box | "paste a management key to see your real balance" |
| Codex `app-server` probe | undocumented API drifted, binary absent | meter unavailable, pressure = **unknown** | "meter unavailable" on the card |
| Claude quota | no API exists at all | our measured value-consumed + blocked flag only | labelled "measured by Arcelle", never presented as Claude's own number |
| `choose_model` finds nothing eligible | ceiling too low for every connected model | **refuse and say so** — never silently exceed the ceiling, never silently fall back to a model the user's level excludes | "level 0 admits no connected model — raise the level or connect a cheaper provider" |
| Escalation needed above the ceiling | cheap model failed at the user's level | report, do not exceed | "this step needed a stronger model than level 5 allows" |
| Price lookup | model absent from both sources | `price_unknown` → excluded from economy selection, excluded from totals | "no price data" on the model, footnote on the totals |
| Wallet blocked mid-run | 402 / limit message / 429 | economy reroutes within ceiling and announces; **pinned surfaces a choice, never substitutes** | "Claude hit its 5-hour limit — using Codex until 14:30" |

**Tests, each proven red on the unfixed code before the fix lands.** *A test that never failed
proves nothing; a test that doesn't run doesn't exist.* One behavioural promise each:

| Test | Promise | Proven red by |
|---|---|---|
| Envelope parity | `external_llm.py` and `external.rs` produce identical `RoundUsage` for the same fixture | today's code — the Rust path reads no cost field at all |
| Price unit conversion | per-token → per-M is exact for real rate cards (Luna $1.20/M, Opus 5 $25/M) | inverting the conversion; a 10⁶ error must fail loudly |
| No dead notch | every dial level admits ≥1 model the level below does not | collapsing two adjacent ceilings |
| Ceiling is honoured | no model above `ceiling(level)` is ever selected, including after escalation | letting escalation cross the ceiling |
| Unknown pressure | a subscription with unknown pressure is eligible, but loses a tie to a measured one | forcing unknown → 0.0 and to 1.0; both must fail |
| Priceless model | excluded from economy selection, present in pinned | treating `price_unknown` as $0 |
| Blind path closed | a one-shot summary records a `spend_events` row | today's code — it records nothing |
| Ledger never breaks a turn | insert failure leaves the assistant message intact | making the write part of the turn's transaction |

All of these except the last two run against `choose_model` as pure data — no network, no database
— which is the practical payoff of the boundary in §3.3.

---

## Appendix — failover signal cheat sheet

| Provider | Signal | Detection |
|---|---|---|
| OpenRouter | out of credits | HTTP 402 (also on free models when negative) |
| OpenRouter | key limit hit | `limit_remaining` ≤ 0 on `/key`; request errors |
| Claude Max | 5h/weekly limit | stderr/JSON text "You've hit your session limit" / "…weekly limit" (+ reset time) |
| Codex Plus | window/credits out | message prefix **"You've hit your usage limit"**; `--json` `turn.failed` |
| Codex (API key mode) | rate limit | HTTP 429 `rate_limit_exceeded` |
| Ollama `:cloud` | relay throttle | 429 / relay error sentinels already classified in `server.py` |
| Local | daemon down / model missing | existing `OLLAMA_DOWN` / `MODEL_MISSING:*` sentinels |
