# Browser mode — engine options and agent control

**Research report, 2026-07-29.** Question asked: (1) which open-source browser
engines can be embedded in Arcelle, and (2) what is the most efficient way for
the agent to drive that browser. Everything below is research and a
recommendation — nothing has been built.

---

## 0. The short version

**Engine: don't add one.** Use the WKWebView Arcelle already links against, as a
second Tauri webview inside a new "Browser" work area. Every alternative either
can't render the real web (Servo: 62% WPT), costs ~100 MB and ships a Google
engine inside a privacy product (CEF), or doesn't render at all (Lightpanda).

**Control: a ref'd snapshot, not screenshots, and not raw DOM.** The page gets an
injected content script that returns ~200–400 tokens of numbered interactive
elements; the agent acts by number. This is the same mechanism Arcelle already
uses to drive its *own* UI ([driver.ts](src/agent/driver.ts) — `data-agent-mark`),
and the same mechanism every leading web agent converged on independently.

**Why this matters more here than elsewhere:** the default room engine is a local
4B. The week of "Done."-fabrications traced back to a 4k context window
truncating big turns. A raw-DOM control surface costs 3,000–5,000 tokens *per
step*; a ref'd snapshot costs 200–400. On a 4B that is not an optimization, it is
the difference between a browser mode that works and one that hallucinates
clicks. **Token efficiency is the load-bearing design constraint, not a nice-to-have.**

**The new privacy hole to design for up front:** every existing seam is *outbound
to a model*. A browser adds an outbound seam *to the open web* — the agent typing
room content into a form. That is the same class of bug as the MCP outbound-arg
masking issue, and the gatekeeper does not currently cover it.

---

## Part 1 — Engine options

### 1.1 The candidates, measured

| Engine | License | Added bundle | Renders real web? | Agent control surface | Verdict |
|---|---|---|---|---|---|
| **WKWebView** (already linked) | system | **0 MB** | Yes (Safari/WebKit) | `evaluateJavaScript` + injected script | **Recommended** |
| **Servo** 0.1.0 | MPL-2.0 | ~large, source build | **No** — 62% WPT | Rust-native API | Watch, don't ship |
| **CEF** (`tauri-apps/cef-rs`) | BSD | **~100 MB** | Yes (Chromium) | Full CDP | Rejected on size + optics |
| **Lightpanda** | **AGPL-3.0** | ~separate binary | **No rendering at all** | CDP + native MCP | Not for a visible browser |
| **Ladybird** | BSD-2 | source build | No — pre-alpha | none yet | Too early |
| **Ultralight** | proprietary | ~10 MB | partial | custom | Not open source |
| **WebKitGTK** | LGPL | n/a | Yes | WebKit API | Linux-only, irrelevant |

Repo health checked live on 2026-07-29 via the GitHub API: Servo 37.5k★ MPL-2.0
(pushed today), Lightpanda 32.9k★ AGPL-3.0 (pushed today), agent-browser 39.5k★
Apache-2.0 (pushed yesterday), browser-use 107k★ MIT (pushed today). All four are
genuinely alive; the disqualifiers below are about fit, not abandonment.

### 1.2 Servo — the one that looks perfect and isn't

Servo is the emotionally correct answer: Rust-native, memory-safe, no Google, no
Apple, MPL-2.0, and as of **13 April 2026 it is finally `cargo add servo`** — the
first crates.io release, with a real embedding API (`ServoBuilder`, `WebView`,
`RenderingContext`, delegates, pixel readback for headless). There is even an LTS
channel for embedders who don't want monthly breaking changes, and the
NLnet-funded **Verso** project exists specifically to make Servo a Tauri webview
backend (its two funded workstreams were offscreen rendering and multiwebview —
exactly what a browser mode needs).

It still fails on the only axis that matters for a browser users actually browse
with. Servo's WPT pass rate went **30% → 62% over 2.5 years**. The
[Baseline Readiness](https://webtransitions.org/servo-readiness/) analysis puts
Servo at **~22 features implemented per year against ~52 new Baseline
Widely-Available features per year** — at 13 FTE it is projected to **plateau
around 80% by 2037 and never converge**. A browser that fails 4 in 10 platform
tests will break login flows, payment forms, and every SPA a user actually wants
to visit — and it will break them *silently and unpredictably*, which is the
worst failure mode for a feature whose whole pitch is "let the agent use the web
for you."

Also worth knowing: servoshell on macOS still has an open issue opening new
windows, so macOS is not Servo's best-tested target.

**Verdict:** wrong tool today, right tool eventually. The Verso/Tauri path means
that if Servo ever crosses ~90% WPT, swapping it in behind a stable internal
`BrowserEngine` trait is a contained change. Design for that seam; ship WebKit.

### 1.3 CEF / Chromium — capable, and the wrong shape

`tauri-apps/cef-rs` is real and current (created Jan 2025, last push 30 May 2026,
tracking CEF 146.6.0, macOS arm64 + x86_64). It buys full CDP: network
interception, DOM snapshots, accessibility trees, profiling — the richest agent
control surface that exists.

The costs are disqualifying for this product:

- **~100 MB added** versus ~14 MB for the system webview. Arcelle's pitch is a
  single encrypted file and a lean local app; a 100 MB Chromium is a different product.
- **macOS bundling pain.** CEF requires multiple helper app bundles, each needing
  its own signing and entitlements. Arcelle's signing story is already delicate
  (`scripts/macsign.sh` must run after every build or TCC grants die).
- **Optics.** Shipping Google's engine inside a privacy-first local app is a
  story that has to be explained rather than one that sells itself.

CDP's capabilities are genuinely nice, but §2 argues the agent doesn't need most
of them.

### 1.4 Lightpanda — real, fast, and not a browser

Lightpanda is a from-scratch headless browser in Zig: HTTP loader, HTML parser,
DOM, V8, key web APIs, **and deliberately no rendering layer.** Reported ~11×
faster and ~9× less memory than headless Chrome, with drop-in CDP and native MCP.

Two blockers. First, the request is a *visible* browser mode — a page the user
looks at — and Lightpanda by design has nothing to show. Second, **it is
AGPL-3.0.** Arcelle already ships an out-of-process Ollama-style dependency so
the "separate binary, no linking" argument is available, but AGPL in a
distributed commercial desktop app is a legal question, not an engineering one,
and it is not worth taking on for a capability §1.5 gets for free.

### 1.5 The headless case is already solved, twice

Worth stating explicitly, because it's the usual reason people reach for
Lightpanda or CEF: Arcelle already has a static fetch path
([web/fetch.rs](src-tauri/src/web/fetch.rs) — reqwest, charset-aware, SSRF-guarded,
8 MB cap, HTML→text). The only gap is JS-rendered pages.

That gap closes with **a second, hidden WKWebView** — load, wait for idle,
`evaluateJavaScript` an extraction, return markdown, destroy. Same engine, same
code, same guard, no new dependency, no new license. One engine, two surfaces:
one the user sees, one the agent uses for bulk reading.

### 1.6 Why WKWebView is not a compromise

- **0 MB.** `objc2-web-kit` is already in [Cargo.toml](src-tauri/Cargo.toml#L107)
  (`WKWebView`, `WKSnapshotConfiguration`) for the ADD-25 embodiment snapshots.
- **It is Safari.** Every site works, including the ones with hostile bot
  detection, because it *is* the platform browser.
- **Fingerprinting: best-in-class by accident.** A WKWebView with the stock
  Safari UA is indistinguishable from Safari on macOS — the largest anonymity set
  available on the platform. This is strictly better than a randomized or custom
  UA, which makes the room *more* identifiable. **Do not "harden" the UA.**
- **Real private browsing exists at the API level.**
  `WKWebsiteDataStore.nonPersistent()` writes *nothing* to disk — no history, no
  cookies, no form data, no cache. That is a one-line configuration, not a feature
  to build.
- **Real content blocking exists at the API level.** `WKContentRuleList` is the
  same engine Safari content blockers use — compiled rules, enforced in the
  network path, before the request leaves.
- **Brave's filter engine converts the lists for us.** The `adblock` crate
  (MPL-2.0, the engine in Brave and now in Firefox) has a `content-blocking`
  feature that converts ABP/EasyList/EasyPrivacy syntax into exactly Apple's
  content-blocker JSON. Compile the lists at build time, ship the JSON as a
  bundled resource, load with `WKContentRuleListStore`. No runtime list fetch —
  which keeps the no-phone-home story intact.

**One known limitation to design around:** `WKContentRuleList` gives no callback
for *what* it blocked. A "17 trackers blocked on this page" counter cannot be
read from the API. If that UI is wanted, it has to be approximated by running the
`adblock` engine over the URLs an injected `PerformanceObserver` reports — an
estimate, and it must be labelled as one, not presented as ground truth.

---

## Part 2 — How the agent should drive it

### 2.1 The evidence is unusually one-sided

Three perception strategies exist, and the field has converged.

| Approach | Relative cost | Added latency | Coverage |
|---|---|---|---|
| Screenshot / vision | **10–20× baseline** | +2–3 s | Universal |
| DOM / accessibility tree | baseline | +0.2–0.5 s | Most pages |
| Hybrid (tree, vision fallback) | 3–5× | +0.5–1 s | Universal |

Concrete token measurements from an independent 2026 benchmark (a 9-step login
flow with a cookie dialog, phone input, and SMS PIN):

- **Playwright MCP: ~114,000 tokens.** Of which ~13,700 is *tool definitions
  alone*, re-sent every turn.
- **Playwright CLI: ~27,000 tokens** — 4× better, purely from dropping the MCP
  tool-definition overhead.
- **agent-browser: 200–400 tokens per page**, versus 3,000–5,000 for a full DOM
  dump. Claimed ~93% context reduction.

On success rate the tree-based approaches also lead: browser-use reports
**89.1% on WebVoyager** using accessibility-tree perception, against 83.5% for
Google's Project Mariner and 78.2% for MolmoWeb's 8B vision model.

And the finding that matters most for a 4B local engine: a February 2026 result
reports **a 0.6B model reaching F1 88.1% on extraction when paired with
aggressive DOM pruning — a 97.9% input-token reduction.** The
[Prune4Web](https://arxiv.org/abs/2511.21398) paper pushes the same idea further:
have the model emit a small *scoring program* to filter DOM nodes rather than
read the DOM itself, beating a no-pruning baseline (46.8%) and even beating GPT-4o
as the action grounder (80.65%).

> Read together: **the smaller the model, the more the control surface decides the
> outcome.** Arcelle's floor is a 4B. This is the design constraint.

*(The 114k/27k/200–400 figures and the 0.6B result are from secondary sources —
one benchmark blog and one summarized paper — and should be treated as
order-of-magnitude, not precise. The direction is corroborated across every
independent source found.)*

### 2.2 Arcelle already built the right primitive

This is the part worth pausing on. [driver.ts](src/agent/driver.ts) already
implements, for Arcelle's own UI, the exact pattern the web-agent field converged
on:

- walks an `INTERACTIVE_SELECTOR`, filters invisible and disabled elements
  ([`isVisible`](src/agent/driver.ts#L158) uses `checkVisibility` with a fallback)
- assigns numbered marks, stamps `data-agent-mark`, holds a `WeakRef` registry
- emits `{mark, role, label, region, state}` — compact, semantic, no HTML
- caps marks (`MARK_CAP`) and reports the overflow honestly
  (`"…and N more (scroll to reveal)"`)
- invalidates stale marks so an old number can never silently point at a
  re-laid-out element — it returns `"That element is gone — take a fresh ui_snapshot."`

That is a set-of-marks / ref'd-snapshot implementation, with the staleness
invariant that most third-party tools get wrong. agent-browser's format
(`- textbox "Email" [ref=e3]`) is the same idea with different syntax.

**The recommendation is to reuse this file's logic against page documents rather
than invent a second vocabulary.** Same roles, same labels, same staleness rule,
same overflow honesty — so the model's browsing skill and its app-driving skill
are one skill.

### 2.3 The transport: `evaluateJavaScript`, not Tauri IPC

The one genuinely tricky implementation detail, and it's worth getting right
before any code is written.

Tauri's IPC does **not** reach arbitrary remote origins — capabilities allowlist
specific remote domains, and "any site the user visits" cannot be allowlisted.
So the standard `invoke`-from-the-page route is closed for a browser.

The correct path is native and already available:

1. Get the platform handle: `webview.with_webview(|w| ...)` → cast to
   `objc2_web_kit::WKWebView` (the crate is already a dependency).
2. Inject the snapshot script at document start via `WKUserScript` on the
   configuration's `userContentController` — runs on every origin, every frame,
   no allowlist.
3. Call `evaluateJavaScript:completionHandler:` from Rust and read the return
   value directly. Native API, works cross-origin, returns JSON.

Two known hazards to verify against the pinned versions before committing:

- **wry #1151** — `evaluate_script` crashed on *release* builds only, introduced
  with the completion-handler PR in wry 0.35.2. Debug builds looked fine. Given
  Arcelle's history with release-only breakage, this needs an explicit
  release-build test, not a `cargo test` pass.
- **tauri #10011** — multiple webviews in one window rendering white on load.
  Prototype the two-webview layout early; if it bites, a separate
  `WebviewWindow` is the fallback.

### 2.4 The proposed tool set

Ten tools is too many — [room_mcp.rs](src-tauri/src/room_mcp.rs) already spends
~9,700 tokens on `LocalEngine` specs, and the Playwright-MCP benchmark above is a
direct warning about tool-definition overhead. Six, tightly scoped:

| Tool | Returns | Why it exists |
|---|---|---|
| `browse_open(url)` | title + ref'd snapshot | Navigate. Guarded (§3.2). |
| `browse_read()` | page as markdown, chunked | **Skips the agent loop entirely for read-only tasks** — the majority case |
| `browse_find(text)` | matching refs only | Cheaper than a full re-snapshot when the target is known |
| `browse_snapshot()` | ref'd interactive elements | The fallback perception call |
| `browse_do(actions[])` | new snapshot + diff | **Batched** — click/type/select/scroll in one turn |
| `browse_look()` | screenshot | Vision fallback only, for canvas/visual-layout pages |

Three deliberate choices in that table:

- **`browse_read` is the most important tool.** "Look this up for me" is most of
  what a chat-driven browser is for, and it should cost *one* model turn, not a
  navigate/snapshot/click/snapshot loop. This is the agentic-design principle of
  keeping deterministic work out of the model.
- **`browse_do` takes an array.** One action per turn is the dominant cost in
  every agent loop; "click #4, type into #7, click #9" is one turn, not three.
- **`browse_look` exists but is last.** Universal coverage, 10–20× cost. It is
  the escape hatch, and the prompt should say so.

**Advertise them conditionally.** `scoped_specs()` already gates on
`web_enabled`; browser tools should gate on the browser area being active, so a
room that isn't browsing doesn't pay the spec tokens on every turn.

### 2.5 What not to build

- **Don't embed a CDP client.** The capability CDP uniquely buys — network
  interception, HAR, protocol-level DOM — isn't what a chat-driven browser needs,
  and it costs the whole Chromium bundle.
- **Don't ship an MCP browser server** (Playwright MCP, agent-browser MCP). They
  assume a separate browser process, they carry the ~13.7k tool-definition tax,
  and they'd bypass the room's privacy gatekeeper entirely — the tools would talk
  to the model without passing the door. **Architecturally incompatible with the
  product's core promise**, independent of cost.
- **Don't build vision-first control.** Arcelle has `takeSnapshotWithConfiguration`
  and a vision model, so it's tempting. 10–20× cost, +2–3 s, and worse success
  rates.
- **Don't chase WebMCP yet.** `navigator.modelContext` reportedly shipped in
  Chrome 146 (March 2026), letting sites expose typed tools directly to agents —
  a genuinely better future. But it's Chrome-only today, Safari adoption is
  speculated for WWDC 2026 with extra privacy constraints, and it only helps sites
  that adopt it. Worth a watching brief; not a v1 dependency. *(Chrome-146 detail
  is single-sourced — verify before quoting it anywhere externally.)*

---

## Part 3 — Privacy design

### 3.1 What comes free

- **`WKWebsiteDataStore.nonPersistent()`** per room — nothing on disk, ever.
  Destroy the store on room seal, which fits the existing teardown invariants.
- **`WKContentRuleList`** compiled from EasyList + EasyPrivacy via the `adblock`
  crate's `content-blocking` feature, shipped as a build-time-generated bundled
  resource. No runtime list fetch, no phone-home.
- **Stock Safari UA** — maximum anonymity set (§1.6). Resist the urge to change it.

### 3.2 The guard that must not be forgotten

`web/guard.rs` exists because the model can supply URLs. **A browser is that
threat surface with a UI on it.** Every navigation — typed, clicked, redirected,
`window.open`ed, iframe'd — must pass `check_public_http_url` +
`resolve_public_addr`, wired through Tauri's `on_navigation` hook.

The concrete risk is not abstract: Arcelle runs **Ollama on localhost:11434**, a
sidecar on localhost, and sits on the user's LAN. A page that navigates to
`http://localhost:11434/api/delete` is an attack, and `guard.rs` already blocks
exactly that class (`localhost`, `.local`, RFC1918, CGNAT, IPv4-mapped IPv6).
Reuse it verbatim — do not write a second URL checker.

`on_navigation` only sees the URL, not the webview. Sub-resource loads bypass it
entirely, so pair it with a `WKContentRuleList` rule blocking private-range hosts
at the network layer as defense in depth.

### 3.3 The new hole — outbound to the web

Every seam the gatekeeper guards today is **outbound to a model**: `chat.py`,
`external_llm.py`, `run_external`, the MCP bridge. All of them are "room content
going to something that might be cloud."

A browser adds a seam of a different shape: **room content going to an arbitrary
website.** When the agent calls `browse_do` with `{type: "user@example.com"}` into
a form field, that is a protected entity leaving the Mac — through a path
`privacy.py` never sees, because no model is involved.

This is structurally the same bug as the MCP outbound-arg masking issue, and the
lesson there applies: silent masking reads as a broken feature, so the answer is
consent plus visibility, not blind redaction. Concretely:

- `browse_do` typing arguments run through the entity map **before** hitting the
  page.
- A hit does not silently redact — it prompts, the way per-call MCP consent does
  (`agent_ui.rs`'s oneshot pattern is the existing mechanism for exactly this).
- **Any password field is agent-blocked outright** — the `[data-agent-blocked]`
  fence from ADD-25, applied to the page instead of the app.

Two smaller ones: downloads must land in the encrypted room, never `~/Downloads`;
and page text the agent *reads* is untrusted input reaching the model, so
prompt injection from a web page is now in scope. The agent should treat page
content as data, never as instructions — and given a 4B engine, that boundary
needs to be in the prompt explicitly.

---

## Part 4 — Fit with what exists

Unusually little is new. The reusable pieces, all already in the tree:

| Need | Already exists |
|---|---|
| WKWebView + snapshots | `objc2-web-kit` dep, ADD-25 `takeSnapshotWithConfiguration` |
| Ref'd element snapshot | [driver.ts](src/agent/driver.ts) `uiSnapshot`, marks, WeakRef registry, staleness |
| Blocked-surface fence | `[data-agent-blocked]` walker exclusion |
| Async tool ↔ webview bridge | [agent_ui.rs](src-tauri/src/commands/agent_ui.rs) `request_ui` oneshot + timeout |
| URL safety | [web/guard.rs](src-tauri/src/web/guard.rs) |
| HTML → text | `extraction::strip_html`, charset-aware decode |
| Per-tier tool exposure | `ToolScope` + `scoped_specs()` |
| Redaction door | `commands/privacy.rs` + `sidecar/privacy.py` |
| A new work area | `AREAS` in [ActivityRail.tsx](src/shell/ActivityRail.tsx#L25) + `WorkArea` in `workspace/types.ts` |

New work is: the browser webview + its chrome, the injected page script (a port
of `driver.ts`), the six tools, the content-blocker build step, and the outbound
consent door from §3.3.

### Suggested sequencing

1. **Spike the risky part first.** Two webviews in one window + `evaluateJavaScript`
   returning a value **in a release build**. This is where tauri #10011 and wry
   #1151 live, and everything else depends on it.
2. Browser area + chrome + `on_navigation` guard + non-persistent store.
3. Port `driver.ts` snapshot logic to a `WKUserScript`; add `browse_open` /
   `browse_read` / `browse_snapshot`.
4. `browse_do` + `browse_find` + the §3.3 consent door + password fence.
5. Content-blocker build step (`adblock` → Apple JSON → bundled resource).
6. `browse_look`, and the hidden headless webview for `fetch_page`'s JS gap.

Step 3 alone — open, read, snapshot — is already a usable "look this up for me"
feature, which makes it a reasonable place to stop and evaluate before building
the interaction half.

---

## Open questions

1. **One shared browser per room, or one per chat?** Affects the data-store
   lifecycle and whether two agents can browse concurrently.
2. **Does the user drive it too, or is it agent-only?** A user-driven browser
   needs bookmarks/history — which fights the non-persistent store. Recommendation:
   agent-first, user can watch and take over, nothing persists.
3. **Cloud-engine tier.** Should `CloudEngine` rooms get browser tools? Consistent
   with the engine-parity doctrine, but it widens §3.3's exposure.
4. **Do we want the blocked-tracker counter?** It cannot be read from
   `WKContentRuleList` (§1.6) and would have to be an estimate.

---

## Sources

Engines: [Servo 0.1.0 release](https://servo.org/blog/2026/04/13/servo-0.1.0-release/) ·
[Servo Baseline Readiness](https://webtransitions.org/servo-readiness/) ·
[Servo WPT pass rates](https://servo.org/wpt/) ·
[servo/servo](https://github.com/servo/servo) ·
[Verso / NLnet](https://nlnet.nl/project/Verso/) ·
[tauri-apps/cef-rs](https://github.com/tauri-apps/cef-rs) ·
[cef-rs macOS support](https://deepwiki.com/tauri-apps/cef-rs/4.2-macos-support) ·
[Lightpanda](https://www.scrapingbee.com/blog/lightpanda-headless-browser/) ·
[Ladybird](https://ladybird.org/)

Control: [Browser automation landscape 2026](https://zylos.ai/research/2026-04-05-browser-automation-ai-agents-2026-landscape/) ·
[Token benchmark: Playwright CLI vs agent-browser vs Claude in Chrome](https://www.ytyng.com/en/blog/ai-browser-automation-tools-comparison-2026) ·
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) ·
[Browser Use vs Stagehand vs Playwright MCP](https://fp8.co/articles/Browser-Use-vs-Stagehand-vs-Playwright-MCP-AI-Agent-Browser-Automation) ·
[Prune4Web (arXiv 2511.21398)](https://arxiv.org/abs/2511.21398) ·
[Playwright a11y trees for agents](https://bytetunnels.com/posts/playwright-for-browser-automation-in-ai-agents/)

Platform/privacy: [WKWebsiteDataStore](https://developer.apple.com/documentation/webkit/wkwebsitedatastore) ·
[What's new in WKWebView (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10049/) ·
[wry macOS/WKWebView](https://deepwiki.com/tauri-apps/wry/3.2-macosios-(wkwebview)) ·
[brave/adblock-rust](https://github.com/brave/adblock-rust) ·
[adblock crate](https://docs.rs/adblock) ·
[Tauri WebviewWindowBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html) ·
[wry #1151](https://github.com/tauri-apps/wry/issues/1151) ·
[tauri #10011](https://github.com/tauri-apps/tauri/issues/10011)
