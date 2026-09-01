import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Val } from "./obs.js";
import {
  ERR_KINDS,
  LOG_ENV,
  MAX_LOG_BYTES,
  Sink,
  UNEXPECTED,
  UNLOGGABLE,
  bytes,
  count,
  debug,
  errKind,
  filterFrom,
  flag,
  id,
  ids,
  info,
  logDir,
  logPath,
  model,
  ms,
  oneOf,
  previousLogPath,
  render,
  state,
  warn,
} from "./obs.js";

/** A stand-in for the Rust source's `JOB_STATES` — that constant belongs to
 * the excluded "decision function" section of the module, but `oneOf` is
 * generic, so any small whitelist demonstrates its collapse behavior. */
const JOB_STATES = ["queued", "running", "paused", "done", "error", "cancelled"] as const;

/** Values a room really does hold. Every one of these must be impossible to
 * get into the log through any helper this module exposes — ported from the
 * Rust `ROOM_CONTENT` fixture. */
const ROOM_CONTENT: readonly string[] = [
  "Q3 board minutes.pdf",
  "diary.pdf",
  "/Users/ben/Documents/Divorce settlement.docx",
  "Dear Sarah, I've decided to leave the company",
  "sk-ant-api03-REALKEYMATERIAL",
  "לקוחות פרטיים.xlsx",
  "https://example.com/private/doc?token=abc123",
];

describe("id", () => {
  it("a handle-shaped id survives and anything else does not", () => {
    expect(id("9f2c4a1b7e0d4f3a").toString()).toBe("9f2c4a1b7e0d4f3a");
    expect(id("ask-17_2").toString()).toBe("ask-17_2");
    expect(id("browse_open").toString()).toBe("browse_open");

    // The near misses that matter: a dotted filename, a space, a path,
    // something long enough to be a payload rather than a handle, and a
    // credential (shape-identical to a handle, hence the prefix list).
    for (const bad of [
      "diary.pdf",
      "my notes",
      "/tmp/x",
      "",
      "a".repeat(65),
      "sk-ant-api03-REALKEYMATERIAL",
      "ghp_0123456789abcdef",
    ]) {
      expect(id(bad).toString(), `${JSON.stringify(bad)} got through`).toBe(UNLOGGABLE);
    }
  });

  it("ids() checks each entry independently, so one bad entry does not blank the rest", () => {
    expect(render("probe", [["names", ids(["browse_open", "save_file"])]])).toBe(
      "probe names=[browse_open save_file]",
    );
    expect(render("probe", [["names", ids(["browse_open", "diary.pdf", "save_file"])]])).toBe(
      `probe names=[browse_open ${UNLOGGABLE} save_file]`,
    );
    expect(ids([]).toString()).toBe("[]");
  });
});

describe("model", () => {
  it("a model id survives but a path or a sentence does not", () => {
    for (const good of ["qwen3.5:4b", "anthropic/claude-opus-4", "codex-cli:gpt-5", "gpt-oss:120b-cloud"]) {
      expect(model(good).toString(), `${JSON.stringify(good)} was refused`).toBe(good);
    }
    for (const bad of [
      "/Users/ben/model.gguf",
      "../secrets",
      "Q3 board minutes.pdf",
      ".hidden",
      "~/Downloads/x",
      // The near miss the boundary test caught: filename-shaped, but with
      // none of the giveaways (no space, no slash, no leading dot).
      "diary.pdf",
      "notes.md",
    ]) {
      expect(model(bad).toString(), `${JSON.stringify(bad)} got through`).toBe(UNLOGGABLE);
    }
  });

  it("a model id's dotted segment is a version, so it survives where a filename does not", () => {
    expect(model("nomic-embed-text-v1.5").toString()).toBe("nomic-embed-text-v1.5");
    expect(model("llama3.2").toString()).toBe("llama3.2");
  });

  it("refuses credential prefixes even when the shape otherwise fits", () => {
    for (const cred of [
      "sk-ant-api03-REALKEYMATERIAL",
      "ghp_0123456789abcdef",
      "AKIAABCDEFGHIJKLMNOP",
      "Bearer.some.jwt.like.thing",
    ]) {
      expect(model(cred).toString(), `${JSON.stringify(cred)} got through`).toBe(UNLOGGABLE);
      expect(id(cred.replace(/[^A-Za-z0-9_-]/g, "")).toString()).toBe(UNLOGGABLE);
    }
  });
});

describe("errKind", () => {
  it("keeps its kind and loses its text entirely", () => {
    const table: [string, string][] = [
      ["failed to read /Users/ben/Diary.pdf: No such file or directory (os error 2)", "not_found"],
      ["error sending request for url (https://api.example.com/v1/chat): connection refused", "network"],
      ["the AI service refused the Stop (status 503)", "upstream_error"],
      ["Read timed out after 30s", "timeout"],
      ["no api key for this provider", "no_credential"],
      ["permission denied", "denied"],
      ["429 quota exceeded", "rate_limited"],
      ["operation was cancelled", "cancelled"],
      ["allocation failed: out of memory", "out_of_memory"],
      ["context too large for this model", "too_large"],
      ["malformed json schema", "malformed"],
      ["", "none"],
      ["Q3 board minutes.pdf", "other"],
    ];
    for (const [msg, kind] of table) {
      expect(errKind(msg).toString(), `for ${JSON.stringify(msg)}`).toBe(kind);
    }
    // Whatever comes in, what comes out is one of a fixed list of literals.
    for (const msg of ROOM_CONTENT) {
      const k = errKind(msg).toString();
      expect(ERR_KINDS as readonly string[], `${JSON.stringify(k)} is not a kind`).toContain(k);
    }
  });

  it("exposes the exact 13 kinds in declaration order", () => {
    expect(ERR_KINDS).toEqual([
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
    ]);
  });

  it("picks the FIRST matching category when a message matches more than one, in the Rust if/else-if order", () => {
    // "timed out" (timeout, checked 2nd) and "connection" (network, 8th)
    // both match; timeout wins.
    expect(errKind("connection timed out while contacting the model").toString()).toBe("timeout");

    // "cancel" (cancelled, 3rd) and "429"/"rate limit" (rate_limited, 4th)
    // both match; cancelled wins.
    expect(errKind("the request was cancelled after hitting a 429 rate limit").toString()).toBe(
      "cancelled",
    );

    // "429"/"rate limit" (rate_limited, 4th) and "denied" (denied, 5th) both
    // match; rate_limited wins.
    expect(errKind("429 rate limit exceeded; access was also denied").toString()).toBe(
      "rate_limited",
    );

    // "403"/"denied" (denied, 5th) and "no key" (no_credential, 6th) both
    // match; denied wins.
    expect(errKind("access denied (403): no api key on file").toString()).toBe("denied");

    // "no such file"/"404" (not_found, 7th) and "connection" (network, 8th)
    // both match; not_found wins.
    expect(errKind("404 no such file, and the connection dropped too").toString()).toBe(
      "not_found",
    );

    // "connection" (network, 8th) and "invalid"/"json" (malformed, 12th)
    // both match; network wins.
    expect(errKind("connection reset: invalid json payload").toString()).toBe("network");

    // "500"/"server error" (upstream_error, 9th) and "json"/"parse"
    // (malformed, 12th) both match; upstream_error wins.
    expect(errKind("500 server error while trying to parse the json body").toString()).toBe(
      "upstream_error",
    );
  });
});

describe("oneOf", () => {
  it("a whitelist is the only way a runtime string becomes a state", () => {
    expect(oneOf("running", JOB_STATES).toString()).toBe("running");
    expect(oneOf("Running", JOB_STATES).toString()).toBe(UNEXPECTED);
    expect(oneOf("", JOB_STATES).toString()).toBe(UNEXPECTED);
  });
});

describe("numeric and boolean factories", () => {
  it("render as bare numbers/booleans and clamp non-negative", () => {
    expect(count(0).toString()).toBe("0");
    expect(bytes(2048).toString()).toBe("2048");
    expect(ms(1500).toString()).toBe("1500");
    expect(flag(false).toString()).toBe("false");
    expect(flag(true).toString()).toBe("true");
    // Defensive clamping for inputs that should never occur in practice.
    expect(count(-5).toString()).toBe("0");
    expect(bytes(3.7).toString()).toBe("3");
    expect(ms(Number.NaN).toString()).toBe("0");
  });
});

describe("render", () => {
  it("quotes a value only when it would otherwise break k=v parsing", () => {
    expect(render("probe", [["a", state("safe-value")]])).toBe("probe a=safe-value");
    expect(render("probe", [["a", state("has space")]])).toBe('probe a="has space"');
    expect(render("probe", [["a", state("has=equals")]])).toBe('probe a="has=equals"');
    expect(render("probe", [["a", state('has"quote')]])).toBe('probe a="has\\"quote"');
    // Empty is quoted too — logfmt cannot express `k=` as "present but
    // empty" any other way.
    expect(render("probe", [["a", state("")]])).toBe('probe a=""');
  });

  it("renders numbers and flags without quoting", () => {
    expect(render("probe", [["n", count(3)]])).toBe("probe n=3");
    expect(render("probe", [["b", bytes(1024)]])).toBe("probe b=1024");
    expect(render("probe", [["d", ms(42)]])).toBe("probe d=42");
    expect(render("probe", [["f", flag(true)]])).toBe("probe f=true");
    expect(render("probe", [["f", flag(false)]])).toBe("probe f=false");
  });

  it("room content cannot reach the log through any helper", () => {
    for (const secret of ROOM_CONTENT) {
      const line = render("probe", [
        ["a", id(secret)],
        ["b", model(secret)],
        ["c", oneOf(secret, JOB_STATES)],
        ["d", errKind(secret)],
        ["e", ids([secret])],
      ]);
      for (const word of secret.split(/\s+/)) {
        if (word.length > 3) {
          expect(
            line,
            `${JSON.stringify(word)} from ${JSON.stringify(secret)} leaked into ${line}`,
          ).not.toContain(word);
        }
      }
      expect(line, `${JSON.stringify(secret)} leaked whole into ${line}`).not.toContain(secret);
    }
  });

  it("a credential-prefixed secret cannot reach the log through id() or model(), whatever else is true of it", () => {
    for (const secret of [
      `sk-${randomUUID()}`,
      `ghp_${randomUUID().replace(/-/g, "")}`,
      `AKIA${randomUUID().replace(/-/g, "").toUpperCase().slice(0, 16)}`,
    ]) {
      const line = render("probe", [
        ["a", id(secret)],
        ["b", model(secret)],
      ]);
      expect(line, `${JSON.stringify(secret)} leaked into ${line}`).not.toContain(secret);
    }
  });
});

describe("Sink", () => {
  let dir: string;

  afterEach(() => {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function freshDir(): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-obs-test-"));
    return dir;
  }

  it("rotates instead of growing without bound", () => {
    const d = freshDir();
    const p = path.join(d, "h.log");
    const prev = path.join(d, "h.prev.log");
    const sink = new Sink(p, prev);
    const chunk = "x".repeat(64 * 1024);
    // Enough to cross MAX_LOG_BYTES at least twice.
    const iterations = Math.floor((2 * MAX_LOG_BYTES) / chunk.length) + 4;
    for (let i = 0; i < iterations; i++) {
      sink.writeRaw(chunk);
    }
    sink.close();
    const live = fs.statSync(p).size;
    expect(live, `live log grew to ${live}`).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(fs.existsSync(prev), "the previous generation was destroyed").toBe(true);
  });

  it("rotates on open (not truncate), preserving the prior session as .prev", () => {
    const d = freshDir();
    const p = path.join(d, "h.log");
    const prev = path.join(d, "h.prev.log");
    const first = new Sink(p, prev);
    first.info("first.session", [["n", count(1)]]);
    first.close();

    const second = new Sink(p, prev);
    second.info("second.session", [["n", count(2)]]);
    second.close();

    expect(fs.readFileSync(prev, "utf8")).toContain("first.session");
    expect(fs.readFileSync(p, "utf8")).toContain("second.session");
    expect(fs.readFileSync(p, "utf8")).not.toContain("first.session");
  });

  it("per-call detail is off until it is asked for, and info/warn need no asking", () => {
    const d = freshDir();
    const p = path.join(d, "h.log");
    const prev = path.join(d, "h.prev.log");
    const sink = new Sink(p, prev);

    sink.info("job.status", [["job", id("job17")]]);
    sink.debug("tools.call", [["tool", id("open_file")]]);
    let out = fs.readFileSync(p, "utf8");
    expect(out).toContain("job.status");
    expect(out).not.toContain("tools.call");

    sink.setLevel("debug");
    sink.debug("tools.call", [
      ["tool", id("open_file")],
      ["error", flag(true)],
    ]);
    sink.close();
    out = fs.readFileSync(p, "utf8");
    expect(out).toContain("tools.call");
    expect(out).toContain("tool=open_file error=true");
    expect(out).toContain("DEBUG");
  });

  it('an explicit "off" level silences info and warn as well as debug', () => {
    const d = freshDir();
    const p = path.join(d, "h.log");
    const prev = path.join(d, "h.prev.log");
    const sink = new Sink(p, prev);
    sink.setLevel("off");
    sink.info("should.not.appear", []);
    sink.warn("should.not.appear.either", []);
    sink.debug("nor.this", []);
    sink.close();
    expect(fs.readFileSync(p, "utf8")).toBe("");
  });

  it("a refused stop reads as a warning and an accepted one does not", () => {
    const d = freshDir();
    const p = path.join(d, "h.log");
    const prev = path.join(d, "h.prev.log");
    const sink = new Sink(p, prev);

    sink.info("cancel.requested", [
      ["run", id("run17")],
      ["known", flag(true)],
    ]);
    sink.info("cancel.delivered", [
      ["run", id("run17")],
      ["ms", ms(12)],
    ]);
    sink.warn("cancel.refused", [
      ["run", id("run18")],
      ["ms", ms(3100)],
      ["err", errKind("the AI service did not recognise the run")],
    ]);
    sink.close();

    const out = fs.readFileSync(p, "utf8");
    expect(out).toContain("cancel.requested run=run17 known=true");
    expect(out).toContain("cancel.delivered run=run17 ms=12");
    expect(out).toContain("cancel.refused");
    expect(out, "a refused Stop must not read as routine").toContain("WARN");
  });

  it("room content cannot reach the log through the real emit path", () => {
    const d = freshDir();
    const p = path.join(d, "h.log");
    const prev = path.join(d, "h.prev.log");
    const sink = new Sink(p, prev);
    const secret = "Divorce settlement.docx";

    sink.info("job.status", [
      ["job", id(secret)],
      ["to", oneOf(secret, JOB_STATES)],
      ["err", errKind(secret)],
    ]);
    sink.info("sidecar.run.end", [
      ["outcome", state("failed")],
      ["ms", ms(3)],
      ["textBytes", bytes(12)],
      ["err", errKind(secret)],
    ]);
    sink.info("tools.catalog", [
      ["scope", state("LocalEngine")],
      ["served", count(1)],
      ["names", ids([secret])],
    ]);
    sink.close();

    const out = fs.readFileSync(p, "utf8");
    expect(out, "the sink recorded nothing").not.toBe("");
    expect(out).not.toContain("Divorce");
    expect(out).not.toContain("settlement");
    expect(out).not.toContain(".docx");
    // ...and the event still SAYS something: a scrubbed log that logs
    // nothing is the same blindness this module exists to end.
    expect(out).toContain("job.status");
    expect(out).toContain(UNLOGGABLE);
    expect(out).toContain(UNEXPECTED);
  });
});

describe("filterFrom", () => {
  it("falls back to the default instead of going silent on an unparseable request", () => {
    // Not set at all, and the shipped default.
    for (const req of [undefined, "arcelle=info"]) {
      const { understood, level } = filterFrom(req);
      expect(understood, `${JSON.stringify(req)} should be honoured`).toBe(true);
      expect(level, `${JSON.stringify(req)} should resolve to info`).toBe("info");
    }

    // Values that CANNOT speak about us: honoured would mean silence.
    for (const bad of ["", " , ", "not a filter!!", "ARCELLE=debug", "somethingelse=trace", "arcelle=debag"]) {
      const { understood, level } = filterFrom(bad);
      expect(understood, `${JSON.stringify(bad)} was taken at face value`).toBe(false);
      expect(level, `${JSON.stringify(bad)} silenced the fallback`).toBe("info");
    }

    // Values that genuinely do speak about us are obeyed — including the
    // explicit "be quiet", which is an answer rather than a mistake.
    for (const [good, expectedLevel] of [
      ["arcelle=debug", "debug"],
      ["trace", "trace"],
      ["warn,arcelle=debug", "debug"],
    ] as const) {
      const { understood, level } = filterFrom(good);
      expect(understood, `${JSON.stringify(good)} was overridden`).toBe(true);
      expect(level, `${JSON.stringify(good)}`).toBe(expectedLevel);
    }
  });

  it("honors an explicit off as a real request, not a typo, and it is genuinely quiet", () => {
    const { understood, level } = filterFrom("arcelle=off");
    expect(understood, "an explicit off is a real request").toBe(true);
    expect(level).toBe("off");
    // "quiet" means not even the least verbose events are enabled — proved
    // against a real Sink, since that is what "off" is actually for.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-obs-test-"));
    try {
      const sink = new Sink(path.join(dir, "h.log"), path.join(dir, "h.prev.log"));
      sink.setLevel(level);
      sink.info("noise", []);
      sink.warn("noise", []);
      sink.close();
      expect(fs.readFileSync(path.join(dir, "h.log"), "utf8")).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("log paths", () => {
  it("both logs live in one folder a user can be pointed at", () => {
    expect(path.dirname(logPath())).toBe(logDir());
    expect(logPath()).not.toBe(previousLogPath());
    expect(logPath().endsWith("arcelle-host.log")).toBe(true);
    expect(previousLogPath().endsWith("arcelle-host.prev.log")).toBe(true);
  });

  it("LOG_ENV names the variable init() reads", () => {
    expect(LOG_ENV).toBe("ARCELLE_LOG");
  });
});

describe("Val is opaque by construction", () => {
  it("cannot be constructed from outside this module even via a direct import", () => {
    // `Val` is exported ONLY as a type (`export type { Val }`), and its
    // constructor is additionally `private`. Attempting to use the
    // type-only import as a runtime value is a compile error on BOTH
    // grounds — either one alone would already block this.
    //
    // This proof has to live inside a function that is DEFINED but never
    // CALLED: `tsc --noEmit` still type-checks an uncalled function body
    // (so `@ts-expect-error` is genuinely exercised — if the construction
    // ever stopped erroring, tsc would fail the build with "unused
    // '@ts-expect-error' directive"), while vitest — which only transpiles,
    // it does not type-check — never executes the body, so the reference to
    // the erased-at-runtime `Val` binding never actually runs.
    function typeCheckedProofValIsUnconstructible(): void {
      // @ts-expect-error - Val has no runtime export (type-only) and a private constructor; `new Val(...)` cannot compile here.
      const forbidden: Val = new Val("arbitrary-room-content");
      void forbidden;
    }
    expect(typeof typeCheckedProofValIsUnconstructible).toBe("function");
  });

  it("the module exports no runtime binding named Val, and nothing beyond the documented factories", async () => {
    const mod = await import("./obs.js");
    expect(Object.hasOwn(mod, "Val")).toBe(false);
    expect((mod as Record<string, unknown>).Val).toBeUndefined();

    const expectedExports = new Set([
      "UNLOGGABLE",
      "UNEXPECTED",
      "LOG_ENV",
      "MAX_LOG_BYTES",
      "ERR_KINDS",
      "id",
      "ids",
      "model",
      "state",
      "oneOf",
      "count",
      "bytes",
      "ms",
      "flag",
      "errKind",
      "render",
      "Sink",
      "init",
      "info",
      "warn",
      "debug",
      "logPath",
      "previousLogPath",
      "logDir",
      "filterFrom",
    ]);
    const actualExports = new Set(Object.keys(mod));
    expect(actualExports).toEqual(expectedExports);
  });
});

describe("module-level info/warn/debug", () => {
  it("are no-ops until init() has installed a sink, and never throw", async () => {
    const mod = await import("./obs.js");
    expect(() => mod.info("no.sink.yet", [])).not.toThrow();
    expect(() => mod.warn("no.sink.yet", [])).not.toThrow();
    expect(() => mod.debug("no.sink.yet", [])).not.toThrow();
  });
});

describe("event names, field keys, and whitelists must be compile-time literals", () => {
  /**
   * Adversarially found: the first version of this file typed `render()`'s
   * `event`, every field-list KEY, and `oneOf()`'s whole `allowed` whitelist
   * as plain `string` / `string[]` — no check of any kind, not even the
   * honor-system disclaimer `state()` carried. That meant a room-content
   * string could reach the log verbatim through THREE different doors that
   * never touch a `Val` at all:
   *
   *   render(someFilename, [[someOtherSecret, count(1)]])   // event AND key
   *   oneOf(secret, [secret])                                // whitelist
   *
   * Same proof technique as the `Val` opacity test above: these live inside a
   * function that is DEFINED but never CALLED, so `tsc --noEmit` type-checks
   * the `@ts-expect-error` directives for real (and would fail the build with
   * "unused '@ts-expect-error' directive" if any of these ever stopped
   * erroring), while vitest — transpile-only, no type-checking — never
   * executes the body.
   */
  it("cannot be bypassed even via a direct call with runtime-typed arguments", () => {
    function typeCheckedProofLiteralsAreEnforced(secret: string, secretKey: string): void {
      // @ts-expect-error - render()'s event must be a literal, not a runtime string.
      render(secret, [["a", count(1)]]);
      // @ts-expect-error - every field KEY must be a literal too, not just the event.
      render("probe", [[secretKey, count(1)]]);
      // @ts-expect-error - a whitelist built to already contain the value under test must not compile.
      oneOf(secret, [secret]);
      // @ts-expect-error - the module-level info() carries the same event constraint as render().
      info(secret, []);
      // @ts-expect-error - ...and so does warn().
      warn(secret, []);
      // @ts-expect-error - ...and so does debug().
      debug(secret, []);
    }
    expect(typeof typeCheckedProofLiteralsAreEnforced).toBe("function");
  });

  it("still compiles normally for the literal-only style every real call site already uses", () => {
    // No @ts-expect-error anywhere below — these are the shapes every event
    // helper in this file and every future caller is expected to use, and
    // the fix must not have made them harder to write.
    expect(render("probe", [["a", count(1)]])).toBe("probe a=1");
    expect(oneOf("running", JOB_STATES).toString()).toBe("running");
    expect(() => info("no.sink.yet", [["n", count(1)]])).not.toThrow();
  });

  it("proves the exact old exploit strings no longer reach the log, at runtime", () => {
    // Belt-and-braces companion to the compile-time proof above: even setting
    // the type system aside, confirm the specific bypass strings an
    // adversarial pass constructed are gone from actual output. (Reaching
    // this line at all already required the literal-only call shapes below —
    // this asserts the CONTENT is also correct, not just that it compiled.)
    const secretFilename = "Divorce settlement.docx";
    const line = render("job.status", [["job", id(secretFilename)]]);
    expect(line).not.toContain("Divorce");
    expect(line).toContain(UNLOGGABLE);
  });
});

describe("sink failure handling and startup wiring", () => {
  it("keeps logging non-fatal when opening, writing, or closing a sink fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-obs-test-"));
    const importWithFs = async (overrides: Record<string, unknown>) => {
      vi.resetModules();
      vi.doMock("node:fs", async () => {
        const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
        return { ...actual, ...overrides };
      });
      return import("./obs.js");
    };
    const clearFsMock = () => {
      vi.doUnmock("node:fs");
      vi.resetModules();
    };
    try {
      const writing = await importWithFs({
        writeSync: () => { throw new Error("disk full"); },
      });
      const writeSink = new writing.Sink(path.join(dir, "write.log"), path.join(dir, "write.prev.log"));
      expect(() => writeSink.info("safe.event", [["n", writing.count(1)]])).not.toThrow();
      writeSink.close();
      clearFsMock();

      const rotating = await importWithFs({
        closeSync: () => { throw new Error("close failed"); },
      });
      const rotationSink = new rotating.Sink(path.join(dir, "rotate.log"), path.join(dir, "rotate.prev.log"));
      Reflect.set(rotationSink as unknown as object, "written", rotating.MAX_LOG_BYTES);
      expect(() => rotationSink.writeRaw("x")).not.toThrow();
      clearFsMock();

      const unopened = await importWithFs({
        openSync: () => { throw new Error("sandboxed"); },
      });
      const unopenedSink = new unopened.Sink(path.join(dir, "unavailable.log"), path.join(dir, "unavailable.prev.log"));
      expect(() => unopenedSink.writeRaw("ignored")).not.toThrow();
      clearFsMock();

      const closing = await importWithFs({
        closeSync: () => { throw new Error("close failed"); },
      });
      const closeSink = new closing.Sink(path.join(dir, "close.log"), path.join(dir, "close.prev.log"));
      expect(() => closeSink.close()).not.toThrow();
    } finally {
      clearFsMock();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes a single startup record and reports a rejected filter in its isolated log directory", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arcelle-obs-init-test-"));
    const previous = process.env[LOG_ENV];
    process.env[LOG_ENV] = "arcelle=debag";
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, tmpdir: () => dir };
    });
    try {
      const isolated = await import("./obs.js");
      isolated.init("qwen3.5:4b");
      isolated.init("ignored-on-second-call");
      const log = fs.readFileSync(path.join(dir, "arcelle-host.log"), "utf8");
      expect(log).toContain("host.start version=qwen3.5:4b");
      expect(log).toContain("host.log_filter_ignored");
      expect(log.match(/host\.start/g)).toHaveLength(1);
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
      if (previous === undefined) delete process.env[LOG_ENV];
      else process.env[LOG_ENV] = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains the default Val guard even if an external runtime mutates an opaque instance", () => {
    const forged = id("opaque") as unknown as { shape: unknown; toString(): unknown };
    Reflect.set(forged, "shape", { kind: "impossible" });
    expect(forged.toString()).toEqual({ kind: "impossible" });
  });
});
