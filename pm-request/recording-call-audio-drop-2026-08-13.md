# Root-cause report: call audio drops the moment a recording starts

**Date:** 2026-08-13 · **Status:** ROOT CAUSE CONFIRMED — fix not yet applied (awaiting owner decision on fix option)
**Symptom:** starting an Arcelle recording while on a Slack / Teams / Zoom-style call makes the call's audio (and other apps' audio generally) drop sharply in volume and become hard to hear. Reported before as GH issue #4 in its input-gain form; this is the output half.

---

## 1. TL;DR

Arcelle opens the microphone inside the WKWebView with `echoCancellation: true` (`src/workspace/liveRec.ts:80-86`, default on at `liveRec.ts:21`). On macOS, that single constraint makes WebKit capture through Apple's **VoiceProcessingIO (VPIO)** audio unit — and while a VPIO unit is live, **macOS ducks the audio output of every other application system-wide**. That is the drop you hear. It is an OS behavior, not an Arcelle bug in the usual sense: nothing in our code touches volume, devices, or gain (exhaustively verified).

It is *worst during calls* specifically because WebKit configures the duck as `duckingLevel = min` **but `enableAdvancedDucking = true`** — voice-activity-driven ducking that deepens whenever someone is speaking. On a call, someone is always speaking, so the duck engages continuously and hard.

Two knock-on effects make it worse than "quieter":

- **The recording itself degrades.** Our ScreenCaptureKit meeting lane records the *already-ducked* mix, so the moment the duck engages, the meeting-audio lane drops toward silence (a comparable app measured −51 dB) — transcription of the other side suffers along with the user's ears.
- **Muting doesn't help.** Our mute only flips `track.enabled` (`liveRec.ts:52-57`), and current WebKit deliberately keeps the VPIO unit running while tracks are muted — so the duck persists through mute. Only pause (which stops the tracks) releases it.

There is already a user-facing escape hatch: **Settings → Voice → Microphone → uncheck "Clean up microphone audio"** — this sets `echoCancellation: false`, which makes WebKit use a plain HAL unit with **no ducking at all**. Our own settings copy even predicts the symptom ("if another app sounds quieter while Arcelle records, turn this off", `MicSection.tsx:69-74`). The bug, product-wise, is that the default engages VPIO and the toggle is buried where no one mid-call will find it.

---

## 2. What actually happens when you press Record

Chronological, with the ducking-relevant moments in bold:

1. UI click → `startLiveRecording()` (`src/workspace/recordingActions.ts:343-397`).
2. **`acquireMic()` runs first** (`recordingActions.ts:359`) — before `rec_start` — to keep WebKit's user-gesture activation alive. `getUserMedia({ audio: micConstraints() })` with `echoCancellation: true, noiseSuppression: true, autoGainControl: false`. **The VPIO unit spins up here; the system-wide duck begins at this instant**, several IPC round-trips before the recording is even confirmed on the backend.
3. `rec_start` (`src-tauri/src/commands/recording_cmds.rs:147-248`): DB writes, engine start, `caffeinate -i` child.
4. `start_engine` (`src-tauri/src/recording.rs:1422-1487`) starts: decoder thread (Whisper on Metal + TitaNet diarization embeddings), engine thread (100 ms poll), 2× Silero VAD contexts (2 threads each), the live-translation task, and the **ScreenCaptureKit system-audio tap** (`recording/sck.rs:122-217`) on its own dispatch queue.
5. Mic tap attaches (`recordingActions.ts:384` → `attachMicTap`, `liveRec.ts:215-260`): AudioContext + AudioWorklet, 4 base64 IPC pushes/sec.

The same `micConstraints()` govern **every** mic path: live recordings, streaming dictation (`recordingActions.ts:181`), voice notes (`recordingActions.ts:99-101`), and the hands-free loop, which **re-opens the mic automatically after every assistant turn** (`src/workspace/effects.ts:430-448`) — each re-arm re-engages VPIO and re-ducks.

## 3. The root-cause chain, with evidence

**(a) `echoCancellation: true` ⇒ VPIO.** WebKit's Cocoa capture code (shared by Safari and every WKWebView embedder, so it applies to Tauri) chooses the audio unit in `createAudioUnit(bool shouldUseVPIO)`:

```cpp
OSType unitSubType = kAudioUnitSubType_VoiceProcessingIO;
if (!shouldUseVPIO) {
#if PLATFORM(MAC)
    unitSubType = kAudioUnitSubType_HALOutput;
...
m_shouldUseVPIO = enableEchoCancellation();
```

— `Source/WebCore/platform/mediastream/cocoa/CoreAudioCaptureUnit.cpp` (formerly `CoreAudioSharedUnit.cpp`). `echoCancellation: false` has selected the plain HAL unit (no voice processing) since WebKit commit `1796e2f138` (bug 235643, Safari 16.4-era, 2023). Use the plain `false` form, not `{exact: false}` — the exact form failed with OverConstrained until a Jan 2025 fix (bug 286680).

**(b) VPIO ⇒ system-wide output duck.** Apple's WWDC23 "What's new in voice processing" (session 10235): all audio streams other than the app's voice stream are "other audio" — *"That's why we duck the volume level of other audio."* On macOS there is no per-app session isolation, so "other audio" = every other app, including your call. Long-standing unresolved complaints: Apple dev forums threads 664346 (2020) and 710124 (2022, specifically Safari `getUserMedia` lowering Music/Spotify volume; the same page in Chrome does not duck, because Chrome uses WebRTC's software AEC in-process rather than VPIO).

**(c) Why calls get hammered continuously.** macOS 14 added `AVAudioVoiceProcessingOtherAudioDuckingConfiguration` (`duckingLevel`: default/min/mid/max + `enableAdvancedDucking`). WebKit adopted it in commit `d234c3b9c4` (bug 248810):

```cpp
AUVoiceIOOtherAudioDuckingConfiguration configuration { true, kAUVoiceIOOtherAudioDuckingLevelMin };
```

`true` = advanced ducking **on**: the duck level is driven dynamically by voice-activity detection "from either side." During a meeting there is near-constant voice activity, so ducking engages essentially the whole time. This exactly matches "everything drops the moment recording starts" on this machine (macOS 26.5.1, system WebKit).

**(d) The duck outlives mute.** WebKit commit `f078400396` (bug 279515, 2024): the audio unit is now *always kept running* while a capture source has clients, even when every track is muted (needed for AirPods-mute UX and voice-activity events). So `track.enabled = false` — our mute — does not stop the duck. Only `track.stop()` tears the unit down. Our pause path does stop tracks (`stopMicTap`, `liveRec.ts:343-352`) and also stops the SCK tap (`recording.rs:1691-1710`), so **pause un-ducks; mute does not.**

## 4. Ruled out / secondary causes

- **AGC riding the shared input gain** — the original GH #4 mechanism (other apps' *outgoing mic* volume dropping). Already fixed: `autoGainControl` is hard-pinned `false` (`liveRec.ts:84`), with an e2e contract (`e2e/qa-specs/gh4-mic-volume.e2e.mjs`). Not the current cause.
- **ScreenCaptureKit tap** — innocent. Audio-only SCStream capture opens no VPIO and doesn't duck (mechanism + third-party reports). But it is a *victim*: it records the post-duck mix, so the meeting lane goes near-silent while the duck is engaged.
- **Arcelle touching volume/devices** — ruled out by exhaustive search: no CoreAudio/HAL/cpal code, no volume, device-selection, sample-rate, or hog-mode calls anywhere in the app. Stream rates are negotiated passively.
- **CPU/GPU contention** — real but structurally separate. At rec_start we light up Whisper-on-Metal partials every 1.5 s (beam-5 finals), 4 Silero VAD threads, TitaNet embeddings per final, a 200 ms `rec-level` event stream, and 4 IPC pushes/sec. This can make an already-ducked call *sound* worse (dropouts under load) but cannot produce a volume drop by itself. Worth a separate look someday; not this bug.
- **Bluetooth A2DP→HFP collapse** — a *stacking* secondary mechanism, device-dependent: if the call runs on a headset whose mic was *not* in use and Arcelle's `getUserMedia` opens that headset mic, macOS drops the whole link to HFP/SCO (~16 kHz "AM-radio" quality) for all output. Distinguishing signature: happens only with Bluetooth headsets and sounds *muffled/low-fidelity* rather than *quiet*. The reported symptom (volume drop on any output, any Zoom-like app) is the VPIO duck; both can co-occur on AirPods.

## 5. How to verify on this machine (5 minutes)

1. Play music (Music/Spotify/YouTube) at a fixed volume through built-in speakers.
2. Start an Arcelle recording → volume of the music drops immediately. Stop → recovers.
3. Settings → Voice → Microphone → uncheck "Clean up microphone audio" → start a recording → **no drop** (this isolates VPIO as the cause; SCK and all the CPU load are still running).
4. During a ducked recording, hit Mute → no recovery. Hit Pause → recovers. (Confirms the mute/pause asymmetry.)
5. Optional Bluetooth check: repeat (2) with AirPods on a call that uses the Mac's built-in mic — expect an additional fidelity collapse, not just volume.

## 6. Fix options (for decision — none applied yet)

**Recommended: C first as the durable fix, with D as immediate relief. A is the one-line lever if you accept its trade-off.**

- **A. Flip the default: `voiceProcessing = false`.** One line (`liveRec.ts:21`) + settings-default reads (`v !== "0"` → `v === "1"` in `effects.ts:390-394`, `MicSection.tsx`). Kills the duck for everyone immediately. Trade-off: on **speakers**, meeting audio re-enters the mic and can be transcribed as "You" — the exact reason AEC was kept on (`liveRec.ts:71-75`). We do have the `echo_of` cross-lane dedup (`recording.rs:2333+`) as a second line of defense, but it was built as a backstop, not the primary defense; headphone users lose nothing.
- **B. Auto by output route:** query the default output device's transport type natively (built-in speakers vs headphones/Bluetooth) at record start; headphones → no AEC needed (no acoustic echo path) → `voiceProcessing off`, speakers → keep AEC. Small native addition (one CoreAudio property read); makes the common headphone-call case duck-free with zero quality regression. Doesn't help speaker users.
- **C. Move mic capture native (the real fix):** capture the mic in Rust (AVAudioEngine/AUVoiceIO via objc2) with VPIO enabled **and** `OtherAudioDuckingConfiguration { enableAdvancedDucking: false, duckingLevel: .min }` — keeps Apple AEC (so "You"-attribution stays clean on speakers) while reducing the duck to its minimum static level; a comparable transcription app verified this restores normal loudness. Also removes the WebKit gesture-activation dance and makes mute real (we'd control the unit). Cost: a new native capture path feeding the engine (the SCK lane already models this), TCC prompt moves from WebKit to the app (mic entitlement + usage string already present), and the worklet path stays as fallback.
- **D. UX relief regardless of A–C:** surface the duck at the moment it matters — a hint on the recording view when voice processing is on ("Other apps sound quieter while this is on — turn off"), linkable straight to the toggle; plus changelog/docs mention. Today the only mention is buried in Settings and predicts the symptom perfectly, which is where this report started.
- **Not viable:** influencing WebKit's ducking config from the host app (no public API; the config is set inside WebKit's capture process), or calling the private `AudioDeviceDuck` symbol to fight the OS (unsupported, fragile).

Whatever is chosen: mute-during-recording should either stop tracks (real un-duck, mic lane goes silent server-side and watchdog implications reviewed) or the mute button should say audio stays ducked.

## 7. Sources

- WebKit unit selection: github.com/WebKit/WebKit — `Source/WebCore/platform/mediastream/cocoa/CoreAudioCaptureUnit.cpp`, `CoreAudioCaptureSource.cpp`; commits `1796e2f138` (bug 235643, HAL when AEC off), `d234c3b9c4` (bug 248810, ducking config min + advanced), `f078400396` (bug 279515, unit keeps running while muted), `7f097e6965` (bug 286680, `{exact:false}` fix).
- Apple: WWDC23 session 10235 "What's new in voice processing"; `AVAudioVoiceProcessingOtherAudioDuckingConfiguration` docs; dev forums threads 664346, 710124, 751100.
- Chrome contrast (software AEC, no duck): developer.chrome.com/blog/macos-native-echo-cancellation; Apple forums 710124.
- SCK-records-the-ducked-mix + native ducking-config fix verified: dev.to/thehwang "Building a 100% local meeting transcription app… with whisper.cpp and ScreenCaptureKit" (−51 dB observation).
- Bluetooth HFP collapse: audacious.blog/2017/airpods-macos-call-quality-fix, swissmacuser.ch, Apple discussions 251297908 / 252003288 / 253316042.
- In-repo prior art: GH issue #4 (closed 2026-07-25, AGC half); `MicSection.tsx:6-13, 44-85`; `liveRec.ts:63-86`; `e2e/qa-specs/gh4-mic-volume.e2e.mjs`.
