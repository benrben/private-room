# Navigation redesign — research + implementation plan

**Date:** 2026-08-13, amended 2026-08-14 · **Status:** phases 0–7 BUILT and green. Phase 8 (density) shipped early with phase 4.
**Ask:** five labeled sidebar destinations, advanced tools under "More tools", a Layout menu, an Assistant titlebar control, Settings → Interface, new typography, and a calmer visual register.

---

## Amendment, 2026-08-14 — phases 5, 6 and 7 are built

Gate: typecheck, `npm run build`, **500 page-script tests**, **1,384 Rust**,
**1,586 sidecar**, `test:mock` no drift, and the rendered contrast audit
(`capture-specs/contrast.mjs`) green in both themes with zero app failures.
`cargo clippy` has two errors, both pre-existing and in files this work did not
touch (`commands/sketchdoc.rs` `.skip(0)`, `quicklook.rs` `|| true`).

### What the install caught that the suites did not

Built, signed and installed to `/Applications` on 2026-08-14, then verified by
reading the shipped binary — which surfaced a regression **no suite could see**:

The palette is written down **five** times, not the three the pass assumed. The
two extra copies are the three Studio templates (`studios/{flashcards,mindmap,
podcast}.rs`, which splice `NOTEBOOK_CSS` in and then write their own rules on
top of its token names) and `SELF_CONTAINED_HTML_RULES` (the palette as English
in a model prompt). Renaming `--mk-pink` to `--mk-berry` left all three Studio
templates reading a token nothing defines — and an undefined custom property
does not fall back, it voids the whole declaration, so **the hero divider
vanished from every flashcards, mind-map and podcast export**. Silent: no
error, no log, no failing test.

Fixed, each with a test proven red first:

- `docs_html::tests::every_generated_page_defines_the_tokens_it_reads` composes
  all four generated pages and asserts every `var(--x)` resolves. Red on three
  sites, green after.
- `studios::tests::the_prompt_palette_matches_the_notebook` ties the prompt to
  `NOTEBOOK_CSS`, reading the expected values out of it rather than restating
  them. It caught that the prompt's accent pair had **already** drifted before
  this work: `#be3754`/`#c87b91` was never `--mk-pink-ink` in either theme.
- `NOTEBOOK_CSS` claimed "the app bundles Manrope, Kalam and IBM Plex Mono" —
  false since phase 6, and shipped inside every exported document.

**Pre-existing and left alone** (found by the same sweep, all silent): `--sp-5`
and `--sp-7` in create.css, where the scale is deliberately 1,2,3,4,6,8, so
those cards have no padding at all; `--radius-md` ×3 in create.css against an
xs/sm/base/lg scale, rendering square; `--ink-soft` in recording.css and
waveform.css against an ink/ink-strong/ink-2/ink-muted track, falling back to
inherited colour. None were defined at HEAD either. Fixing them means choosing
a rung the original author did not write down, and it would change the Create
and Recording pages in the middle of this review — so they are reported, not
guessed at.

**Also left alone, deliberately:** `.nb-mark-pink` still names the old colour
while setting `--mk-berry`, and ~50 comments call hue 298 "the pink pen". A
blanket sweep is not obviously right, because the sketch tool's ink vocabulary
(`Ink::Pink`, `INKS`, `.sk-ink-pink`) is a user- and agent-facing API whose
words must not move — so the codebase carries both words either way.

**Phase 5 — native View menu.** `src-tauri/src/menu.rs` declares the whole menu
bar as a `const` the builder walks, because muda needs a real NSApplication and
a menu built the ordinary way can only be checked by launching the app and
looking. As data, the invariants are unit tests: the Edit submenu still
declares the clipboard rows, ids are unique, ⌘1/⌘2 are declared once each.

  * **⌘1 and ⌘2 moved OUT of `useLayout`.** macOS gives a key equivalent to the
    menu bar before the key window sees it, so leaving the keydown listener in
    place would have made two owners for one press — and a pane toggled twice
    never moves. `PANE_KEYS` now holds only ⌘3, the alias no menu row can
    carry. `nativeMenu.test.mjs` holds both halves of that split together.
  * `menu_sync` sends the four ticks and the enabled flag as ONE payload, not
    `set_check(id, bool)` per row (the plan's shape): they are one fact about
    one window, and sending them together means the menu cannot be caught
    halfway through a layout change. It is also re-sent after every press —
    muda ticks a check row itself on click, so a press whose handler changed
    nothing would otherwise leave that tick lying.
  * Rows are born DISABLED and the room enables them, so the menu bar over the
    password gate offers nothing that would do nothing.
  * **Two tests the plan asked for cannot exist as written.** "Clipboard keys in
    the password gate" and "every View item with a private-browser page open"
    are both AppKit-level: webdriver drives the webview, not the menu bar, so
    an e2e here would exercise WKWebView's default handling and prove nothing.
    Each is instead guarded at its actual failure cause (a spec test for the
    Edit rows; the crate-wide `get_webview_window` scanner for the emit path)
    and written up as a real manual row in `qa/UA-FEATURE-CHECKLIST.md` §7c.
  * The module's own `get_webview_window` scanner was deleted once
    `browser.rs`'s turned out to do the same job crate-wide — and to have
    solved the two problems a second copy hits (skipping comments, and not
    reporting its own source).

**Phase 6 — typography.** Figtree and Space Grotesk bundled as variable faces,
latin + latin-ext, OFL like the two already here. **The bundle got smaller:
216 KB → 205 KB**, because two variable files replace Manrope's pair and cover
more weight. `--display` is new and applied at all 18 display-rung sites.

  * **`--hand`: 71 sites → 27**, under a rule about AUTHORSHIP rather than
    length: *the hand is for words a person wrote, and for the app speaking in
    its own voice at an empty moment; never for a fact the app computed.* The
    older rule ("annotations, dates, counts, durations, short labels…") is what
    let the hand reach 71 sites and stop meaning anything. Dates, counts,
    durations, timestamps, diarized speaker names, progress lines and
    model-written headings all moved; empty states, margin notes, prompt chips,
    the composer placeholder, sketch text and short conversational messages
    stayed. Owner picked this over the literal reading of decision 2, which
    would have cut ~60 including `.msg.is-hand` and `composer.ts`'s heuristic.
  * `isLatinScript` and `.is-latin` were deleted: they existed only to keep
    Hebrew and CJK headings out of Kalam, and model-written headings are in the
    sans now, so there is no face left to keep them out of.
  * **Sizes moved with the faces.** `--fs-hand` is 15px because *Kalam* runs
    small for its nominal size; a moved site takes `--fs-meta` so its optical
    size is unchanged. `typography.test.mjs` fails on any sans rule that
    borrows a hand rung.
  * `LABEL_CHAR_W` in the Room Map was tuned against "Manrope's average advance
    (~6.6px)". Measured with fontTools over the characters file names are made
    of, **Figtree comes to 6.600px at 12px** — the constant did not have to
    move, and now says so.
  * **A screenshot caught what the greps missed.** Sweeping `var(--hand)` finds
    every stylesheet that reaches for the face and none of the components that
    wear `.nb-hand` to get it, so a date on the Recordings page stayed
    handwritten through a pass meant to have moved every date. Five class
    consumers moved; the test now censuses both halves.

**Phase 7 — visual register.** Berry-purple and warm gold solved numerically
against all four grounds of both themes and asserted in
`visualRegister.test.mjs`, which computes the ratios from the stylesheet rather
than trusting a comment — the failure mode this palette has already had once.

  * **The plan's "change the definitions, do not touch 225 call sites" was
    wrong by 90.** 230 rules read `var(--radius*)`, but a further 90 hand-wrote
    their own four-corner radius; a token-only change would have left the app
    split down the middle, half symmetric and half wobbling, which is worse
    than either. Those 90 now read tokens. Marks (2–5px: tape, underlines,
    bars, category edges) keep their wobble, and so do paper.css's four frame
    signatures — now the whole of the drawn identity, which is why their spread
    narrowed from 9–12px to 9–11px.
  * **`--radius-xs: 6px` is new.** 37 of those 90 rules had already converged on
    a ~6px corner and were each writing their own approximation of it.
  * **`--redraw` was NOT turned off, and the plan's premise here was also
    wrong.** Setting it to 0 does not disable the second outline, it lays it
    exactly on the first. And there was no global motif to remove: `.nb-redraw`
    has no consumers at all — the only three redraws in the app hand-roll their
    own pseudo-element and are deliberate single-element decisions (gate,
    browser chrome, remote-install badge), which read the token for geometry.
  * **Icons: 16 distinct sizes → three.** 12 (dense metadata) / 14 (default) /
    16 (chrome), with ≥20 left alone as art. 188 call sites moved, none by more
    than 2px. The plan's literal "normalize chrome to 16" would have grown 99
    13px icons by 23% in the densest rows.
  * Settings lost its paper texture: it is a modal that FLOATS above the
    notebook, and printing the page's tooth onto something stacked on top of
    the page was the one place the metaphor contradicted itself.
  * The texture switch already reached every copy of the dotted canvas —
    `--grid-dot: transparent` is read by paper.css, settings.css, roomMap.css
    and sketch.css alike, so the plan's "the second copy is easy to miss" was
    already solved by the token indirection.

**Two harness fixtures added** (`qa/qa-mock.js`): `menu_sync`, and `voices_list`
— the latter pre-existing, and the reason every screenshot of Settings in the
vision dataset was a picture of its error boundary. `generate_ui_text` and
`set_unsaved_edits` are still unfixtured and still print the gap banner.

---


**Phases 0–4 are implemented.** Typecheck, `npm run build`, 480 page-script tests and 1,374 Rust tests all green; `test:mock` reports no drift. The Assistant default-flip, the native View menu, the inline Home composer, the accent-hue change and the typography swap remain out, per decisions 4, 5, 9 and 11.

**Three defects surfaced during the build**, two of them pre-existing:

1. **⌘K was missing three areas** — Recordings, Create and Sketch had no palette row at all. Latent before; load-bearing the moment unpinned tools went behind a disclosure, since the palette is the completeness guarantee. All eleven are listed now, with a test that fails if one is ever added to the sidebar and not the palette.
2. **`activateResult` never revealed the pane** (§2.4) — fixed, and covered.
3. **The Review preset's ratios summed to 1.23**, introduced by this work. Invisible until you reopened the Assistant from Review, at which point every pane was the wrong width and `applyResize`'s centre floor was silently breached. Caught by a unit test, not by looking.

Density shipped with phase 4 rather than being held to phase 8: at token level it is ~40 lines, and Settings → Interface says in its own copy which pages give back less room, so the rough edges read as a known limit rather than as bugs.

---

## Part 0 — Locked decisions (2026-08-13)

| # | Decision | Effect on the plan |
|---|---|---|
| **1** | **Library is a pane, not a destination.** Removed from the nav list entirely; reachable only via **Layout → Library** and **⌘1**. | Kills the biggest open question. All 11 areas are now placed with none left over. |
| **2** | **Kalam is the only handwriting face.** Restricted to wordmark, rare authored annotations, and selected empty-state personality moments. Figtree (bundled) for functional UI, Space Grotesk (bundled) for major headings. No remote fonts, no machine-dependent fallbacks. | SignPainter is out. No licensing risk. |
| **3** | **Numbered shortcuts stay.** ⌘1 Library · ⌘2 Assistant · ⌘3 Assistant (back-compat alias, ≥1 release) · Focus unchanged. | Cheapest possible remap — see §2.3, ⌘3 already means Assistant today. |
| **4** | **No inline Home composer during the navigation phase.** | Removes the one product-shaped hole from the plan. |
| **5** | **Existing rooms retain their current pane state. New wide rooms open with Library + Workspace + Assistant.** | **The Assistant default-flip is cancelled.** No `LAYOUT_VERSION` bump. AI/Studio/Activity/approvals stay exactly as discoverable as today. |
| **6** | **900–1080px reuses the existing one-pane behaviour** — the Assistant titlebar button switches to the Assistant pane. No new drawer system. | Zero new code; `togglePane` already does this in narrow mode. |
| **7** | **Approval/activity counts ride on the Assistant button even when the pane is closed.** | Counts move from the rail's AI toggle to the titlebar. |
| **8** | **Studio/Activity actions open the Assistant directly to the requested tab.** | Already true at 5 of 6 call sites; one is a live bug (§2.4). |
| **9** | **No native Tauri menu during the navigation phase.** Ships later as its own change with explicit App/Edit predefined-item tests. | Removes the highest-risk item from the critical path. |
| **10** | **Responsive icon-only mode is derived UI state, never written to `railExpanded`.** | Confirms the recommendation. |
| **11** | **Accent colours unchanged during navigation work.** Berry-purple ships in the visual pass, both themes verified by `contrast.mjs` against the real hover/selection surfaces. | Removes the contrast-regression risk from the navigation phase. |

**Amended 2026-08-13 (owner):** Create moves to More tools.

**The default destinations (4):** Home · Recordings · Private browser · Sketch
**Under More tools, all pinnable (7):** Create · Room Map · Workflows · Scripts · Skills · Connectors · Memory

4 + 7 = 11. Every existing area is accounted for.

---

## Part 1 — What actually exists today (verified, 2026-08-13)

### 1.1 The shell

`src/Workspace.tsx:698-759` composes the whole frame:

```
<main class="pr-main">
  <ActivityRail />                    ← 84px collapsed / 192px expanded
  <div class="pane-grid">
    <section class="pane-library" />  ← 0.16
    <Splitter side="a" />
    <section class="pane-center" />   ← 0.61  (TabStrip + ViewerPane)
    <Splitter side="b" />
    <section class="pane-ai" />       ← 0.23  (AiPane: Chat/Studio/Activity)
  </div>
</main>
<StatusBar />
```

`TopBar` sits above `main` — brandmark, room name, ⌘K button, then a right cluster: recording chip, pinned-workflow pill, global-script pill, engine pill, privacy badge, room "…" menu, Lock ([TopBar.tsx:112-433](src/workspace/TopBar.tsx#L112-L433)).

### 1.2 The rail is seventeen buttons, not ten icons

[ActivityRail.tsx:33-49](src/shell/ActivityRail.tsx#L33-L49) plus its render:

| Group | Buttons |
|---|---|
| (chrome) | Collapse/Expand |
| **Panes** | Library, Workspace, AI — *pane toggles*, `data-pane-toggle` |
| **Room** | Room home, Room Map |
| **Capture** | Recordings, Create, Sketch, Private browser |
| **Automate** | Workflows, Scripts, Skills, Connectors |
| **Context** | Memory & scratch pad |
| (footer) | Focus, Settings |

The rail's doc comment ([ActivityRail.tsx:60-95](src/shell/ActivityRail.tsx#L60-L95)) already argues that **the rail navigates to PLACES and the tab strip holds DOCUMENTS**, and that full labels are the default so a first-time reader never hovers a column of glyphs. The redesign narrows the place list and moves the pane toggles out — it does not overturn that reasoning.

### 1.3 `useLayout` — the state machine everything routes through

[src/shell/useLayout.ts](src/shell/useLayout.ts), 554 lines.

- **Persistence:** `prLayout:<64-bit FNV digest of the room path>` in `localStorage`, storing `{ratios, hidden, railExpanded, v}` ([useLayout.ts:209-218](src/shell/useLayout.ts#L209-L218)). Path-hashed on purpose so no room name lands in plain storage.
- **`LAYOUT_VERSION = 2`** — bumped only when a default changes in a way a stored value would hide ([useLayout.ts:69-79](src/shell/useLayout.ts#L69-L79)). **Per decision 5, it is not bumped by this work.**
- **Narrow mode:** `NARROW_QUERY = "(max-width: 1080px)"` ([useLayout.ts:58](src/shell/useLayout.ts#L58)) → one pane at a time; `togglePane` moves the single visible slot rather than toggling ([useLayout.ts:306-310](src/shell/useLayout.ts#L306-L310)). Window `minWidth` is 900.
- **⌘1/⌘2/⌘3** claimed with capture-phase `stopPropagation` ([useLayout.ts:483-508](src/shell/useLayout.ts#L483-L508)) so no second handler fires — a deliberate fix for a bug where one press both collapsed a pane and jumped tabs.
- **`aiSteppedAside`** ([useLayout.ts:197-206](src/shell/useLayout.ts#L197-L206)) is the key prior art: a suggestion the software makes (collapse the AI column when a PDF opens), held *deliberately outside* `hidden` so it is never persisted — because when it was persisted, opening one PDF hid the AI pane forever. **Decision 5 keeps the Assistant open by default, so this machinery stays.**

### 1.4 Typography today

`src/styles/fonts.css` + `src/assets/fonts/` (216 KB, 17 woff2, manifest `faces.json`):

| Token | Family | Role | Uses |
|---|---|---|---|
| `--sans` | Manrope 400–800 var | every functional label, control, body | 77 |
| `--hand` | Kalam 300/400/700 | annotations, dates, counts | **71** |
| `--mono` | IBM Plex Mono 400/500/600 | code, timestamps, paths | — |

All bundled, latin + latin-ext only, `font-display: block`. **CSP is `font-src 'self' data:`** — no webfont CDN is reachable.

### 1.5 The visual register, in numbers

| Thing | Definition | Call sites |
|---|---|---|
| Asymmetric radii | `--radius-sm/--radius/--radius-lg` ([tokens.css:241-243](src/styles/tokens.css#L241-L243)) | **225** |
| Hand stroke | `--stroke-w: 1.5px` | 58 |
| Drawn frame | `.nb-frame` + `--b/--c/--d` | 24 |
| Drawn button | `.nb-btn` | 140 |
| Drawn chip | `.nb-chip` | 57 |
| Pen colour | `var(--sketch)` | 26 files |
| Dotted canvas | `html` ([paper.css:80-99](src/styles/paper.css#L80-L99)) **and** a second copy at [settings.css:179](src/styles/settings.css#L179) | 2 |

Accent today is pink (`--mk-pink-ink`). Every ink-track marker is solved to ≥4.6:1 against `--hover` — the lightest ground in dark mode, the darkest in light, i.e. the floor in both ([tokens.css:90-97](src/styles/tokens.css#L90-L97)). A previous solve against `--raised` shipped 4.15:1 values *with a comment claiming they passed*.

### 1.6 What binds to the current markup

| Consumer | Selector | File |
|---|---|---|
| Capture harness (4 specs) | `.rail-button[data-area="…"]` | `e2e/capture-specs/{screens,qaround,contrast,readme}.mjs` |
| GH#2 regression | `[data-testid="rail-expander"]`, exact label text, `title` fallback | `e2e/qa-specs/gh2-sidebar-expand.e2e.mjs:32-105` |
| Areas/viewers e2e | `.rail-button[data-area="…"]` | `e2e/qa-specs/areas-and-viewers.e2e.mjs:88` |
| Mic e2e | `.activity-rail button[aria-label^="Open room settings"]` | `e2e/qa-specs/gh4-mic-volume.e2e.mjs:30` |
| Create e2e | `.rail-button[data-area="create"]` | `e2e/qa-specs/create-look.e2e.mjs:25` |
| **Agent embodiment loop** | `.activity-rail` → region "activity rail" | [src/agent/driver.ts:63](src/agent/driver.ts#L63) |
| UA checklist | documents `data-area` as a stable contract | `qa/UA-FEATURE-CHECKLIST.md:87` |

---

## Part 2 — The work, piece by piece

### 2.1 Pane icons → Layout menu — *small*

Everything the menu needs exists on `LayoutApi`: `togglePane`, `toggleFocus`, `collapsePane`, `showPane`, `resetLayout`, `toggleRail`, `visible`, `focusPane`, `railExpanded`.

New: a `LayoutMenu` in the top bar, plus **presets** (Focus / Research / Review) — a preset is `{hidden, ratios, railExpanded}` applied atomically. Menu contents: Library (⌘1), Assistant (⌘2), Focus, the three presets, Reset layout.

**Trap:** the top bar hand-coordinates "one popover at a time" through three separate booleans in `state.ts` (`modelMenuOpen`, `roomMenuOpen`, `qaMenuOpen`) with manual `setXOpen(false)` calls at every open site ([TopBar.tsx:77](src/workspace/TopBar.tsx#L77)). Adding Layout and Assistant makes five. **Collapse to a single `openMenu: string | null` in Phase 0**, before adding two more, or the mutual exclusion will drift.

### 2.2 Ten icons → five labels + More tools — *medium*

New module `src/shell/navPrefs.ts` owning the pinned set, the order, and the More-tools remainder. `ActivityRail` then renders pinned rows → a `More tools` disclosure → the customize sheet.

**Storage:** device-wide `localStorage` (`prNav:v1`), same tier as theme. Three precedents exist and this one is chrome, not room content — and a customized sidebar should follow the user across rooms. (Contrast: pane layout is per-room-digest; current area is inside the encrypted room via `api.setSetting("workspace_area")`.)

**Discoverability regression to guard.** Six tools behind a collapsed disclosure are invisible to `uiSnapshot()` in the embodiment loop ([driver.ts](src/agent/driver.ts)) until expanded. ⌘K already lists every area ([Overlays.tsx `buildPaletteActions`](src/workspace/Overlays.tsx#L228-L270)), so humans are covered; the agent needs the palette as its navigation route, verified by a driver test.

`AREA_HEADINGS` ([Sidebar.tsx:38-52](src/workspace/Sidebar.tsx#L38-L52)) is untouched — the left pane still says "Library" for the file-centric areas. Per decision 1, that word simply no longer appears in the nav list.

### 2.3 Workspace permanent + shortcut remap — *small, mostly deletion*

Drop `center` from the toggleable set. Consequences:

- `applyResize`'s `centerHidden` branch ([useLayout.ts:392-404](src/shell/useLayout.ts#L392-L404)) → dead, delete.
- The `if (next.library && next.center && next.ai) next.center = false` guards ([useLayout.ts:316-320](src/shell/useLayout.ts#L316-L320), `:350-358`) → unreachable, delete.
- Focus mode still hides both sides — same end state, keep it.

**The remap is nearly free.** Today `PANE_ORDER = ["library","center","ai"]` and the handler does `togglePane(PANE_ORDER[Number(e.key)-1])` — so **⌘1 already means Library and ⌘3 already means Assistant.** Only ⌘2 is repointed, from center to assistant, and the back-compat alias is *the existing behaviour left alone*. Replace the index lookup at [useLayout.ts:493](src/shell/useLayout.ts#L493) with an explicit map:

```ts
const PANE_KEY: Record<string, PaneKey> = { "1": "library", "2": "ai", "3": "ai" };
```

Update in three places: the handler, the shortcuts sheet ([Overlays.tsx SHORTCUTS "Panes"](src/workspace/Overlays.tsx#L305-L311)), and the Layout menu's accelerator hints.

**Focus has no enter-key today** — only Escape to leave ([useLayout.ts:496](src/shell/useLayout.ts#L496)). It is reached from the rail button, the palette command `focus-editor`, and the viewer header. Decision 3 says leave it unchanged, so no key is added; Focus moves into the Layout menu alongside its existing routes.

**⚠️ Migration trap, no version bump needed.** `hidden.center` can be `true` in a stored record today, because the workspace *is* toggleable right now. After this change a room saved that way would open with a permanently hidden, no-longer-toggleable centre and no way back. Coerce `hidden.center = false` on load in the `useState` initialiser — one line, and it satisfies decision 5 (every *real* choice, library and assistant, is preserved).

### 2.4 Assistant titlebar control — *small*

Decision 5 cancels the default-flip, which removes most of this phase. What remains:

- An **Assistant button** in the top-right cluster calling `layout.togglePane("ai")`. In narrow mode that already switches the single visible pane to the Assistant ([useLayout.ts:306-310](src/shell/useLayout.ts#L306-L310)) — decision 6 satisfied with zero new code.
- **Move the counts** off the rail's AI toggle ([ActivityRail.tsx:196-203](src/shell/ActivityRail.tsx#L196-L203)) onto that button: the hand-circled approval count (`nb-circled nb-sem-pending`) and the quiet running dot (`nb-sem-linked`). Both values are already computed in `Workspace.tsx` via `pendingApprovalCount`/`runningJobCount` from `shell/activity.ts` — pass them to `TopBar` instead of `ActivityRail`. Keep them `aria-hidden` with the words carried by the button's label, exactly as the rail does today.
- The step-aside machinery (`aiSteppedAside`, `aiChoiceRef`, `setFocusedPage`, `FOCUSED_KINDS` at [Workspace.tsx:45-57](src/Workspace.tsx#L45-L57)) **stays** — the Assistant is still open by default, so it still needs to step aside for a PDF.

**🐞 Decision 8 surfaced a live bug.** Five of six `setAiTab` call sites correctly pair the tab switch with `layout.showPane("ai")` — `Workspace.tsx:663`, `miscActions.ts:334` (`focusComposer`), `FrontPage.tsx:232/279/527`. The sixth does not:

> [`miscActions.ts:258-266`](src/workspace/miscActions.ts#L258-L266) — `activateResult` on a **chat-message search hit** calls `setAiTab("chat")` and never reveals the pane. With the Assistant collapsed, picking a message from ⌘K silently switches a tab you cannot see and appears to do nothing.

`activateResult` holds no `LayoutApi` (unlike `focusComposer`, which takes one as a parameter). Both callers are in `Overlays.tsx` ([:472](src/workspace/Overlays.tsx#L472), [:1118](src/workspace/Overlays.tsx#L1118)) where `layout` is in scope, so thread it through the same way `focusComposer` does. This is a pre-existing defect, not one this redesign introduces — but decision 8 makes it in-scope.

### 2.5 Auto icon-only on narrow windows — *small, one trap*

Add a rail-specific media query at ~1180px. Do **not** reuse the 1080px `NARROW_QUERY` — firing both at one width would collapse the rail and the panes simultaneously.

**The trap, per decision 10 and already documented in the file:** the persist effect writes `railExpanded` on every change ([useLayout.ts:209-218](src/shell/useLayout.ts#L209-L218)). If auto-collapse writes there, narrowing the window once permanently un-chooses the user's label preference — the exact bug `aiSteppedAside` exists to avoid. Implement as separate, never-persisted state:

```ts
const effRailExpanded = railExpanded && !railAutoCollapsed;
```

Only `effRailExpanded` reaches the render; only `railExpanded` reaches storage.

### 2.6 Settings → Interface — *medium; density is the expensive half*

New `src/settings/InterfaceSection.tsx` + `useInterfaceSettings.ts`, registered in `SETTINGS_GROUPS` ([Settings.tsx:46-76](src/Settings.tsx#L46-L76)). Deep-linking works for free via `GROUP_OF_SECTION`.

| Control | Cost | Notes |
|---|---|---|
| Sidebar visibility + order | cheap | Same store as §2.2; the customize sheet and this section are one component rendered twice |
| Default layout | cheap | The preset new rooms open with |
| Focus/Research/Review presets | cheap | Same preset objects as the Layout menu |
| **Comfortable/Compact density** | **expensive** | Nothing exists today — grep finds only the unrelated "Compact room" DB action at `PrivacySection.tsx:273` |
| Canvas texture Subtle/Off | cheap | Two rules — `paper.css` `html` **and** the duplicate at `settings.css:179` |
| Reset to Arcelle defaults | cheap | Clears `prNav:v1` + `prLayout:*` + density/texture |

Density done honestly = `:root[data-density="compact"]` overriding `--sp-1..--sp-8`, `--fs-*`, `--lh-body` and a short list of fixed control heights. It will land ~80% correct and need a hand-fix pass on the dense surfaces. **Ship it last, or not this cycle.**

### 2.7 Native View menu — *deferred out of the navigation phase (decision 9)*

Greenfield: zero hits for `MenuBuilder`/`SubmenuBuilder`/`on_menu_event` across `src-tauri/`. Tauri 2.11.5 supplies its stock macOS menu. When this ships as its own change, two gotchas govern it:

**⚠️ Calling `app.set_menu(...)` replaces the stock menu entirely.** Without re-declaring the App submenu (about / services / hide / hide-others / quit) and the Edit submenu (undo / redo / cut / copy / paste / select-all) as `PredefinedMenuItem`s, **⌘C, ⌘V, ⌘X and ⌘A stop working in every text field — including the password gate.** Decision 9 requires explicit tests for exactly this.

**⚠️ The event handler must emit through [`main_window()`](src-tauri/src/lib.rs#L36-L51), never `get_webview_window("main")`.** Once a private-browser page is open the main window hosts two webviews, `is_webview_window()` goes false, and every `get_webview_window("main")` returns `None` — the View menu would silently die the moment a user opened a web page. Test every item *with a page open*.

Check-item state needs pushing back from the frontend when the UI toggles (a `menu_set_check(id, bool)` command). No capability change needed.

### 2.8 Typography — *large*

Per decision 2: `--sans` Manrope → **Figtree**; new `--display` → **Space Grotesk** for page/section titles; IBM Plex Mono unchanged; **Kalam retained** and confined to wordmark, rare authored annotations, and selected empty-state moments.

- `--sans` is a token, so the body swap is **one line in `tokens.css`** plus new `@font-face` blocks and subset files.
- `--display` is new and must be *applied*: `--fs-page` (5 sites) + `--fs-section` (14) + `h1`/`h2` in `base.css`. ~20 sites.
- **`--hand` is used 71 times across 22 stylesheets.** Getting to the three sanctioned uses is an exhaustive audit, not a token change. Memory note `private-room-feedback-exhaustive-consistency` applies directly: grep exhaustively, don't trust a list of named instances.
- `index.html:83` hardcodes Kalam for the pre-React splash wordmark — that one is a *sanctioned* use and stays, but verify it still matches the wordmark after the swap.

**⚠️ "No machine-dependent fallbacks" must not be read as "delete the fallback stacks."** The system tails on `--sans`/`--mono` are load-bearing for **per-glyph** fallback: only latin + latin-ext are bundled, so Hebrew and CJK resolve through them ([fonts.css:12-16](src/styles/fonts.css#L12-L16)). Collapsing those stacks to a single family renders Hebrew as tofu — and this app has shipped Hebrew PDF and Hebrew STT work. Decision 2 rules out a *branded* face resolved from the system (SignPainter); it does not touch the non-latin chain. Keep the tails, drop nothing.

Bundle impact: Figtree variable + Space Grotesk × latin/latin-ext = 4 files, ~+60–80 KB; Manrope's 2 files (~40 KB) come out. Regenerate `faces.json`.

### 2.9 Visual middle ground — *large, token-first*

Do not touch 225 call sites. Change the definitions:

| Change | Where | Effect |
|---|---|---|
| Symmetric radii 8/10/12px | `tokens.css:241-243` | flips ~225 sites at once |
| `--stroke-w: 1.5px → 1px` | `tokens.css:80` | flips 58 |
| `--redraw` (second pen outline) → off | `tokens.css:81` | removes the doubled-outline motif globally |
| `.nb-frame--b/c/d` hardcoded radii | `paper.css:127-140` | neutralized separately — they don't read the token |
| Texture off menus/toolbars/settings | `paper.css` html rule + `settings.css:179` | the second copy is easy to miss |
| **Accent → berry-purple** | `--mk-pink*` track | **deferred to this phase per decision 11**; re-solve both themes against `--hover`, then run `contrast.mjs` |
| Privacy → warm gold | `--sem-pending` track + `trustState()` | per memory `private-room-ux-audit-response-2026-07-21`, `trustState()` in `markup.ts` is the single source for every cloud-vocabulary spot — change it there, not at the badges |

Icon alignment to 16px: the codebase passes **9 distinct sizes** inline (95×13, 48×14, 37×12, 23×15, 22×17, 20×11, 19×16, …). Normalizing chrome to 16 is mechanical but wide, and it shifts vertical rhythm in dense rows. Its own pass, with screenshot diffs.

---

## Part 3 — Phasing

### Navigation phase — ~8 days, fully reversible

**Phase 0 — groundwork (0.5 d)**
Collapse the top bar's three open-menu booleans into one `openMenu: string | null`. Extract `navPrefs.ts` with the pinned/order model and its `localStorage` codec. No visible change.

**Phase 1 — Layout menu + workspace permanent (2 d)**
`LayoutMenu` in the top bar; presets in `useLayout`; remove `center` from the toggleable set and delete the dead branches; coerce `hidden.center = false` on load; remap ⌘2; update the shortcuts sheet. The rail keeps its pane toggles this phase so nothing is unreachable mid-flight.

**Phase 2 — sidebar restructure (3 d)**
Five pinned rows + More tools + Customize sheet; remove the pane toggles from the rail; auto icon-only on narrow (non-persisted). Update the six e2e specs and `driver.ts`'s region map. **Keep `.activity-rail` and `data-area` — they are contracts.**

**Phase 3 — Assistant titlebar control (1 d)**
Assistant button with approval/running counts; verify every `setAiTab` site reveals the pane, and **fix `activateResult`** (§2.4). No default change, no `LAYOUT_VERSION` bump, no Home composer.

**Phase 4 — Settings → Interface, minus density (1.5 d)**
Section + hook + registration; sidebar/layout/preset/texture/reset controls; wire Reset to clear all three stores.

### Separate changes, after navigation ships

**Phase 5 — native View menu (1.5 d)** — full App+Edit re-declaration, check items, `main_window()` emit, `menu_set_check` sync. Explicit tests: clipboard keys in the password gate; every View item with a private-browser page open.
**Phase 6 — typography (2 d)** — subset + bundle Figtree and Space Grotesk; `--sans`/`--display`; ~20 heading sites; the exhaustive `--hand` audit; regenerate `faces.json`. Keep the non-latin fallback tails.
**Phase 7 — visual register (3 d)** — token-level radius/stroke/redraw; `.nb-frame` variants; texture scoping; **berry-purple + warm gold with contrast verification**; icon-size pass.
**Phase 8 — density (1.5 d, optional)** — `data-density` + token overrides + hand-fix pass on Settings, marketplace, workflows, browser.

---

## Part 4 — Test and QA impact

Must be updated in **Phase 2** or CI goes red:

- `e2e/qa-specs/gh2-sidebar-expand.e2e.mjs` — asserts exact rail label text and the collapsed-`title` fallback for `connectors` and `recordings`. `connectors` moves under More tools; `recordings` stays pinned.
- `e2e/capture-specs/{screens,qaround,contrast,readme}.mjs` — all navigate by `.rail-button[data-area="…"]`; the six More-tools areas need the disclosure opened first.
- `e2e/qa-specs/areas-and-viewers.e2e.mjs` — same.
- `e2e/qa-specs/gh4-mic-volume.e2e.mjs:30` — depends on `aria-label^="Open room settings"` staying on a button inside `.activity-rail`.
- `e2e/qa-specs/create-look.e2e.mjs:25` — `create` stays pinned, so this one survives unchanged. Confirm rather than assume.
- `qa/UA-FEATURE-CHECKLIST.md:87` — documents the `data-area` contract; add pin/order/More-tools items.
- `src/agent/driver.ts:63` — keep `.activity-rail` as the class or the embodiment loop stops labelling that region.

New coverage worth adding:

- Presets are idempotent.
- Auto-collapse never writes `railExpanded` (assert the stored record after a resize).
- A stored `hidden.center: true` opens with the workspace visible.
- Hidden tools are reachable via ⌘K.
- Every `setAiTab` path reveals the Assistant pane — the `activateResult` regression in particular.

---

## Part 5 — Risks after the decisions

The three highest-severity risks from the first draft were removed by decisions 9, 5 and 11. What remains:

1. **Auto-collapse silently eats the label preference** — mitigated by decision 10; enforce with a test that reads storage.
2. **`hidden.center: true` in an existing record** — one-line coercion; without it, an affected room opens with a permanently hidden workspace.
3. **Agent embodiment loses six destinations** behind the disclosure — mitigated by the palette route, verified by a driver test.
4. **Deleting the non-latin fallback tails while implementing "no machine-dependent fallbacks"** — would render Hebrew as tofu. Called out in §2.8.
5. **Density lands 80% right** — mitigated by shipping it last.

---

## Part 6 — Deferred, with reasons

| Item | Why it is out | When |
|---|---|---|
| Assistant closed by default | Decision 5 — would make AI, Studio, Activity and approvals less discoverable | Revisit only alongside a composer that has a home |
| Inline Home composer | Decision 4 — product surface, not a layout tweak | Its own change |
| Native View menu | Decision 9 — highest-risk item, off the critical path | Phase 5 |
| Berry-purple accent | Decision 11 — needs a two-theme contrast re-solve | Phase 7 |
| Compact density | ~80% automatic, needs a hand-fix pass | Phase 8 |

---

## Appendix — files touched, by phase

| Phase | Files |
|---|---|
| 0 | `src/workspace/state.ts`, `src/workspace/TopBar.tsx`, **new** `src/shell/navPrefs.ts` |
| 1 | `src/shell/useLayout.ts`, **new** `src/workspace/LayoutMenu.tsx`, `src/workspace/TopBar.tsx`, `src/workspace/Overlays.tsx` (shortcuts + palette), `src/styles/shell.css` |
| 2 | `src/shell/ActivityRail.tsx`, **new** `src/shell/CustomizeSidebar.tsx`, `src/shell/useLayout.ts`, `src/styles/shell.css`, `src/agent/driver.ts`, 6 e2e specs, `qa/UA-FEATURE-CHECKLIST.md` |
| 3 | `src/workspace/TopBar.tsx`, `src/Workspace.tsx`, `src/shell/ActivityRail.tsx`, `src/workspace/miscActions.ts`, `src/workspace/Overlays.tsx`, `src/styles/shell.css` |
| 4 | **new** `src/settings/InterfaceSection.tsx` + `useInterfaceSettings.ts`, `src/Settings.tsx`, `src/styles/settings.css` |
| 5 | **new** `src-tauri/src/menu.rs`, `src-tauri/src/lib.rs`, `src/workspace/effects.ts`, **new** `menu_set_check` command |
| 6 | `src/styles/fonts.css`, `src/styles/tokens.css`, `src/assets/fonts/*`, `faces.json`, `index.html`, ~22 stylesheets for the `--hand` audit |
| 7 | `src/styles/tokens.css`, `src/styles/paper.css`, `src/styles/settings.css`, `src/workspace/markup.ts` (`trustState`), icon-size pass across `src/**/*.tsx` |
| 8 | `src/styles/tokens.css`, `src/styles/{settings,marketplace,workflows,browser}.css` |
