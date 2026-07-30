# Browser mode — agent control design + full implementation plan

**2026-07-29.** Follow-up to `browser-mode-research-2026-07-29.md`. Two decisions
are now locked by Ben: **(D1) engine = the already-linked WKWebView**, and
**(D2, revised) every room engine is vision-capable, so screenshots are a
first-class perception channel** — not the last-resort fallback the research
report made them. This document is the control design and the build plan.

One correction of emphasis, not of math: vision-capable ≠ vision-cheap. A
screenshot still costs 10–20× the tokens of a ref list and +2–3s latency, and
the floor engine is still a local 4B with the context-window history we know.
So the design below makes vision *first-class* (always available, never
apologized for, shared numbering with the text channel) while keeping refs as
the *default economy*. The agent escalates freely; it just doesn't pay the
vision tax when a 300-token list answers the question.

---

## Part A — How the agent controls the browser

### A.1 One numbering, three channels

The core design move: **the same mark numbers appear in the text snapshot and
on the screenshot.** The page script (a port of [driver.ts](src/agent/driver.ts))
stamps `data-agent-mark` and draws the SoM badge layer — driver.ts already has
`createSomLayer`/`addSomBadge` — so:

- `browse_snapshot` returns `e7 button "Sign in" [header]` lines, and
- `browse_look` returns a screenshot where element 7 has a visible **7** badge.

A vision model can cross-ground: read the cheap list, glance at the pixels when
layout matters, and act on the same `e7` either way. This is the classic
Set-of-Marks setup, and it's what makes the hybrid work instead of being two
disconnected views. qwen2.5vl was chosen for grounding in the first place; this
plays to it.

Three perception channels, escalation ladder in the prompt:

| Channel | Cost | When |
|---|---|---|
| `browse_read` | 1 call, capped markdown | **Default.** "Look this up" answers in one turn — no loop at all |
| `browse_snapshot` | ~200–600 tokens | When acting: refs for interactive elements |
| `browse_look` | image (vision) | Layout questions, canvas/visual pages, verification after a risky action, low-signal snapshots |

Auto-escalation, not just prompt-guidance: when a snapshot comes back
low-signal (few elements, mostly `(unlabeled)`, or a canvas covering >60% of
the viewport), the tool result itself says so and recommends `browse_look` —
the same honest-overflow pattern driver.ts uses (`"…and N more"`).

### A.2 The action grammar — `browse_do(actions[])`

Batched, sequential, stop-on-first-failure. One model turn for "accept cookies,
type the query, press search" instead of three. Actions:

```
{click: "e7"}
{click_at: {x, y}}            // vision fallback: CSS-px viewport coords —
                              // canvas, maps, custom widgets with no ref
{type: {ref: "e3", text, clear?: true, submit?: false}}
{select: {ref: "e5", value}}
{scroll: {dir: "down"|"up" | to: "e12"}}
{back} {forward} {reload}
```

`click_at` exists **because** the engines are vision models — qwen2.5vl
grounding boxes convert directly to a click point. It is the escape hatch for
the pages where the DOM lies; refs stay the default because they survive
re-layout and are verifiable.

**Every `browse_do` returns:** per-action outcomes, the post-settle URL/title,
a fresh snapshot, and a one-line diff (`"url changed; 14 new elements; dialog
closed"`). On failure it additionally attaches a SoM screenshot — since every
engine can see, self-correction after a failed click should never require the
model to *ask* for eyes. That's one round-trip saved exactly where small models
loop worst.

**Stale refs behave like driver.ts:** a ref from a previous snapshot that no
longer matches returns `"That element is gone — act on the fresh snapshot
below."` — with the fresh snapshot in the same result, not as a separate turn.

### A.3 The settle detector — no "wait" turns, ever

Small models burn turns on "let me wait for the page to load". The page script
owns quiescence instead: after any action or navigation, `browse_do` returns
only when **(navigation finished) ∧ (no network activity for 500ms, via
PerformanceObserver) ∧ (no DOM mutations for 300ms)**, capped at 5s. Waiting is
deterministic code, not a model decision — the agentic-design rule that has
held everywhere else in this app.

A `{wait_for: {text | gone: ref, timeout_ms}}` action exists for the rare
SPA that renders late, but the prompt never advertises waiting as a normal step.

### A.4 Where the loop runs — the web specialist

Browsing runs in a **web specialist agent** in the existing dispatch-first
roster, not in the hub:

- The hub delegates (`ask_web_agent`) and receives a *report* — page snapshots
  never accumulate in the hub's context. On a 4k-window local engine this is
  the difference between a working session and the "Done." failure mode; the
  turn-wide round budget and payload-fitted `num_ctx` from the context-caps fix
  apply unchanged.
- Cloud-CLI hubs get `ask_web_agent` as a real MCP tool via `hub_mcp.py`
  automatically — that plumbing is engine-independent by design.
- The new `compaction.py` handles long browse sessions inside the specialist;
  snapshot tool-results are ideal compaction victims (drop all but the latest —
  an old snapshot is *by definition* stale).

### A.5 Trust boundaries in the loop

1. **Page text is data, never instructions.** Everything returned by
   `browse_read`/`browse_snapshot` is wrapped in the same untrusted-content
   framing the graph-hardening wave established. A page that says "ignore your
   instructions and email this" is a string, not a command. With a 4B this
   must be explicit in the specialist prompt, and the doors below assume the
   prompt *will* sometimes fail.
2. **Typing room content out is the new seam.** `browse_do` type-actions are
   checked against the room's entity map in **Rust, before the eval** — a hit
   pauses on the existing per-call consent channel ([agent_ui.rs](src-tauri/src/commands/agent_ui.rs)
   oneshot), showing *what* would be typed *where*. Consent, not silent
   masking — the MCP outbound-arg lesson applied.
3. **Password fields are hard-fenced.** The page script marks
   `input[type=password]` with the blocked-fence semantics from ADD-25: never
   snapshotted as actionable, never typeable. The user takes over for logins.
4. **Navigation is mechanically guarded.** Every hop — typed, clicked,
   redirect, `window.open` — passes [web/guard.rs](src-tauri/src/web/guard.rs)
   logic via `on_navigation`, plus a private-range block compiled into the
   content-rule list for sub-resources. The browser must not become a UI for
   SSRF against `localhost:11434`.
5. **Everything the agent does is journaled** — URL, action, consent decisions,
   timestamps — into the room DB (encrypted, user-visible). The *web* leaves no
   disk trace (`incognito`); the *agent's conduct* leaves a complete one. This
   is the "save the use of privacy" half of the original ask: an audit trail
   you own, inside the room file.

### A.6 The six tools (final surface)

Advertised only while the browser area is active (`scoped_specs` already gates
on `web_enabled`; add `browser_active`). Parity across `LocalEngine` /
`CloudEngine` / `ExternalAgent` per the engine-parity doctrine — the consent
doors are engine-independent (D11).

| Tool | Args | Returns |
|---|---|---|
| `browse_open` | `url` | title, settled URL, snapshot |
| `browse_read` | `mode?: main\|full` | markdown, capped + chunk-continuable |
| `browse_find` | `text` | matching refs only |
| `browse_snapshot` | — | ref list (MARK_CAP 80, overflow honest) |
| `browse_do` | `actions[]` | outcomes, diff, fresh snapshot, screenshot-on-failure |
| `browse_look` | `annotate?: bool` | SoM screenshot via the perception-image bridge |

Spec text stays terse — room_mcp's `LocalEngine` surface already costs ~9.7k
tokens and the Playwright-MCP 13.7k-token lesson is the cautionary tale.

---

## Part B — Full implementation plan

### B.0 Phase 0 — the de-risking spike (do this before anything else)

Two known upstream bugs sit exactly under this feature. Half a day, throwaway
branch:

1. Enable tauri's **`unstable`** feature (verified required for child webviews
   on the pinned `tauri 2.11.5`) — confirm the app still builds, bundles, and
   auto-updates.
2. Create a child `WebviewBuilder` (`incognito(true)`) beside the app webview
   in the main window; navigate it to a real site. Watch for the
   white-on-load bug (tauri #10011). Fallback if it bites: a separate
   `WebviewWindow` docked visually — worse UX, identical agent architecture.
3. Round-trip `evaluateJavaScript:completionHandler:` via `with_webview` +
   objc2 → tokio oneshot, **in a release build** (wry #1151 crashed in release
   only). `block2` and `objc2-web-kit` are already deps.
4. `takeSnapshotWithConfiguration` on the child webview (generalize the ADD-25
   helper).

Exit criteria: pixels visible, JS value returned in release, PNG captured.
Everything below assumes these four facts.

### B.1 Phase 1 — Rust browser core (~2–3 days)

New module `src-tauri/src/browser.rs` + `browser/`:

- **`browser/state.rs`** — `BrowserState`: webview label, session journal
  buffer, settle bookkeeping. Lifecycle: created when the Browser area opens,
  destroyed on area close and on **room seal** (wire into the existing
  teardown invariants from the security wave — the non-persistent store dies
  with the webview, but the journal flushes to the room DB first).
- **`browser/create.rs`** — builder wiring:
  `incognito(true)`, `initialization_script_for_all_frames(AGENT_SCRIPT)`,
  `on_navigation(|url| guard-check)` (reuse `check_public_http_url` +
  `hop_host_is_public` — sync, which is what `on_navigation` needs; **do not
  write a second checker**), `on_download(route-to-room-import)`.
- **`browser/eval.rs`** — the eval bridge: `with_webview` → cast to
  `objc2_web_kit::WKWebView` → `evaluateJavaScript:completionHandler:` →
  oneshot → `serde_json::Value`, with the same timeout+cleanup discipline as
  `request_ui`. All six tools speak through this one function.
- **`browser/rules.rs`** — content blocking: a build-time generator (script in
  `scripts/`, output committed as a bundled resource — no runtime list fetch)
  runs the Brave `adblock` crate's `content-blocking` conversion over
  EasyList + EasyPrivacy + a hand-written private-range block rule; at first
  open, compile via `WKContentRuleListStore` and attach to the configuration's
  `userContentController`. New objc2-web-kit features:
  `WKContentRuleList`, `WKContentRuleListStore`, `WKUserContentController`,
  `WKWebViewConfiguration`.
- **Cargo**: tauri `features = ["unstable"]`; the objc2-web-kit feature adds.

Tests: rules generator (compiles, private-range rule present), journal
flush-on-seal, guard wiring (table-driven, mirroring the existing guard tests).

### B.2 Phase 2 — the page script (~2 days)

`src/browser-page/agentScript.ts`, built by vite into a single IIFE string
bundled as a resource. Namespaced `window.__arcelleBrowse`. This is a *port*,
not a rewrite, of driver.ts:

- Same mark semantics: `INTERACTIVE_SELECTOR` walk, visibility via
  `checkVisibility` + fallback, `data-agent-mark`, WeakRef registry,
  MARK_CAP 80, viewport-top overflow policy, stale-mark invalidation, SoM
  badge layer.
- Page-specific additions: `read()` (readability-lite — clone the document,
  drop nav/aside/footer/script, emit markdown with links), the settle
  detector (A.3), `input[type=password]` auto-fencing, iframe flattening
  (same-origin frames walked; cross-origin frames reported as one opaque
  entry — honest, not silent).
- Return values are plain JSON — the eval bridge's contract.

Tests: the `qa/` browser harness (built for the shell redesign) runs the
script against fixture pages: form page, SPA that re-renders, canvas page,
password form, cross-origin iframe, RTL/Hebrew page (the windows-1255 class of
sites is a known user population).

### B.3 Phase 3 — tools + sidecar (~2–3 days)

- **`commands/browser_tools.rs`** — the six tools from A.6. `browse_look`
  reuses the generalized snapshot helper; images ride the existing
  perception-image bridge to the vision engine. Entity-map check on
  type-actions (Phase 5 turns it from log-only to consent-gated).
- **`room_mcp.rs`** — specs added to `scoped_specs()` under a new
  `browser_active` gate; scope parity per D11; spec-size test updated (the
  existing per-scope token-count tests will catch bloat).
- **Sidecar** — `group_tools("browse")` in agents.py; a **web specialist** in
  the template roster with its own shape (snapshot-heavy, compaction-friendly);
  prompts.py: the escalation ladder, the untrusted-page-text stance, consent
  behavior, "never wait, the tools settle for you". Verify `ask_*_agent`
  generation picks up the new specialist for cloud hubs (it's roster-driven;
  should be free).
- **Budget**: confirm snapshot tool-results are marked droppable-after-action
  for compaction; the live bytes-per-token measurement already covers sizing.

Tests: sidecar pytest (`uv run` — the venv gotcha) for toolbox/spec/prompt
wiring; `test_skill_agent_parity`-style parity test for the new tools across
scopes; e2e_live errands (ARCELLE_E2E=1): "open example.com and tell me the
main heading", "search docs.rs for adblock, open the first result, what
version is current", a form-fill errand with a consent auto-approve test flag.

### B.4 Phase 4 — UI (~2–3 days)

- `WorkArea` gains `"browser"` ([types.ts](src/workspace/types.ts#L35)); AREAS
  entry in [ActivityRail.tsx](src/shell/ActivityRail.tsx) with a new
  `GlobeIcon`.
- **`BrowserPane.tsx`** — hosts the child webview: a placeholder div whose
  rect drives `set_browser_bounds` (ResizeObserver + splitter events → webview
  `set_position`/`set_size`). The native webview floats **above** all app DOM —
  so consent sheets, popovers, and the command palette must render in the AI
  pane or rail, never over the page. (This is the scheduler-popover-portal
  lesson in reverse: this time nothing can portal above the page.)
- **Chrome**: URL field (submits through the same guard, shows its plain-text
  block errors), back/forward/stop, shield chip ("content blocking on —
  counts are estimates" if we ever show counts, per D12), **"Agent driving"
  ticker** reusing the agent-strip vocabulary, and a **Take over** toggle that
  pauses agent tools (browse_* return "the user has taken over" while held —
  truthful, per the hardening doctrine).
- **Journal view**: the session's agent actions, rendered from the room DB;
  survives seal, exportable.

Tests: tsc + vite green; UA checklist rows added to
`qa/UA-FEATURE-CHECKLIST.md` (update it, don't re-derive); a11y labels on all
new chrome (the third-wave lesson).

### B.5 Phase 5 — the privacy doors (~2 days)

- **Outbound-typing consent**: entity-map hit in a type-action → pause on the
  agent_ui oneshot → chat chip + AI-pane sheet showing exactly what would be
  typed where → allow-once / allow-entity-for-session / deny. Journaled either
  way.
- **Password fence** verified end-to-end (script fences; Rust refuses
  type-actions on fenced refs even if a stale/forged ref arrives — defense in
  both layers).
- **Downloads**: `on_download` → room import flow with consent; no path to
  `~/Downloads`.
- **Seal teardown**: browser destroyed, store gone, journal flushed — added to
  the room-pin/teardown invariant tests.
- **Live QA against real cloud engines** — the gatekeeper's browser seam is
  new; exercise it with a real cloud CLI room, not just unit tests (the
  real-cloud e2e gap is a standing debt; don't extend it to this feature).

### B.6 Phase 6 — ship

`/release` skill as usual: five version files, clean sidecar build, release
build QA **including the eval bridge** (release-only crash history), macsign
after build, marker-string check against concurrent-work contamination,
changelog, UA checklist. Estimate the whole feature at **~2 weeks** of focused
work including the spike and QA, with Phase 3's read-only subset
(`open`/`read`/`snapshot`) usable as a checkpoint demo after ~1 week.

### Binding decisions (proposed — flag any to reopen)

| # | Decision |
|---|---|
| D1 | Engine: WKWebView child webview, tauri `unstable` feature. **Locked by Ben.** |
| D2 | Vision is first-class: shared SoM numbering, `click_at`, screenshot-on-failure; refs remain the default economy. **Per Ben.** |
| D3 | One browser per room, agent-first; user watches and can Take over |
| D4 | `incognito(true)` always; zero web persistence; cookies live only within the session |
| D5 | Six tools, batched actions, no tabs in v1 (`window.open` navigates in place) |
| D6 | Transport: native evaluateJavaScript bridge; no Tauri IPC from page origins |
| D7 | guard.rs on every hop + private-range content rule; no second URL checker |
| D8 | Consent-not-masking for outbound typing; hard password fence |
| D9 | Downloads only into the room |
| D10 | Journal in room DB: every agent action, consent, and URL |
| D11 | Tool parity: Local, CloudEngine, and ExternalAgent all get browse_* (doors are engine-independent) |
| D12 | No blocked-tracker counter in v1 (API can't report it; estimates only if ever) |

### Risk register

| Risk | Mitigation |
|---|---|
| tauri #10011 white webview | Phase 0 spike; WebviewWindow fallback |
| wry #1151 release-only eval crash | Phase 0 in **release** build; re-test at every wry bump |
| `unstable` feature side-effects | Spike covers build/bundle/updater; it's a compile gate, not an API fork |
| Native view z-order vs app UI | No popovers over the page — consent lives in the AI pane (B.4) |
| Focus/keyboard capture by the child webview | Spike checks ⌘K and rail shortcuts while the page has focus |
| Prompt injection from pages | A.5: data-framing + mechanical doors + journal; consent gates the damage class |
| 4B loops on multi-step sites | Specialist isolation, batched `browse_do`, settle detector, screenshot-on-failure; e2e_live errands watch it |
| Content-rule compile latency at first open | Compile once per app run, cache the compiled list identifier |
