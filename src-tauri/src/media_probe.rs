//! What a video ACTUALLY is: duration, display size, codec, frame rate and
//! whether it carries sound.
//!
//! Nothing in this app used to ask a video file anything. `stt::media_kind`
//! answers "audio or video?" from the mime type and the extension without ever
//! opening the container, so a room could tell you an MP4 was 40 MB and nothing
//! else. This module opens it — through AVFoundation, the same OS media stack
//! `avconvert` already decodes audio tracks with (`stt.rs`), so there is no
//! ffmpeg to bundle, sign or notarize.
//!
//! EVERY FIELD IS OPTIONAL AND MEANS IT. A container that does not state its
//! frame rate leaves `frame_rate` None and the viewer says "unknown"; it never
//! shows a plausible default. A file AVFoundation refuses entirely probes to
//! `None`, not to a struct full of zeros — "0 × 0, 0 s" is a claim, and it
//! would be a false one.
//!
//! PRIVACY NOTE, same bargain `quicklook.rs` and `stt::decode_bytes_to_pcm`
//! already state: AVFoundation takes a file URL, so [`probe_bytes`] writes the
//! decrypted bytes to an owner-only temp file for the moment the probe takes
//! and removes it on every exit path. The import path never needs that — the
//! user's own file is still on disk there, so it is probed in place.

use serde::{Deserialize, Serialize};
use std::path::Path;

/// The technical facts about one media file. Every field is independently
/// unknown-able: AVFoundation may read a duration from a container that states
/// no frame rate, and both answers are honest.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MediaMeta {
    pub duration_secs: Option<f64>,
    /// DISPLAY size — the track's natural size with its preferred transform
    /// applied. A portrait iPhone clip stores 1920×1080 plus a 90° rotation;
    /// reporting the stored size would contradict both the player and the
    /// user's eyes.
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Human name where we know one ("H.264"), otherwise the container's own
    /// four-character code verbatim. Never a guess.
    pub video_codec: Option<String>,
    pub frame_rate: Option<f64>,
    pub bitrate_kbps: Option<u32>,
    /// Some(true)/Some(false) once the track list has been read. None only when
    /// the asset would not open at all.
    pub has_audio: Option<bool>,
    pub audio_codec: Option<String>,
}

impl MediaMeta {
    /// Nothing was learned. Storing this would put a row of "unknown" in the
    /// database that a later, better probe could never tell apart from a real
    /// answer, so callers drop it instead.
    pub fn is_empty(&self) -> bool {
        *self == MediaMeta::default()
    }
}

/// Four-character codes we can name. Anything absent stays a raw fourcc in the
/// UI — an unrecognized codec is a fact about our table, not about the file,
/// and "unknown codec" would hide information the container did give us.
fn codec_name(fourcc: &str) -> String {
    match fourcc {
        "avc1" | "avc3" => "H.264",
        "hvc1" | "hev1" => "HEVC",
        "vp09" => "VP9",
        "av01" => "AV1",
        "mp4v" => "MPEG-4",
        "jpeg" => "Motion JPEG",
        "apch" | "apcn" | "apcs" | "apco" | "ap4h" | "ap4x" => "Apple ProRes",
        "aac" | "mp4a" => "AAC",
        ".mp3" | "mp3" => "MP3",
        "lpcm" => "Linear PCM",
        "alac" => "Apple Lossless",
        "opus" => "Opus",
        _ => return fourcc.to_string(),
    }
    .to_string()
}

/// A CoreMedia FourCharCode as its four ASCII bytes, trimmed. Codes are
/// space-padded ('aac ') and a non-ASCII code is not a name we can show.
fn fourcc_string(code: u32) -> Option<String> {
    let bytes = code.to_be_bytes();
    if bytes.iter().any(|b| !(0x20..0x7f).contains(b)) {
        return None;
    }
    let s = String::from_utf8_lossy(&bytes).trim().to_string();
    (!s.is_empty()).then_some(s)
}

/// A nominal frame rate worth reporting. AVFoundation returns 0 for a
/// container that states none, and the value is a float that can arrive as NaN;
/// the upper bound rejects nonsense without rejecting real high-speed capture
/// (240 fps slow motion is a normal iPhone file).
fn sane_frame_rate(fps: f32) -> Option<f64> {
    let fps = fps as f64;
    (fps.is_finite() && fps > 0.0 && fps <= 1000.0).then(|| (fps * 100.0).round() / 100.0)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{codec_name, fourcc_string, sane_frame_rate, MediaMeta};
    use objc2::rc::{autoreleasepool, Retained};
    use objc2_av_foundation::{
        AVAssetTrack, AVMediaTypeAudio, AVMediaTypeVideo, AVURLAsset,
    };
    use objc2_core_media::CMFormatDescription;
    use objc2_foundation::{NSArray, NSString, NSURL};

    /// The first track's codec fourcc.
    ///
    /// `formatDescriptions` is declared as an UNTYPED NSArray because its
    /// members are CoreMedia objects, not ObjC ones: CMFormatDescription is a
    /// CFType that is toll-free bridged into the array. Reading it therefore
    /// means casting the element pointer across that bridge by hand — there is
    /// no typed accessor to use instead.
    fn track_codec(track: &AVAssetTrack) -> Option<String> {
        let descs: Retained<NSArray> = unsafe { track.formatDescriptions() };
        let first = descs.firstObject()?;
        let desc = unsafe { &*(Retained::as_ptr(&first) as *const CMFormatDescription) };
        fourcc_string(unsafe { desc.media_sub_type() }).map(|c| codec_name(&c))
    }

    /// The size the track is meant to be SEEN at: the natural size run through
    /// the preferred transform's bounding box. A 90°/270° rotation swaps the
    /// axes, which is why a portrait phone clip that stores 1920×1080 must be
    /// reported as 1080×1920.
    fn display_size(track: &AVAssetTrack) -> Option<(u32, u32)> {
        let size = unsafe { track.naturalSize() };
        let t = unsafe { track.preferredTransform() };
        let w = t.a.abs() * size.width + t.c.abs() * size.height;
        let h = t.b.abs() * size.width + t.d.abs() * size.height;
        let (w, h) = (w.round(), h.round());
        (w >= 1.0 && h >= 1.0 && w.is_finite() && h.is_finite()).then_some((w as u32, h as u32))
    }

    /// `duration`/`tracksWithMediaType` are deprecated in favour of the
    /// completion-handler loaders, which need a run loop to answer on. Every
    /// caller here is already on a blocking worker (import, `spawn_blocking`)
    /// and has nothing to do but wait, so the synchronous accessors are both
    /// correct and simpler — they are what an AVAsset has done since 10.7.
    #[allow(deprecated)]
    pub fn probe(path: &std::path::Path) -> Option<MediaMeta> {
        let path_str = path.to_str()?;
        autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
            let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };

            // The media-type constants are weak-linked statics, so a build
            // where AVFoundation did not load gives None rather than a crash.
            let video_tracks = unsafe { asset.tracksWithMediaType(AVMediaTypeVideo?) };
            let audio_tracks = unsafe { asset.tracksWithMediaType(AVMediaTypeAudio?) };
            // A file with no tracks at all is not media we read — a text file
            // renamed .mp4 opens as an empty asset rather than failing, and
            // storing "0 tracks, unknown everything" for it would be a claim
            // that we probed a video.
            if video_tracks.is_empty() && audio_tracks.is_empty() {
                return None;
            }

            let mut meta = MediaMeta { has_audio: Some(!audio_tracks.is_empty()), ..Default::default() };

            // Duration is a property of the ASSET, not of a track: on a real
            // clip the video track ran 30.000 s and the audio 29.756 s.
            let d = unsafe { asset.duration() };
            let valid = d.flags.contains(objc2_core_media::CMTimeFlags::Valid);
            if valid && d.timescale > 0 {
                let secs = d.value as f64 / d.timescale as f64;
                if secs.is_finite() && secs > 0.0 {
                    meta.duration_secs = Some(secs);
                }
            }

            if let Some(track) = video_tracks.firstObject() {
                if let Some((w, h)) = display_size(&track) {
                    meta.width = Some(w);
                    meta.height = Some(h);
                }
                meta.video_codec = track_codec(&track);
                meta.frame_rate = sane_frame_rate(unsafe { track.nominalFrameRate() });
                let bits = unsafe { track.estimatedDataRate() } as f64;
                if bits.is_finite() && bits > 0.0 {
                    meta.bitrate_kbps = Some((bits / 1000.0).round() as u32);
                }
            }
            if let Some(track) = audio_tracks.firstObject() {
                meta.audio_codec = track_codec(&track);
            }

            (!meta.is_empty()).then_some(meta)
        })
    }

    /// A CMTime as seconds, or None when it is not a usable number.
    fn seconds_of(t: objc2_core_media::CMTime) -> Option<f64> {
        if !t.flags.contains(objc2_core_media::CMTimeFlags::Valid) || t.timescale <= 0 {
            return None;
        }
        let secs = t.value as f64 / t.timescale as f64;
        (secs.is_finite() && secs >= 0.0).then_some(secs)
    }

    /// The last frame of the clip at `path`, as PNG.
    #[allow(deprecated)] // duration + copyCGImageAtTime: sync accessors, same
                         // bargain as `probe` — every caller is on a blocking
                         // worker with nothing to do but wait.
    pub fn last_frame(path: &std::path::Path) -> Option<Vec<u8>> {
        use objc2::AnyThread;
        use objc2_av_foundation::AVAssetImageGenerator;
        use objc2_core_media::CMTime;

        let path_str = path.to_str()?;
        autoreleasepool(|_| {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path_str));
            let asset = unsafe { AVURLAsset::URLAssetWithURL_options(&url, None) };
            let d = unsafe { asset.duration() };
            if !d.flags.contains(objc2_core_media::CMTimeFlags::Valid) || d.timescale <= 0 {
                return None;
            }

            let generator = unsafe {
                AVAssetImageGenerator::initWithAsset(AVAssetImageGenerator::alloc(), &asset)
            };
            // A portrait clip stores landscape pixels plus a rotation; without
            // this the captured frame — and therefore the whole next clip —
            // comes out sideways.
            unsafe { generator.setAppliesPreferredTrackTransform(true) };

            // Anchor to the VIDEO TRACK's end, not the asset duration. The
            // asset duration is the max across ALL tracks, and an audio track
            // routinely outruns the video by a few dozen milliseconds (AAC
            // priming padding — reproduced live with a 76 ms overhang). A
            // zero-tolerance request in that gap sits after the last video
            // frame and fails outright with "Cannot Open".
            let video_end_secs: f64 = unsafe { AVMediaTypeVideo }
                .and_then(|kind| {
                    let tracks = unsafe { asset.tracksWithMediaType(kind) };
                    let track = tracks.firstObject()?;
                    let range = unsafe { track.timeRange() };
                    let start = seconds_of(range.start)?;
                    let length = seconds_of(range.duration)?;
                    Some(start + length)
                })
                .or_else(|| seconds_of(d))?;

            // "The last frame" cannot be asked for as the end itself: that is
            // the boundary AFTER the final frame. A thirtieth of a second
            // earlier lands inside the final frame's display window.
            let at_secs = (video_end_secs - 1.0 / 30.0).max(0.0);
            // 600 is the classic movie timescale — exact for every common
            // frame rate, and it sidesteps building times in a track's own
            // (sometimes enormous) timescale.
            let at = CMTime {
                value: (at_secs * 600.0).round() as i64,
                timescale: 600,
                flags: objc2_core_media::CMTimeFlags::Valid,
                epoch: 0,
            };
            // Zero tolerance first: the point of this capture is exactness.
            // With the default tolerance AVFoundation may answer with a nearby
            // KEYFRAME, which on a 15-second clip can be half a second early —
            // visibly not the frame the clip ends on.
            let zero = CMTime {
                value: 0,
                timescale: 1,
                flags: objc2_core_media::CMTimeFlags::Valid,
                epoch: 0,
            };
            unsafe {
                generator.setRequestedTimeToleranceBefore(zero);
                generator.setRequestedTimeToleranceAfter(zero);
            }

            let exact = unsafe {
                generator
                    .copyCGImageAtTime_actualTime_error(at, std::ptr::null_mut())
                    .ok()
            };
            let cg = match exact {
                Some(cg) => cg,
                None => {
                    // The exact request failed — an odd container, a
                    // fragmented mp4, a track that lied about its range. A
                    // frame NEAR the end, from the real clip, still beats the
                    // drawn still by a mile, so retry with the tolerance the
                    // OS wants before giving up.
                    let any = CMTime {
                        value: i64::MAX,
                        timescale: 1,
                        flags: objc2_core_media::CMTimeFlags::Valid
                            | objc2_core_media::CMTimeFlags::PositiveInfinity,
                        epoch: 0,
                    };
                    unsafe {
                        generator.setRequestedTimeToleranceBefore(any);
                        generator.setRequestedTimeToleranceAfter(zero);
                    }
                    unsafe {
                        generator
                            .copyCGImageAtTime_actualTime_error(at, std::ptr::null_mut())
                            .ok()?
                    }
                }
            };

            // CGImage -> PNG, the same way quicklook.rs encodes its previews.
            use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
            use objc2_foundation::NSDictionary;
            let bitmap = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
            let data = unsafe {
                bitmap.representationUsingType_properties(
                    NSBitmapImageFileType::PNG,
                    &NSDictionary::new(),
                )
            };
            data.map(|d| d.to_vec())
        })
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// AVFoundation is the only media stack this app ships with. Off macOS
    /// there is nothing to probe with, and inventing fields would be worse
    /// than saying so.
    pub fn probe(_path: &std::path::Path) -> Option<super::MediaMeta> {
        None
    }

    pub fn last_frame(_path: &std::path::Path) -> Option<Vec<u8>> {
        None
    }
}

/// Probe a file already on disk. None = the OS would not open it as media, or
/// opened it and told us nothing.
pub fn probe_path(path: &Path) -> Option<MediaMeta> {
    if std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) == 0 {
        return None;
    }
    imp::probe(path)
}

/// Probe bytes that live encrypted in the room. AVFoundation dispatches on the
/// file EXTENSION as well as the container's own magic, so the temp copy keeps
/// it — an .mov handed over as `.bin` reads as a different (or no) container.
pub fn probe_bytes(bytes: &[u8], ext: &str) -> Option<MediaMeta> {
    if bytes.is_empty() {
        return None;
    }
    let stem = uuid::Uuid::new_v4();
    let file = std::env::temp_dir().join(if ext.is_empty() {
        format!("arcelle-probe-{stem}")
    } else {
        format!("arcelle-probe-{stem}.{ext}")
    });
    if write_private(&file, bytes).is_err() {
        // A PARTIAL write (disk full mid-file) has already created the file,
        // and the early return used to skip the cleanup below — leaving
        // decrypted video on disk, which is exactly what this function
        // promises never to do. Removing a file that never got created is a
        // no-op, so this is unconditional.
        let _ = std::fs::remove_file(&file);
        return None;
    }
    let meta = imp::probe(&file);
    // Always, on both paths — a probe must not leave decrypted video behind.
    let _ = std::fs::remove_file(&file);
    meta
}

/// The REAL final frame of a clip, as PNG bytes.
///
/// This is the Story tab's continuous mode. The first design pinned clip N's
/// `last_frame` to shot N+1's still and trusted the model to land on it —
/// and models treat that slot as a target they drift toward, not a frame they
/// guarantee, so scene 2 did not start where scene 1 ended (reported live).
/// Capturing the frame the finished clip ACTUALLY ends on and starting the
/// next clip from it makes the join exact by construction, on any model that
/// takes a first frame at all — 19 of the 21, not the 12 with a last-frame
/// slot.
///
/// Same privacy bargain as [`probe_bytes`]: AVFoundation takes a file URL, so
/// the decrypted clip sits in an owner-only temp file for the moment the
/// capture takes and is removed on every exit path.
///
/// `None` means the frame could not be read — a codec AVFoundation does not
/// decode (a WebM, say). The caller falls back to the drawn still, which is
/// yesterday's behaviour: an approximate cut, never a lost clip.
pub fn last_frame_png(bytes: &[u8], ext: &str) -> Option<Vec<u8>> {
    if bytes.is_empty() {
        return None;
    }
    let stem = uuid::Uuid::new_v4();
    let file = std::env::temp_dir().join(if ext.is_empty() {
        format!("arcelle-endframe-{stem}")
    } else {
        format!("arcelle-endframe-{stem}.{ext}")
    });
    if write_private(&file, bytes).is_err() {
        // Same promise as probe_bytes: a partial write is still a file, and
        // it holds decrypted clip bytes. Removed on THIS path too.
        let _ = std::fs::remove_file(&file);
        return None;
    }
    let png = imp::last_frame(&file);
    let _ = std::fs::remove_file(&file);
    png
}

/// Owner-only from the moment it exists, rather than created world-readable
/// and tightened afterwards: between those two steps another local process can
/// already have opened it. (Same reasoning as `quicklook::write_private`.)
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

/// A real, short video built at test time from a file every Mac has, so nothing
/// binary is checked into the repo. Returns None — and the caller SKIPS rather
/// than fails — when this machine has no such wallpaper or no converter: that
/// is a fact about the machine, not a defect in the code under test.
///
/// Shared with `commands::video`'s tests, which need a genuine clip to cut.
#[cfg(test)]
pub(crate) fn test_fixture(name: &str, extra: &[&str]) -> Option<std::path::PathBuf> {
    const SOURCE: &str =
        "/System/Library/Desktop Pictures/.wallpapers/Sonoma/Sonoma Graphic Light Landscape.mov";
    if !Path::new(SOURCE).exists() {
        return None;
    }
    let out = std::env::temp_dir().join(format!("arcelle-fixture-{}-{name}", uuid::Uuid::new_v4()));
    let ok = std::process::Command::new("/usr/bin/avconvert")
        .args(["-p", "PresetPassthrough", "-s", SOURCE, "-o"])
        .arg(&out)
        .args(["--duration", "1", "--replace"])
        .args(extra)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    (ok && out.exists()).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_clip_reports_the_facts_it_has() {
        let Some(path) = test_fixture("probe.mov", &[]) else {
            eprintln!("skipped: no system fixture source on this machine");
            return;
        };
        let meta = probe_path(&path).expect("a real .mov must probe");
        let _ = std::fs::remove_file(&path);

        let secs = meta.duration_secs.expect("duration");
        assert!((secs - 1.0).abs() < 0.2, "asked for 1 s, got {secs}");
        assert!(meta.width.unwrap() >= 640 && meta.height.unwrap() >= 360, "{meta:?}");
        // The wallpaper is video-only: "no audio track" is a FINDING, not an
        // unknown, and the viewer must be able to say so.
        assert_eq!(meta.has_audio, Some(false));
        assert_eq!(meta.audio_codec, None);
        assert!(meta.video_codec.is_some(), "a video track always names a codec");
        assert!(!meta.is_empty());
    }

    /// The probe must not answer for things that are not media. A text file
    /// renamed .mp4 is the honest version of this test: AVFoundation opens it
    /// as an asset with no tracks rather than erroring, and returning
    /// `MediaMeta::default()` there would put "unknown, unknown, unknown" in
    /// the database as though we had looked.
    #[test]
    fn a_non_media_file_probes_to_nothing() {
        assert_eq!(probe_bytes(b"this is not a video", "mp4"), None);
        assert_eq!(probe_bytes(b"", "mp4"), None);
        let missing = std::env::temp_dir().join(format!("arcelle-nope-{}.mp4", uuid::Uuid::new_v4()));
        assert_eq!(probe_path(&missing), None);
    }

    #[test]
    fn probing_bytes_leaves_no_decrypted_copy_behind() {
        let leftovers = || {
            std::fs::read_dir(std::env::temp_dir())
                .map(|d| {
                    d.filter_map(Result::ok)
                        .filter(|e| {
                            let n = e.file_name().to_string_lossy().into_owned();
                            n.starts_with("arcelle-probe-") && n.ends_with(".probetest")
                        })
                        .count()
                })
                .unwrap_or(0)
        };
        assert_eq!(leftovers(), 0, "a previous run leaked");
        let _ = probe_bytes(b"secret video bytes", "probetest");
        assert_eq!(leftovers(), 0, "a decrypted probe copy survived the call");
    }

    #[test]
    fn unreadable_fields_stay_unknown_rather_than_defaulting() {
        // 0 fps is what AVFoundation reports for a container that states no
        // frame rate; it must read as "we don't know", never as "0 fps".
        assert_eq!(sane_frame_rate(0.0), None);
        assert_eq!(sane_frame_rate(-1.0), None);
        assert_eq!(sane_frame_rate(f32::NAN), None);
        assert_eq!(sane_frame_rate(f32::INFINITY), None);
        assert_eq!(sane_frame_rate(1e6), None);
        assert_eq!(sane_frame_rate(29.97), Some(29.97));
        assert_eq!(sane_frame_rate(240.0), Some(240.0)); // real slow-motion
        // An all-unknown struct is not a probe result.
        assert!(MediaMeta::default().is_empty());
        assert!(!MediaMeta { has_audio: Some(false), ..Default::default() }.is_empty());
    }

    #[test]
    fn codecs_are_named_where_we_know_them_and_verbatim_where_we_do_not() {
        assert_eq!(fourcc_string(u32::from_be_bytes(*b"avc1")).as_deref(), Some("avc1"));
        assert_eq!(fourcc_string(u32::from_be_bytes(*b"aac ")).as_deref(), Some("aac"));
        assert_eq!(fourcc_string(0), None);
        assert_eq!(codec_name("hvc1"), "HEVC");
        // An unmapped code is shown as the file stated it — dropping it would
        // hide a fact the container did give us.
        assert_eq!(codec_name("xyzw"), "xyzw");
    }
}
