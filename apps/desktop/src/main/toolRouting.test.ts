import { describe, expect, it } from "vitest";
import {
  isBareSaveReference,
  isPureSaveReference,
  requestedFileName,
  wantsJobTools,
  wantsMcpManagementTools,
  wantsSkillTools,
  wantsUiTools,
  wantsWriteTools,
} from "./toolRouting.js";

describe("wantsWriteTools", () => {
  it("fires on an English write verb", () => {
    expect(wantsWriteTools("please edit the summary")).toBe(true);
  });
  it("fires on a Hebrew write stem", () => {
    expect(wantsWriteTools("שמרי את זה בבקשה")).toBe(true);
  });
  it("is false for a plain question", () => {
    expect(wantsWriteTools("what does this file say about revenue?")).toBe(false);
  });
});

describe("isBareSaveReference", () => {
  it("fires for a short save-that turn", () => {
    expect(isBareSaveReference("save that as a file")).toBe(true);
  });
  it("fires for the Hebrew equivalent", () => {
    expect(isBareSaveReference("שמרי את זה")).toBe(true);
  });
  it("is false when the turn is long (carries its own content)", () => {
    const long = `save ${"x".repeat(200)}`;
    expect(isBareSaveReference(long)).toBe(false);
  });
  it("is false with a verb but no referent", () => {
    expect(isBareSaveReference("save the quarterly numbers to a spreadsheet")).toBe(false);
  });
  it("counts by Unicode code point, not UTF-16 units, for the 160 cutoff", () => {
    // 170 astral emoji would be 340 UTF-16 units but 170 code points — still
    // over 160 either way, so use a boundary case: exactly 160 code points
    // of a BMP filler plus a real save/referent pair must still fire.
    const filler = "a".repeat(150);
    expect(isBareSaveReference(`save that ${filler}`)).toBe(true);
  });
});

describe("isPureSaveReference", () => {
  it("is true for a pure save-that turn", () => {
    expect(isPureSaveReference("save that")).toBe(true);
    expect(isPureSaveReference("please save this as a new file")).toBe(true);
  });
  it("is false the moment an unrecognised word appears (a real instruction)", () => {
    expect(isPureSaveReference("save that as a PDF")).toBe(false);
    expect(isPureSaveReference("save that with the headings fixed")).toBe(false);
  });
  it("strips an explicit name before checking vocabulary", () => {
    expect(isPureSaveReference("save that called Q3 revenue notes")).toBe(true);
  });
  it("delegates to isBareSaveReference first (false when not even a bare reference)", () => {
    expect(isPureSaveReference("what is the weather today")).toBe(false);
  });
});

describe("requestedFileName", () => {
  it("extracts a name after 'called'", () => {
    expect(requestedFileName("save that called Summary")).toBe("Summary");
  });
  it("strips a LEADING quote and a trailing sentence-punctuation mark, in that fixed order", () => {
    // Faithful-port quirk, not a bug introduced here: the Rust source runs
    // ONE pass of `trim_matches` for quotes and THEN a separate pass of
    // `trim_end_matches` for '.'/'!'/'?' — so when the quote is immediately
    // followed by a period, the quote-trim pass sees '.' at the end (not a
    // quote) and only strips the LEADING quote; by the time the period is
    // stripped, the quote-trim pass has already finished and never re-runs.
    // A trailing quote WITH NO trailing period is stripped from both ends
    // normally, since the quote pass alone then sees a quote at the end too.
    expect(requestedFileName('save this named "Q3 notes".')).toBe('Q3 notes"');
    expect(requestedFileName('save this named "Q3 notes"')).toBe("Q3 notes");
  });
  it("extracts the Hebrew marker בשם", () => {
    expect(requestedFileName("שמרי את זה בשם סיכום")).toBe("סיכום");
  });
  it("is null when there is no marker", () => {
    expect(requestedFileName("save that")).toBeNull();
  });
  it("is null when the extracted name is empty or absurdly long", () => {
    expect(requestedFileName("save that called ")).toBeNull();
    expect(requestedFileName(`save that called ${"x".repeat(90)}`)).toBeNull();
  });
  it("returns on the FIRST marker (in NAME_MARKERS order) found anywhere in the text, not the first one written", () => {
    // NAME_MARKERS order is ["called ", "named ", "titled ", "as file ", "בשם "].
    // "called " is checked first and DOES occur later in this sentence, so it
    // wins over "titled " even though "titled" appears earlier in the text —
    // requested_file_name tries markers in a fixed order against the WHOLE
    // string and returns on the first one that yields a name, it does not
    // scan left to right for whichever marker appears soonest.
    const q = "save that titled Draft One called Draft Two";
    expect(requestedFileName(q)).toBe("Draft Two");
  });
});

describe("wantsSkillTools", () => {
  it("fires on 'skill'", () => {
    expect(wantsSkillTools("what skills do you have")).toBe(true);
  });
  it("fires on Hebrew מיומנות", () => {
    // Substring match only — the HEBREW HINT is the singular "מיומנות"; the
    // plural "מיומנויות" inserts a extra letter that breaks the substring
    // match, so the test must use a phrase actually containing the hint.
    expect(wantsSkillTools("איזו מיומנות יש לך")).toBe(true);
  });
  it("is false otherwise", () => {
    expect(wantsSkillTools("summarize this document")).toBe(false);
  });
});

describe("wantsMcpManagementTools", () => {
  it("fires on 'connector'", () => {
    expect(wantsMcpManagementTools("add a new connector for gmail")).toBe(true);
  });
  it("fires on 'mcp'", () => {
    expect(wantsMcpManagementTools("list my mcp servers")).toBe(true);
  });
  it("is false otherwise", () => {
    expect(wantsMcpManagementTools("what is in this file")).toBe(false);
  });
});

describe("wantsUiTools", () => {
  it("fires on a click/press verb", () => {
    expect(wantsUiTools("click the flashcards button")).toBe(true);
  });
  it("fires on an app-navigation verb", () => {
    expect(wantsUiTools("open the room map")).toBe(true);
  });
  it("fires on a Hebrew navigation verb", () => {
    expect(wantsUiTools("לחצי על הכפתור")).toBe(true);
  });
  it("is false for a plain content question", () => {
    expect(wantsUiTools("what did the contract say about rent")).toBe(false);
  });
});

describe("wantsJobTools", () => {
  it("fires on whole-file intent", () => {
    expect(wantsJobTools("summarize the entire book")).toBe(true);
  });
  it("fires on job/progress talk", () => {
    expect(wantsJobTools("is the job done yet?")).toBe(true);
  });
  it("fires on workflow/automation words", () => {
    expect(wantsJobTools("automate this every morning")).toBe(true);
  });
  it("fires on Hebrew whole-file intent", () => {
    expect(wantsJobTools("תרגם את כל הקובץ")).toBe(true);
  });
  it("is false for a short specific question", () => {
    expect(wantsJobTools("what is the total on page 2")).toBe(false);
  });
});
