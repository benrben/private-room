# The Private Room Pledge

**A room is a file.**

Not an account. Not a folder in someone else's cloud. One document on your Mac
that you can hold, copy, back up, and hand to another person — and that only you
can open.

Here is what that means, in plain words.

## It's yours

A room is a single `.roomai` file. It lives where you put it. Copy it to a USB
drive, back it up, AirDrop it to a colleague — it is a document, and it belongs
to you the way a paper file in a drawer belongs to you.

## No account. No server. No telemetry. Ever.

There is nothing to sign up for. The app keeps no account, has no server of
ours to phone home to, and sends no usage data — not "anonymized," not "to
improve the product." None. There is no company watching over your shoulder,
and **there is no third party to subpoena**, because your rooms never touch
anyone else's computer.

## Nothing leaves your Mac unless you flip a labelled switch

By default, everything runs on your machine: the AI, the search, the
transcription, the encryption. The few features that can reach the internet —
web search, an optional cloud AI engine, sharing a room with another tool —
are **off until you turn them on**, and each one is clearly labelled the moment
it can send anything out. No surprises. No quiet background traffic.

## If we disappear, your rooms still open

This is the promise that matters most. The `.roomai` format is open and
written down, and the `roomai` command-line tool — built from the same code the
app uses — can open, verify, and export any room, given your password. You are
never locked in. If this project ends tomorrow, your rooms are still just
encrypted files that you still hold the key to.

## Your password is the only key

A room is encrypted with your password. We cannot read it. We cannot reset it.
There is no backdoor and no cloud recovery. When you create a room you can print
a one-time recovery key and keep it somewhere safe — that is the only other way
in. Lose both, and the room stays closed. That is not a flaw; it is the whole
point.

---

*Check it yourself.* Run `strings your-room.roomai` and you will see nothing but
noise. Run `roomai export` with your password and you will get everything back.
The file cannot be bought, moved, or switched off out from under you. It is
just yours.
