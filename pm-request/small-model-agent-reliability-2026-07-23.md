# Making the Arcelle agent reliable on a 4B model — deep research report

**Date:** 2026-07-23
**Method:** 106-agent research harness — 5 search angles, 24 primary sources fetched, 118 claims extracted, top 25 adversarially verified by 3-vote refutation panels (20 confirmed, 5 refuted, 0 unverified). Every number below survived verification against the primary source (papers/leaderboard CSVs read directly, not blogs).

---

## Executive summary

The evidence says "a 4B agent that works perfectly" is achievable **only if the harness, not the model, owns the hard parts**. The single most important measured fact:

> On BFCL V4 (April 2026 data), **Qwen3-4B-Instruct-2507 scores 87.88% on single-turn tool calls — frontier parity — but collapses to 22.12% on multi-turn** (frontier models hold 53–68%). Overall: 35.68% vs Claude Opus 4.5's 77.47%.

**The 4B model is not bad at calling tools. It is bad at *being an agent* — planning, tracking state, and staying coherent across turns.** So the winning architecture keeps the model inside its zone of competence (one tool decision at a time, short catalog, externally enforced format) and moves planning, state, and verification into deterministic code.

Ranked interventions by expected reliability gain (each individually evidenced; the ranking is a cross-study synthesis):

1. **Demote the loop: single-shot decisions inside deterministic scaffolds** (fixes the 87.88→22.12 collapse)
2. **Swap in / LoRA-tune a function-calling-specialized small model** (FC-tuned 3B beats 32B and 70B generalists at multi-turn tool use)
3. **Enforce output structure externally** — native FC mode / constrained decoding + repair loop (~3× fewer decode failures)
4. **Catalog design: few tools per decision, semantics in descriptions not names, code-side argument validation**
5. **Few-shot exemplars: test per-model, don't assume** (7%→89% for one model, 0% change for another)

---

## Finding 1 — The failure is multi-turn agency, not tool calling  ⭐ the load-bearing fact

**Confidence: HIGH (verified 3-0 against the primary BFCL V4 CSV, 2026-04-12)**

| BFCL V4 category | Qwen3-4B-Instruct-2507 (FC) | Claude-Opus-4-5 (rank 1) |
|---|---|---|
| Overall | 35.68% (rank 54) | 77.47% |
| Non-Live single-turn AST | **87.88%** | (comparable) |
| Live single-turn | 76.39% | — |
| **Multi-turn** | **22.12%** | 53–68% band for frontier |
| Agentic web search | 3.00% | — |

The collapse is differential and 4B-specific. Arcelle runs a multi-turn ReAct loop — meaning today's architecture exercises the 4B model exactly where it is weakest and ignores where it is frontier-grade.

**Implication:** every round the model has to (a) remember the plan, (b) remember environment state, and (c) pick the next action is a round drawn from the 22% distribution. Every round where code hands it a pre-framed single decision is drawn from the ~88% distribution. **The architecture goal is to convert rounds of type (a-c) into rounds of the second type.**

Corroborating failure-mode data (ICML 2025 BFCL paper, Sec 5.4.2): the most prevalent multi-turn failure across ALL models is **hallucinating/misassuming environment state** (wrong directories, premature termination) — not argument formatting. And a companion 2026 study found Qwen3-4B is also a *weak judge of its own steps* (~56–59% step-accuracy vs 81.6% for a frontier judge) — so a 4B self-critic loop cannot rescue a 4B actor.

**For Arcelle concretely:**
- The scaffold (Rust/Python code) should **re-inject verified state into every round**: current room, open file, selection, running-job status — as fresh structured context, never trusting the model's conversational memory. (Rated medium-confidence as a prescription — it's inferred from failure data, not a benchmarked intervention — but it targets the #1 measured failure mode.)
- For multi-step tasks, prefer **plan-then-execute over free ReAct**: a fixed scripted plan (or a plan authored once, by the strongest available engine or by the user's workflow) where the 4B fills one slot at a time. Arcelle's Rust jobs/workflow DAG runner is *exactly* this shape already — the research says lean on it harder for the local engine, not less.
- The existing graph.py guardrails (tool-less final round, duplicate suppression, forced synthesis) are validated by this data — they are crutches *for the right leg*. Keep them on the 4B path.

## Finding 2 — FC-specialized fine-tuning is the biggest model-side lever

**Confidence: HIGH (7 claims merged, all verified against Hammer paper tables, xLAM/NAACL 2025 paper, ICML 2025 BFCL paper, live leaderboard CSV)**

Function-calling-tuned 1–8B models repeatedly beat models 10–50× larger:

- **Hammer-7B**: 83.92% on BFCL v2 (09/2024), second only to GPT-4; beat GPT-4 on executable eval (89.72)
- **Hammer-4B**: 76.05% — its untuned Qwen1.5-4B base averaged 42.25 F1; tuning took it to 71.35
- **xLAM-1b-fc-r (1.35B!)**: 75.43% — above Claude-3-Opus (FC) and GPT-3.5-Turbo
- **ToolACE-2-8B** (56.6) outranks Claude-3.5-Sonnet FC (53.8) in the peer-reviewed BFCL paper
- **On current BFCL V4 multi-turn: xLAM-2-3b-fc-r scores 58.38% — beating Qwen3-32B (47.87%), Llama-3.3-70B (21.50%), and general Qwen3-4B (22.12%). The 8B xLAM-2 hits 70.00%, in frontier territory.**

**Fine-tuning moves multi-turn performance more than parameter count does.**

What drives the gains is **execution-verified synthetic training data, not architecture** (xLAM ablations: data augmentation +2.3 to +18.3 points, data cleaning a further +23.4 on ToolQuery; APIGen pipeline = format → execution → semantic verification filters; dataset public on HuggingFace).

Caveats (verified): the v1 Hammer/xLAM scores are BFCL-v2-era snapshots (single-turn-heavy); xLAM-2-3b is a narrow specialist — near-zero on web-search/memory categories. These are **executors, not planners** — which is fine, because Finding 1 says don't let the small model plan anyway.

**For Arcelle concretely:**
- **Evaluate xLAM-2-3b/8B and Hammer-class models as the local engine** behind the existing tool loop (they run in Ollama-compatible runtimes). The 8B at 70% multi-turn is a different reliability universe from qwen-4B's 22%, at a size that still fits the Mac-local story.
- **The LoRA path is real and evidence-backed**: generate traces of Arcelle's own ~40 tools, keep only traces that *execute successfully in the app sandbox* (the APIGen recipe), LoRA-tune the local model on them. Arcelle can generate this data mechanically — the app IS the execution verifier. Cost/volume for a 40-tool catalog is an open question (the "fine-tuning is cheap" OPT-350M claims were refuted 0-3 in verification — do not budget off those).

## Finding 3 — Enforce structure outside the model

**Confidence: HIGH**

The dominant small-model failure on function calls is **output-format non-compliance** (unparsable JSON / uncontrolled generation — study of 1.3B–3.8B models on the xLAM dataset). Measured remedies:

- **Native FC mode cuts decoding failures ~3×** vs prompt-based tool calling (182.5 vs 412.93 issues per 4,251 entries — ICML 2025 BFCL paper).
- But FC mode is measurably **worse at parallel multi-call turns** (77.5 vs 21 incorrect call-counts among decoded responses). **Never ask the 4B for parallel tool calls. One call per round.**
- Format rules embedded in JSON-schema *descriptions* are unreliable even for frontier models: on IFEval-FC, **no model — including GPT-5 and Opus 4.1 — exceeded 80%** adherence (best: 79.87%). For a 4B: **argument formats (dates, enums, path shapes) must be validated and repaired in code, never trusted to description text.** (Medium confidence: single-author preprint, but fully algorithmic eval with open code.)

**For Arcelle concretely:**
- Use Ollama's native FC / structured-outputs (grammar-constrained) path for every tool decision; keep the existing `recover_json` as the repair fallback rather than the primary parse.
- Add a **code-side argument validator** in front of `exec_tool`: check enums/paths/ranges, and on failure return a *structured, specific* repair message ("`page` must be an integer ≤ 412") for one retry round — this converts the top frontier-grade failure class into a deterministic fix.
- Enforce single-call rounds on the 4B path (the duplicate-suppression logic already halfway does this).
- One flagged trade-off to test (surfaced in the sweep, not among the verified 25): hard grammar-constraint can raise schema validity to 100% while *lowering answer accuracy* on small models ("constraint tax"). Mitigation: constrain the envelope (tool name + arg keys), validate values in code — don't grammar-constrain free-text arg values.

## Finding 4 — Catalog design: descriptions carry the semantics; small per-decision subsets

**Confidence: HIGH (Hammer paper Figs 2/5, Table 5; independently corroborated by IBM TrustNLP 2025 robustness study)**

- Small models are **systematically misled by tool naming conventions** — name style alone (CamelCase vs snake_case, suggestive names) can flip tool selection and explains large cross-benchmark variance.
- Training with **function masking** (random-string names → model must read descriptions) largely fixes it: under test-time name masking, xLAM-1B dropped sharply; masking-trained Hammer-1.5B barely moved.
- **Explicit irrelevance handling is load-bearing**: ~10% "no tool applies" training data materially improved Hammer's robustness. A catalog with no none-of-the-above escape teaches forced wrong calls.

**For Arcelle concretely:**
- **The short-catalog doctrine is validated** — small per-decision tool subsets are the right call for a 4B. What the evidence does NOT support is the *keyword trigger* deciding the subset. Replace the substring router with either (a) a stable always-on core + retrieval for the periphery, or (b) semantic retrieval over tool descriptions. (Directional, from the sweep's fetch layer: RAG-over-tools tripled selection accuracy vs all-tools-in-prompt in one MCP study, 13.62%→43.13%, and full-pool schema injection collapsed even Claude-3.5 from ~98%→69%; an adaptive-subset study measured 93.1% correct selection when showing ~2 tools vs 87.1% at 5. These specific numbers were not among the 25 verified claims — treat as strong leads, not established facts.)
- **Rewrite every tool description as the primary decision signal**: what it does, when to use it, when NOT to use it, one concrete arg example. Audit that no tool's purpose is inferable only from its name.
- Give every decision point an explicit **"no tool / answer directly"** option.

## Finding 5 — Few-shot exemplars: a per-model gamble

**Confidence: HIGH (verified verbatim against Kavathekar et al. 2025)**

3-shot prompting took Deepseek-Coder-1.3B from **7.34% → 89.38% JSON parsability** (1.11% → 55.65% task accuracy) — and left Phi-3-mini at **0% parsability, unchanged**. "Many models are unable to perform better even after providing examples."

**For Arcelle:** A/B the current prompt ± 2–3 canonical tool-call exemplars *on the exact shipping model* using the rec_bench-style harness. Could be a massive free win or nothing; only the test tells.

---

## What was refuted (do not build on these)

Five widely-circulated claims died 0-3 in adversarial verification:

1. The dramatic fine-tuned parsability numbers (99.4%/99.6%) attributed to the "Small Models, Big Tasks" paper — not supported by the source.
2–3. OPT-350M hitting 77.55% on ToolBench after one cheap SFT epoch ("fine-tuning is nearly free") — refuted; the cheap-specialization cost estimate is unknown.
4. "o1 gets only 12% on memory category → all models fail at state, size irrelevant" — the specific number didn't hold; the *differential* (4B collapses harder) is what's true.
5. The IFEval-FC "capability gradient" extrapolation to 4B models — the 4B extrapolation was not measured; only the frontier <80% ceiling stands.

## Open questions the literature genuinely hasn't answered

1. **The exact catalog-size threshold** for a 4B (how many tools per decision before accuracy bends) — no surviving quantitative evidence; needs in-house measurement.
2. **Do markdown skills / progressive disclosure measurably help small models?** Zero verified evidence either way — the entire skills arm came back empty. (Skills clearly help by *shortening the decision*, but no one has benchmarked it at 4B scale.)
3. **Cost to LoRA-specialize qwen-class 4B on a 40-tool catalog** (data volume, epochs) — unknown after the OPT-350M refutations.
4. **Constraint tax at 4B**: does grammar-constrained decoding hurt *selection* while fixing *parsability*? Flagged, unresolved.

These four are all answerable in-house with the app as the eval harness (it can execute-verify every trace).

---

## Recommended architecture (synthesis — each part evidenced, composition not benchmarked end-to-end)

**The 4B lane ("perfectly, no matter what") — model as slot-filler, code as agent:**

1. **Deterministic scaffolds own plans and state.** Multi-step work routes through the Rust jobs/workflow DAG (already durable + resumable); the model makes one decision per step. Free ReAct on the 4B is capped at short horizons; the scaffold re-injects verified app state (room, file, selection, job status) every round.
2. **FC-specialized model.** Evaluate xLAM-2-8B / xLAM-2-3b / Hammer as the local engine; medium-term, LoRA-tune on execution-verified traces of Arcelle's own tools (the app is the verifier — APIGen recipe).
3. **Structure enforced outside:** native FC/grammar decoding on the envelope, code-side argument validation with one structured repair round, single-call rounds only.
4. **Catalog:** stable tiny core + retrieved periphery (replacing keyword routing); description-first specs; explicit no-tool option.
5. **Few-shot exemplars** if (and only if) the A/B on the shipping model says so.

**The strong lane (claude-cli / codex / cloud):** none of these crutches — full catalog or search-then-call, free multi-turn agency. This is the engine-tiered split from the 2026-07-22 analysis, now with quantitative backing: the two lanes fail differently, so they must be scaffolded differently.

**Sequencing by leverage:** (1) state re-injection + single-decision framing — pure harness code, no model change; (2) xLAM-2/Hammer evaluation — a weekend eval against rec_bench-style tasks; (3) FC-mode + code-side validation + repair; (4) catalog rewrite (descriptions, no-tool option, retrieval periphery); (5) few-shot A/B; (6) LoRA program on app-verified traces — the long pole, gated on (2)'s results.

---

## Primary sources

- BFCL V4 leaderboard + data CSV (2026-04-12): https://gorilla.cs.berkeley.edu/leaderboard.html
- BFCL paper (ICML 2025): https://proceedings.mlr.press/v267/patil25a.html
- Hammer — function masking (arXiv 2410.04587): https://arxiv.org/abs/2410.04587
- xLAM / APIGen (NAACL 2025, arXiv 2409.03215): https://arxiv.org/pdf/2409.03215
- Small Models, Big Tasks (arXiv 2504.19277): https://arxiv.org/html/2504.19277
- IFEval-FC (arXiv 2509.18420): https://arxiv.org/pdf/2509.18420
- IBM TrustNLP 2025 tool-robustness: https://aclanthology.org/2025.trustnlp-main.20.pdf
- CodeAct (ICML 2024, arXiv 2402.01030), RAG-MCP (arXiv 2505.03275), MCP-Zero (arXiv 2506.01056) — sweep layer, directional
- Verification stats: 24 sources fetched, 118 claims extracted, 25 verified (20 confirmed / 5 refuted / 0 unverified)
