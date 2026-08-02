# Security policy

Arcelle stores personal archives in an encrypted single-file workspace, holds
cloud API keys in the macOS Keychain, and ships signed auto-updates. If you
find a way to break any of that, please tell me before telling anyone else.

## Reporting a vulnerability

- Preferred: open a private advisory —
  **Security → Report a vulnerability** on
  https://github.com/benrben/private-room (GitHub private vulnerability
  reporting; it stays invisible to the public until it is fixed).
- Or email **benrben4@gmail.com** with `ARCELLE SECURITY` in the subject.

Please include the version (Arcelle → About, or the DMG file name), macOS
version, what you did, and what happened. A proof of concept helps. Never
attach a real `.arcelle` workspace or a real password — a synthetic
reproduction is enough.

You should get an acknowledgement within a week. Please give me 90 days before
public disclosure, or less if the issue is being actively exploited.

## What is in scope

- Reading workspace contents without the password or recovery code.
- Anything that sends room content off the Mac without the user's consent, or
  that gets past the privacy gatekeeper's redaction of outbound text.
- Forging or downgrading an auto-update (the updater's minisign verification).
- Code execution from an imported file, a saved web page, or the private
  browser, escaping into the app's Tauri command surface.
- Recovering plaintext from a workspace file, temporary files, or caches after
  the room is closed.

## What is not in scope

- Anything requiring physical access to an unlocked Mac with the room already
  open.
- Advisories in developer-only dependencies (the test runners) that never ship
  in the app.
- Missing hardening that is not exploitable on its own — still welcome, just
  send it as a normal issue.

## Supported versions

Only the latest release gets fixes. Update from
https://github.com/benrben/private-room/releases, or from inside the app.
