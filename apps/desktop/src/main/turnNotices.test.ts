import { describe, expect, it } from "vitest";
import {
  LOST_REPLY_AFTER_WRITE,
  LOST_REPLY_CLEAN,
  LOST_REPLY_WITH_JOB,
  STOPPED_NO_ANSWER_AFTER_WRITE,
  STOPPED_NO_ANSWER_CLEAN,
  STOPPED_NO_ANSWER_WITH_JOB,
  backgroundWorkLive,
  claimsUnbackedAction,
  emptyReplyNotice,
  isFailureNotice,
} from "./turnNotices.js";

describe("emptyReplyNotice", () => {
  it("picks the six notices by the (stopped, wrote, jobLive) truth table", () => {
    expect(emptyReplyNotice(true, true, false)).toBe(STOPPED_NO_ANSWER_AFTER_WRITE);
    expect(emptyReplyNotice(true, true, true)).toBe(STOPPED_NO_ANSWER_AFTER_WRITE);
    expect(emptyReplyNotice(true, false, true)).toBe(STOPPED_NO_ANSWER_WITH_JOB);
    expect(emptyReplyNotice(true, false, false)).toBe(STOPPED_NO_ANSWER_CLEAN);
    expect(emptyReplyNotice(false, true, false)).toBe(LOST_REPLY_AFTER_WRITE);
    expect(emptyReplyNotice(false, true, true)).toBe(LOST_REPLY_AFTER_WRITE);
    expect(emptyReplyNotice(false, false, true)).toBe(LOST_REPLY_WITH_JOB);
    expect(emptyReplyNotice(false, false, false)).toBe(LOST_REPLY_CLEAN);
  });

  it("never claims 'lost' after a Stop — that would describe a failure that did not happen", () => {
    const notice = emptyReplyNotice(true, false, false);
    expect(notice).not.toContain("lost");
  });
});

describe("backgroundWorkLive", () => {
  it("is true when a job is running or queued", () => {
    expect(backgroundWorkLive(() => [{ status: "running" }])).toBe(true);
    expect(backgroundWorkLive(() => [{ status: "queued" }])).toBe(true);
  });
  it("is false when every job is finished/failed/paused", () => {
    expect(backgroundWorkLive(() => [{ status: "finished" }, { status: "failed" }])).toBe(false);
  });
  it("is false (never claims either way) when the read failed / no room is open", () => {
    expect(backgroundWorkLive(() => undefined)).toBe(false);
  });
  it("is false for an empty jobs table", () => {
    expect(backgroundWorkLive(() => [])).toBe(false);
  });
});

describe("isFailureNotice", () => {
  it("recognises the lost-reply notices", () => {
    expect(isFailureNotice(LOST_REPLY_CLEAN)).toBe(true);
    expect(isFailureNotice(LOST_REPLY_AFTER_WRITE)).toBe(true);
    expect(isFailureNotice(LOST_REPLY_WITH_JOB)).toBe(true);
  });
  it("recognises the stopped notices", () => {
    expect(isFailureNotice(STOPPED_NO_ANSWER_CLEAN)).toBe(true);
    expect(isFailureNotice(STOPPED_NO_ANSWER_AFTER_WRITE)).toBe(true);
    expect(isFailureNotice(STOPPED_NO_ANSWER_WITH_JOB)).toBe(true);
  });
  it("recognises the mid-run error notice shape", () => {
    expect(isFailureNotice("*(The agent hit an error and stopped mid-run: boom)*")).toBe(true);
  });
  it("is false for a real answer, even one that happens to start similarly", () => {
    expect(isFailureNotice("The agent in this story is a metaphor for growth.")).toBe(false);
    expect(isFailureNotice("Q3 revenue was $5M.")).toBe(false);
  });
  it("tolerates leading whitespace", () => {
    expect(isFailureNotice(`   ${LOST_REPLY_CLEAN}`)).toBe(true);
  });
});

describe("claimsUnbackedAction", () => {
  it("flags a write claim when nothing was actually written", () => {
    expect(claimsUnbackedAction("I've updated the file with the new numbers.", false, false)).toBe(true);
  });
  it("does not flag the same claim when a write DID happen", () => {
    expect(claimsUnbackedAction("I've updated the file with the new numbers.", true, false)).toBe(false);
  });
  it("flags a highlight claim when nothing was highlighted", () => {
    expect(claimsUnbackedAction("I've highlighted the clause for you.", false, false)).toBe(true);
    expect(claimsUnbackedAction("I've highlighted the clause for you.", false, true)).toBe(false);
  });
  it("does not flag a NEGATED claim on the same line", () => {
    expect(claimsUnbackedAction("I could not have updated the file — no room is open.", false, false)).toBe(
      false
    );
    expect(claimsUnbackedAction("I have not updated the file.", false, false)).toBe(false);
  });
  it("ignores a claim inside a fenced code block", () => {
    const text = "```\nI've updated the file\n```\nHere is what I actually did instead.";
    expect(claimsUnbackedAction(text, false, false)).toBe(false);
  });
  it("is false for ordinary prose with no claim at all", () => {
    expect(claimsUnbackedAction("Q3 revenue grew 12% year over year.", false, false)).toBe(false);
  });
  it("a negation elsewhere in the text does not suppress a claim on an unrelated line", () => {
    const text = "I cannot see the screenshot.\nI've updated the file with the fix.";
    expect(claimsUnbackedAction(text, false, false)).toBe(true);
  });
  it("continues after a negated matching claim to inspect a later line", () => {
    const text = "I've updated nothing, not really.\nI've updated the file with the fix.";
    expect(claimsUnbackedAction(text, false, false)).toBe(true);
  });
});
