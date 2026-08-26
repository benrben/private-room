# Private Browser audit — what was built, what was not

Response to the product audit of `/Applications/Arcelle.app`, 15 August 2026.

## Two corrections to the audit's premises

**The screenshots are the audit's own concept mockups, not the shipped app.** No
"12 blocked" counter exists anywhere in the codebase — no blocked-request count
is captured in Rust, transported, or rendered. Neither does the "Selected
passage" chip, the three-card empty state, or the string "This session is
private on this Mac". Recommendations drawn from those images describe a design
that has not been built; recommendations drawn from the *behaviour* were all
real and are addressed below.

**P1 "loaded page retains the title `New page`" was already fixed at `HEAD`.**
The reconciliation bail-out that caused it (a `setPages` updater that changed
nothing made React drop the nested `setActiveId` with it) is fixed in
`browserPages.ts:195-207`, commit `2da71b2`. The audit tested an older installed
build. No further change made.

## The P0, restated more precisely than the audit did

The audit found the UI claiming `trackers blocked` while the journal logged
`Content blocking FAILED to load`. The mechanism is worse than a stale label:

`"Nothing is saved — no history, cookies or cache. Trackers blocked."` was
hard-coded onto the `ephemeral === true` branch of the shield. `ephemeral` is
the answer to `browser_verify_private`, which asks the live webview whether its
data store is non-persistent. It knows nothing about tracker blocking. The
blocker's real verdict reached a journal row and nothing else — and three of the
six exit paths in `attach_rules_then_go` recorded nothing at all.

So it was not a label that had gone stale. It was **two questions with one
answer between them**, and the answer belonged to the other question.

## Delivered

| Audit item | What shipped |
|---|---|
| P0 protection state | `Protection` verdict per page in Rust, aggregated worst-wins; on the `browser_info` payload; `privacyClaim` takes the weaker of the two facts. Four states, each with **its own word** — Private / Checking / Partly private / Not private. Banner carries WebKit's own `localizedDescription` and a **Retry** that re-attaches the list to every open page without navigating. |
| P0 atomic last-page cleanup | `forgetThePage()` — one reset, listing exactly the state that belongs to a page. **A defect the audit missed:** the four Save-strip buttons were gated on `saving` alone, so with zero pages open they stayed clickable and failed down in Rust. `chromeAbilities` is now one list every control reads. |
| (not in the audit) frozen toolbar | `refresh()` swallowed poll failures with a bare `catch {}`, leaving the last report — padlock, address, armed Save — standing forever. Two strikes, then the chrome admits it does not know. |
| P1 chrome contrast | Opaque `--panel` ground, `--rule-strong` separator, lift shadow. Banner rows too. The stage keeps the sheet. |
| P1 Journal | Sittings (a real session id from Rust, not a guess from timestamp gaps), six facet filters, run-collapsing with `×N`, per-sitting summary counted over the **whole** sitting rather than the filtered view. |
| P1 Clear understates its deletion | `browser_clear_scope` reports the counts; the confirmation names the journal entries **and** the cached searches, page text and previews it also erases. |
| P1 privacy copy | `EPHEMERAL_VS_ROOM` and `NOT_ANONYMOUS`, used verbatim by every surface so they cannot drift apart again. The start screen's promise is derived from the blocker's verdict. |
| P1 Assistant scope | Page / room scope, default Current page in the Browser, cloud disclosure reusing the existing `trustState` vocabulary. |
| P2 reading view | **Replaces** the page; `Compare with page` is the option. The page is handed a real layout viewport only for the extraction window, released in a `finally`. |
| P1 first navigation fails until Reload | Root cause found: `attach_rules` defers the real navigation behind WebKit's rule-list compile, and the FIRST compile of a launch is the uncached one. Meanwhile `browser_info`'s probe ran against a document about to be replaced; the dropped callback was reported as `"The browser closed while the page was answering."` — nothing had closed. Now: the lost-callback error is named and reworded (`EVAL_LOST`, "The page was replaced while it was answering"), `readiness_from_probe_error` reads it as `Loading` (a probe interrupted *by* a navigation is the strongest evidence a navigation is in progress), and a page with a deferred navigation reports `loading` with **no** error and its recorded destination rather than flashing `about:blank` in the bar the user just typed into. |
| A11y | Protection failure and session-cleared are announced. `protection` joined the announcement identity, without which a blocker failing after the page settled read as "nothing changed". |
| "Selected passage" scope | Built. New read-only `browser_page_selection` — writes no file and no journal row, unlike `browser_save_page("selection")`. `hasSelection` rides the poll the chrome already runs, so the scope is offered only when a passage exists and costs no extra IPC. A selection gets its own preamble, because "the page open in the private browser, as text" would make a model answer about the article when the question was about the sentence. |

## The fixes were reviewed, and seven of them were wrong

An adversarial pass over the diff — hunting only for defects *introduced by the
fix* — found seven real ones. Six would have shipped. Worth recording, because
five of the seven are the same shape: **a fix that added a new case to a rule
that was written down in more than one place.**

| Defect | Why it happened |
|---|---|
| `extracting` was a boolean shared by two async callers. The mode toggle and the poll's `info.url` effect both start extractions; the first to finish revoked the page's viewport from under the second, and Rust then either stalled into its parked refusal or measured the page at one CSS pixel and returned that reflow **as the whole page**. | A borrow with two owners and no count. |
| The results row and the reading view could be open at once, leaving the reader's toggle **disabled with `aria-pressed="true"`** — a control the user cannot un-press. | "Can open the reader" and "can close the reader" were one ability. |
| `forgetThePage` wiped the address bar mid-keystroke. | The module's own doc explains why `address` is excluded from the ability list, then `CLOSED_VIEW` cleared it anyway. |
| **Retry** rendered under the storage-breach banner, where it recompiles the tracker list and changes nothing the sentence describes. | The banner's text and the button's condition were computed independently. |
| The Clear confirmation showed the **previous** deletion's counts for the length of a round trip. | `clearScope` was fetched but never dropped. |
| Three places disagreed about what "parked" means; the reading view — the newest parking cause — reached only one of them. | No single definition. Now `pageIsParked`. |
| `coalesce` ran after filtering, printing `×2` for an adjacency the record does not have. | Order of two transformations. |

All eight fixes (the seven plus a duplicated threshold constant) are pinned and
were **proven red** by mutation before being called done. The review also
flagged an unguarded string match across the FFI boundary — `summarise` decides
a blocker row is a warning by *not* matching Rust's success sentence — which now
has a test holding the two literals in step.

The lesson worth keeping: every one of these was introduced while fixing a bug
whose root cause was *also* "one fact, stated in several places, and only some
of them updated". The fixes reproduced the disease they were treating.

## Then it was RUN, and four more defects fell out

The suite was green — 719 tests, typecheck, clippy, 1414 Rust tests — and the
app had never been launched. Driving the real React app through
`e2e/wdio.capture.conf.mjs` (the QA harness: real components, real CSS, real
layout, `qa/qa-mock.js` standing in for Rust) found four things no test could
see, because in every case the code did exactly what it was asked to.

1. **The reading view never actually replaced the page.** `openReader` took a
   stage borrow to cover the frame before the first extraction begins; the
   reader's own extraction then took a SECOND borrow and released only its own,
   so the refcount never returned to zero. Measured: the stage was **320px wide
   in both states**. The P2 fix was inert in the shipped build. Now a separate
   `priming` flag that the first real extraction clears — the borrow and the
   placeholder are different instruments and were wrong to be the same one.
2. **The start screen said the same thing twice.** `startScreenCopy` prefixed
   its own "keeps nothing: no history, no cookies, no cache" onto
   `EPHEMERAL_VS_ROOM`, which already says what clears and when. Rendered, it
   read as padding.
3. **The shield sat on "Checking" forever** with no page open — that word means
   an unanswered check, and nothing was being checked. It now reads "No page".
4. **The Journal was drawn straight through the start screen.** `.browser-start`
   and `.bsearch` were `position: absolute; inset: 0` over the whole body while
   the journal and reading view are transparent flex SIBLINGS — so the record
   and the start screen's prose rendered on top of each other, both unreadable.
   Pre-existing, and invisible to any layout test: every box was exactly where
   it had been asked to go. Both are flex items now, and the stage yields to
   them the same way it yields to the reading view.

Also fixed while looking: the Clear confirmation — the sentence whose whole job
is to state the true size of an irreversible deletion — was wrapping to five
lines inside a 130px header cell. It gets its own full-width row.

The walk is kept as `e2e/capture-specs/browseraudit.mjs`, with the stage width
asserted rather than merely noted, so #1 cannot come back.

**The lesson, again:** the green suite measured the code against what it was
asked to do. Three of these four were the code doing exactly that, correctly,
and the result still being wrong on screen.

## Deliberately NOT built, with reasons

**Favicons and per-row loading spinners in the sidebar.** Rust's `Page` holds
`{id, url}` and computes the title from the host; there is no per-tab readiness
signal, and asking each background webview for one costs an `evaluateJavaScript`
round trip per page per poll. Favicons additionally require a fetch per site,
which in a private browser is a tracking vector that needs its own design. A
spinner driven by a signal the app does not have is exactly the class of
dishonesty this whole pass is about, so none was added.

**One-Escape exit from the native page.** The double-Escape chord is correct and
was left alone: Escape is the one key VoiceOver passes through, and a single
Escape would steal it from every web page that uses it. What changed is that the
instruction now only appears while a page is actually on screen to be trapped
in — with the reader replacing the page, the trap mostly stops arising.

**Everything in "Must add" beyond the above** — permission ledger, panic action,
auto-lock, find-in-page, zoom, print, downloads queue, save deduplication,
source-diff, agent replay, research bundles, session groups, thumbnails. These
are features, not defects, and each is its own piece of work.

## Regression proof

`e2e/page-script/browserTrust.test.mjs` — 41 tests. Proven red rather than
assumed: 11 source-scan tests fail against `HEAD`'s components; 9 behaviour tests
fail under targeted mutation of the pure modules.
