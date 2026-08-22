/**
 * Tests for `turnContext.ts` — the pure half of a chat turn, pinned against
 * the Rust source's own `#[cfg(test)]` fixtures wherever they exist
 * (`agent.rs`'s save-reference, skill-advertisement and style tests,
 * `vision.rs`'s locate-intent table, `models.rs`'s `best_default` cases).
 */

import { describe, expect, it } from "vitest";
import {
  BASE_SYSTEM_PROMPT,
  DEFAULT_MODEL,
  advertiseSkills,
  bestDefault,
  buildSystemPrompt,
  explicitSkillRequest,
  handoffBudgetBytes,
  historyBudgetBytes,
  isBareSaveReference,
  isCliEngine,
  isEmbeddingModel,
  isExternalEngine,
  isImage,
  isLocateIntent,
  isPureSaveReference,
  passthroughPrepareImage,
  pixelsReachChatModel,
  requestedFileName,
  roleInstructions,
  splitExternalModel,
  stripStoppedSuffix,
  styleBlock,
  styleParagraph,
} from "./turnContext.js";

// ---------------------------------------------------------- slash skills

describe("explicitSkillRequest", () => {
  it("extracts the selected skill and the request text", () => {
    expect(explicitSkillRequest("/lease-review check the termination clause")).toEqual({
      name: "lease-review",
      request: "check the termination clause",
    });
    expect(explicitSkillRequest("  /lease-review   check this  ")).toEqual({
      name: "lease-review",
      request: "check this",
    });
    expect(explicitSkillRequest("/lease-review")).toEqual({ name: "lease-review", request: "" });
  });

  it("is null for anything that is not a leading, well-formed /name", () => {
    expect(explicitSkillRequest("summarize /lease-review")).toBeNull();
    expect(explicitSkillRequest("/not_valid do it")).toBeNull();
    expect(explicitSkillRequest("/UPPER do it")).toBeNull();
    expect(explicitSkillRequest("/")).toBeNull();
    expect(explicitSkillRequest(`/${"x".repeat(65)} go`)).toBeNull();
  });
});

// ------------------------------------------------------- save-that-as-a-file

describe("isPureSaveReference / isBareSaveReference / requestedFileName", () => {
  it("pure save references bypass the model", () => {
    expect(isPureSaveReference("save that as a new file called Summary")).toBe(true);
    expect(isPureSaveReference("save this to the room")).toBe(true);
    expect(isPureSaveReference("שמור את זה כקובץ בשם סיכום")).toBe(true);
    expect(isPureSaveReference("keep it as a note")).toBe(true);
    expect(isPureSaveReference("Save this, please.")).toBe(true);
    // A file NAME must not read as a transform verb.
    expect(isPureSaveReference("save this as a file called translate the shorter version")).toBe(true);
  });

  it("a qualified save is the model's job, not the bypass's", () => {
    for (const q of [
      "save that translated to Hebrew",
      "save this but shorten it first",
      "save it without the code blocks",
      "save this as a PDF",
      "save this in a table format",
      "save that with the headings fixed",
      "save that as bullet points",
      "save it in Hebrew",
      "save this and email it to Dana",
      "save that minus the intro",
    ]) {
      expect(isBareSaveReference(q)).toBe(true);
      expect(isPureSaveReference(q)).toBe(false);
    }
  });

  it("bare save references are detected, and a long one is not", () => {
    expect(isBareSaveReference("save that as a new file called Summary")).toBe(true);
    expect(isBareSaveReference("Save this to the room")).toBe(true);
    expect(isBareSaveReference("keep it as a note")).toBe(true);
    expect(isBareSaveReference("record your answer in a file")).toBe(true);
    expect(isBareSaveReference("שמור את זה כקובץ חדש")).toBe(true);
    expect(isBareSaveReference("save the quarterly report file")).toBe(false);
    expect(isBareSaveReference("what does the contract say about rent")).toBe(false);
    expect(isBareSaveReference(`save this: ${"x".repeat(200)}`)).toBe(false);
  });

  it("requested file names are extracted", () => {
    expect(requestedFileName("save that as a new file called Summary")).toBe("Summary");
    expect(requestedFileName('keep it, named "Q3 notes"')).toBe("Q3 notes");
    expect(requestedFileName("שמור את זה בשם סיכום הפרויקט")).toBe("סיכום הפרויקט");
    expect(requestedFileName("save that to the room")).toBeNull();
  });

  it("a lowercase-LENGTHENING char does not shift the cut (find_ci offsets the ORIGINAL)", () => {
    const tricky = "save that İcalled Report";
    expect(tricky.toLowerCase().length).toBeGreaterThan(tricky.length);
    expect(requestedFileName(tricky)).toBe("Report");
  });

  it("strips every repetition of the stopped suffix, as trim_end_matches does", () => {
    expect(stripStoppedSuffix("partial *(stopped)*")).toBe("partial");
    expect(stripStoppedSuffix("partial *(stopped)* *(stopped)*")).toBe("partial");
    expect(stripStoppedSuffix("a finished answer")).toBe("a finished answer");
  });
});

// ------------------------------------------------------------ advertiseSkills

describe("advertiseSkills", () => {
  it("no skills, no preamble", () => {
    expect(advertiseSkills([])).toBe("");
  });

  it("a cut description says it was cut and stays small", () => {
    const one = advertiseSkills([["planner", "x".repeat(2_000)]]);
    expect(one).toContain("- planner: ");
    expect(one).toContain("…");
    expect(one.length).toBeLessThan(500);
  });

  it("caps the count and says how many more there are", () => {
    const many: Array<[string, string]> = Array.from({ length: 40 }, () => ["s", "d"]);
    const all = advertiseSkills(many);
    expect((all.match(/- s: d\n/g) ?? []).length).toBe(12);
    expect(all).toContain(`${40 - 12} more enabled skills`);

    const exact: Array<[string, string]> = Array.from({ length: 12 }, () => ["s", "d"]);
    expect(advertiseSkills(exact)).not.toContain("more enabled skills");
  });
});

// -------------------------------------------------------- personas & style

describe("roleInstructions", () => {
  it("returns persona instructions, or empty for default/unknown", () => {
    expect(roleInstructions("tutor")).toContain("patient tutor");
    expect(roleInstructions("opposing-counsel")).toContain("opposing counsel");
    expect(roleInstructions("default")).toBe("");
    expect(roleInstructions("no-such-role")).toBe("");
  });
});

describe("styleParagraph / styleBlock", () => {
  it("maps the three known styles", () => {
    expect(styleParagraph("terse")?.startsWith("Response style: TERSE.")).toBe(true);
    expect(styleParagraph("friendly")).toContain("briefly explain the why");
    expect(styleParagraph("formal")).toContain("short headings or numbered points");
  });

  it("nothing for absent/default/unknown/wrong-case", () => {
    expect(styleParagraph(null)).toBeNull();
    expect(styleParagraph("default")).toBeNull();
    expect(styleParagraph("")).toBeNull();
    expect(styleParagraph("TERSE")).toBeNull();
    expect(styleParagraph("shakespearean")).toBeNull();
  });

  it("appends the precedence sentence only alongside custom instructions", () => {
    expect(styleBlock("terse", false)).toBe(styleParagraph("terse"));
    const withCustom = styleBlock("terse", true)!;
    expect(withCustom.startsWith(styleParagraph("terse")!)).toBe(true);
    expect(withCustom.endsWith("follow the user's preferences.")).toBe(true);
    expect(styleBlock(null, true)).toBeNull();
  });
});

// ------------------------------------------------------ engines and models

describe("splitExternalModel / isCliEngine / isExternalEngine", () => {
  it("splits a picked cloud selection, most-specific last", () => {
    expect(splitExternalModel("codex-cli")).toEqual(["codex-cli", undefined, undefined]);
    expect(splitExternalModel("codex-cli::gpt-5.6-sol")).toEqual(["codex-cli", "gpt-5.6-sol", undefined]);
    expect(splitExternalModel("codex-cli::gpt-5.6-sol::high")).toEqual(["codex-cli", "gpt-5.6-sol", "high"]);
    expect(splitExternalModel("qwen3.5:4b")).toEqual(["qwen3.5:4b", undefined, undefined]);
  });

  it("only the two CLI-backed engines are CLI engines", () => {
    expect(isCliEngine("claude-cli")).toBe(true);
    expect(isCliEngine("codex-cli::gpt-5.6-sol")).toBe(true);
    expect(isCliEngine("openrouter::vendor/model")).toBe(false);
    expect(isCliEngine("qwen3.5:4b")).toBe(false);
  });

  it("all three non-local engines are external", () => {
    expect(isExternalEngine("claude-cli")).toBe(true);
    expect(isExternalEngine("codex-cli")).toBe(true);
    expect(isExternalEngine("openrouter::vendor/model")).toBe(true);
    expect(isExternalEngine("qwen3.5:4b")).toBe(false);
  });
});

describe("bestDefault / isEmbeddingModel", () => {
  it("never returns an embedding model", () => {
    expect(isEmbeddingModel("nomic-embed-text:latest")).toBe(true);
    expect(isEmbeddingModel("mxbai-embed-large")).toBe(true);
    expect(isEmbeddingModel("bge-m3")).toBe(true);
    expect(isEmbeddingModel("qwen3.5:9b")).toBe(false);
    expect(bestDefault(["nomic-embed-text:latest", "qwen3.5:9b"])).toBe("qwen3.5:9b");
  });

  it("the bare default name when nothing is installed", () => {
    expect(bestDefault([])).toBe(DEFAULT_MODEL);
  });

  it("the installed tag, exact match preferred over a build-suffixed one", () => {
    expect(bestDefault([`${DEFAULT_MODEL}-mlx`, DEFAULT_MODEL])).toBe(DEFAULT_MODEL);
    expect(bestDefault([`${DEFAULT_MODEL}-mlx`])).toBe(`${DEFAULT_MODEL}-mlx`);
  });
});

describe("isImage", () => {
  it("true only for an image/* mime", () => {
    expect(isImage("image/png")).toBe(true);
    expect(isImage("image/jpeg")).toBe(true);
    expect(isImage("text/plain")).toBe(false);
    expect(isImage("application/pdf")).toBe(false);
  });
});

describe("pixelsReachChatModel", () => {
  const local = { runsOnThisMac: () => true, privacyActive: () => false };
  const cloudDoorOpen = { runsOnThisMac: () => false, privacyActive: () => false };
  const cloudDoorOn = { runsOnThisMac: () => false, privacyActive: () => true };

  it("needs the engine's own capability first", () => {
    expect(pixelsReachChatModel("qwen3.5:4b", false, local)).toBe(false);
    expect(pixelsReachChatModel("qwen3.5:4b", true, local)).toBe(true);
  });

  it("a capable cloud model is blind in a door-ON room — the door strips the pixels", () => {
    expect(pixelsReachChatModel("claude-cli", true, cloudDoorOn)).toBe(false);
    expect(pixelsReachChatModel("claude-cli", true, cloudDoorOpen)).toBe(true);
  });

  it("a local model still sees pixels with the door on (nothing leaves the Mac)", () => {
    expect(pixelsReachChatModel("qwen3.5:4b", true, { runsOnThisMac: () => true, privacyActive: () => true })).toBe(
      true
    );
  });
});

describe("passthroughPrepareImage", () => {
  it("hands the original bytes back and reports no dimensions", () => {
    const bytes = Buffer.from([1, 2, 3]);
    expect(passthroughPrepareImage(bytes)).toEqual({ bytes, width: 0, height: 0 });
  });
});

// ----------------------------------------------------- history/handoff budgets

describe("historyBudgetBytes / handoffBudgetBytes", () => {
  it("the history budget is the flat backstop regardless of model", () => {
    expect(historyBudgetBytes("qwen3.5:4b")).toBe(200_000);
    expect(historyBudgetBytes("")).toBe(200_000);
  });

  it("the handoff budget is two thirds of the window at 3 chars/token, capped", () => {
    // floor(8192/3)*2 = 5460 tokens; *3 chars = 16380 bytes.
    expect(handoffBudgetBytes(8192)).toBe(16_380);
    expect(handoffBudgetBytes(10_000_000)).toBe(200_000);
  });
});

// ------------------------------------------------------------ locate intent

describe("isLocateIntent", () => {
  it("fires on unambiguous locate verbs", () => {
    expect(isLocateIntent("where is the serial number?", null)).toBe(true);
    expect(isLocateIntent("mark the total on it", null)).toBe(true);
    expect(isLocateIntent("circle the signature", null)).toBe(true);
  });

  it("a weak verb needs the question to refer to the image", () => {
    expect(isLocateIntent("highlight the total", null)).toBe(false);
    expect(isLocateIntent("highlight the total in the screenshot", null)).toBe(true);
    expect(isLocateIntent("highlight the total", "receipt.png")).toBe(false);
    expect(isLocateIntent("highlight the total in receipt.png", "receipt.png")).toBe(true);
  });

  it("never fires when the question names a different, non-image target", () => {
    expect(isLocateIntent("where is the deposit clause in the pdf?", null)).toBe(false);
    expect(isLocateIntent("mark the total in the spreadsheet", null)).toBe(false);
  });

  it("an ordinary question is not a locate intent", () => {
    expect(isLocateIntent("what does this say?", "receipt.png")).toBe(false);
  });
});

// ---------------------------------------------------------- buildSystemPrompt

describe("buildSystemPrompt", () => {
  const base = {
    webEnabled: false,
    connectedMcp: [] as string[],
    inventory: [] as Array<[string, string, string | null]>,
    roomRoleId: null,
    responseStyle: null,
    customInstructions: null,
  };

  it("is EXACTLY the byte-stable base when nothing else applies (ADD-22)", () => {
    expect(buildSystemPrompt(base)).toBe(BASE_SYSTEM_PROMPT);
  });

  it("appends the web-access addition only when enabled", () => {
    const on = buildSystemPrompt({ ...base, webEnabled: true });
    expect(on).toContain("web access ON");
    expect(on).toContain("web_search (find pages)");
    expect(buildSystemPrompt(base)).not.toContain("web access ON");
  });

  it("names connected MCP servers when any are present", () => {
    const withMcp = buildSystemPrompt({ ...base, connectedMcp: ["notion", "linear"] });
    expect(withMcp).toContain("connected external tool servers to this room: notion, linear");
    expect(withMcp).toContain("search_mcp_tools");
  });

  it("lists the inventory newest-first, with cached one-liners", () => {
    const withFiles = buildSystemPrompt({
      ...base,
      inventory: [
        ["Report.pdf", "application/pdf", "A quarterly report."],
        ["notes.md", "text/markdown", null],
      ],
    });
    expect(withFiles).toContain("Report.pdf (application/pdf) — A quarterly report.\n");
    expect(withFiles).toContain("notes.md (text/markdown)\n");
    expect(withFiles).not.toContain("partial");
  });

  it("flags a >100-file inventory as partial and truncates the list to 100", () => {
    const many: Array<[string, string, string | null]> = Array.from({ length: 105 }, (_, i) => [
      `f${i}.txt`,
      "text/plain",
      null,
    ]);
    const withMany = buildSystemPrompt({ ...base, inventory: many });
    expect(withMany).toContain("This list is partial");
    expect((withMany.match(/f\d+\.txt/g) ?? []).length).toBe(100);
  });

  it("stops spending one-liners once the running BYTE budget is gone", () => {
    // 60 files, each with a summary far past `clampWords`' 120-char cut, so
    // every liner costs the same 123 UTF-8 bytes ("y" x120 + "…"). The 3000-byte
    // budget therefore covers exactly 25 of them (24 x 123 = 2952, leaving 48 —
    // still > 0, so a 25th is spent and the budget hits zero); the rest fall
    // back to the bare `- name (mime)` line. Counting BYTES is what the Rust
    // source does (`liner.len()`), and it is what makes a Hebrew one-liner cost
    // its real weight rather than half of it.
    const long = "y".repeat(1_000);
    const many: Array<[string, string, string | null]> = Array.from({ length: 60 }, (_, i) => [
      `f${i}.txt`,
      "text/plain",
      long,
    ]);
    const built = buildSystemPrompt({ ...base, inventory: many });
    expect((built.match(/ — y+…\n/g) ?? []).length).toBe(25);
    expect(built).toContain("- f59.txt (text/plain)\n");
  });

  it("injects the room persona, and nothing at all for the default one", () => {
    expect(buildSystemPrompt({ ...base, roomRoleId: "tutor" })).toContain("patient tutor");
    expect(buildSystemPrompt({ ...base, roomRoleId: "default" })).toBe(BASE_SYSTEM_PROMPT);
  });

  it("injects the style preset, with the precedence sentence only alongside custom text", () => {
    const styledOnly = buildSystemPrompt({ ...base, responseStyle: "terse" });
    expect(styledOnly).toContain("Response style: TERSE.");
    expect(styledOnly).not.toContain("follow the user's preferences");

    const styledWithCustom = buildSystemPrompt({
      ...base,
      responseStyle: "terse",
      customInstructions: "Always cite page numbers.",
    });
    expect(styledWithCustom).toContain("follow the user's preferences");
    expect(styledWithCustom).toContain("Always cite page numbers.");
  });

  it("injects custom instructions with no style set", () => {
    const withCustom = buildSystemPrompt({ ...base, customInstructions: "Prefer bullet points." });
    expect(withCustom).toContain("standing preferences for how you respond");
    expect(withCustom).toContain("Prefer bullet points.");
  });

  it("whitespace-only custom instructions inject nothing", () => {
    expect(buildSystemPrompt({ ...base, customInstructions: "   \n " })).toBe(BASE_SYSTEM_PROMPT);
  });
});
