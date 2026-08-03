//! The host's own event log — what Arcelle DECIDED, in a file you can attach
//! to a bug report.
//!
//! Owner replacement #1, 2026-08-03. The premise this was ordered on was half
//! wrong and worth correcting here so nobody re-derives it: the sidecar's
//! stderr *is* captured (see [`crate::sidecar_lifecycle::stderr_log_path`],
//! one generation of rotation). What genuinely did not exist was any record of
//! the HOST's own decisions — which tools were served to which engine, which
//! model a turn selected, whether a Stop was accepted, when a job changed
//! state. That gap is why the flagship agent failure was undiagnosable: a
//! model handed an empty tool bridge does not report "my bridge is empty", it
//! rationalises, and the rationalisation became the bug report.
//!
//! # The privacy boundary is the point of this module
//!
//! Rooms are encrypted; nothing that lives inside one may reach a log file
//! sitting in `$TMPDIR`. That includes FILE NAMES — the privacy door
//! deliberately does not redact them, because a filename in an encrypted-room
//! app is user content. So this module does not offer a way to log a string.
//! There is no `obs::info("...", &[("path", some_string)])`; the only things
//! that can become a log value are:
//!
//! * [`id`] — an opaque handle, and only if it *is* one: `[A-Za-z0-9_-]{1,64}`
//!   and nothing else. A filename ("Q3 notes.pdf", "diary.pdf") fails on the
//!   space or the dot and is recorded as `<unloggable>`.
//! * [`one_of`] — a runtime string collapsed onto a compile-time whitelist. A
//!   value that is not in the whitelist becomes `<unexpected>`, never itself.
//! * [`state`] — a `&'static str`, which by construction came from our source
//!   and not from a room.
//! * [`count`] / [`bytes`] / [`ms`] / [`flag`] — numbers and booleans.
//! * [`model`] — the narrow exception: a model/provider identifier, which is
//!   configuration rather than room content, under its own tight charset.
//! * [`err_kind`] — an error message classified onto one of [`ERR_KINDS`]. The
//!   message itself never travels; see that function for why scrubbing it was
//!   tried, tested and abandoned.
//!
//! Event names and field names are `&'static str` for the same reason. The
//! wrong thing is not merely discouraged here; there is no function that
//! accepts it — and, since [`Val`] is an opaque newtype over a module-private
//! enum, there is no LITERAL that expresses it either. `obs::Val::State(name)`
//! does not compile outside this file, which is the difference between a
//! boundary and a request to be careful.
//!
//! One thing shape checking genuinely CANNOT do is separate a bearer token from
//! a uuid — both are runs of random alphanumerics. What keeps credentials out
//! is that no event helper here takes one; [`id`] additionally refuses the
//! well-known secret prefixes as a second line, and says so rather than
//! claiming to be a guarantee.

use std::fmt;
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

use tracing::Level;

/// What a value that failed its shape check is recorded as. Deliberately not
/// silence: "this field existed and was refused" is different from "this field
/// was absent", and the anti-fabrication doctrine applies to our own log too.
pub const UNLOGGABLE: &str = "<unloggable>";

/// What a runtime string that is not in its caller's whitelist is recorded as.
pub const UNEXPECTED: &str = "<unexpected>";

/// Keep one live log plus one previous generation, same doctrine as the
/// sidecar's stderr mirror: the run that just died is usually the one worth
/// reading, and truncating on launch destroys it.
const MAX_LOG_BYTES: u64 = 4 * 1024 * 1024;

/// The default filter. Quiet enough to ship: our own events at `info`, and
/// nothing at all from dependencies (tauri, wry, reqwest, hyper) — the file
/// has to stay readable by the person attaching it to a bug report.
const DEFAULT_FILTER: &str = "arcelle=info";

/// The tracing target every event in this module uses. One target, so the
/// filter above is the whole story.
const TARGET: &str = "arcelle";

/// The environment variable that overrides [`DEFAULT_FILTER`], in the usual
/// `target=level` syntax (`ARCELLE_LOG=arcelle=debug`, `ARCELLE_LOG=trace`).
pub const LOG_ENV: &str = "ARCELLE_LOG";

// ------------------------------------------------------------------ the file

/// Where the host's event log lives — beside the sidecar's stderr mirror, so
/// "the logs" is one folder and not a scavenger hunt.
pub fn log_path() -> PathBuf {
    std::env::temp_dir().join("arcelle-host.log")
}

/// The previous session's host log, kept for exactly the reason the sidecar's
/// is: the interesting session is usually the one that just ended.
pub fn previous_log_path() -> PathBuf {
    std::env::temp_dir().join("arcelle-host.prev.log")
}

/// The folder holding both logs, for the Settings affordance that reveals it.
pub fn log_dir() -> PathBuf {
    std::env::temp_dir()
}

/// A size-capped file with one generation of rotation. Deliberately hand-rolled
/// rather than `tracing-appender`: its rolling appenders never delete anything,
/// and an app that runs for days would grow a log nobody can attach anywhere.
struct Sink {
    path: PathBuf,
    prev: PathBuf,
    file: Option<std::fs::File>,
    written: u64,
}

impl Sink {
    fn new(path: PathBuf, prev: PathBuf) -> Self {
        // Rotate on open, not truncate — see [`previous_log_path`].
        let _ = std::fs::rename(&path, &prev);
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
            .ok();
        Self {
            path,
            prev,
            file,
            written: 0,
        }
    }

    fn rotate(&mut self) {
        self.file = None;
        let _ = std::fs::rename(&self.path, &self.prev);
        self.file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&self.path)
            .ok();
        self.written = 0;
    }
}

impl Write for Sink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.written + buf.len() as u64 > MAX_LOG_BYTES {
            self.rotate();
        }
        if let Some(f) = self.file.as_mut() {
            // A logging failure must never fail the app: a full disk or a
            // sandboxed temp dir means we lose the line, not the turn.
            let _ = f.write_all(buf);
            self.written += buf.len() as u64;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        if let Some(f) = self.file.as_mut() {
            let _ = f.flush();
        }
        Ok(())
    }
}

/// `MakeWriter` handle over the shared sink.
#[derive(Clone)]
struct SharedSink(Arc<Mutex<Sink>>);

struct SinkGuard(Arc<Mutex<Sink>>);

impl Write for SinkGuard {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self.0.lock() {
            Ok(mut s) => s.write(buf),
            // A poisoned log mutex must not panic a turn.
            Err(_) => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self.0.lock() {
            Ok(mut s) => s.flush(),
            Err(_) => Ok(()),
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for SharedSink {
    type Writer = SinkGuard;
    fn make_writer(&'a self) -> Self::Writer {
        SinkGuard(self.0.clone())
    }
}

/// UTC timestamps via `chrono` (already a dependency for schedule arithmetic),
/// so the format is pinned here rather than inherited from whichever
/// tracing-subscriber time feature happens to be enabled.
struct Utc;

impl tracing_subscriber::fmt::time::FormatTime for Utc {
    fn format_time(&self, w: &mut tracing_subscriber::fmt::format::Writer<'_>) -> fmt::Result {
        write!(w, "{}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"))
    }
}

static STARTED: OnceLock<()> = OnceLock::new();

/// Install the host log. Idempotent — a second call is a no-op, so a test or a
/// re-entrant startup path cannot fight the global subscriber.
pub fn init(app_version: &str) {
    if STARTED.set(()).is_err() {
        return;
    }
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let requested = std::env::var(LOG_ENV).ok();
    let (filter, understood) = filter_from(requested.as_deref());

    let sink = SharedSink(Arc::new(Mutex::new(Sink::new(
        log_path(),
        previous_log_path(),
    ))));

    let fmt = tracing_subscriber::fmt::layer()
        // A file, so colour codes would be noise a bug reporter has to strip.
        .with_ansi(false)
        // Every event here carries one target; printing it on each line buys
        // nothing and costs width.
        .with_target(false)
        .with_timer(Utc)
        .with_writer(sink);

    // A failing install must not take the app down — worst case we run with no
    // host log, exactly as every release before this one did.
    let _ = tracing_subscriber::registry().with(fmt).with(filter).try_init();

    info(
        "host.start",
        &[
            ("version", model(app_version)),
            ("log", state("arcelle-host.log")),
            // Whether ARCELLE_LOG was honoured, in the file itself. A log that
            // is quieter than the reader expects has to say why in the one place
            // the reader is already looking.
            ("filter", state(if understood { "as asked" } else { "default" })),
        ],
    );
    if !understood {
        warn(
            "host.log_filter_ignored",
            &[("env", state(LOG_ENV)), ("bytes", bytes(requested.map_or(0, |s| s.len())))],
        );
    }
}

/// Resolve `ARCELLE_LOG` into a filter, and say whether the request was honoured.
///
/// The subtlety that cost a silent log: `Targets` accepts far more than it
/// should. `"not a filter!!"` and `"ARCELLE=debug"` (wrong case) both PARSE —
/// as a target with that literal name — so `s.parse().ok()` reports success and
/// installs a filter that matches nothing we ever emit. The result is a 0-byte
/// host log with no error anywhere, which is precisely the blindness this module
/// was ordered to end, reached by the single most likely user action: turning
/// the logging up and mistyping it.
///
/// So a parsed filter is only honoured if it can actually SPEAK about us: it
/// names our target, or it sets a default level that reaches every target.
/// `arcelle=off` names us and is therefore respected — an explicit "be quiet" is
/// a real answer; a typo is not.
fn filter_from(requested: Option<&str>) -> (tracing_subscriber::filter::Targets, bool) {
    let default = || {
        DEFAULT_FILTER
            .parse::<tracing_subscriber::filter::Targets>()
            .expect("the default filter parses")
    };
    match requested {
        None => (default(), true),
        Some(s) => match s.parse::<tracing_subscriber::filter::Targets>() {
            Ok(t)
                if t.default_level().is_some() || t.iter().any(|(target, _)| target == TARGET) =>
            {
                (t, true)
            }
            _ => (default(), false),
        },
    }
}

// ------------------------------------------------------------- the value type

/// A value that is allowed to reach the log file.
///
/// OPAQUE ON PURPOSE, and this is the whole design rather than a detail of it.
/// [`Shape`] — the enum that actually holds the bytes — is private to this
/// module, so `Val` has no constructor anywhere else in the crate: the only way
/// to make one is to call [`id`], [`model`], [`state`], [`one_of`], [`err_kind`],
/// [`ids`], [`count`], [`bytes`], [`ms`] or [`flag`], every one of which either
/// shape-checks its input or cannot take a string at all.
///
/// It was a public enum with public `String` variants first, and that was a
/// hole big enough to drive the packet through: `Val::State(filename)` compiles,
/// reads as ordinary, and puts room content straight in the file — it is in fact
/// SHORTER to write than the checked helper. The boundary has to be something a
/// caller cannot spell, not something a caller is asked not to spell.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Val(Shape);

/// The private interior of [`Val`]. Not `pub`, not `pub(crate)` — module-private,
/// which is what makes `Val` unconstructible outside `obs`.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Shape {
    /// An opaque handle that passed its shape check, or [`UNLOGGABLE`].
    Id(String),
    /// A model/provider identifier — configuration, not room content.
    Model(String),
    /// A compile-time literal, or a runtime string collapsed onto one.
    State(String),
    Count(u64),
    Bytes(u64),
    Ms(u64),
    Flag(bool),
    /// A list of handles, each independently shape-checked.
    Ids(Vec<String>),
}

impl fmt::Display for Val {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            Shape::Id(s) | Shape::Model(s) | Shape::State(s) => quoted(f, s),
            Shape::Count(n) | Shape::Bytes(n) | Shape::Ms(n) => write!(f, "{n}"),
            Shape::Flag(b) => write!(f, "{b}"),
            Shape::Ids(v) => {
                write!(f, "[")?;
                for (i, s) in v.iter().enumerate() {
                    if i > 0 {
                        write!(f, " ")?;
                    }
                    write!(f, "{s}")?;
                }
                write!(f, "]")
            }
        }
    }
}

/// logfmt quoting: only when the value would otherwise break `k=v` parsing.
fn quoted(f: &mut fmt::Formatter<'_>, s: &str) -> fmt::Result {
    if s.is_empty() || s.contains(' ') || s.contains('=') || s.contains('"') {
        write!(f, "{s:?}")
    } else {
        write!(f, "{s}")
    }
}

/// An opaque handle — a run id, chat id, job id, room id, tool name.
///
/// Shape-checked, not trusted: `[A-Za-z0-9_-]{1,64}` and nothing else. That
/// admits every id this app mints (uuid simple form, nanoid, our tool names)
/// and refuses essentially every filename, because a filename either carries a
/// space, a dot before its extension, or a path separator. A value that fails
/// is recorded as [`UNLOGGABLE`] — the field still appears, so the log never
/// pretends the caller passed nothing.
pub fn id(s: &str) -> Val {
    let ok = !s.is_empty()
        && s.len() <= 64
        && !looks_like_a_credential(s)
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    Val(Shape::Id(if ok {
        s.to_string()
    } else {
        UNLOGGABLE.to_string()
    }))
}

/// Well-known secret prefixes, refused by [`id`] and [`model`].
///
/// This one is a BLOCKLIST and therefore not a guarantee — say so rather than
/// imply otherwise. A bearer token is a run of random alphanumerics, which is
/// exactly what a uuid is; no shape check can separate them, and a check that
/// claimed to would be the kind of confident overstatement this codebase exists
/// to avoid. What actually keeps credentials out of the log is that not one of
/// the event helpers below takes a credential: the bridge token, the Keychain
/// entry and the provider key have no parameter to arrive through. This list is
/// the second line — it catches the copy-paste mistake that would otherwise
/// reach the file.
fn looks_like_a_credential(s: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "sk-", "sk_", "pk_", "rk_", "ghp_", "gho_", "ghu_", "github_pat_", "xoxb-", "xoxp-",
        "xapp-", "AKIA", "ASIA", "AIza", "hf_", "eyJ", "Bearer",
    ];
    PREFIXES.iter().any(|p| s.starts_with(p))
}

/// [`id`] over a list — a served tool catalog, an advisor roster. Each entry is
/// checked on its own, so one odd connector tool name does not blank the rest.
pub fn ids<S: AsRef<str>>(items: &[S]) -> Val {
    Val(Shape::Ids(
        items
            .iter()
            .map(|s| match id(s.as_ref()) {
                Val(Shape::Id(v)) => v,
                _ => UNLOGGABLE.to_string(),
            })
            .collect(),
    ))
}

/// A model or provider identifier (`qwen3.5:4b`, `anthropic/claude-opus-4`,
/// `codex-cli:gpt-5`). Configuration the user chose in Settings, not something
/// that came out of a room — but still shape-checked, and still no spaces, so
/// a prose string cannot arrive here by accident.
pub fn model(s: &str) -> Val {
    let ok = !s.is_empty()
        && s.len() <= 96
        && !s.starts_with(['/', '.', '~'])
        && !s.contains("..")
        && !looks_like_a_filename(s)
        && !looks_like_a_credential(s)
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':' | b'/' | b'+')
        });
    Val(Shape::Model(if ok {
        s.to_string()
    } else {
        UNLOGGABLE.to_string()
    }))
}

/// The one shape a model id and a filename share, closed here because the
/// boundary test found it: "diary.pdf" has no space, no path separator and no
/// leading dot, so the charset check above waved it straight through.
///
/// A model id's dotted segment is a VERSION — `qwen3.5:4b`, `llama3.2`,
/// `nomic-embed-text-v1.5` — so it ends in digits or carries a `:`/`/` after
/// the dot. A file extension is short and purely alphabetic. That is the whole
/// discriminator, and it costs nothing to be wrong in the safe direction: a
/// model genuinely named `foo.bar` is recorded as [`UNLOGGABLE`], which is a
/// missing diagnostic, not a leak.
fn looks_like_a_filename(s: &str) -> bool {
    match s.rsplit_once('.') {
        Some((_, ext)) => {
            (1..=5).contains(&ext.len()) && ext.chars().all(|c| c.is_ascii_alphabetic())
        }
        None => false,
    }
}

/// A compile-time literal: an enum name, an outcome, a phase.
pub fn state(s: &'static str) -> Val {
    Val(Shape::State(s.to_string()))
}

/// A RUNTIME string collapsed onto a compile-time whitelist.
///
/// This is how a `&str` that happens to be a closed-set state ("running",
/// "paused", "done") reaches the log without opening a hole: anything not in
/// `allowed` becomes [`UNEXPECTED`]. A room's contents cannot match a
/// whitelist, so they cannot get through.
pub fn one_of(s: &str, allowed: &[&'static str]) -> Val {
    match allowed.iter().find(|a| **a == s) {
        Some(a) => Val(Shape::State((*a).to_string())),
        None => Val(Shape::State(UNEXPECTED.to_string())),
    }
}

pub fn count(n: usize) -> Val {
    Val(Shape::Count(n as u64))
}

pub fn bytes(n: usize) -> Val {
    Val(Shape::Bytes(n as u64))
}

pub fn ms(d: std::time::Duration) -> Val {
    Val(Shape::Ms(d.as_millis().min(u64::MAX as u128) as u64))
}

pub fn flag(b: bool) -> Val {
    Val(Shape::Flag(b))
}

/// The closed set of error kinds. Every one is a compile-time literal, which
/// is what makes [`err_kind`] safe by construction.
pub const ERR_KINDS: &[&str] = &[
    "none",
    "timeout",
    "network",
    "not_found",
    "denied",
    "rate_limited",
    "upstream_error",
    "malformed",
    "no_credential",
    "out_of_memory",
    "too_large",
    "cancelled",
    "other",
];

/// Reduce an error message to its KIND — one of [`ERR_KINDS`], never the text.
///
/// The first version of this scrubbed the message token by token, keeping short
/// alphanumeric words. Its own boundary test killed it in the first run: the
/// filename "Q3 board minutes.pdf" survives as "Q3 board", because the words in
/// a filename are short alphanumeric words. An error message can carry room
/// content in ANY position — a path, a title the model quoted back, a row of a
/// spreadsheet — so no amount of filtering makes the text itself safe.
///
/// So the text does not travel. It is CLASSIFIED, and only the class travels.
/// The detail still exists where it always did: the sidecar's stderr mirror
/// keeps full Python tracebacks, and that file is written by the sidecar's own
/// process about its own failures, not by us about a room's contents.
///
/// Deliberately no digest either. An 8-hex fingerprint of an error would let
/// anyone holding the log confirm a guessed filename by hashing it, which is a
/// smaller hole than a plaintext leak but is still a hole.
pub fn err_kind(s: &str) -> Val {
    let t = s.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| t.contains(n));
    let kind = if s.trim().is_empty() {
        "none"
    } else if has(&["timed out", "timeout", "deadline"]) {
        "timeout"
    } else if has(&["stopped by the user", "cancel", "aborted"]) {
        "cancelled"
    } else if has(&["429", "rate limit", "quota", "too many requests"]) {
        "rate_limited"
    } else if has(&["401", "403", "permission", "denied", "forbidden", "unauthor"]) {
        "denied"
    } else if has(&["api key", "no key", "credential", "keychain", "not signed in"]) {
        "no_credential"
    } else if has(&["404", "no such file", "not found", "does not exist"]) {
        "not_found"
    } else if has(&[
        "connection",
        "connect",
        "dns",
        "unreachable",
        "sending request",
        "network",
        "offline",
        "broken pipe",
    ]) {
        "network"
    } else if has(&["500", "502", "503", "504", "bad gateway", "server error"]) {
        "upstream_error"
    } else if has(&["out of memory", "oom", "allocation"]) {
        "out_of_memory"
    } else if has(&["context", "too long", "too large", "token limit", "exceeds"]) {
        "too_large"
    } else if has(&["json", "parse", "decode", "invalid", "malformed", "schema"]) {
        "malformed"
    } else {
        "other"
    };
    Val(Shape::State(kind.to_string()))
}

// ---------------------------------------------------------------- emit

/// Render one event as a logfmt line. Split out from the emit functions so the
/// privacy boundary can be asserted without a subscriber.
pub fn render(event: &'static str, fields: &[(&'static str, Val)]) -> String {
    let mut line = String::from(event);
    for (k, v) in fields {
        line.push(' ');
        line.push_str(k);
        line.push('=');
        line.push_str(&v.to_string());
    }
    line
}

/// A decision worth keeping. `event` and every field NAME are `&'static str`,
/// so neither can be room content either.
pub fn info(event: &'static str, fields: &[(&'static str, Val)]) {
    tracing::event!(target: TARGET, Level::INFO, "{}", render(event, fields));
}

/// Something went wrong but the app carried on.
pub fn warn(event: &'static str, fields: &[(&'static str, Val)]) {
    tracing::event!(target: TARGET, Level::WARN, "{}", render(event, fields));
}

/// Detail for a live investigation — off by default (see [`DEFAULT_FILTER`]).
/// The line is not even rendered unless something is listening at `debug`,
/// because this fires on paths that run per tool call.
pub fn debug(event: &'static str, fields: &[(&'static str, Val)]) {
    if tracing::level_filters::LevelFilter::current() < Level::DEBUG {
        return;
    }
    tracing::event!(target: TARGET, Level::DEBUG, "{}", render(event, fields));
}

/// The run/chat this event belongs to, as leading fields.
///
/// Identity comes from [`crate::turn::TurnId`] — the same `run_id` the frontend
/// minted, the sidecar echoes on every NDJSON line and `/cancel` addresses — so
/// a log line, a UI event and a sidecar traceback can be lined up by eye. A
/// caller with no turn (a headless workflow, a persistent bridge) says so with
/// `-`, exactly as the event envelope says so with a null id.
pub fn turn_fields(turn: Option<&crate::turn::TurnId>) -> [(&'static str, Val); 2] {
    match turn {
        Some(t) => [("run", id(t.run_id())), ("chat", id(t.chat_id()))],
        None => [("run", state("-")), ("chat", state("-"))],
    }
}

// -------------------------------------------------- the instrumented decisions

/// The tool catalog one engine was actually served. THE event this module was
/// ordered for: an engine handed an empty bridge rationalises instead of
/// reporting it, so the count and the names have to exist somewhere the model
/// cannot narrate over.
pub fn tool_catalog(scope: &'static str, names: &[String], turn: Option<&crate::turn::TurnId>) {
    let [run, chat] = turn_fields(turn);
    info(
        "tools.catalog",
        &[
            run,
            chat,
            ("scope", state(scope)),
            ("served", count(names.len())),
            ("names", ids(names)),
        ],
    );
}

/// One tool call, at `debug` — the per-call detail you turn on for a live
/// investigation and never ship enabled.
///
/// The tool's NAME and verdict only. Its arguments are room content by
/// definition (a filename to open, a passage to write, a query about the user's
/// own documents), so there is no parameter here for them to arrive through.
pub fn tool_dispatched(
    scope: &'static str,
    tool: &str,
    is_error: bool,
    result_bytes: usize,
    turn: Option<&crate::turn::TurnId>,
) {
    let [run, chat] = turn_fields(turn);
    debug(
        "tools.call",
        &[
            run,
            chat,
            ("scope", state(scope)),
            ("tool", id(tool)),
            ("error", flag(is_error)),
            ("resultBytes", bytes(result_bytes)),
        ],
    );
}

/// A sidecar run beginning: who it is, which engine it picked, what the bridge
/// tier is, and how big the request was. Sizes and counts only — the question
/// and the history are room content.
#[allow(clippy::too_many_arguments)]
pub fn run_start(
    turn: Option<&crate::turn::TurnId>,
    model_id: &str,
    engine: &'static str,
    scope: &'static str,
    web_enabled: bool,
    headless: bool,
    advisors: usize,
    history: usize,
    question_bytes: usize,
) {
    let [run, chat] = turn_fields(turn);
    info(
        "sidecar.run.start",
        &[
            run,
            chat,
            ("model", model(model_id)),
            ("engine", state(engine)),
            ("scope", state(scope)),
            ("web", flag(web_enabled)),
            ("headless", flag(headless)),
            ("advisors", count(advisors)),
            ("history", count(history)),
            ("questionBytes", bytes(question_bytes)),
        ],
    );
}

/// How a sidecar run landed. `outcome` is a `&'static str` off
/// [`crate::sidecar::SidecarOutcome`], so "done" can never be printed for a
/// run that failed.
pub fn run_end(
    turn: Option<&crate::turn::TurnId>,
    outcome: &'static str,
    elapsed: std::time::Duration,
    text_bytes: usize,
    error: Option<&str>,
) {
    let [run, chat] = turn_fields(turn);
    info(
        "sidecar.run.end",
        &[
            run,
            chat,
            ("outcome", state(outcome)),
            ("ms", ms(elapsed)),
            ("textBytes", bytes(text_bytes)),
            ("err", err_kind(error.unwrap_or(""))),
            // The message's SIZE, since its text cannot travel: a 12-byte
            // "no key" and a 4 KB provider refusal are different failures.
            ("errBytes", bytes(error.map_or(0, str::len))),
        ],
    );
}

/// Stop pressed. `known` is the honest half: a Stop for a run the host no
/// longer has a flag for stopped nothing, and that is exactly the case that
/// used to look identical to a Stop that worked.
pub fn cancel_requested(run_id: &str, known: bool) {
    info(
        "cancel.requested",
        &[("run", id(run_id)), ("known", flag(known))],
    );
}

/// How much one Stop reached: the run plus everything it had started
/// (`crate::cancel`). A count, never a label — the labels name the user's own
/// artifacts. `0` is the interesting one: a known run whose whole subtree was
/// already stopped, i.e. a Stop that changed nothing.
pub fn cancel_subtree(run_id: &str, stopped: usize) {
    info(
        "cancel.subtree",
        &[("run", id(run_id)), ("stopped", count(stopped))],
    );
}

/// Whether the sidecar ACCEPTED the Stop, and how long that took. A refused or
/// unrecognised Stop is a `warn`: the run may still be spending the model slot.
pub fn cancel_delivered(
    run_id: &str,
    elapsed: std::time::Duration,
    outcome: Result<(), &str>,
) {
    match outcome {
        Ok(()) => info(
            "cancel.delivered",
            &[("run", id(run_id)), ("ms", ms(elapsed))],
        ),
        Err(e) => warn(
            "cancel.refused",
            &[
                ("run", id(run_id)),
                ("ms", ms(elapsed)),
                ("err", err_kind(e)),
            ],
        ),
    }
}

/// Every status a job row moves to. The DB write is the single choke point, so
/// this is the complete transition history for a run — which is what makes a
/// job that "just stopped" answerable.
pub const JOB_STATES: &[&str] = &["queued", "running", "paused", "done", "error", "cancelled"];

pub fn job_status(job_id: &str, to: &str, error: Option<&str>) {
    info(
        "job.status",
        &[
            ("job", id(job_id)),
            ("to", one_of(to, JOB_STATES)),
            ("err", err_kind(error.unwrap_or(""))),
        ],
    );
}

// ------------------------------------------------------------- the affordance

/// Reveal the folder holding both logs (`arcelle-host.log` and
/// `arcelle-sidecar.log`) in Finder, and return its path so the UI can show it.
///
/// Done from Rust rather than the JS opener API on purpose: the window
/// capability grants `opener` only for `x-apple.systempreferences:` URLs, and
/// widening it to arbitrary paths for one button would hand the whole frontend
/// a file-reveal primitive.
#[tauri::command]
pub fn reveal_logs(app: tauri::AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = log_dir();
    // Reveal the host log itself when it exists — Finder then selects the file
    // rather than dropping the user in a folder of unrelated temp items.
    let target = if log_path().exists() {
        log_path()
    } else {
        dir.clone()
    };
    app.opener()
        .reveal_item_in_dir(&target)
        .map_err(|e| format!("The logs folder could not be opened: {e}"))?;
    Ok(dir.to_string_lossy().to_string())
}

// ------------------------------------------------------------------- testing

/// Run `f` with a subscriber that captures this module's events, and return
/// what was written. Test-only, and deliberately thread-local (`with_default`),
/// so suites stay parallel and no test can install the global subscriber.
#[cfg(test)]
pub(crate) fn capture<T>(f: impl FnOnce() -> T) -> (T, String) {
    let (sub, buf) = test_subscriber();
    let out = tracing::subscriber::with_default(sub, f);
    (out, drain(&buf))
}

/// [`capture`] for an async body. A thread-local dispatcher does not survive an
/// await that moves the future to another worker, so this ATTACHES the
/// subscriber to the future itself.
#[cfg(test)]
pub(crate) async fn capture_async<T>(f: impl std::future::Future<Output = T>) -> (T, String) {
    use tracing::instrument::WithSubscriber;
    let (sub, buf) = test_subscriber();
    let out = f.with_subscriber(sub).await;
    (out, drain(&buf))
}

#[cfg(test)]
type TestBuf = Arc<Mutex<Vec<u8>>>;

#[cfg(test)]
fn drain(buf: &TestBuf) -> String {
    String::from_utf8_lossy(&buf.lock().unwrap()).to_string()
}

#[cfg(test)]
fn test_subscriber() -> (impl tracing::Subscriber + Send + Sync, TestBuf) {
    use tracing_subscriber::layer::SubscriberExt;

    #[derive(Clone)]
    struct Buf(TestBuf);
    struct BufGuard(TestBuf);
    impl Write for BufGuard {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Buf {
        type Writer = BufGuard;
        fn make_writer(&'a self) -> Self::Writer {
            BufGuard(self.0.clone())
        }
    }

    let buf: TestBuf = Arc::new(Mutex::new(Vec::new()));
    let sub = tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(false)
                .with_writer(Buf(buf.clone())),
        )
        // OUR target only, exactly as the shipped filter does. Without this a
        // test that runs an HTTP client captures hyper's TRACE stream, and an
        // assertion like `contains("WARN")` starts passing for the wrong reason.
        // TRACE rather than INFO so `debug` events are testable too.
        .with(
            tracing_subscriber::filter::Targets::new()
                .with_target(TARGET, tracing::level_filters::LevelFilter::TRACE),
        );
    (sub, buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Values a room really does hold. Every one of these must be impossible to
    /// get into the log through any helper this module exposes.
    const ROOM_CONTENT: &[&str] = &[
        "Q3 board minutes.pdf",
        "diary.pdf",
        "/Users/ben/Documents/Divorce settlement.docx",
        "Dear Sarah, I've decided to leave the company",
        "sk-ant-api03-REALKEYMATERIAL",
        "לקוחות פרטיים.xlsx",
        "https://example.com/private/doc?token=abc123",
    ];

    #[test]
    fn room_content_cannot_reach_the_log_through_any_helper() {
        for secret in ROOM_CONTENT {
            // Every dynamic-string entry point, in one line.
            let line = render(
                "probe",
                &[
                    ("a", id(secret)),
                    ("b", model(secret)),
                    ("c", one_of(secret, JOB_STATES)),
                    ("d", err_kind(secret)),
                    ("e", ids(&[*secret])),
                ],
            );
            for word in secret.split_whitespace() {
                // Whole-token containment: "settlement.docx" appearing anywhere
                // in the line is a leak even if the path around it was stripped.
                if word.len() > 3 {
                    assert!(
                        !line.contains(word),
                        "{word:?} from {secret:?} leaked into {line:?}"
                    );
                }
            }
            assert!(
                !line.contains(*secret),
                "{secret:?} leaked whole into {line:?}"
            );
        }
    }

    #[test]
    fn room_content_cannot_reach_the_log_through_the_real_emit_path() {
        // The test above checks the renderer. This one goes through
        // `tracing::event!` and a real fmt layer, so a future change that
        // formats fields some other way is still caught.
        let secret = "Divorce settlement.docx";
        let (_, out) = capture(|| {
            job_status(secret, secret, Some(secret));
            run_end(None, "failed", std::time::Duration::from_millis(3), 12, Some(secret));
            tool_catalog("LocalEngine", &[secret.to_string()], None);
        });
        assert!(!out.is_empty(), "the capture subscriber recorded nothing");
        assert!(!out.contains("Divorce"), "leaked into {out:?}");
        assert!(!out.contains("settlement"), "leaked into {out:?}");
        assert!(!out.contains(".docx"), "leaked into {out:?}");
        // …and the event still SAYS something: a scrubbed log that logs nothing
        // is the same blindness this module exists to end.
        assert!(out.contains("job.status"), "{out:?}");
        assert!(out.contains(UNLOGGABLE), "{out:?}");
        assert!(out.contains(UNEXPECTED), "{out:?}");
    }

    #[test]
    fn a_handle_shaped_id_survives_and_anything_else_does_not() {
        // Compared through `Display`, because that is the only way to read a
        // `Val` from outside its constructors — which is the point of the type.
        assert_eq!(id("9f2c4a1b7e0d4f3a").to_string(), "9f2c4a1b7e0d4f3a");
        assert_eq!(id("ask-17_2").to_string(), "ask-17_2");
        assert_eq!(id("browse_open").to_string(), "browse_open");
        // The near misses that matter: a dotted filename, a space, a path,
        // something long enough to be a payload rather than a handle, and a
        // credential (shape-identical to a handle, hence the prefix list).
        for bad in [
            "diary.pdf",
            "my notes",
            "/tmp/x",
            "",
            &"a".repeat(65),
            "sk-ant-api03-REALKEYMATERIAL",
            "ghp_0123456789abcdef",
        ] {
            assert_eq!(id(bad).to_string(), UNLOGGABLE, "{bad:?} got through");
        }
    }

    #[test]
    fn a_model_id_survives_but_a_path_or_a_sentence_does_not() {
        for good in [
            "qwen3.5:4b",
            "anthropic/claude-opus-4",
            "codex-cli:gpt-5",
            "gpt-oss:120b-cloud",
        ] {
            assert_eq!(model(good).to_string(), *good, "{good:?} was refused");
        }
        for bad in [
            "/Users/ben/model.gguf",
            "../secrets",
            "Q3 board minutes.pdf",
            ".hidden",
            "~/Downloads/x",
            // The near miss the boundary test caught: filename-shaped, but with
            // none of the giveaways (no space, no slash, no leading dot).
            "diary.pdf",
            "notes.md",
        ] {
            assert_eq!(model(bad).to_string(), UNLOGGABLE, "{bad:?} got through");
        }
    }

    #[test]
    fn an_error_keeps_its_kind_and_loses_its_text_entirely() {
        for (msg, kind) in [
            (
                "failed to read /Users/ben/Diary.pdf: No such file or directory (os error 2)",
                "not_found",
            ),
            (
                "error sending request for url (https://api.example.com/v1/chat): connection refused",
                "network",
            ),
            ("the AI service refused the Stop (status 503)", "upstream_error"),
            ("Read timed out after 30s", "timeout"),
            ("no api key for this provider", "no_credential"),
            ("", "none"),
            ("Q3 board minutes.pdf", "other"),
        ] {
            assert_eq!(err_kind(msg).to_string(), kind, "for {msg:?}");
        }
        // Whatever comes in, what comes out is one of a fixed list of literals —
        // that is the whole guarantee.
        for msg in ROOM_CONTENT {
            let k = err_kind(msg).to_string();
            assert!(ERR_KINDS.contains(&k.as_str()), "{k:?} is not a kind");
        }
    }

    #[test]
    fn a_whitelist_is_the_only_way_a_runtime_string_becomes_a_state() {
        assert_eq!(one_of("running", JOB_STATES).to_string(), "running");
        assert_eq!(one_of("Running", JOB_STATES).to_string(), UNEXPECTED);
        assert_eq!(one_of("", JOB_STATES).to_string(), UNEXPECTED);
    }

    #[test]
    fn every_event_names_the_run_and_chat_it_belongs_to() {
        let turn = crate::turn::TurnId::new("run17", "chatA");
        let (_, out) = capture(|| {
            run_start(Some(&turn), "qwen3.5:4b", "ollama", "LocalEngine", true, false, 1, 9, 40);
            tool_catalog("LocalEngine", &["browse_open".into(), "save_file".into()], Some(&turn));
        });
        assert!(out.contains("run=run17 chat=chatA"), "{out:?}");
        assert!(out.contains("served=2"), "{out:?}");
        assert!(out.contains("names=[browse_open save_file]"), "{out:?}");
        assert!(out.contains("model=qwen3.5:4b"), "{out:?}");
        // A turn-less caller says so rather than borrowing an owner — same rule
        // the event envelope follows.
        let (_, out) = capture(|| tool_catalog("CloudEngine", &[], None));
        assert!(out.contains("run=- chat=-"), "{out:?}");
        assert!(out.contains("served=0"), "{out:?}");
    }

    #[test]
    fn a_refused_stop_is_a_warning_and_an_accepted_one_is_not() {
        let (_, out) = capture(|| {
            cancel_requested("run17", true);
            cancel_delivered("run17", std::time::Duration::from_millis(12), Ok(()));
            cancel_delivered(
                "run18",
                std::time::Duration::from_millis(3100),
                Err("the AI service did not recognise the run"),
            );
        });
        assert!(out.contains("cancel.requested run=run17 known=true"), "{out:?}");
        assert!(out.contains("cancel.delivered run=run17 ms=12"), "{out:?}");
        assert!(out.contains("cancel.refused"), "{out:?}");
        assert!(out.contains("WARN"), "a refused Stop must not read as routine: {out:?}");
        // A Stop for a run the host no longer knows must say so.
        let (_, out) = capture(|| cancel_requested("gone", false));
        assert!(out.contains("known=false"), "{out:?}");
    }

    #[test]
    fn the_log_rotates_instead_of_growing_without_bound() {
        let dir = std::env::temp_dir().join(format!("arcelle-obs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("h.log");
        let prev = dir.join("h.prev.log");
        let mut sink = Sink::new(path.clone(), prev.clone());
        let chunk = vec![b'x'; 64 * 1024];
        // Enough to cross MAX_LOG_BYTES at least twice.
        for _ in 0..(2 * MAX_LOG_BYTES / chunk.len() as u64 + 4) {
            sink.write_all(&chunk).unwrap();
        }
        sink.flush().unwrap();
        let live = std::fs::metadata(&path).unwrap().len();
        assert!(live <= MAX_LOG_BYTES, "live log grew to {live}");
        assert!(prev.exists(), "the previous generation was destroyed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn per_call_detail_is_off_until_it_is_asked_for() {
        // `tools.call` fires on every tool a turn makes, so shipping it enabled
        // would bury the decisions the file exists for. It must be reachable,
        // and it must be silent at the shipped level.
        let (_, out) = capture(|| tool_dispatched("LocalEngine", "open_file", true, 0, None));
        assert!(out.contains("tools.call"), "{out:?}");
        assert!(out.contains("tool=open_file error=true"), "{out:?}");

        // The shipped filter admits `info` and nothing finer.
        let shipped: tracing_subscriber::filter::Targets = DEFAULT_FILTER.parse().unwrap();
        assert!(!shipped.would_enable(TARGET, &Level::DEBUG));
        assert!(shipped.would_enable(TARGET, &Level::INFO));
    }

    #[test]
    fn the_default_filter_is_quiet_enough_to_ship() {
        let t: tracing_subscriber::filter::Targets = DEFAULT_FILTER.parse().unwrap();
        // Our own events at info…
        assert_eq!(t.iter().count(), 1);
        let (target, level) = t.iter().next().unwrap();
        assert_eq!(target, TARGET);
        assert_eq!(level, tracing::level_filters::LevelFilter::INFO);
        // …and nothing else, so a chatty dependency cannot bury the file.
        assert!(t.default_level().is_none());
    }

    #[test]
    fn a_log_level_nobody_can_parse_falls_back_instead_of_going_silent() {
        // The defect this closes: `Targets` PARSES almost anything. A stray
        // word, or `ARCELLE=debug` with the wrong case, becomes a filter for a
        // target of that literal name — it matches nothing we emit, so the host
        // log is 0 bytes and says nothing about why. That is the exact blindness
        // this module exists to end, reached by the most likely user action
        // there is: turning the logging up and mistyping it.
        let quiet = |t: &tracing_subscriber::filter::Targets| !t.would_enable(TARGET, &Level::ERROR);

        // Not set at all, and the shipped default.
        for req in [None, Some(DEFAULT_FILTER)] {
            let (t, ok) = filter_from(req);
            assert!(ok, "{req:?} should be honoured");
            assert!(t.would_enable(TARGET, &Level::INFO), "{req:?}");
        }

        // Values that CANNOT speak about us: honoured would mean silence.
        for bad in ["not a filter!!", "ARCELLE=debug", "somethingelse=trace", "arcelle=debag"] {
            let (t, ok) = filter_from(Some(bad));
            assert!(!ok, "{bad:?} was taken at face value");
            assert!(t.would_enable(TARGET, &Level::INFO), "{bad:?} silenced the log");
            assert!(!t.would_enable(TARGET, &Level::DEBUG), "{bad:?} did not land on the default");
        }

        // Values that genuinely do speak about us are obeyed — including the
        // explicit "be quiet", which is an answer rather than a mistake.
        for (good, debug_on) in [("arcelle=debug", true), ("trace", true), ("warn,arcelle=debug", true)] {
            let (t, ok) = filter_from(Some(good));
            assert!(ok, "{good:?} was overridden");
            assert_eq!(t.would_enable(TARGET, &Level::DEBUG), debug_on, "{good:?}");
        }
        let (off, ok) = filter_from(Some("arcelle=off"));
        assert!(ok, "an explicit off is a real request, not a typo");
        assert!(quiet(&off), "arcelle=off must actually be off");
    }

    #[test]
    fn both_logs_live_in_one_folder_a_user_can_be_pointed_at() {
        assert_eq!(
            log_path().parent(),
            crate::sidecar_lifecycle::stderr_log_path().parent()
        );
        assert_eq!(log_path().parent(), Some(log_dir().as_path()));
        assert_ne!(log_path(), previous_log_path());
        assert!(log_path().to_string_lossy().ends_with("arcelle-host.log"));
    }
}
