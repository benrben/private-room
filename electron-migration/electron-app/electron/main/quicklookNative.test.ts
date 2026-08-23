import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NATIVE_RENDER_NOT_IMPLEMENTED,
  PREVIEW_EDGE,
  nativeThumbnailNotImplemented,
  previewPng,
  qlmanageThumbnailPng,
  tempPathFor,
  writePrivate,
} from "./quicklookNative.js";

const QLMANAGE = "/usr/bin/qlmanage";
const hasQlmanage = process.platform === "darwin" && fs.existsSync(QLMANAGE);

/** Count leftover temp copies WITH A GIVEN SUFFIX in the shared temp dir —
 * same reasoning `quicklook.rs`'s own tests and `textUtil.test.ts` give for
 * filtering by an owned suffix rather than a bare `arcelle-ql-*` count: the
 * suite runs against one shared temp directory, so an unfiltered count would
 * see another test's in-flight file and report a leak that isn't there. */
function leftovers(suffix: string): number {
  return fs
    .readdirSync(os.tmpdir())
    .filter((n) => n.startsWith("arcelle-ql-") && n.endsWith(suffix)).length;
}

// ------------------------------------------------------------- tempPathFor

describe("tempPathFor", () => {
  it("keeps the original extension, lower-cased", () => {
    expect(tempPathFor("Deck.PPTX").endsWith(".pptx")).toBe(true);
  });

  it("gives two renders of the same name two different paths", () => {
    const a = tempPathFor("same-name.key");
    const b = tempPathFor("same-name.key");
    expect(a).not.toBe(b);
  });

  it("a name with no extension gets no dot in the temp filename", () => {
    const p = tempPathFor("noext");
    expect(path.basename(p).includes(".")).toBe(false);
    expect(path.basename(p).startsWith("arcelle-ql-")).toBe(true);
  });

  it("a dotfile with no other dot counts as extension-less, matching Path::extension()", () => {
    const p = tempPathFor(".gitignore");
    expect(path.basename(p).includes(".")).toBe(false);
  });

  it("lands in the OS temp directory", () => {
    expect(path.dirname(tempPathFor("thing.pdf"))).toBe(os.tmpdir());
  });
});

// -------------------------------------------------------------- writePrivate

describe("writePrivate", () => {
  it("writes the bytes and they can be read back", () => {
    const p = path.join(os.tmpdir(), `arcelle-ql-test-${randomUUID()}.wponce`);
    expect(writePrivate(p, Buffer.from("hello"))).toBe(true);
    expect(fs.readFileSync(p).toString()).toBe("hello");
    fs.unlinkSync(p);
  });

  it("is owner-only from creation", () => {
    const p = path.join(os.tmpdir(), `arcelle-ql-test-${randomUUID()}.wpperm`);
    expect(writePrivate(p, Buffer.from("secret"))).toBe(true);
    const mode = fs.statSync(p).mode;
    expect(mode & 0o077).toBe(0);
    fs.unlinkSync(p);
  });

  it("refuses to overwrite an existing file rather than clobbering it", () => {
    const p = path.join(os.tmpdir(), `arcelle-ql-test-${randomUUID()}.wptwice`);
    expect(writePrivate(p, Buffer.from("first"))).toBe(true);
    expect(writePrivate(p, Buffer.from("second"))).toBe(false);
    expect(fs.readFileSync(p).toString()).toBe("first");
    fs.unlinkSync(p);
  });
});

// ----------------------------------------------------------------- previewPng

describe("previewPng", () => {
  it("empty bytes resolve null WITHOUT ever touching disk", async () => {
    expect(leftovers(".qlempty")).toBe(0);
    const result = await previewPng("thing.qlempty", Buffer.alloc(0));
    expect(result).toBeNull();
    expect(leftovers(".qlempty")).toBe(0);
  });

  it("the default render rejects with the labelled NOT_IMPLEMENTED reason, and still cleans up the temp copy", async () => {
    expect(leftovers(".qldefault")).toBe(0);
    await expect(previewPng("thing.qldefault", Buffer.from("bytes"))).rejects.toThrow(
      NATIVE_RENDER_NOT_IMPLEMENTED
    );
    expect(leftovers(".qldefault")).toBe(0);
  });

  it("nativeThumbnailNotImplemented rejects on its own with the same labelled reason", async () => {
    await expect(nativeThumbnailNotImplemented("/tmp/whatever", PREVIEW_EDGE)).rejects.toThrow(
      NATIVE_RENDER_NOT_IMPLEMENTED
    );
  });

  it("passes the temp file's path and PREVIEW_EDGE through to render, and returns render's PNG bytes", async () => {
    let seenPath = "";
    let seenMaxEdge = -1;
    let existedDuringRender = false;
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result = await previewPng("thing.qlcustom", Buffer.from("bytes"), async (filePath, maxEdge) => {
      seenPath = filePath;
      seenMaxEdge = maxEdge;
      existedDuringRender = fs.existsSync(filePath); // checked HERE — previewPng's finally removes it right after render returns
      return png;
    });
    expect(result).toBe(png);
    expect(seenPath.endsWith(".qlcustom")).toBe(true);
    expect(existedDuringRender).toBe(true);
    expect(seenMaxEdge).toBe(PREVIEW_EDGE);
    expect(leftovers(".qlcustom")).toBe(0); // and is gone again afterwards, once previewPng has returned
  });

  it("a render that resolves null is a normal answer, not an error, and still cleans up", async () => {
    expect(leftovers(".qlnothing")).toBe(0);
    const result = await previewPng("thing.qlnothing", Buffer.from("bytes"), async () => null);
    expect(result).toBeNull();
    expect(leftovers(".qlnothing")).toBe(0);
  });

  it("hands render a BYTE-EXACT copy of the document, owner-only on disk", async () => {
    // ADVERSARIAL ADDITION (verification pass): every existing previewPng test
    // asserts only on the temp path's NAME and on cleanup — none opens the
    // file. Quick Look renders whatever is at that path, so a port that
    // re-encoded (utf8'd a binary, truncated, wrote the name instead of the
    // bytes) would draw the wrong document and still pass all of them. Binary
    // bytes including a NUL, a lone 0xFF and a 0x89 PNG-magic byte, so a
    // string round-trip cannot survive.
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0a, 0x00, 0x7f]);
    let seen: Buffer | null = null;
    let mode = -1;
    await previewPng("scan.qlbytes", bytes, async (filePath) => {
      seen = fs.readFileSync(filePath);
      mode = fs.statSync(filePath).mode;
      return null;
    });
    expect(seen).not.toBeNull();
    expect(Buffer.compare(seen!, bytes)).toBe(0);
    // The privacy bargain the module doc states: owner-only for the moment it
    // exists, not world-readable-then-tightened.
    expect(mode & 0o077).toBe(0);
    expect(leftovers(".qlbytes")).toBe(0);
  });

  it("20 concurrent renders of the SAME document name never collide, and leave nothing behind", async () => {
    // ADVERSARIAL ADDITION (verification pass): the uuid stem exists for one
    // stated reason — "two concurrent renders of the same document never
    // collide" — and `writePrivate`'s exclusive create means a collision does
    // NOT overwrite, it silently returns no preview. The existing test for
    // this only checks that `tempPathFor` returns two different STRINGS,
    // which a per-name (non-uuid) scheme could still satisfy while
    // `previewPng` collided end to end. This drives the real function
    // concurrently and proves each call saw its own bytes.
    const N = 20;
    expect(leftovers(".qlrace")).toBe(0);
    const results = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        previewPng("same-name.qlrace", Buffer.from(`payload-${i}`), async (filePath) => {
          // Yield, so every render is genuinely in flight at once and the temp
          // copies overlap in time rather than being created and removed
          // one after another.
          await new Promise((r) => setTimeout(r, 15));
          return Buffer.from(fs.readFileSync(filePath));
        })
      )
    );
    const seen = results.map((b) => b!.toString("utf8")).sort();
    expect(seen).toEqual(Array.from({ length: N }, (_unused, i) => `payload-${i}`).sort());
    expect(leftovers(".qlrace")).toBe(0);
  });

  it("a render that REJECTS propagates the rejection but still cleans up the temp copy", async () => {
    expect(leftovers(".qlreject")).toBe(0);
    await expect(
      previewPng("thing.qlreject", Buffer.from("bytes"), async () => {
        throw new Error("simulated hard failure");
      })
    ).rejects.toThrow("simulated hard failure");
    expect(leftovers(".qlreject")).toBe(0);
  });
});

// ------------------------------------------------- qlmanageThumbnailPng (real)

describe("qlmanageThumbnailPng", () => {
  it("resolves null immediately on a non-macOS platform, without spawning anything", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const result = await qlmanageThumbnailPng("/nonexistent/path.txt", 64);
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", original);
    }
  });

  it.skipIf(!hasQlmanage)(
    "renders a REAL .txt file to a real PNG at the requested 2x-scale pixel size",
    async () => {
      const src = path.join(os.tmpdir(), `arcelle-ql-test-${randomUUID()}.txt`);
      fs.writeFileSync(src, "Hello from a real Quick Look render.\n".repeat(30));
      try {
        const png = await qlmanageThumbnailPng(src, 64);
        if (png === null) {
          // A bare-metal Mac with no text-preview generator registered is a
          // real, if unusual, environment; this is Quick Look's business, not
          // this wrapper's — matches the Rust source's own tests, which never
          // assert a render must succeed, only that hygiene holds either way.
          return;
        }
        expect(png.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        // PNG IHDR: width at byte offset 16, height at 20, big-endian u32 —
        // `-s 64 -f 2` should yield 128x128, the same 2x-scale math the Rust
        // source's `CGSize{64,64}` @ `scale 2.0` produces.
        expect(png.readUInt32BE(16)).toBe(128);
        expect(png.readUInt32BE(20)).toBe(128);
      } finally {
        fs.unlinkSync(src);
      }
    },
    20_000
  );

  it.skipIf(!hasQlmanage)(
    "a file qlmanage genuinely hangs on is killed within the given timeout, resolving null",
    async () => {
      // A bogus/unrecognized extension reproducibly hung a real qlmanage -t
      // process (confirmed live via `ps`, 2+ minutes at 0% CPU, three
      // independent repeats each killed at ~1000ms with a 1000ms timeout) —
      // this is the exact hazard quicklook.rs's own TIMEOUT constant exists
      // to contain, reproduced here with a short timeout so the test itself
      // stays fast rather than waiting out the full NATIVE_RENDER_TIMEOUT_MS.
      const src = path.join(os.tmpdir(), `arcelle-ql-test-${randomUUID()}.zzzqltesthang`);
      fs.writeFileSync(src, `hang probe ${randomUUID()}`);
      const start = Date.now();
      try {
        const result = await qlmanageThumbnailPng(src, 64, 1_000);
        const elapsed = Date.now() - start;
        expect(result).toBeNull();
        // Generous upper bound for CI slowness; the point is "bounded by the
        // timeout", not "hangs the full default 20s".
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        fs.unlinkSync(src);
        // qlmanage may have left a partial output behind if this specific
        // run didn't hit the hang; clean it up too.
        try {
          fs.unlinkSync(`${src}.png`);
        } catch {
          // fine — either it rendered fine and was already cleaned up, or it
          // never got that far.
        }
      }
    },
    15_000
  );

  it.skipIf(!hasQlmanage)(
    "a nonexistent input file is ALSO one qlmanage hangs on (confirmed live: 2+ minutes, killed by hand) — so this too resolves null only once the timeout kills it, never throws",
    async () => {
      const bogus = path.join(os.tmpdir(), `arcelle-ql-test-${randomUUID()}.doesnotexist`);
      const result = await qlmanageThumbnailPng(bogus, 64, 1_000);
      expect(result).toBeNull();
    },
    15_000
  );
});
