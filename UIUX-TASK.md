# Task: UI/UX audit of Private Room (for a computer-use agent)

## Your role
You are a senior product designer doing a hands-on UI/UX review of a macOS
desktop app called **Private Room**. Drive the real app, look closely at every
screen, and produce a prioritized list of concrete UI/UX improvements — with a
screenshot for each finding.

You are judging **look, feel, clarity, and flow** — not functional bugs. If
something is broken, note it briefly and move on; your job is the experience.

## What the product is (so you judge it against its own intent)
Private Room is a private AI workspace that lives inside one encrypted file. The
brand is calm, quiet, and trustworthy — "a sealed room you step into." Design
language:
- **Mood:** calm, private, focused. Not loud, not busy. Lots of breathing room.
- **Colors:** ink background (`#0e1014`), dark panels, one violet accent
  (`#8b7cf6`) used sparingly for focus/keyholes/actions. Green/amber/red for
  status only.
- **Metaphor:** a violet keyhole / doorway. Unlocking and locking are meant to
  feel like a small ritual ("The Seal").
- **Users:** privacy-conscious non-experts plus professionals (lawyers,
  therapists, journalists). Text should be plain and reassuring, never jargon.

## Setup
- The app is already installed and open (Applications → Private Room). If closed,
  open it.
- Some screens need the local AI (Ollama) running; most UI can be judged without
  it. Do a full pass without Ollama first, then turn it on for the AI screens.
- Take a screenshot of every screen and every issue. Note light vs dark if the
  system theme matters.

## What to evaluate (apply these lenses to every screen)
1. **Visual hierarchy** — is the most important thing the most prominent? Can you
   tell at a glance what to do next?
2. **Consistency** — do buttons, spacing, corners, icons, and wording match
   across screens? Flag anything that looks like it came from a different app.
3. **Spacing & alignment** — cramped areas, uneven gaps, misaligned edges,
   things touching the window edge.
4. **Typography** — sizes, weights, line length, truncation, text that runs
   together or wraps badly.
5. **Color & contrast** — is text readable? Is the violet accent used with
   restraint and only for real actions? Check both light and dark themes.
6. **Affordance & discoverability** — do clickable things look clickable? Are key
   features hidden? Would a first-timer find them?
7. **Feedback & loading** — does every action show it's working (spinners,
   disabled states, "done")? Any action that seems to do nothing?
8. **Empty states** — what does a brand-new room / empty list / no-results look
   like? Is it welcoming and guiding, or blank and cold?
9. **Error & edge states** — are error messages calm, clear, and do they offer a
   next step (a button, not just text)?
10. **Motion** — the unlock "bloom" and the lock "fold" (The Seal). Do they feel
    smooth and intentional, or janky/missing? Respect that some users have
    reduced-motion on.
11. **Flow & friction** — count the clicks and confusion in each core journey.
    Where do you hesitate or feel lost?
12. **Accessibility** — focus rings, keyboard navigation, hit-target sizes, and
    contrast. Is there a visible focus state when tabbing?
13. **Delight & brand fit** — does it feel like the calm, private "room" it
    promises, or like a generic settings-heavy tool?
14. **Resize behavior** — make the window small and large. Does the layout hold
    up, or do things overlap / get cut off / scroll horizontally?

## Screens & flows to cover (don't skip any)
Walk these in order and apply the lenses above to each:
1. **Start / gate screen** — first impression, "Create a room," "Open," "Try a
   demo room," recent rooms.
2. **Create-room flow** — location, password + strength, name, template picker,
   role picker, the recovery-code sheet (and its Copy/Print buttons).
3. **The Seal** — the unlock animation (every open) and the lock animation (⌘L).
4. **Front Page** — the dashboard shown on unlock (recent files/chats, memory,
   counts, suggested questions).
5. **File sidebar & folders** — list, folders, drag behavior, the "Map" toggle.
6. **Room Map** — the constellation view (stars, links, tooltips, zoom/pan, the
   header text, empty state).
7. **Chat** — composer, the `#` command menu and `#help`, streaming answer,
   source chips, annotation/receipt chips, memory-suggestion card.
8. **Studio Shelf** — Flashcards / Mind map / Podcast buttons, the new
   "edit the prompt" box, and the generated files as they open in the viewer.
9. **Viewers** — PDF, DOCX, spreadsheet, Markdown/HTML, image (with the
   "mark something" bar), audio transcript, code (Monaco). Judge the viewer
   chrome and toolbars.
10. **File history / Time Machine** — the version timeline.
11. **Settings** — every section: model, Remote AI (Closet), Room server (Leash),
    Roles, AI helpers, Recovery key, online features. Settings is long — judge
    its navigation and grouping.
12. **Toasts & dialogs** — trigger a few (e.g. an action with the AI off) and
    judge the messaging and action buttons.

## How to report (this is the deliverable)
Produce a single report with:

**A. Findings list**, each item:
- Screen / location
- Screenshot
- What's wrong (one sentence)
- Which lens it fails (from the list above)
- Why it matters (the user impact)
- Suggested fix (concrete — e.g. "increase gap to ~12px," "move X above Y,"
  "add a loading spinner," "soften this red")
- Severity: **High** (hurts trust or blocks understanding), **Medium** (friction
  or inconsistency), **Low** (polish).

**B. Top 5 quick wins** — small changes with the biggest payoff.

**C. Top 3 high-impact ideas** — bigger redesign moves that would most raise the
overall feel, each with a short rationale.

**D. One-paragraph overall read** — does the app currently deliver on its "calm,
private, trustworthy room" promise? Where does it feel most on-brand, and where
does it feel like a generic tool?

## Rules
- Judge against the app's OWN calm/private/violet-keyhole intent, not a generic
  "add more color/animation" template.
- Be specific and visual — every finding needs a screenshot and a concrete fix,
  not a vague "improve spacing."
- Prefer restraint. This product's strength is quiet focus; flag anything that
  adds noise, clutter, or unnecessary decoration.
- Separate opinion from fact: mark subjective calls as "taste" vs. clear
  problems (contrast failures, overlaps, dead-looking buttons).
