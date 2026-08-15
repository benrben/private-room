# Changelog

All notable, user-facing changes to Arcelle. Versions follow
[semver](https://semver.org); dates are the GitHub release dates.

## 0.24.0 — 2026-08-16

### Tracker blocking actually works

The private browser has been saying **Tracker blocking is OFF** and meaning it.
The rule list is compiled by WebKit itself, and WebKit does not run an ordinary
regular-expression engine over it — it accepts a narrow subset and throws out
the **whole list** if one pattern falls outside it, without saying which. Two
patterns did. Both are unremarkable regular expressions that any other engine
takes, which is why they looked right and why the tests covering them passed:
those tests check the patterns against a real regex engine, and a real regex
engine agreeing proves nothing about WebKit's.

Every pattern is now written in the subset WebKit documents, and a test refuses
the two constructs that broke it, so this cannot come back quietly. When a
compile does fail, the journal now records the reason instead of a bare error
number.

### The browser stops crying wolf on the first page you open

Type an address into a new page, press Return, and the page loaded — while the
toolbar said *"This page is not answering."* Reload was the only cure.

The browser asks each page how it is doing about once a second. A navigation
takes the page out from under that question, which is the strongest possible
sign that a navigation is happening — and it was being reported as the page
failing to answer. Only the case where a page waits for its content blocker had
been fixed, so the case everybody meets first was untouched.

Private pages are also named after themselves now. The page list said **New
page** over a loaded site while the toolbar beside it already showed the site's
real title: one answer carrying both facts, with the title thrown away. A page
that moves loses the old name immediately rather than wearing it into the next
site.

### Recordings is a review screen again

**One player.** There were two — a transport at the top and a second, plain
audio player further down, with nothing saying which was in charge. The second
one only existed because the first had no volume, speed or scrubbing. It has
all three now, plus a seek bar marked with the highlights and chapters worth
scrubbing to, and the second player is gone.

**Recording settings stopped following you into playback.** A finished
recording permanently showed *Continue recording*, the Mac's-audio switch,
speaker handling and Live translate. Those are choices about capturing, not
about reviewing, so they now appear when you choose to continue recording and
not before. Nothing was removed.

**A transcript you can work with.** It was one dense block of speech. It is a
line per phrase now, each with its own timestamp you can play from, the line at
the playhead marked as you listen, and a search that says how many matches it
found — including when it found none.

**Highlights say what they are.** A highlight used to be a bare time range. It
now carries a title and a quotation drawn from the words actually spoken in that
stretch, with a way to play it and a way to find it in the transcript. A mark
over a stretch nobody transcribed says so, rather than showing an empty quote.

**The Recordings overview stopped repeating the sidebar.** It listed every
recording and offered the same two capture buttons the sidebar already has.
Instead it now shows what is recording or saving right now, what is on the
shelf, the most recent recording, and any recording still waiting on a
transcript — with the reason for each. It deliberately does not show total
length or your capture devices: nothing in the app can currently state either
without guessing.

## 0.23.0 — 2026-08-15

### Sketch becomes an editor

Drawings opened ready to draw. Every one of them — so panning around a diagram
someone else had made left marks on it. **Select is the resting state now**, and
a tool goes back to it after making one thing. Double-click a tool to make it
stay; the button shows which state it is in.

Once something is selected there is finally something to do with it. Eight
grips resize it, a dragged box selects several, and a multi-selection can be
aligned, spread evenly, sent forward or back, duplicated, locked in place, or
nudged with the arrow keys. Objects snap to the page's dots and to each other,
with alignment guides while you drag.

**Arrows attach.** Draw one from one box to another and it stays attached: move
either box and the arrow re-routes to follow. The drawing agent's arrows attach
the same way, so a diagram it draws survives being rearranged by hand. Drawings
made before this release still open — an arrow that was never attached to
anything simply stays where it was put.

Every object is reachable without a pointer. The strip under the canvas names
each one — what it is, what it says, where it sits, whether it is locked — and
selecting a row selects the shape. It follows the selection instead of leaving
it off the end of the row, and the count on the left opens the whole set.

A drawing can be saved into the room as a **picture (PNG)** or a **drawing
(SVG)**, both from the file header alongside Export, worded so the two acts
cannot be confused: one writes into this room, the other writes out of it.

### The assistant can see the drawing you are looking at

Asked "what's missing here?" over a full diagram, the room used to search two
hundred files, find nothing about the drawing, and answer anyway — with nothing
on screen saying it had never looked.

The chat now says what it is answering from, and offers the drawing by name.
Select some objects and it offers those instead. Pinned sources are added to,
never silently swapped out — the strip says `"Portfolio map" + 2 attached` when
that is what it is about to do.

### Fixes

- **Escape no longer closes the whole drawing.** It now closes a menu, then
  clears the selection, and only then reaches the shell.
- **Export appeared twice**, a few pixels apart, doing different things.
- "Could not open that file" named no file, offered no way to try again, and
  stayed on screen after a second click had opened it. All three fixed. Errors
  still never vanish on a timer.
- Undo looked broken while typing in a note. It was not: a note has its own
  undo and the drawing deliberately keeps out of it. The page says so now
  instead of leaving you to guess.
- Removing a sketch from the Library jumped to a different sketch.
- Add/Remove confirmations piled up until they covered the workspace.
- The contextual sidebar was still labelled "Library" inside Memory.
- An agent promoting a file to the Library was recorded in Chat but not in
  Activity.

### The private browser stops overstating itself

The shield read **Private** — "nothing saved, trackers blocked" — off a single
check that knows about storage and nothing whatsoever about tracker blocking.
It kept saying so while the room's own journal filled with "Content blocking
FAILED to load". Two facts now, asked separately and stated separately, and the
weaker one sets the tone.

Closing the last page left the toolbar showing the closed page's address, its
padlock and a live Save strip; leaving the destination and coming back was the
only way to get an honest toolbar. Page-scoped state is now dropped with the
page, and the Save strip's buttons no longer stay clickable with no browser
open.

The activity journal was 300 rows of every event from every sitting in one flat
list — auditable and unreadable, which for an audit trail is the same as
unauditable. It is grouped by browsing sitting now, with "what just happened"
first and filters over the kinds.

A page's text and a way back out of it can now be reached by keyboard and
screen reader — the page is a native view whose accessibility tree the app
cannot otherwise reach into.

## 0.22.0 — 2026-08-15

### Quote from anything you can read

Selecting a sentence in a document offers to send it to the chat, with the
file's name attached. That used to work only for plain documents. Saved web
pages, e-books and old Word files were left out — not on purpose, but because
the rule that decided it was borrowing a list built to answer a different
question. Three of the formats people most want to quote from were quietly
excluded.

Now they all work. Highlight a sentence on a rendered web page and the quote
button appears over it. E-books and `.doc`/`.rtf` files gained a **Text** view
beside the formatted one — the document's words, selectable and quotable.
Those two render with scripting completely switched off for safety, and that
isn't being loosened to sell a quote button, so **Text** is where you quote
them.

The room will not quote something it cannot find in the file. A web page that
writes its own text with a script has nothing the app can check against, so no
quote is offered rather than one it can't stand behind. Selecting the room's
own reply in the chat, a chapter title in a book's contents, or a label on a
toolbar offers nothing either — none of those are the document.

### The room stops saying things it doesn't know

A wave of small honesty fixes, each removing a claim the app couldn't back up.

A job waiting its turn used to animate as though it were working; it now sits
still and says it's queued. A job that had just started showed "0 of 1 steps" —
one step, none of them done, both invented — and a finished deck kept saying it
in the history forever. Studio runs report their phase instead, because that is
what they actually know.

Turning off automatic file descriptions now turns them off. "Scan now" with
cloud privacy switched off explains why it can't, instead of doing nothing.
Speech that fails says so rather than going quiet, and no longer speaks a
two-word fragment before pausing. Error messages stay until you dismiss them.
Opening a file no longer discards a prompt you were half-way through typing,
and a background job finishing while you're reading an answer waits with an
"Open" button instead of jumping you away.

Hebrew and other non-Latin text was getting about a third of the working memory
it should have — the room was counting bytes where it meant characters.

### A real View menu, and a new face

The layouts, panes and sidebar options that lived only in on-screen controls
are now in the Mac's own **View** menu, where you can search them from Help and
see their keyboard shortcuts written down. ⌘1 and ⌘2 show and hide the Library
and the Assistant.

The room also reads a little differently: a new typeface for the interface and
another for headings, warmer accent colours, and corners and icons that are
consistent from one surface to the next.

### Quieter and quicker

The room was shutting its local model down inside the very window it had asked
it to stay warm, so the next question paid a cold start for nothing. Locking
the room now releases that memory instead of holding it behind the password
screen.

## 0.21.0 — 2026-08-13

### A page for drawing

**Sketch** is a new place in the sidebar. Five marker pens, boxes, ellipses,
arrows, notes and freehand, on a dotted sheet that matches the rest of the
room. Pinch to zoom, two-finger scroll or hold space to pan, ⌘0 to fit the
page. Nothing has a Save button — the page saves itself as you work, and ⌘Z
goes back eighty steps.

A drawing is an ordinary room file, which means it gets everything other
files get: version history, trash, and search. Search the room for a word you
wrote inside a box and the drawing comes back. Export it as an SVG and it
lands in the library like anything else.

### The room can draw with you

Ask for a diagram in chat — "draw my login flow" — and it appears on the
page, shape by shape, in the pink pen the room uses to mark its own work.
Ask it to add to a drawing you started and it reads yours first, so your
shapes are still there afterwards.

What makes this useful rather than approximate: after it draws, it measures.
Boxes sitting on top of each other, an arrow stopping short of the box it
was meant to reach, a note lying across something, a box with no words in
it, anything off the page — it finds these itself and fixes them before
telling you it's done. That check is real measurement, not the model
squinting at a picture, so it works the same whether the room is running a
small model on your Mac or a large one in the cloud. Pictures are only ever
sent to a model that can see them, and never past the privacy setting.

**`#sketch` a file** turns a whole document into a diagram — read the file,
find what it's made of and how the parts connect, and lay it out. The layout
is computed rather than guessed, so a generated diagram can't come out with
boxes overlapping or arrows pointing at nothing.

### A calmer sidebar

The left column used to hold ten destinations, three pane toggles, search,
focus and settings. It now holds **four places** — Home, Recordings, Private
browser and Sketch — with the rest one click away under **More tools**. You
choose which four: **Customize sidebar** pins, unpins and reorders, and your
choice follows you between rooms. ⌘K still lists every place, pinned or not.

Showing and hiding panes moved out of navigation and into the toolbar. A new
**Layout** menu holds Library (⌘1), Assistant (⌘2), Focus, three presets and
Reset, each with its shortcut printed on the row rather than hidden in a
tooltip. The **Assistant** button carries its own news: how many approvals
are waiting, and whether anything is running — but only while the pane is
shut, because a count next to an open pane isn't news. The workspace itself
can no longer be hidden by anything, and a room that had somehow been left
with it hidden opens with it back.

**Settings → App → Interface** is new: the same sidebar list, the layout
presets, a **Compact** density for the whole app, and a switch to turn off
the dotted canvas texture. Everything applies as you touch it.

### Fixed

The eraser could freeze the canvas — one swipe and nothing responded again
until you reopened the file. Drawing also stuttered, because every stroke
was being filed as a new version of the whole document and re-indexed for
search; a page now keeps one version per editing session, which is what
version history was for. And zoom, which the drawing page shipped without.

## 0.20.1 — 2026-08-09

### Long prompts draw pictures now

A detailed picture prompt — the kind a story shot writes for its opening
frame, with the scene, the cast, the action and the light all spelled out —
was refused at 4,000 characters with "over the 4,000 this room sends in one
go". That was Arcelle's own cap, not the model's, and it's gone: the prompt
is sent whole, and if a provider has a real limit, you hear it from the
provider in its own words. Video prompts never had this cap; pictures now
match.

## 0.20.0 — 2026-08-09

### A story films as one take

Filming a shot list no longer produces a pile of unrelated clips. Each clip
now opens on the **exact final frame of the clip before it** — captured from
the finished video itself, not re-imagined from a description — so scene two
starts precisely where scene one ended. The captured frames are filed into
the room ("… — end frame.png"), so you can open any seam and check it. A
clip whose predecessor hasn't finished parks itself with "Waiting for the
shot before it" and starts on its own the moment that clip lands; stopping,
locking the room, or quitting mid-run can't reorder the chain or bill a
join that was lost.

### Read the plan before it costs money

**Film them…** now opens a review sheet first: every part with its prompt,
its opening frame, its length, its model, and who's in it — plus plain
warnings when something won't do what you expect (a part with no picture of
its character, a model that can't accept an opening frame). Nothing is sent
until you press Send, and pressing it twice can't queue the list twice. When
a run is doomed — out of credits, a model with no endpoint — the parts
waiting behind it stop too, with the reason on each card, instead of failing
one by one at full price.

### Scripts and characters come from your files

The Story tab can now read what you already have instead of asking you to
retype it. Pick a script file from the room and its text becomes the shot
list source; pick a character sheet and the room's own model reads the cast
out of it, showing you exactly who it found — every name editable, anything
that isn't a person one click away from being dropped — before a word of it
is used.

### Pictures and clips, sized how you want them

The Create page now offers resolution and aspect-ratio choices for models
that publish them, and only shows models that can actually be reached — no
more picking a router that has no image endpoint behind it.

### A new face

Arcelle has a new icon: a cream paper ribbon folded into an A, peeling open
at the foot, with a small gold spark in the counter — on the same dark
dotted sheet the app itself is drawn on. The Dock, the document icon, the
favicon, the launch screen, and the little mark in the top bar all wear it.

## 0.19.1 — 2026-08-08

### In-app updates actually install now

Checking for updates worked, but installing one didn't: the download would
finish and then fail to unpack. The updater payload was built with a plain
macOS `tar`, which silently smuggles in an invisible `._Arcelle.app` metadata
entry ahead of the real app — invisible because macOS's own `tar` hides it
from a normal listing, so it looked fine right up until the updater actually
tried to install it. This release's payload is built without that entry, so
**Settings → App → Check for updates** can now download and install in one
click, the way it was always meant to. If you're on an older version, this is
the first release your app should be able to install by itself — the bug was
in how past releases were packaged, not in your app's updater, so this one
clean payload is enough to fix it going forward.

## 0.19.0 — 2026-08-08

### The room describes itself

Area subtitles, tab titles, and activity summaries are no longer fixed copy —
Arcelle now drafts them from what's actually in the room. Recordings, Memory,
Skills, and the room's front page each get a one-line description grounded in
your own files; open files pick up a 2-3 word tab title instead of a bare
filename; and repeated runs of the same script or workflow collapse into one
activity-feed row with a summary line instead of a wall of duplicates. A
plain static line always shows first — the generated one only swaps in if
it's ready in a blink, otherwise it's ready next time you look, never mid-read.
One switch covers all of it: **Settings → AI & behavior → "Let the local AI
write small pieces of the interface."**

Files in the Library can also show their own AI-written one-line description
under the filename, when "Describe new files automatically" is on — that
text already existed, it just wasn't shown until now.

### A calmer left rail, and Find moved where you already look

The rail's areas are grouped into four labeled sections — Room, Capture,
Automate, Context — instead of one long list. Collapsed, it shows icon and
tooltip instead of shrunken relabeled text. The standalone Find page is gone;
the same filters, highlighting, and saved/recent searches now live inside
⌘K.

### A quieter composer and document toolbar

The composer's two privacy ribbons collapse into a single line reflecting
what's actually about to happen, instead of repeating on every message; the
token meter only shows once you're actually using real context space. The
document toolbar keeps 2-3 primary actions and tucks the rest into an
overflow menu — "Preview cloud payload" is now "Show me exactly what would
be sent."

### Fixes

- Pane toggle buttons show their actual on/off state, and the Library stays
  readable when panes are hidden.
- The composer's "# Action" button opens its popover reliably; "*
  Specialist" and "# Action" now clear their active state on Escape/blur even
  with a partial filter typed.
- Settings is a fixed size and resets scroll position correctly when you
  switch tabs.
- ⌘A selects page content again — chat text, document content, form fields —
  not the whole app chrome.

## 0.18.0 — 2026-08-07

### Do things to many files at once

The Library used to work one file at a time. Now you can pick several — hold
⌘ to add one, Shift to take a run, ⌘A for everything on screen — and move,
export, attach, or trash the whole lot in a single go. Dragging any picked
file drags all of them. The Trash tab works the same way, so you can put a
dozen files back where they came from without clicking a dozen times.

When part of a batch fails, Arcelle now tells you *which* files failed and
why, and finishes the rest. It no longer reports a whole batch as done when
some of it wasn't.

### The AI can tidy your room

Ask the file assistant to sort your files into folders, rename them, file
them by topic, merge two documents into one, or move clutter to the trash —
and it does it in one pass rather than one file at a time. For anything big,
ask it to show you the plan first: it can preview the whole reorganisation
without touching anything.

It can move files to the trash, and that's as far as it goes — it cannot
permanently delete anything or empty your trash. Those stay yours alone. When
it does trash something, the Trash tab says so, and names the tool it used.

Renaming and moving by name also just works now. Arcelle lists files as
`Folder/name.pdf`, but the assistant couldn't accept that back — you had to
strip the folder off first, and often it simply failed. It now takes exactly
what it showed you.

### Podcasts you can actually listen to

A podcast script is no longer only a page to read. Open one and you'll find
**Voices**: each host gets their own voice, speed and pitch, with a preview
that reads one of their real lines so you can hear whether it suits them.
Press Record and Arcelle produces a finished episode as an audio file in your
room — each host in their own voice, with natural gaps between turns.

The episode arrives with a timed transcript, so you can read along, click any
line to jump to that moment, and see who said what. Re-cast a host and record
again and your earlier episode is kept, under its own name.

Recording sends the script to an online voice service, and the panel says so
plainly before the button — including a warning that if your privacy door is
on, names will be spoken as their placeholders, so you learn that before you
listen rather than after.

## 0.17.0 — 2026-08-05

### Hands-free now sends on its own

Talking to Arcelle hands-free used to still need one manual step: after you
finished speaking, you had to tap the mic again to stop the recording and
send it. Now it notices the pause — once you've said something and go quiet
for a beat, it sends on its own. Nothing to tap mid-conversation.

### Deleting a memory is no longer permanent

The same trash Arcelle already gives deleted files now covers memories too.
Removing one moves it to the trash instead of erasing it — it drops out of
what the AI can recall, but it can be put back.

### The AI's editing tools got more precise, and more honest about what they did

A handful of fixes to how Arcelle's own AI edits files and reports back on
its work:

- Asking it to change one specific occurrence among several identical ones,
  or to edit only a named section of a document, now works instead of
  guessing.
- A full-document rewrite now reports what actually changed — added/removed
  lines and a flag when the new version is suspiciously shorter — instead of
  just a character count that could hide a partial rewrite passed off as
  complete.
- A big find-and-replace (more than 10 occurrences at once) now always shows
  a preview first, even with the "ask before AI edits" setting off.
- Checking on a background job can now target one specific job instead of
  always listing all of them.
- Fetching a web page that redirects elsewhere now says so, instead of
  silently reading the page it landed on.
- The memory list the AI can see is now capped (with an honest count) so one
  room with hundreds of saved notes can't crowd out everything else it knows.

### Quieter security hardening

- A downloaded file whose actual content doesn't match its extension (an
  executable disguised with an inert-looking name) is now caught.
- Spreadsheet values pasted or imported from elsewhere are checked against
  the same broader "could this be read as a live formula" rule Excel/Sheets/
  Numbers use, not just this app's own narrower one.

## 0.16.0 — 2026-08-04

### When something goes wrong, there is now a record of what Arcelle did

Arcelle already kept the AI service's own log. It kept nothing about its own
decisions — so when an agent behaved strangely, the only account of what
happened came from the model, and a model handed no tools does not report that;
it invents a reason. That guess has ended up in bug reports.

- **A second log file, `arcelle-host.log`**, records what the app decided: which
  tools each AI was given (by name), which model answered a question and how
  long it took, whether a Stop actually reached the AI service, and every change
  of state in a background job.
- **Settings → Updates & version → Reveal logs** opens the folder holding both
  files, so a bug report can have them attached.
- **Nothing from a room is in them.** No messages, no file contents, and not
  even file names. The log holds ids, counts, sizes, durations and the *kind* of
  an error ("not found", "network") — never its text. This is enforced by the
  code rather than by care: there is no way to write a room's words into the log
  even by mistake.
- Both files keep one previous copy instead of growing forever, and the app log
  is capped in size.
- The detail level is quiet by default and turned up with `ARCELLE_LOG`
  (`ARCELLE_LOG=arcelle=debug`). A value Arcelle cannot make sense of falls back
  to the default and says so in the log, rather than leaving you with an empty
  file and no hint that your setting was the reason.

### Deleting a file is no longer permanent

Arcelle had no undo for a deleted file. That mattered more here than in most
apps, because Arcelle edits and removes things on its own without asking first.

- **Deleting moves a file to the trash.** It leaves the library, the counts,
  ⌘F search and everything the AI can find or answer from — but its bytes, its
  saved versions and its transcript are still there.
- **A Trash tab in the Library** lists what was deleted, when, and **by what**:
  by you, by the AI (naming which tool), or by Arcelle itself (naming which
  command). "What did the AI delete" is now a question with an answer.
- **Restore puts a file back whole** — including back into search. A restored
  file is findable by keyword and by meaning immediately, not after some later
  background pass.
- **Deleting for good is a separate, explicit act**, only available on a file
  already in the trash, and it says so. Emptying the trash reports the number
  of files it actually destroyed.
- Nothing ever leaves the room. Trashed files stay inside the encrypted room
  file — there is no hop through the macOS Trash and no copy on your disk.

Files and how you read them. Arcelle already stored a lot of formats; it could
only really *show* about half of them. Nine formats had no viewer at all, three
more opened in the wrong one, and a file over a size limit silently lost its
viewer entirely. This is that gap, closed.

### Formats that had no viewer now have one

- **PowerPoint decks open as slides — drawn by macOS itself**, so a deck looks
  the way it looks in PowerPoint: real backgrounds, real type, real artwork.
  Both `.pptx` and the old `.ppt` render this way, with a slide rail, speaker
  notes, and citations that land on the right slide.
- **Old Word files (`.doc`) and `.rtf` keep their formatting** — headings,
  weights, sizes, colours and alignment — read by the same importer TextEdit
  uses. They used to arrive as one flat column of text, when they arrived at
  all.
- **E-books open as books**, with a table of contents, chapter navigation and
  adjustable text size, instead of the whole volume as one block of text.
- **Zip archives show what is inside them**, as a folder tree with sizes,
  without unpacking anything.
- **Jupyter notebooks render like notebooks** — prose, code and output — rather
  than as raw JSON in a code editor.
- **Saved email (.eml) reads as mail**: subject, sender, date, body, and a list
  of the attachments. It used to show MIME headers and base64.
- **Subtitles (.srt/.vtt) open as a timed transcript**, and you can fix a line
  without hand-editing a single timecode.
- **JSON opens as a collapsible tree** you can actually navigate, with a Raw
  toggle when you want the source.
- **SVG shows the drawing with its source one click away.** It used to open as
  a flat picture with the markup unreachable.
- **Plain text and logs stopped opening in a code editor.** A letter gets prose
  typography; a log gets severity colours, a filter, and the end of the file
  first — which is where the answer usually is.
- **Anything else the Mac can preview now gets previewed.** Keynote, Pages,
  Numbers, RAW photos, Photoshop files, 3D models — macOS draws the page.
  "No preview available for this file type yet" is now genuinely the last
  resort rather than the first answer.

### Formats that had a viewer, improved

- **Recordings show their waveform, with each speaker's turns drawn over it.**
  Arcelle has separated speakers on-device since 0.14.0 and none of it was
  visible; now the shape of a conversation is the first thing you see, and the
  speaker's name sits in its own column down the transcript.
- **Spreadsheets show the whole sheet.** The grid stopped at 1,000 rows and 60
  columns — silently. It now scrolls the entire workbook and honours the
  column widths, merged cells, colours and bold that were in the file all along.
- **Word files can actually be edited.** "Edit as text" saved a separate
  Markdown copy and left the document untouched; the assistant could edit the
  real file and you could not. Editing a `.docx` now writes back into it,
  paragraph by paragraph, keeping its styles, tables and images.
- **Notes render maths, diagrams and highlighted code.** `$…$` becomes real
  mathematics, a ```mermaid block becomes a diagram, and fenced code is
  coloured — all drawn on this Mac, nothing fetched.
- **Pictures pan by dragging**, and Word documents show their page breaks,
  headers, footers and comments.

### Big files stopped breaking

- **The 50 MB wall is gone.** A PDF, scan, workbook or document over it used to
  lose its real viewer and open as plain text with no explanation. Files now
  stream to the viewer instead of being copied through as one giant string, so
  a 300 MB scan is just a scan.

### Files that imported as unreadable

- **Old Office files read on their own.** `.doc`, `.ppt`, `.xls` and
  OpenDocument spreadsheets needed a separate developer tool installed to be
  readable at all — which in practice meant they weren't, so their contents
  were invisible to search and to the assistant. Arcelle reads them itself now.
- **Badly-extracted PDFs get read again properly.** A PDF whose text came out
  as interleaved columns or words with no spaces between them was indexed
  exactly like that, quietly poisoning search results and the assistant's
  answers. Arcelle now notices and re-reads the page with the same on-device
  recognizer it uses for scans.
- **Notebooks, email, subtitles, SVG and archives became searchable**, because
  their text is now read at import instead of being skipped.
- **Old Word and PowerPoint files no longer read as gibberish.** Reading them
  natively worked on paper and not on real files: a `.doc` came out as its font
  table followed by mojibake, and a `.ppt` as its slide master's placeholder
  prompts and binary noise. That was not just what the editor showed — it was
  the text stored for the file, so search and the assistant saw it too. `.doc`
  now goes through the same macOS importer that draws its preview, and `.ppt`
  is read from its actual slide records, numbered `[slide 1]`, `[slide 2]`, the
  same way a `.pptx` is. **Files already in a room are re-read once, on open**,
  so an old import fixes itself.
- **Links in old Word files are links.** A hyperlink used to print as
  `HYPERLINK "https://…"` in the middle of the sentence it belonged to, both on
  screen and in the indexed text.
- **A file renamed `.doc` can no longer smuggle its bytes into the index.** The
  macOS importer does not check that its input is really a Word document — hand
  it anything and it hands the bytes back as "text" — so Arcelle checks first.

### Editing tells you what it will do

The editors all looked alike — one monospace pane — while meaning three quite
different things, and several ways out of them threw work away without asking.

- **Nothing discards your edits silently any more.** Closing a file, closing or
  switching a tab, or opening another area now asks: Save, Discard, or Cancel.
  Closing the file used to lose the edit outright, and the tab strip used to
  refuse with a message that offered no way forward. A failed save no longer
  continues as though it had worked.
- **Undo clears the unsaved marker.** Typing and then undoing back to the
  original left "● unsaved changes" showing and the tab still blocked.
- **Every editor says what saving does** — rewrite this file, rewrite the words
  inside a Word document while keeping its layout, or write a separate note and
  leave the original untouched.
- **Notes edit beside their preview.** A `.md` file now opens with the Markdown
  and the finished page side by side, and a toolbar for headings, lists,
  quotes, links, code and tables. Source-only and preview-only are a click away.
- **Spreadsheet edits can be undone.** A cell saves the moment you leave it, and
  nothing said so: there was no mark on the changed cell, ⌘Z did nothing, and
  the only way back was the version history. Changed cells are now marked, the
  bar counts them, and ⌘Z puts the last one back.
- **Legacy `.xls` says it is read-only** instead of just having no Edit button.
- **Files that differ only by extension are told apart.** `report.doc` and
  `report.docx` both showed as "report" in the library and as "repo…" in the
  tab strip; where the tidy name is ambiguous the full filename is shown.

## 0.15.0 — 2026-08-02

A repair release. The whole app was read end to end — every Rust, Python and
TypeScript file — and the 484 problems that turned up were fixed. Most of them
you will never notice, which is the point. These are the ones you will.

### Your unsaved work stops disappearing

- **Nothing closes over unsaved edits any more.** Closing the window, quitting,
  locking the room, opening a new tab, switching tabs, closing a tab — all
  twelve ways out now stop and ask you first. Several of them used to throw
  away whatever you had typed without a word.
- **Locking no longer cuts off an answer mid-sentence.** If the assistant is
  still writing when you lock, you get asked before it is stopped.
- **Keyboard shortcuts that never fired now fire.** Next and previous tab
  (⇧⌘] and ⇧⌘[) were listening for the wrong key the whole time. Jump to a
  tab by position is ⌥⌘1 through ⌥⌘9. ⌘1/2/3 still show and hide the panes,
  and nothing else steals them.
- **Closing a tab closes the file it was showing**, instead of leaving it
  open and invisible.

### Documents behave

- **Spreadsheets stop eating your formulas.** Clicking into a formula cell and
  clicking away used to overwrite the formula with the text `=SUM(...)`.
  Nothing is written unless you actually change something, and typing a formula
  into a cell now tells you plainly that it is not supported instead of quietly
  storing it as text. Blank rows no longer shift every row below them.
- **PDF citations highlight every time.** Following a second citation in a PDF
  you already had open used to scroll to the right place and highlight nothing.
  Find-in-page highlights also survive scrolling away and back.
- **Recordings say what they will do.** A recording that already has audio
  offers "Continue recording", and continuing genuinely appends rather than
  starting over. Exported subtitles are cut on the right timings.

### The window survives a bad panel

- **One broken panel no longer blanks the whole app.** A crash inside a viewer,
  the chat or the browser is now caught and shown in place, with everything
  else still working and a button to reload just that piece.

### Every agent works on every engine

- **The Browser agent works on cloud API models.** When a cloud provider
  rejected a request, Arcelle retried it with a hardcoded list of "its own"
  tools — a list last updated long ago, missing 19 of the room's 62 tools
  including *every* browser tool. For the Browser agent nothing matched, so the
  retry was skipped and the failure surfaced as an unexplained provider error;
  for other agents it quietly removed tools they were never told they had lost.
  The list is gone: a rejected request is now reported, with the provider's own
  reason, and never worked around by shrinking an agent's abilities behind its
  back.
- **Cloud models no longer get the screen tools.** The rule was always that an
  engine running outside this Mac can do everything the local one can *except*
  see or operate the app's own controls. The check only recognised the two
  command-line engines, so rooms on a cloud API model — added later — were
  handed those tools anyway. They now get the same tier as every other
  non-local engine; nothing else about what they can do changes.

### When a search or an agent fails, it says so

- **A blocked web search no longer reports an empty web.** Arcelle searches
  seven engines at once. When some of them are rate limited or blocked — which
  happens on an ordinary day — the assistant used to be handed the words "No
  results found.", so it told you a subject had nothing written about it when
  really the search had not run. It now says which engines were unreachable,
  and the results page marks a partial search as partial.
- **Every agent's full reply is kept in its own box.** A specialist's answer
  scrolled past in the chat and was gone a second later; the box that should
  have held it only said the agent had reported back.
- **A failed agent explains itself.** The panel used to say "the agent did not
  finish" and nothing more.
- **Provider errors now name the actual cause.** When a cloud provider routes
  your request to a backend that fails, it hands back the fixed phrase
  "Provider returned error" and files the real reason separately — that reason
  is now shown, so a rate limit, a rejected key and a refused request stop
  looking identical.

### Connectors ask two questions instead of one

- **"Run connector tools without asking" and "Send remote connectors real
  values" are now separate switches**, and both start off. They used to be one:
  the only way to stop a lookup coming back empty — because the privacy door
  had replaced the name you were asking about with a placeholder — was to also
  stop Arcelle asking your permission to run anything. Those are different
  risks, so they are now two decisions. Turning off the prompt no longer changes
  what leaves your Mac, and asking for real values no longer stops the prompt:
  with the prompt on, the card shows you the actual arguments before they go.
- **Both questions are asked per connector.** The two switches are now the
  default, and every installed connector can answer either one for itself —
  trusting the connector that reads files on your Mac says nothing about the one
  that reaches a service on the internet. Each connector shows which answer is
  in force for it and where it came from, so there is never a pair of controls
  whose combination you have to work out.
- If you had the old combined switch on, your connector calls still run
  unattended and Arcelle goes back to sending placeholders until you ask for
  real values. Nothing gains a per-connector permission you did not choose:
  every connector simply follows the switch until you tell it otherwise. The
  Connectors page states which is true right now, on this Mac.

### Around the code

- **The app carries a licence** (MIT), a security policy, and automated checks
  that run on every change.
- **One command now checks a release before it ships.** All six version files,
  the changelog, the bundled models, and every test suite — after 0.14.0 went
  out with a stale lockfile inside it.
- **The signature covers the whole bundle.** The offline command-line tool
  shipped inside the app was signed after the app was sealed, which invalidated
  the seal; macOS could refuse to open the result.
- The test suites roughly doubled: 738 on the app, 1,241 on the AI service,
  85 on the page scripts.

*Not yet:* an update is still a ~600 MB download, because the speech model
ships inside the app. Making it download on first use like every other model is
real work and is not done — and the shortcut version of that fix silently broke
transcription in an unreleased build, so it stays as it is until the real one
exists.

## 0.14.0 — 2026-08-01

### Recordings finally split speakers where they actually change

- **Two people talking back and forth no longer melt into one "Speaker 1".**
  The old pipeline labeled whole phrases, and most real conversation puts two
  voices inside a single phrase — so short exchanges collapsed into one
  speaker. Recordings are now re-examined in 1.5-second steps and the
  transcript is cut exactly where the voice changes, both for live
  recordings and for **Re-transcribe** on anything you already recorded.
  On our meeting test set this took speaker mix-ups from 17.9% to 1.3%.
- **No more phantom speakers.** A couple of seconds of laughter, overlap, or
  an odd-sounding word could previously mint a "Speaker 4" who owned one
  line. A voice now has to carry real speech mass before it counts as a
  person; short odd moments join the nearest real voice instead.
- **The recording benchmark ships with the code.** A permanent acceptance
  harness scores the real pipeline against reference meetings, so future
  changes to speaker separation get measured, not eyeballed.

### The browser grows downloads, search, and tabs

- **Downloads that behave.** Click a download link and the file lands through
  one guarded funnel — size-capped, origin-checked, recorded as a job you can
  watch. The assistant can save a link, a file, or a page's media for you,
  and video sites work through the same door.
- **A real search page.** Searching in the browser opens a results page of
  its own — with previews, and an on-demand AI summary whose every claim
  links back to the result it came from.
- **Tabs.** The browser now holds several pages at once.
- *Not yet:* saving a file that no link points at but that needs the site's own
  login, and "Save as PDF" of the page you're reading. Clicking a download link
  on a site you're signed in to does work — those carry the session with them.

### Spoken voice is now fully neural

- **The robotic fallback voice is gone.** Arcelle speaks only with the neural
  voices; the on-device engine and its settings have been removed.
- **The voice list is live.** Voices come from the speech engine's actual
  catalog (322 voices today), grouped by language, with preview — instead of
  a bundled list that goes stale.

## 0.13.0 — 2026-07-30

### One search engine, built in

- **No more picking a search provider.** Settings → Online features used to make
  you choose between DuckDuckGo and running your own SearXNG server (and, before
  that, Brave with an API key you had to get yourself). All of that is gone. It's
  now a single switch: let this room reach the internet, or don't.
- **Search asks several engines at once and merges the answers.** One query fans
  out to seven independent sources — general web engines, an encyclopedia, and a
  news feed — and the results come back as one list, ranked by how highly the
  engines rated each page *and* how many of them agreed on it. Pages several
  engines put near the top rise to the top.
- **A blocked engine no longer means a failed search.** Any single engine can be
  rate-limited, ask for a human check, or change its layout; when that happens it
  simply drops out and the rest still answer. The old setup had one engine, so
  one bad day meant "search is broken, try again in a minute".
- **Every result says where it came from.** Each hit now carries the engine that
  found it, its date when the source publishes one, and how relevant it scored —
  instead of the marketing blurb search pages print under a link.
- **Rooms you already have keep working.** A room where you'd picked a provider
  opens with the internet switch already on. Nothing to redo.

### A private browser, and an assistant that can use it

- **New Browser area: a web browser that keeps nothing.** It has no history, no
  cookies, no cache and no saved logins — not "cleared on exit", but never
  written to disk in the first place — and it blocks ads and trackers before
  the request leaves your Mac. The shield in the toolbar is a live check of the
  browser's own storage, not a label.
- **Ask the assistant to look something up and it opens the page itself.** It
  can read a page, find and click things, fill in forms, and look at the page
  as a picture with every clickable thing numbered — the same numbers it uses
  when it describes them to you, so you can follow along.
- **You can take the wheel at any time.** "Take over" pauses the assistant's
  browsing; it will say its tools are paused rather than pretending to act.
- **Nothing of yours goes into a web page without you saying so.** If the
  assistant is about to type something you marked private into a site, it stops
  and shows you the exact text and the exact site first.
- **The web forgets; your room remembers.** Everything the assistant did in the
  browser — every page, click and consent — is kept in a Journal inside your
  encrypted room, so you can read back exactly what happened. You can clear it
  whenever you like.
- **The browser can't be used to reach this Mac.** Addresses on your own
  computer or home network are refused, in the address bar and inside pages
  alike, and passwords fields are fenced off from the assistant entirely.
- **Two separate switches for what the assistant may do online.** Searching the
  web and driving the browser are now independent: turn either off and the
  assistant is not offered those tools at all, so it cannot use one by mistake
  — and it will say plainly that it can't rather than pretend. Your own Browser
  area is unaffected either way; these govern the assistant, not you.
- **"Go to", "browse to", "navigate to" always open the page.** Asking to go
  somewhere specific used to fall through to the search agent, which looked the
  site up instead of opening it. Naming a destination now reaches the browser
  every time, in English and Hebrew alike.

### Answers you can trust

- **A room with the internet turned off says so, instead of answering from your
  files.** Arcelle still described "the internet" as one of its specialities in
  a room where web access was off, so asking for the weather could quietly reach
  the file specialist, which answered out of your documents. Every list of what
  Arcelle can do is now built from what that room actually has, and a request
  for a specialist the room does not have is reported plainly rather than
  handed to a different one.
- **Changing several files at once is all-or-nothing, as promised.** If one
  entry in a multi-file change was missing its file name, that entry was
  silently dropped and the rest were applied — and the result still said the
  change had landed. Now the whole batch stops and names the entry to fix.
- **A tool called without a file name no longer edits the wrong file.** A
  missing name was treated as an empty search, which matched the most recently
  added file in the room — so a malformed request could open, or edit, a file
  nobody named. Every tool now refuses a request that is missing something it
  requires, and says which part was missing.
- **A skill can no longer be filed under a specialist that does not exist.** One
  mistyped character used to save the skill to nowhere: it was never offered to
  anyone and never shown to you again.
- **Reading a heavy page no longer kills the whole request.** Fetching a big
  site handed the entire page to the model in one go. On a cloud room nothing
  trimmed it, so the request was rejected and the specialist came back with
  nothing — you saw a failed step and an assistant improvising about why it
  couldn't read the page. Pages now arrive a chunk at a time, with the
  assistant told how to read on, and no single result can overflow the model
  again whichever engine you use.
- **The assistant stops denying things it can do.** On a cloud engine it would
  answer "I can't browse the web" or "I have no way to inspect connected
  services" while those very tools were available to it. The sentence that
  tells it otherwise was being dropped on exactly the turns where it decides
  what to do.
- **Once the browser was open, the assistant's other tools stopped working.**
  Opening a page changed how the app found its own main window, and every tool
  that needed it failed — silently, including background jobs and the
  scheduler.

### When something goes wrong

- **A failed answer now leaves a trace.** If a run ends without producing an
  answer, the reason is written to a log file on this Mac instead of vanishing.
  Nothing about your room or your question is logged — only the failure.

### Connected services

- **Connector tools keep their warnings.** Descriptions from connected services
  were trimmed mid-sentence with nothing to show they had been cut, so a tool
  documented as permanent and irreversible could arrive reading as routine.
  Trimmed text is now marked, and the budget is measured in characters, so
  Hebrew and other non-Latin descriptions get the same room as English.
- **Connector options are no longer quietly hidden.** Where a connected tool
  offered a long list of allowed values, everything past the first sixteen was
  dropped with nothing said — those choices were simply unreachable. The list is
  now far longer, and when it is still shortened Arcelle says so.

### Faster on small models

- **Less of every request is spent describing the tools.** The full workflow
  node reference — the largest tool description in the app — moved out of every
  turn and into the moment Arcelle actually looks up your workflows, leaving
  more of a small local model's context for your actual question.

## 0.12.0 — 2026-07-27

### Answers you can trust

- **A failed send is never reported as sent.** The agent that sends email and
  Slack messages had no check on its own claims, so a message that failed to go
  out could still be described to you as sent. It is now held to the same
  ground-truth check as anything that writes to your room.
- **A successful save is never reported as failed.** Editing several files at
  once — or moving one — recorded nothing, so Arcelle told you the change had
  not landed when it had, and spent an extra round doing it.
- **Every step of a multi-step task is checked, not just the first.** A task
  like "summarize the lease, then save the notes" lost its safety check on the
  step that does the writing.
- **Transcribing a file you named loosely now works.** Asking to re-transcribe
  "the meeting recording" made the agent look up which file you meant — and
  that lookup used up its only turn, so it finished having found the file and
  never transcribed it, while telling you it was done.
- **Web answers are sourced.** Arcelle could answer from a search-result
  snippet without opening the page, which its own rules call "not a source".
- **A specialist that comes back empty-handed now says so** instead of showing
  a green tick.

### Faster multi-part questions

- **Independent parts of a question run at the same time.** Ask "what does my
  lease say about rent, and what is the current rate" and both are worked on
  together, so the answer takes as long as the slower half rather than the sum.
- **One request can carry a whole plan.** Arcelle can now dispatch a list of
  tasks in a single step, saying which depend on which — dependent work waits,
  everything else runs immediately, and each dependent step is handed what the
  earlier one found.
- **No more arbitrary limits.** The caps on how many specialists a question
  could consult, and how many turns each could spend, are gone.

### Sturdier under pressure

- **One thing going wrong no longer loses the rest.** If a specialist fails
  mid-question, its part is reported as failed and everything else still
  arrives.
- **Stop keeps what already finished.** Stopping a question used to discard
  completed work; you now get what came back, clearly labelled as partial.
- **Long answers degrade gracefully.** When a conversation outgrows the model's
  window, Arcelle trims what it has already used before it touches the material
  your answer is built from.

### Image marking tells the truth

- **"Could not locate that in this image" no longer hides a missing model.**
  With no vision model installed, marking silently ran on a model that cannot
  see and reported that your image did not contain the thing. It now says a
  vision model is needed and offers to download it.

## 0.11.0 — 2026-07-21

### Bring your own cloud models

- **OpenRouter is now a first-class AI provider.** Connect an API key from
  Settings; it is validated and stored in macOS Keychain, never in a room file.
- **A live catalog instead of a hardcoded list.** Arcelle loads the models
  available to the connected OpenRouter account, with search, context windows,
  and live input/output pricing.
- **Choose by capability.** Filter models for tool calling, vision, reasoning,
  and structured JSON output, then use the selection anywhere Arcelle uses the
  room's AI engine.
- **Cloud models keep Arcelle's agent workflow.** OpenRouter models stream
  answers, use room and MCP tools when supported, work across background
  actions and workflows, and pass through the same cloud-privacy door.
- **Failures say what actually happened.** Provider validation and upstream
  errors are no longer mislabeled as a sidecar startup failure; incompatible
  tool catalogs recover to ordinary chat without exposing credentials.

## 0.10.0 — 2026-07-21

### See — and reclaim — your context budget

- **A live token-budget bar.** The composer now shows how full the model's
  context window is, right where you're typing — a segmented bar colored by
  what's actually taking up the space.
- **Click for the exact breakdown.** See precisely how many tokens come from
  the system prompt, conversation history, tool results, skills, and file
  reads, each with an exact count and percentage.
- **Hand off when you're running low.** One click summarizes the conversation
  so far and continues the same chat with a fresh, much smaller context — no
  need to start a new chat just to keep going.
- **Real counts wherever the engine reports them.** Local models, Ollama cloud
  models, Claude Code, and Codex all report their actual token usage now;
  anywhere else, the bar says plainly that it's estimating.

## 0.9.0 — 2026-07-21

### Skills turn repeatable work into a reusable capability

- **A dedicated Skills workspace.** Skills now live in their own encrypted
  area instead of masquerading as ordinary room files. Create them manually or
  describe what you need and let the room's current AI engine draft one for
  review.
- **Portable, folder-shaped skills.** Import and export the familiar
  `SKILL.md` structure with optional `scripts/`, `references/`, and `assets/`
  folders, so a skill can move between Arcelle and other agent-skill systems
  without being flattened or rewritten.
- **Everything needed stays together.** Browse the skill tree, edit its
  instructions and text resources, add supporting files, and maintain many
  independent skills from one place.

### The assistant loads only the expertise it needs

- **Progressive disclosure keeps context focused.** The assistant initially
  sees only enabled skill names and trigger descriptions, then reads the full
  instructions or a specific resource when the task actually calls for it.
- **Skills work across every engine.** Local models, cloud models, Codex, and
  Claude share the same room skill catalog and can list, read, draft, and
  extend skills through the agent tool bridge.
- **Review before activation.** Imported and AI-generated skills begin as
  disabled drafts. Script helpers run only from reviewed, enabled skills,
  require approval for their exact content, and execute from an isolated
  temporary skill tree without access to the encrypted room key.

## 0.8.0 — 2026-07-21

### Always know where your content is going

- **One trust indicator, everywhere.** The room now states its privacy state
  in one consistent way — **Local only**, **Protected cloud**, or **Raw
  cloud** — with the same words and the same color in the status bar, the top
  bar's engine badge, and the chat pane, instead of "Cloud model" in one place
  and "nothing leaves on its own" in another. Click it to jump straight to
  Cloud privacy in Settings.
- **See exactly what a cloud model would receive.** "Cloud view" is now
  **Preview cloud payload** — it shows the estimated size, states plainly
  whether the door is protecting you or off, and if it's off, marks the
  details that would otherwise be hidden.
- **The AI's source scope is explicit.** The sidebar now says outright whether
  the assistant is drawing on the **whole room** or only your **selected
  files** — no more guessing what an empty checkbox means.
- **Spoken answers default to on-device.** Voice replies now default to the
  on-device synthesizer, which never sends anything off this Mac; the cloud
  neural voice is an explicit opt-in, and the Voice settings page states which
  one is active before you touch anything.

### Home leads with what needs you

- **A new "Needs your attention" section.** Home now opens with the things
  that actually need a decision — a raw-cloud model in use, files still
  waiting on a privacy scan, scripts that need review, workflows stuck as
  drafts — each with a one-click fix, instead of only a list of recent files.

### Workflows and scripts you can trust

- **Steps have real names.** A workflow step no longer opens to a blank "Step
  name" while the canvas shows `file_pass` — every step gets a short,
  human-language name, backfilled automatically for existing workflows and
  requested up front when the assistant builds a new one.
- **One incident, not five identical errors.** A script that fails the same
  way repeatedly now shows as a single incident — the cause, how many times,
  and one recovery action — instead of five raw error rows.
- **The assistant won't say "fixed" until it's actually fixed.** Testing a
  workflow now returns an explicit validated/not-validated result, and the
  assistant is instructed never to claim a script or workflow works until a
  real test confirms it — a script step that only *parked* for your approval
  is no longer reported as working.

### A calmer, clearer shell

- **Settings is six focused pages**, not one long scroll — AI & behavior,
  Voice, Privacy & recovery, Connections, History & storage, and App.
- **Every rail icon has a label.** The left rail is no longer icon-only —
  Library, Workspace, AI, Home, Map, Recordings, Workflows, Scripts, Memory,
  Connect, Focus, and Settings are all named, and the Focus button now reads
  "Focus" / "Unfocus" instead of relying on a tooltip.
- **The workspace is the star.** New rooms open with a wider, more dominant
  center pane; the AI pane eases open and closed instead of snapping.
- **Room Map handles outlier files.** A file unrelated to everything else in
  the room no longer drifts off-screen and breaks the map's auto-fit.

### Re-transcribe on demand

- **A Re-transcribe button on every recording and video.** If a transcript
  came out wrong, or you've since installed the voice model, one click reruns
  on-device transcription and replaces it — no need to delete and re-import.

## 0.7.0 — 2026-07-20

### Private Room is now Arcelle

- **New name, same sealed room.** Private Room is now **Arcelle** — "a little
  ark." Same app, same encrypted file, same local AI inside; only the name and
  the icon changed. This update renames the app in place, so your rooms,
  memories, Touch ID, and granted permissions carry over untouched.
- **New vaults are `.arcelle` files.** Rooms you create from now on save with
  the `.arcelle` extension; every existing `.roomai` file still opens exactly as
  before — nothing to convert, nothing left behind.
- **A new mark.** The app icon is a single unbroken ribbon folded into an "A" —
  one continuous ribbon for the one file that holds everything, with a small
  amber seam for the one key that opens it.

### A marketplace for tool connectors

- **Browse and install MCP connectors from a live registry.** A new
  **Connectors** area in the sidebar rail lets you search the public Model
  Context Protocol registry, filter to verified publishers, local-only, or "no
  API key needed," and install a connector in one click. Browsing the registry
  is the only time the app reaches out on its own, so it's behind an explicit
  opt-in — nothing about your room is sent, only the catalog comes back.
- **Local by default, cloud by choice.** A connector that ships both a local
  package and a hosted endpoint installs the local one (nothing leaves your
  Mac), with a one-tap switch to the cloud version. Remote connectors are
  badged loudly; before their arguments leave the Mac, Arcelle redacts the
  room's sensitive spans and asks first.
- **Sign in without leaving the app.** Remote connectors that use OAuth get a
  **Connect account** button that runs the whole browser sign-in and stores the
  token in the room — with a manual open/copy-link fallback if your browser
  doesn't open on its own.
- **Manage every connector and every tool.** Installed connectors can be turned
  on or off, removed, and expanded to a per-tool list where you switch
  individual tools on or off — or flip one override to send a connector's whole
  toolset to the assistant. Cloud models now get a much larger tool budget than
  the small on-device model, so a big connector's tools all come through.

### Workflows do more — and in parallel

- **Nine new step types** join generate / summarize / deep-pass / agent /
  save / condition: **HTTP fetch** a URL, **extract** structured fields into a
  table, **transform** text with no model call at all, **merge** several
  branches back together, **route** to labeled branches, **vote** across
  parallel attempts for consensus, **fan out over every matching file**,
  **refine** an output until it passes its own check, and **plan-then-map** an
  objective into sub-tasks. Each type gets its own parameter sheet in the
  builder.
- **Steps run in parallel.** Independent branches now execute concurrently —
  lane-gated so the single local model stays serialized while cloud and CPU
  work fan out — instead of everything running one after another.
- **Scripts and workflows mix.** A workflow step can run one of your room
  scripts — importing its output, or piping text through it — so deterministic
  code and model calls live in the same pipeline.
- **A friendlier builder.** Parallel-branch authoring, an icon picker per
  workflow, clickable validation errors that jump to the offending step, and
  richer run history with per-step output and copy buttons. The "describe a
  workflow" box grows to fit a long description, and the icon picker's choices
  are reliably clickable.
- **The assistant tests as it builds.** Ask the assistant to build a workflow
  and it can now run it, read what each step actually produced, fix the step
  that failed, and try again — handing you a working draft instead of a guess.
  It still leaves the workflow as a draft for you to review and activate, and a
  step that runs one of your scripts still asks your approval first.
- **Workflows read your generated files.** Steps that pick files — newest, all,
  by name, or "needs a summary" — now include the pages and sheets the
  assistant created, not just files you imported, so a workflow can summarize or
  cross-check the very reports it made.
- **Deep-pass handles code and data.** A full pass over a script or a CSV no
  longer comes back empty when the on-device model can't summarize a dense
  window — the content is kept and covered instead of dropped.
- **Running a workflow's script asks once.** A workflow step that runs one of
  your room scripts now shows the same one-time approval card as the Scripts
  page, instead of silently refusing with a confusing "changed since approved."
- **Dashboards the assistant builds render in place.** HTML pages the assistant
  writes are now self-contained — charts drawn inline, data embedded — so they
  display in the app's private, offline viewer instead of arriving blank because
  they reached for a chart library or live data on the internet.

### A calmer, more professional look

- **One icon family, no emoji.** Every native emoji in the interface — the
  workflow template gallery, pins, schedules, run/stop/pause controls, and the
  "saved / copied / installed" status checks across Settings — is now a line
  icon from a single system (24px grid, monochrome, with the violet accent
  reserved for selected and primary actions). The workflow template gallery in
  particular reads as one professional set instead of seven colorful
  pictograms.

### Updates

- **Check for updates in-app.** A new **Settings → App → Updates & version**
  shows your current version and, in one click, checks the signed GitHub
  release, downloads and verifies it, installs, and relaunches — the visible,
  on-demand counterpart to the quiet check that already runs on launch.

## 0.5.1 — 2026-07-20

- **Recovery codes show as you type them.** The recovery-code box on the
  unlock screen now uppercases each character as you type, matching the
  `XXXX-XXXX-…` format the code was shown in. (It always accepted lowercase —
  this is a display fix, so what you type looks like what you were given.)

## 0.5.0 — 2026-07-20

### Dictation that keeps up with you

- **Words appear as you speak.** Dictation now streams: the composer paints
  your words into the box live while you talk, and the journal, file, and
  memory mics show the rolling transcript in the capture pill. The wait that
  used to start when you hit Stop now happens while you're speaking — Stop
  just finalizes. Still 100% on this Mac, nothing leaves the room.
- **The voice engine finally uses your GPU.** Whisper now runs on Metal on
  Apple Silicon: transcription runs ~2.5× faster (about 15× realtime), and
  the first-dictation model load dropped from ~26 seconds to a few. Live
  recording transcripts and imported audio/video transcription get the same
  speedup.

### Workflows

- New **"All files"** selector for summarize and file-pass nodes.
- The workflow composer is now taught every selector and condition it may
  use, so AI-drafted workflows stop failing validation on selectors the
  model was never told about.

## 0.4.1 — 2026-07-19

Post-incident hardening: the "every model feels stuck" failure chain can't
happen again.

- **The scan yields to you.** The document scanner pauses between files
  whenever a chat turn is in flight (Settings shows "Paused while you
  chat"), so questions never queue behind library scanning on the same
  local model. It quietly resumes when you stop chatting.
- **No more orphan sidecars.** Each sidecar watches its parent app and
  exits within seconds if the app dies (crash, force-quit, reinstall) — a
  leftover process can never hog the local model with nobody listening.
- **The live privacy guard can't stall chat.** Hard-capped at 8 seconds
  and skipped while the scan runs; the mechanical exact-word rules apply
  regardless.
- The sidecar's `/health` now reports the real app version.

## 0.4.0 — 2026-07-19

### Cloud privacy, mechanically enforced

- **The gatekeeper.** With the door on, private details are swapped for
  stable neutral tags (`[Person A]`, `[Address B]`, …) before anything
  reaches a cloud model — and put back in the answer you read. Enforcement
  is mechanical at **every** exit: the sidecar chat/features gateway, Ollama
  `:cloud` models, the Claude/Codex CLIs, and the MCP bridge cloud agents
  use to read room files. Images never leave while the door is on.
- **The scanner.** A local model reads each imported file once and builds
  the room's protected-entity map; it re-runs automatically on import,
  transcription, and rule changes. ("Scan now" also stopped failing
  silently — it never woke the local engine, and the 4B model's off-schema
  replies were discarded; errors now show under the button.)
- **The live guard.** The question you type is scanned before any cloud
  turn, so a name the scanner never met is still caught.
- **Settings → Cloud privacy.** Per-room switch over a global default, an
  iron-clad "Never share these" block list (mechanical, guaranteed),
  best-effort private topics in your own words, and scan status — plus an
  honest-limits note about what redaction can and cannot promise.
- **Cloud view.** Every file gets a toggle showing the blocked version,
  blackouts included — exactly what a cloud model would receive.
- **Chat receipts.** A green "N details hidden" receipt on protected cloud
  turns, a loud red banner when privacy is off on a cloud engine, and a
  confirmed "Ask again with real details (this once)" valve.

### Voice

- **Neural spoken voice is the new default.** Answers are read aloud with
  Andrew (en-US, multilingual) — a neural synthetic voice, not a human
  recording — via Microsoft's Edge TTS at +22% rate / −2 Hz pitch, loudness
  normalized to ≈−16 LUFS with a no-clip soft limiter. Only the sentence
  being spoken leaves the Mac, only while speaking is on, and Settings
  disclose exactly that. The original on-device voice remains one switch
  away (Settings → Spoken voice → On-device) and is the automatic
  per-sentence fallback when offline. Voice archetypes (Demon, Ghost,
  Wraith, Ancient, Custom) apply to both engines.

## 0.3.1 — 2026-07-19

- **Fix:** the library's "Add page or source" menu opened downward past the
  pane's clipped edge and was invisible. It now opens upward from the footer
  button, capped to the viewport with its own scroll.

## 0.3.0 — 2026-07-19

The platform release: one AI engine under everything, any brain on top of it,
and a room that works while you don't — workflows, scripts, live meeting
recording, and a redesigned shell to hold it all.

### The shell

- **Redesigned workspace** — a persistent activity rail (Home, Room Map,
  Recordings, Workflows, Scripts, Memory, Settings), three draggable panes
  (Library / Workspace / AI), and a status bar that always shows the engine,
  local-vs-cloud, file count, background jobs, and pending approvals. `⌘K` is
  now both room search and a command palette.
- **Light theme** — every color moved into one design-token system with full
  dark *and* light palettes; switch from the top bar, persisted per device,
  no flash on reload.
- **AI pane** — Chat, Studio, and a new Activity tab (jobs, imports, saves,
  approvals) live in a dockable pane with an attention dot when something is
  running or waiting on you.
- **Room home** — continue where you left off: recent files and chats,
  current background activity, and every capability of the room one click
  away.

### Any engine, every feature

- **Engine parity** — the engine you pick for a room (local Ollama, Ollama
  `:cloud`, Claude Code, or Codex CLI) now powers *every* AI feature:
  summaries, deep file passes, AI actions, studios, suggestions, and workflow
  steps — not just chat. Four things intentionally stay on-device: dictation,
  quick local generation, image grounding boxes, and UI-driving tools.
- **Model & effort picker** — choose the exact model behind an engine (Codex's
  catalog is read live from the CLI) and Claude's reasoning effort, from the
  top bar or Settings.
- **Tools for cloud engines** — Codex now gets the room's tools over the same
  per-question localhost MCP bridge Claude Code had; your connected MCP
  servers can ride along behind an explicit switch. The bridge dies when the
  answer returns.
- **One engine under the hood** — all AI features run through a single
  bundled Python/LangGraph sidecar instead of two parallel implementations
  (thousands of duplicate native lines deleted). The app owns its lifecycle:
  spawn on demand, health checks, localhost-only, never sees the room key.
- **Self-managing Ollama** — the app starts the daemon when an AI call needs
  it and stops it after five idle minutes. A daemon you started yourself is
  left strictly alone.
- **The Leash** — an unlocked room can serve external agents on your Mac
  (Claude Code, Codex, Claude Desktop, Cursor) over loopback with a bearer
  token: **Files only** or **Full agent** tiers, per-app approval, stable
  port/token across relocks, and instant revocation.

### Automation

- **Workflows** — visual multi-step AI pipelines (generate, summarize, deep
  file pass, agent, save, condition branches) on an animated canvas with
  template gallery, per-run history with step artifacts, full hand-editing,
  and **compose-with-AI**: describe the pipeline in plain language and the
  room's model drafts it.
- **Schedules** — interval / daily / weekly (DST-safe), optional catch-up run
  at unlock, consent collected once at activation, and no pile-ups: a trigger
  is skipped if the previous run is still going.
- **Room scripts** — Python/JS files in the room become runnable: Run button,
  Scripts area with status and run history (stdout/stderr), isolated per-run
  workspaces, room files materialized in and saved back as versioned files,
  content-hash-gated consent, and dependencies that install themselves via
  `uv` (PEP-723 declarations or on-the-fly self-healing).
- **Background studios** — flashcards, mind maps, and podcast scripts run as
  cancellable queued jobs (FIFO instead of "one at a time, try later"), pinned
  to the room that started them.

### Recording

- **Live meeting capture** — mic + system audio (ScreenCaptureKit) with a
  real-time transcript, automatic speaker identification via on-device
  TitaNet voice embeddings, color-coded speaker chips, live translation, and
  pause/resume. Edit a recording by editing its transcript; re-transcribe old
  recordings with the current pipeline.
- **Crash-proof** — checkpoints from an interrupted recording are spliced
  back together on next unlock; orphaned jobs offer Resume instead of
  haunting the room as phantom "running" entries.

### Editing & history

- **Reliable AI edits** — normalization-tolerant exact-match editing (curly
  quotes, NBSP, CRLF, dashes) that still requires uniqueness and fails safely
  with a closest-snippet hint; a new atomic `edit_files` tool validates whole
  multi-file batches (including rename + reference updates) before writing,
  undoable as a group; optional **ask-before-AI-edits** with a side-by-side
  diff per batch.
- **Compare view** — open any saved version in a read-only side-by-side diff
  against the current file (RTL-aware) and restore from there.
- **Room checkpoints** — named, encrypted snapshots of the whole room with
  safe rollback (automatic "before rollback" copy, blocked while jobs or
  recordings are in flight).

### Voice

- **Spoken answers** — on-device synthesis with Web-Audio-shaped archetypes
  (Demon, Ghost, Wraith, Ancient, or Custom), sentence-chunked so speech
  starts fast, per-message play buttons, auto-speak, and a hands-free
  listen-back loop for voice conversations.

### Memory

- **Memory area** — browse, add, edit, and delete everything the AI remembers,
  grouped by category; suggestions from conversations wait for approval by
  default (auto-save is opt-in); legacy rooms migrate automatically.
- **Scratch pad** — a pinned, versioned `Scratch pad.md` shared by you and the
  AI, with reconcile-instead-of-clobber when you both edit at once.
- **Style presets** — terse-technical, friendly, or formal; your custom
  instructions always win.

### Platform & quality

- **Security hardening (31 fixes)** — full room teardown before opening
  another (the MCP bridge and its bearer token can never serve the wrong
  room), 8 MB cap on fetched pages, a stricter private-network guard (CGNAT,
  multicast, reserved, IPv4-mapped IPv6), recovery-code re-wrap on password
  change, fully atomic version restore.
- **Hebrew, fixed for real** — visual-order (mirrored) Hebrew PDFs are
  detected and repaired at import with vowel points re-attached; nikud is
  stripped for search so plain queries match pointed text; windows-1255 pages
  decode correctly. (Previously imported Hebrew PDFs need a re-import.)
- **PDF viewer** — the 100-page cap is gone; pages render lazily and recycle,
  so book-length PDFs open fast and stay smooth.
- **Always-on indexing** — new files are indexed and described automatically
  in the background (debounced, resumable, no more 50-file cap) without
  hijacking the viewer or your room summary.
- **Verified agent citations** — when the agent opens a file to show a
  passage, the quote is verified against the real file first (any language,
  pointed Hebrew included); misses anchor to the closest real passage.
- **`:cloud` honesty** — Ollama `:cloud` models are labeled cloud everywhere,
  drive the privacy indicator, are excluded from local-only features, and
  their fence-wrapped JSON is recovered so structured features work.
- **The Role setting works** — the persona picked in Settings is now actually
  injected into the system prompt (it was saved but never read).
- **Regenerate, fixed** — regenerating a `#command` message re-executes the
  command and re-attaches `@files` instead of resending literal text.
- **Audit-driven cleanup** — a 1,626-item feature audit drove deletion of
  dead duplicate engines and API wrappers, fixed the MCP initialize handshake
  (standards-strict servers now connect), and added syntax highlighting to
  diff approval cards.
- **QA harness** — `qa/make-qa.mjs` renders the full UI in a plain browser
  with mocked IPC for visual QA and screenshots.

## 0.2.3 — 2026-07-08

QA-driven fixes: reliable tool calls on Ollama `:cloud` models, honest
local-vision fallback, video frame capture no longer returns black frames,
unlimited agent tool rounds, a UI-driving agent that reliably receives its
tools, and image marking that routes to qwen2.5vl when installed.

## 0.2.1 — 2026-07-08

Agent embodiment: the local AI can operate the app like a human (numbered
control snapshots, click/type/scroll with every action visible), plain-prose
answers with structured highlights, and video previews that stream and seek
properly. Consent surfaces are off-limits to the agent by construction.

## 0.2.0 — 2026-07-08

The "moonshot" release: Front Page dashboard, the Room Map, recordings with
diarization, the Leash (room-as-MCP-server), room templates, and a full
internal modularization.

## 0.1.0 — 2026-07-05

First release: a private, on-device AI workspace for your documents — chat,
search, highlight, transcribe, and summarize with a small local model, sealed
in one encrypted `.roomai` file.
