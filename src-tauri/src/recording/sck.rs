//! ADD-27: the "hear the meeting" half of a live recording — a system-audio
//! tap built on ScreenCaptureKit.
//!
//! Whatever the Mac is playing (a Google Meet tab, the Zoom/Teams/Slack app,
//! a video) is delivered as 16 kHz mono f32 straight into the engine, with
//! the app's own output excluded so playback of an earlier recording never
//! records itself. Requires the user's one-time Screen Recording permission
//! (macOS 13+ for audio capture); when it's missing the recording degrades
//! to microphone-only and the UI says why, instead of failing.
//!
//! SCK objects are created and driven from a helper thread; Apple documents
//! ScreenCaptureKit as callable from any thread, with output delivered on the
//! queue we hand it — the `unsafe impl Send` below leans on exactly that.

use block2::RcBlock;
use dispatch2::DispatchQueue;
use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_core_media::{CMFormatDescription, CMSampleBuffer};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol, NSProcessInfo};
use objc2_screen_capture_kit::{
    SCContentFilter, SCShareableContent, SCStream, SCStreamConfiguration, SCStreamOutput,
    SCStreamOutputType,
};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use super::SAMPLE_RATE;

/// Wrapper that lets a Retained ObjC object cross a thread boundary. Sound
/// here because ScreenCaptureKit's API contract is thread-agnostic (see
/// module docs) and we never touch the object from two threads at once.
struct SendCell<T>(T);
unsafe impl<T> Send for SendCell<T> {}

pub struct TapIvars {
    on_samples: Box<dyn Fn(&[f32], u32) + Send + Sync>,
    /// The rate the stream was CONFIGURED for — used only when a delivered
    /// batch carries no readable audio format description. The rate handed to
    /// `on_samples` comes from the buffer itself (see `buffer_sample_rate`);
    /// reading it back off the configuration object we had just written to was
    /// no check at all.
    rate: u32,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[name = "PRSystemAudioTap"]
    #[ivars = TapIvars]
    pub struct TapOutput;

    unsafe impl NSObjectProtocol for TapOutput {}

    unsafe impl SCStreamOutput for TapOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        fn stream_did_output(
            &self,
            _stream: &SCStream,
            sample_buffer: &CMSampleBuffer,
            of_type: SCStreamOutputType,
        ) {
            if of_type != SCStreamOutputType::Audio {
                return;
            }
            if let Some(samples) = extract_f32(sample_buffer) {
                let rate = buffer_sample_rate(sample_buffer).unwrap_or(self.ivars().rate);
                (self.ivars().on_samples)(&samples, rate);
            }
        }
    }
);

impl TapOutput {
    fn new(on_samples: Box<dyn Fn(&[f32], u32) + Send + Sync>, rate: u32) -> Retained<Self> {
        let this = Self::alloc().set_ivars(TapIvars { on_samples, rate });
        unsafe { msg_send![super(this), init] }
    }
}

/// The rate the DELIVERED batch is actually in, taken from its own audio
/// format description. This is the only place the answer can honestly come
/// from: asking the `SCStreamConfiguration` we just wrote 16 kHz into returns
/// 16 kHz whatever macOS went on to negotiate.
///
/// `objc2-core-media` binds `CMAudioFormatDescriptionGetStreamBasicDescription`
/// only behind an optional core-audio-types feature this crate does not carry;
/// the symbol is stable C ABI and only the ASBD's first field is needed, so it
/// is declared directly (as `ocr.rs` does for `CGBitmapContextCreate`). `None`
/// for a non-audio or malformed description, leaving the configured rate.
fn buffer_sample_rate(sb: &CMSampleBuffer) -> Option<u32> {
    #[repr(C)]
    struct AudioStreamBasicDescription {
        sample_rate: f64,
        format_id: u32,
        format_flags: u32,
        bytes_per_packet: u32,
        frames_per_packet: u32,
        bytes_per_frame: u32,
        channels_per_frame: u32,
        bits_per_channel: u32,
        reserved: u32,
    }
    extern "C-unwind" {
        fn CMAudioFormatDescriptionGetStreamBasicDescription(
            desc: &CMFormatDescription,
        ) -> *const AudioStreamBasicDescription;
    }
    let desc = unsafe { sb.format_description() }?;
    let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&desc).as_ref() }?;
    let rate = asbd.sample_rate;
    if rate.is_finite() && rate >= 1.0 {
        Some(rate.round() as u32)
    } else {
        None
    }
}

/// Pull the raw f32 samples out of an SCK audio sample buffer. The stream is
/// configured for 16 kHz mono float32; when macOS hands us two channels
/// anyway they arrive non-interleaved (SCK's documented layout), so the two
/// planes are averaged down to mono.
fn extract_f32(sb: &CMSampleBuffer) -> Option<Vec<f32>> {
    let bb = unsafe { sb.data_buffer() }?;
    let len = unsafe { bb.data_length() };
    if len == 0 || len % 4 != 0 {
        return None;
    }
    let mut bytes = vec![0u8; len];
    let status = unsafe { bb.copy_data_bytes(0, len, NonNull::new(bytes.as_mut_ptr() as *mut c_void)?) };
    if status != 0 {
        return None;
    }
    let floats: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let n = unsafe { sb.num_samples() }.max(0) as usize;
    if n > 0 && floats.len() == n * 2 {
        let (l, r) = floats.split_at(n);
        return Some(l.iter().zip(r).map(|(a, b)| (a + b) * 0.5).collect());
    }
    Some(floats)
}

pub struct SysAudioTap {
    stream: SendCell<Retained<SCStream>>,
    // Kept alive for as long as the stream may call it.
    _output: SendCell<Retained<TapOutput>>,
    _queue: dispatch2::DispatchRetained<DispatchQueue>,
}

impl SysAudioTap {
    /// Set up and start the tap. Blocking (shareable-content lookup + capture
    /// start round-trips); call from a worker thread, never the main one.
    /// `on_samples` is handed each batch together with the sample rate that
    /// batch is really in, read from the buffer's own format description, so a
    /// rate we asked for and did not get is resampled instead of silently
    /// shifting the whole meeting lane's pitch and timing.
    pub fn start(
        on_samples: Box<dyn Fn(&[f32], u32) + Send + Sync>,
    ) -> Result<SysAudioTap, String> {
        // Audio capture arrived in ScreenCaptureKit with macOS 13.
        let os = NSProcessInfo::processInfo().operatingSystemVersion();
        if os.majorVersion < 13 {
            return Err("Meeting audio needs macOS 13 or newer — recording from the microphone only.".into());
        }

        // 1) What can we capture? This is also the call that makes macOS show
        //    the Screen Recording permission prompt the first time.
        let (tx, rx) = mpsc::channel::<SendCell<Result<Retained<SCShareableContent>, String>>>();
        let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
            let result = if content.is_null() {
                Err(unsafe { error.as_ref() }
                    .map(|e| e.localizedDescription().to_string())
                    .unwrap_or_else(|| "screen capture unavailable".into()))
            } else {
                Ok(unsafe { Retained::retain(content) }.expect("non-null just checked"))
            };
            let _ = tx.send(SendCell(result));
        });
        unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&block) };
        let content = rx
            .recv_timeout(Duration::from_secs(20))
            .map_err(|_| PERMISSION_HINT.to_string())?
            .0
            .map_err(|e| format!("{PERMISSION_HINT} ({e})"))?;

        let displays = unsafe { content.displays() };
        let display = displays
            .iter()
            .next()
            .ok_or("No display available to capture audio from.")?;

        // 2) Audio-only stream: capture flags on, video shrunk to a stamp and
        //    simply never subscribed to.
        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::new(),
            )
        };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setCapturesAudio(true);
            config.setExcludesCurrentProcessAudio(true);
            config.setSampleRate(SAMPLE_RATE as isize);
            config.setChannelCount(1);
            config.setWidth(2);
            config.setHeight(2);
        }
        // What we asked for, read back off our own configuration — a fallback
        // only. What each batch is really in comes from the batch.
        let rate = unsafe { config.sampleRate() };
        let rate = if rate > 0 { rate as u32 } else { SAMPLE_RATE as u32 };
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(SCStream::alloc(), &filter, &config, None)
        };

        let output = TapOutput::new(on_samples, rate);
        let queue = DispatchQueue::new("com.benreich.privateroom.sysaudio", None);
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*output),
                    SCStreamOutputType::Audio,
                    Some(&queue),
                )
                .map_err(|e| format!("audio output rejected: {}", e.localizedDescription()))?;
        }

        // 3) Start, and wait for the verdict — the error for a denied
        //    permission surfaces here.
        let (stx, srx) = mpsc::channel::<Option<String>>();
        let start_block = RcBlock::new(move |error: *mut NSError| {
            let _ = stx.send(unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string()));
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&start_block)) };
        match srx.recv_timeout(Duration::from_secs(20)) {
            Ok(None) => {}
            Ok(Some(e)) => return Err(format!("{PERMISSION_HINT} ({e})")),
            Err(_) => return Err(PERMISSION_HINT.to_string()),
        }

        Ok(SysAudioTap {
            stream: SendCell(stream),
            _output: SendCell(output),
            _queue: queue,
        })
    }

    pub fn stop(self) {
        unsafe { self.stream.0.stopCaptureWithCompletionHandler(None) };
    }
}

// The switch can LOOK enabled while macOS still denies: the grant is pinned to
// the code signature of the build that earned it, and this app is ad-hoc
// signed, so every rebuild invalidates it silently ("Failed to match existing
// code requirement" in tccd's log). Hence "off and back on".
const PERMISSION_HINT: &str = "Couldn't hear the Mac's audio — macOS blocked system-audio capture. \
In System Settings → Privacy & Security → Screen & System Audio Recording, switch Arcelle on \
(off and back on if it already looks enabled). Your microphone keeps recording either way.";
