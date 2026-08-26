# Arcelle — full end-to-end review, 2026-08-17

v0.24.0 · working tree clean at `d0d6b40` · **nothing in this review has been fixed**

- [`full-review-2026-08-17-defects.md`](full-review-2026-08-17-defects.md) — 418 defects, P0 → P3
- [`full-review-2026-08-17-ux.md`](full-review-2026-08-17-ux.md) — 332 UI/UX, view-quality and simplification items

## Method

78 subagents in three workflows, ~14.8M tokens. Every domain was read by one agent
and then **adversarially re-checked by a second** told to refute the first and to
default to REFUTED when unconvinced. UX claims went through a grounding pass whose
only job was to strike any control not present in the source.

Baseline first: `tsc -b` clean, every Rust suite green, 1586 sidecar tests green.
**Every finding below survives a fully green gate.** That is the review's main
structural result — the gates do not cover what is broken.

## The four P0s

1. **The cloud-privacy door never engages for Ollama's `<size>-cloud` tags.**
   `sidecar/arcelle_sidecar/privacy.py:35`. `is_cloud_model` requires the tag to be
   exactly `cloud`, so `gpt-oss:120b-cloud` and `qwen3-vl:235b-cloud` — the way
   Ollama actually names hosted models — read as local. `guard_outbound`, documented
   as "the one call every outbound path makes", then returns messages unredacted and
   images unstripped while the UI says the door is on.
   **[author-verified]** Rust already fixed this: `capabilities.rs::engine_id_of`
   handles both spellings and is the stated definition point. The sidecar's copy was
   never updated, and it is the gate that decides whether redaction runs.

2. **A relayed Ollama (the Closet) gets zero enforcement at the sidecar door.** Same
   root cause, different door: locality is decided from the model *name*, so pointing
   the room at another machine's Ollama with a local-sounding tag (`qwen3.5:4b`)
   sends everything unredacted. `capabilities.rs:236` describes this exact bug as
   fixed on the Rust side; the sidecar still decides by name.

3. **`rec_read` never frees the job queue's single heavy-work slot.**
   `src-tauri/src/commands/jobs/rec_read.rs`. **[author-verified]** Eight job runners
   call `queue::finish_and_pump`; `rec_read` is the only one that does not, while
   `start_job_from_row` dispatches it as `Started::Runner` — the outcome that obliges
   the runner's epilogue to free the slot. Reading a recording happens automatically
   on Stop, so the slot leaks on first use and every later background job (deep
   summary, file pass, studio, download, workflow) stalls for the rest of the session.

4. **MarkdownEditor's Preview layout unmounts the buffer.**
   `src/viewers/MarkdownEditor.tsx:136` — `{layout !== "preview" && <CodeEditor …>}`.
   Pressing Preview destroys the only editable copy; the preview keeps painting the
   edited text from React state, so the loss is invisible until you switch back to
   Source and see the last saved text. The dirty flag goes with the unmount, so the
   unsaved-edits guard is disarmed too.

## The two things that recur everywhere

**Unsaved editor text is discarded by almost every navigation.** `guardLeave` is the
stated contract, and sixteen call sites across six files navigate around it — ⌘K rows,
Home cards, skill opens, every Workflows/Scripts/Map entry, Escape, opening any file,
and ⌘Q after cancelling the quit dialog. This is one root cause producing at least
eight separately-reported P1s. Fixing `openArea` into a single `a.goToArea()` and
routing all sixteen through it closes most of them at once.

**The app asserts things it has not checked.** 51 findings are of kind `honesty`:
"Recording saved — transcript included" is asserted rather than checked; "Trackers
blocked" rides on a different question's answer; the crash card claims nothing was
written, which a render boundary cannot know; a timed-out approval is reported to the
model as the user having declined after seeing the preview. For an app whose stated
core value is honesty, this is the highest-leverage theme in the review.

## What I refuted

- **"The files-tier Leash writes its token in plaintext, which the tier promises never
  to do."** The disclosure text at `RoomServerSection.tsx:160-167` names
  `~/.arcelle/leash.json` explicitly and renders for *both* tiers, and the file is
  written `0600` with permissions re-enforced over any pre-existing file. No such
  promise is made. Struck.

## Test coverage — the gates do not cover the app

- **Four test guards cannot fail.** `browser.rs:2470`, `:2471`, `:2571`,
  `web/fetch.rs:675` assert that a file's own source contains a literal that is
  present *in the assertion line itself*. True by construction. **[author-verified]**
  The `fetch.rs` one is guarding an SSRF-relevant invariant (that reqwest must not
  follow redirects itself), so that invariant is in practice unguarded.
- `npm test` runs build + page-script + Rust + Python. It does **not** run
  `npm run test:mock`, clippy, or any wdio suite.
- The only suite that renders the real React app is wired into no gate at all.
- Six of ~26 viewer kinds are ever rendered by a test.
- Touch ID has no test anywhere.
- Nothing ties `RULE_LIST_ID` to the rules it caches, so an edited content blocker
  ships stale — the exact failure mode already recorded from v0.23.0.

## Suggested order

1. The two privacy P0s — one-line fix each, mirroring `engine_id_of`'s both-spellings
   test into `privacy.py`. Add the `<size>-cloud` case to the sidecar's tests.
2. `rec_read`'s missing `finish_and_pump`, plus a test that a second job starts after
   a read completes.
3. The unsaved-edits root cause: one `goToArea`, sixteen call sites.
4. MarkdownEditor Preview.
5. The four inert test guards — rewrite to assert against behaviour, not source text.
6. The honesty pass: 51 items, most of them small, highest value per line changed.
7. Simplification: the deferred-Save model, the duplicate front page, the duplicated
   Create/Creations list, StudioModal vs AiActionModal, and the 215 lines of shadowed
   CSS in `shell.css` are the largest deletions with no behaviour change.
