/**
 * Deterministic keyword routers deciding which OPTIONAL tool groups a turn
 * includes, plus the small save-turn heuristics they lean on.
 *
 * Ported verbatim from `src-tauri/src/commands/agent.rs` (`wants_write_tools`,
 * `is_bare_save_reference`, `is_pure_save_reference`, `requested_file_name`,
 * `wants_skill_tools`, `wants_mcp_management_tools`, `wants_ui_tools`,
 * `wants_job_tools`, `find_ci`). Every hint list is copied character for
 * character, Hebrew included — these are plain substring tests over a
 * lower-cased question, not NLP, and the doctrine throughout is "err toward
 * YES": a false positive costs a few unused tool schemas in context, a false
 * negative is a capability the model silently never had.
 */

/// Keyword router for WRITE intent. Ported verbatim from `wants_write_tools`.
export function wantsWriteTools(question: string): boolean {
  const q = question.toLowerCase();
  const HINTS = [
    "edit", "change", "replace", "fix", "update", "rewrite", "write ", "add ",
    "create", "make ", "new file", "save", "delete", "remove", "set ", "fill",
    "insert", "append", "rename", "correct", "remember", "note ", "jot", "record",
    "translate", "highlight", "mark ", "annotate", "draft", "generate",
    "move ", "rename", "organize", "organise", "put ", "folder", "sort ", "tidy",
    // Hebrew (substring matchers see no word boundaries, so stems suffice):
    "ערוך", "עריכה", "שנה", "תקן", "עדכן", "כתוב", "צור ", "שמור", "שמרי",
    "מחק", "הוסף", "תרגם", "סמן", "זכור", "תזכור", "רשום", "העבר", "תיקיה",
    "תיקייה", "טיוטה", "קובץ חדש",
  ];
  return HINTS.some((h) => q.includes(h));
}

/**
 * Detects a short save/record turn whose object is a bare reference ("that",
 * "this", "it", "זה") rather than inline content. Ported verbatim from
 * `is_bare_save_reference`.
 */
export function isBareSaveReference(question: string): boolean {
  const q = question.toLowerCase();
  // Long turns carry their own content — the reference is not bare. Counted
  // in Unicode CODE POINTS (`[...q].length`), matching Rust's `chars().count()`
  // rather than JS's UTF-16-code-unit `.length`.
  if ([...q].length > 160) {
    return false;
  }
  const VERBS = [
    "save", "keep ", "record", "write that", "write this", "write it",
    "note that", "note this", "jot", "שמור", "שמרי", "תשמור", "רשום", "רשמי",
  ];
  const REFERENTS = [
    "that", "this", "it ", " it", "the above", "your answer", "your reply",
    "your summary", "זה", "זאת", "את זה", "התשובה",
  ];
  return VERBS.some((v) => q.includes(v)) && REFERENTS.some((r) => q.includes(r));
}

/** The markers that introduce an explicit file name in a save turn. Ported
 * verbatim from `NAME_MARKERS`. */
const NAME_MARKERS: readonly string[] = ["called ", "named ", "titled ", "as file ", "בשם "];

/**
 * Case-insensitive substring search returning `[start, end)` INDEXES into the
 * ORIGINAL `haystack`, measured in UTF-16 code units (JS string indexing's
 * native unit — the direct analogue of the Rust source's BYTE offsets into
 * the original `&str`, for the same reason: lower-casing is not
 * length-preserving in either representation, so comparing slice-by-slice
 * against the original keeps every offset valid for a later `haystack.slice`
 * rather than pointing into the lower-cased copy).
 *
 * Ported from `find_ci`, iterating substrings by Unicode SCALAR VALUE
 * (`[...haystack]`) rather than raw UTF-16 units so a needle is matched
 * against whole characters, matching Rust's `char_indices()` — a surrogate
 * pair must not be split mid-codepoint any more than a multi-byte UTF-8
 * sequence may.
 */
function findCi(haystack: string, needleLower: string): [number, number] | null {
  const n = [...needleLower].length;
  // Code-point boundaries as UTF-16 indexes into `haystack`, plus the final
  // end-of-string boundary — the JS analogue of Rust's `char_indices()` +
  // `haystack.len()`. `idx[k]` is where the k-th CODE POINT starts, so a
  // surrogate pair is never split mid-character the way plain UTF-16 index
  // arithmetic (`haystack[i]`) could split one.
  const points = [...haystack];
  const idx: number[] = [0];
  for (const ch of points) {
    idx.push(idx[idx.length - 1]! + ch.length);
  }
  for (let k = 0; k + n <= points.length; k++) {
    const start = idx[k]!;
    const end = idx[k + n]!;
    if (haystack.slice(start, end).toLowerCase() === needleLower) {
      return [start, end];
    }
  }
  return null;
}

/**
 * Live-QA round 2: for a deterministic intent the model gets no vote — a PURE
 * save-that turn is executed by code. Ported verbatim from
 * `is_pure_save_reference`, ALLOW-LIST included.
 */
export function isPureSaveReference(question: string): boolean {
  if (!isBareSaveReference(question)) {
    return false;
  }
  // NOT a stop-at-first-match loop: every marker is tried in turn against
  // whatever `body` currently is, so a SECOND marker earlier in the text can
  // still shorten it further after the first one already cut it once. Mirrors
  // Rust's `for marker in NAME_MARKERS { if let Some(...) = find_ci(body,
  // marker) { body = &body[..start]; } }` exactly — no `break`.
  let body = question.trim();
  for (const marker of NAME_MARKERS) {
    const hit = findCi(body, marker.toLowerCase());
    if (hit !== null) {
      body = body.slice(0, hit[0]);
    }
  }
  // Save verbs, referents, and the filler that legitimately joins them.
  const ALLOWED = new Set([
    // verbs
    "save", "saves", "saved", "keep", "store", "record", "write", "jot",
    "note", "put", "add",
    // referents
    "that", "this", "it", "above", "answer", "reply", "response", "message",
    "text", "output", "last", "previous", "your",
    // filler
    "a", "an", "the", "as", "to", "in", "into", "on", "of", "for", "my",
    "our", "please", "down", "here", "just", "new", "file", "files",
    "document", "doc", "note's", "notes", "room", "library", "somewhere",
    // Hebrew equivalents
    "שמור", "שמרי", "תשמור", "רשום", "רשמי", "זה", "זאת", "את", "קובץ",
    "כקובץ", "חדש", "בחדר", "התשובה", "בבקשה", "לקובץ", "אותו",
  ]);
  const words = body
    .split(/[\s,;:]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "").toLowerCase())
    .filter((w) => w.length > 0);
  return words.every((w) => ALLOWED.has(w));
}

/**
 * "…called Summary" / "…named Q3 notes" / "…בשם סיכום" → the requested file
 * name, if the save turn carries one. Ported verbatim from
 * `requested_file_name`.
 */
export function requestedFileName(question: string): string | null {
  const q = question.trim();
  for (const marker of NAME_MARKERS) {
    const hit = findCi(q, marker.toLowerCase());
    if (hit !== null) {
      const end = hit[1];
      let name = q.slice(end).trim();
      // Strip a single layer of surrounding quote marks, then trailing
      // sentence punctuation — mirrors Rust's `trim_matches`/`trim_end_matches`.
      name = name.replace(/^["'“”„]+|["'“”„]+$/g, "");
      name = name.replace(/[.!?]+$/, "");
      name = name.trim();
      if (name.length > 0 && [...name].length <= 80) {
        return name;
      }
    }
  }
  return null;
}

/** Skill management router. Ported verbatim from `wants_skill_tools`. */
export function wantsSkillTools(question: string): boolean {
  const q = question.toLowerCase();
  const HINTS = ["skill", "agent instruction", "מיומנות", "סקיל"];
  return HINTS.some((hint) => q.includes(hint));
}

/** Connector management router. Ported verbatim from
 * `wants_mcp_management_tools`. */
export function wantsMcpManagementTools(question: string): boolean {
  const q = question.toLowerCase();
  const HINTS = [
    "mcp",
    "connector",
    "connectors",
    "integration",
    "integrations",
    "מחבר",
    "מחברים",
    "אינטגרצ",
  ];
  return HINTS.some((hint) => q.includes(hint));
}

/** App surfaces and navigation verbs. Ported verbatim from
 * `APP_NAVIGATION_VERBS`. */
const APP_NAVIGATION_VERBS: readonly string[] = [
  "open ", "show me", "go to", "switch", "close ", "map", "panel", "tab",
  "studio", "flashcard", "mind map", "mindmap", "podcast", "front page",
  "dashboard", "play", "pause", "image", "photo", "picture",
  "לחץ", "לחצי", "פתח", "פתחי", "הצג", "הציגי", "מסך", "צילום מסך", "גלול",
  "כפתור", "סרטון", "וידאו", "תמונה", "סגור", "עבור אל", "תפריט", "לוח",
];

/** ADD-25: keyword router for the UI/perception tools. Ported verbatim from
 * `wants_ui_tools`. */
export function wantsUiTools(question: string): boolean {
  const q = question.toLowerCase();
  const HINTS = [
    "click", "press ", "button", "screenshot", "screen", "scroll", "navigate",
    "menu", "sidebar", "watch", "frame", "video", "look at", "looking at",
    "interface", "use the app", "the app", "type in", "toggle", "what do you see",
    "what am i", "on screen",
  ];
  return HINTS.some((h) => q.includes(h)) || APP_NAVIGATION_VERBS.some((h) => q.includes(h));
}

/** ADD-32: keyword router for the whole-file pass tools. Ported verbatim from
 * `wants_job_tools`. */
export function wantsJobTools(question: string): boolean {
  const q = question.toLowerCase();
  const HINTS = [
    "whole", "entire", "entirely", "all of", "every ", "everything", "full",
    "fully", "complete", "completely", "cover", "thorough", "in depth",
    "in-depth", "translate", "book", "throughout", "end to end", "cover to cover",
    "start to finish", "page by page", "chapter", "long file", "large file",
    "big file", "deep", "job", "progress", "background", "pass", "digest",
    "no matter", "don't miss", "do not miss", "line by line",
    "workflow", "automate", "automat", "every morning", "every day", "every week",
    "each morning", "each day", "schedule", "recurring", "routine", "pipeline",
    "כל הקובץ", "הקובץ כולו", "כולו", "את כל", "הכל", "הספר", "יסודי", "מקיף",
    "לעומק", "ברקע", "משימת רקע", "תהליך", "אוטומצ", "אוטומט", "תזמן", "מתוזמן",
    "כל בוקר", "כל יום", "כל שבוע", "פרק אחר פרק", "שורה אחר שורה",
  ];
  return HINTS.some((h) => q.includes(h));
}
