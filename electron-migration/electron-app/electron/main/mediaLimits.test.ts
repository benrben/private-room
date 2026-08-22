/**
 * Tests for `mediaLimits.ts`, ported from
 * `src-tauri/src/commands/media_limits.rs`.
 *
 * All six of the Rust source's own `#[cfg(test)]` fixtures are ported below
 * (each keeps its Rust test name in the `it` title so the two can be
 * diffed), and past those this suite adds the real-behavior coverage the
 * Rust file's tests never reach: the fetch/merge/cache round trip through the
 * injected {@link MediaLimitsDeps} seam (including once against a REAL
 * `node:http` server, this repo's convention — see `providers.test.ts`), the
 * staleness/refresh policy with a controlled clock, and the single-flight
 * lock's two branches (a caller with nothing to serve waits; a caller with a
 * full table in hand does not).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENROUTER_BASE_URL,
  type HttpJsonResponseLike,
} from "./providers.js";
import {
  REFRESH_AFTER_MS,
  RETRY_HALF_AFTER_MS,
  allowsSeconds,
  defaultSeconds,
  emptyMediaLimits,
  ensureMediaLimits,
  limitsFor,
  mediaTableLoaded,
  parseImageModels,
  parseVideoModels,
  resetMediaLimitsStateForTests,
  takesFirstFrame,
  type MediaLimits,
  type MediaLimitsDeps,
} from "./mediaLimits.js";

beforeEach(() => {
  resetMediaLimitsStateForTests();
});

function jsonResponse(status: number, body: unknown): HttpJsonResponseLike {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Waits for every microtask queued so far to run — `setImmediate` fires in
 * Node's "check" phase, strictly after the current microtask queue (promise
 * `.then` chains) has fully drained, so this reliably observes state a
 * pending `ensureMediaLimits` call has advanced to without any real delay. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ===========================================================================
// Ported Rust fixtures
// ===========================================================================

describe("parseVideoModels", () => {
  it("video_limits_are_read_off_the_endpoints_own_field_names", () => {
    // Verbatim from the live `/videos/models` payload for Veo 3.1 — whose
    // durations are the reason this module exists: 4, 6 and 8 only, so a
    // "5 second" clip is a 400 rather than a shorter video.
    const value = {
      data: [
        {
          id: "google/veo-3.1",
          supported_durations: [4, 6, 8],
          supported_resolutions: ["720p", "1080p", "4K"],
          supported_aspect_ratios: ["16:9", "9:16"],
          supported_frame_images: ["first_frame", "last_frame"],
          generate_audio: true,
        },
      ],
    };
    const found = new Map<string, MediaLimits>();
    parseVideoModels(value, found);
    const veo = found.get("google/veo-3.1");
    if (!veo) throw new Error("expected to parse");
    expect(veo.durations).toEqual([4, 6, 8]);
    expect(allowsSeconds(veo, 6)).toBe(true);
    expect(allowsSeconds(veo, 5), "5s is not on Veo's list").toBe(false);
    expect(defaultSeconds(veo), "cheapest legal length").toBe(4);
    expect(takesFirstFrame(veo)).toBe(true);
    expect(veo.generateAudio).toBe(true);
  });

  it("a_model_that_takes_no_starting_picture_says_so", () => {
    // Sora 2 Pro and Runway Aleph 2 publish no frame slots at all. The page
    // must not offer a picture that would be silently ignored.
    const value = {
      data: [
        {
          id: "openai/sora-2-pro",
          supported_durations: [4, 8, 12, 16, 20],
          supported_frame_images: null,
        },
      ],
    };
    const found = new Map<string, MediaLimits>();
    parseVideoModels(value, found);
    const sora = found.get("openai/sora-2-pro");
    if (!sora) throw new Error("expected to parse");
    expect(sora.frameImages).toEqual([]);
    expect(takesFirstFrame(sora)).toBe(false);
  });
});

describe("parseImageModels", () => {
  it("image_limits_come_out_of_the_nested_parameter_shape", () => {
    // `/images/models` nests each parameter as enum-or-range rather than
    // publishing flat lists like the video endpoint does.
    const value = {
      data: [
        {
          id: "qwen/qwen-image-3-pro",
          supported_parameters: {
            resolution: { type: "enum", values: ["1K", "2K"] },
            aspect_ratio: { type: "enum", values: ["1:1", "16:9"] },
            n: { type: "range", min: 1, max: 6 },
            input_references: { type: "range", min: 0, max: 4 },
          },
        },
      ],
    };
    const found = new Map<string, MediaLimits>();
    parseImageModels(value, found);
    const qwen = found.get("qwen/qwen-image-3-pro");
    if (!qwen) throw new Error("expected to parse");
    expect(qwen.resolutions).toEqual(["1K", "2K"]);
    // The number the cast strip needs: four heroes in one picture, not five.
    expect(qwen.maxReferences).toBe(4);
    expect(qwen.durations, "a still has no length").toEqual([]);
  });
});

describe("parseVideoModels + parseImageModels merge", () => {
  it("a_slug_on_both_endpoints_keeps_its_lengths_and_frame_slots", () => {
    // The image parse runs second into the SAME map. Overwriting the video
    // entry would blank `durations` (no seconds picker) and `frameImages` —
    // and an empty frame list is a PUBLISHED "takes no starting picture", so
    // a generation path would refuse a legal first frame on the strength of a
    // field `/images/models` never speaks about.
    const videos = {
      data: [
        {
          id: "vendor/model-x",
          supported_durations: [4, 6, 8],
          supported_resolutions: ["720p"],
          supported_frame_images: ["first_frame"],
          generate_audio: true,
        },
      ],
    };
    const images = {
      data: [
        {
          id: "vendor/model-x",
          supported_parameters: {
            aspect_ratio: { type: "enum", values: ["1:1"] },
            input_references: { type: "range", min: 0, max: 3 },
          },
        },
      ],
    };
    const found = new Map<string, MediaLimits>();
    parseVideoModels(videos, found);
    parseImageModels(images, found);
    const both = found.get("vendor/model-x");
    if (!both) throw new Error("expected to parse");
    expect(both.durations, "the video lengths survive").toEqual([4, 6, 8]);
    expect(takesFirstFrame(both), "the frame slot survives").toBe(true);
    expect(both.generateAudio).toBe(true);
    expect(both.resolutions, "the clip's own sizes stand").toEqual(["720p"]);
    // What the images endpoint alone knows is still picked up.
    expect(both.aspectRatios).toEqual(["1:1"]);
    expect(both.maxReferences).toBe(3);
  });
});

describe("mediaTableLoaded", () => {
  it("one_catalogue_alone_is_not_a_loaded_table", async () => {
    // The P1 this guards against: `/videos/models` answered and
    // `/images/models` did not, so the cache held video slugs only — and a
    // non-empty cache used to count as "the media tables loaded". A page
    // reading that would drop every image model behind a row saying the
    // provider's picture endpoint refuses them, a fact nothing had
    // established.
    const videoOnlyDeps: MediaLimitsDeps = {
      fetchJson: async (url) =>
        url.endsWith("/videos/models")
          ? jsonResponse(200, { data: [{ id: "vendor/video-only-fixture", supported_durations: [4] }] })
          : jsonResponse(500, { error: "images endpoint down" }),
    };
    await ensureMediaLimits("test-key", videoOnlyDeps);
    expect(mediaTableLoaded(), "a video table alone settles nothing about image models").toBe(false);
    expect(limitsFor("vendor/video-only-fixture")).toBeDefined();

    // Advance past the HALF-table retry window so the next call actually
    // refetches rather than reading the still-fresh half table, then let the
    // images endpoint answer too.
    const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + RETRY_HALF_AFTER_MS + 1);
    try {
      const bothDeps: MediaLimitsDeps = {
        fetchJson: async (url) =>
          url.endsWith("/videos/models")
            ? jsonResponse(200, { data: [{ id: "vendor/video-only-fixture", supported_durations: [4] }] })
            : jsonResponse(200, { data: [{ id: "vendor/pic", supported_parameters: {} }] }),
      };
      await ensureMediaLimits("test-key", bothDeps);
    } finally {
      spy.mockRestore();
    }
    expect(mediaTableLoaded(), "both halves in, the rule applies").toBe(true);
  });
});

describe("parseVideoModels / parseImageModels (empty catalogues)", () => {
  it("a_body_that_names_no_models_is_not_a_catalogue", () => {
    // `ensureMediaLimits` sets that endpoint's loaded flag from this count,
    // and the flag is what lets the Create page's `drop_unserved` remove
    // models. A 200 whose body is not the shape read here parses to
    // nothing — and calling THAT "the catalogue loaded" says the endpoint
    // serves no model at all, which takes every model off the Create page
    // behind a row blaming the provider for it.
    const found = new Map<string, MediaLimits>();
    expect(parseVideoModels({ data: [] }, found)).toBe(0);
    expect(parseImageModels({ error: { message: "no endpoint" } }, found)).toBe(0);
    expect(found.size).toBe(0);
    // And one real entry counts, so the guard cannot be satisfied by a
    // parser that always answers zero.
    expect(parseVideoModels({ data: [{ id: "vendor/one" }] }, found)).toBe(1);
  });
});

describe("allowsSeconds / defaultSeconds (adversarial)", () => {
  it("defaultSeconds survives an oversized published duration list", () => {
    // `Math.min(...durations)` pushes one call-stack argument per element and
    // throws `RangeError: Maximum call stack size exceeded` well before this
    // many; Rust's `.iter().copied().min()` has no such ceiling. `durations`
    // comes straight off provider JSON, and this whole module's contract is
    // "never fatal" — a garbled `/videos/models` body must not crash a
    // limits lookup.
    const many = emptyMediaLimits();
    many.durations = Array.from({ length: 200_000 }, (_, i) => i + 3);
    expect(defaultSeconds(many)).toBe(3);
    expect(allowsSeconds(many, 3)).toBe(true);
    expect(allowsSeconds(many, 2)).toBe(false);
  });

  it("a duration list published out of order still answers the SHORTEST (cheapest)", () => {
    const shuffled = emptyMediaLimits();
    shuffled.durations = [16, 4, 20, 8];
    expect(defaultSeconds(shuffled)).toBe(4);
  });

  it("a model slug shaped like a prototype key is an ordinary cache entry, not a prototype write", () => {
    // RULE 2: every table here is a `Map`, never a `{}` keyed by a
    // provider-controlled slug. `/videos/models` names the keys, so a
    // `__proto__`/`constructor` id must behave exactly like any other slug —
    // and must not leak a `resolutions` field onto every object in the
    // process.
    const found = new Map<string, MediaLimits>();
    const evil = ["__proto__", "constructor", "prototype", "toString"];
    parseVideoModels(
      { data: evil.map((id) => ({ id, supported_durations: [4], supported_resolutions: ["pwned"] })) },
      found,
    );
    for (const id of evil) {
      expect(found.get(id)?.resolutions).toEqual(["pwned"]);
    }
    expect(found.size).toBe(evil.length);
    expect(({} as Record<string, unknown>).resolutions).toBeUndefined();
    expect(({} as Record<string, unknown>).durations).toBeUndefined();
    // …and the same slug through the real cache round trip.
    expect(limitsFor("__proto__")).toBeUndefined();
  });
});

describe("allowsSeconds / defaultSeconds", () => {
  it("an_unpublished_duration_list_refuses_nothing", () => {
    // The whole table failing to load must not make every generation
    // illegal — an empty list means "we were not told", so the provider's
    // own default decides.
    const silent = emptyMediaLimits();
    expect(allowsSeconds(silent, 7)).toBe(true);
    expect(defaultSeconds(silent)).toBeNull();
  });
});

// ===========================================================================
// Beyond the Rust fixtures — parsing edge cases
// ===========================================================================

describe("parseVideoModels / parseImageModels (edge cases)", () => {
  it("skips an entry with no id rather than counting it, matching Rust's filter_map", () => {
    const found = new Map<string, MediaLimits>();
    const seen = parseVideoModels({ data: [{ supported_durations: [4] }, { id: "vendor/ok" }] }, found);
    expect(seen).toBe(1);
    expect([...found.keys()]).toEqual(["vendor/ok"]);
  });

  it("tolerates a completely malformed payload", () => {
    const found = new Map<string, MediaLimits>();
    expect(parseVideoModels(null, found)).toBe(0);
    expect(parseVideoModels("a string", found)).toBe(0);
    expect(parseVideoModels({}, found)).toBe(0);
    expect(parseVideoModels({ data: "not an array" }, found)).toBe(0);
    expect(parseImageModels(undefined, found)).toBe(0);
    expect(found.size).toBe(0);
  });

  it("drops non-integer or negative entries out of supported_durations, like Rust's as_u64", () => {
    const found = new Map<string, MediaLimits>();
    parseVideoModels(
      { data: [{ id: "vendor/x", supported_durations: [4, -1, 6.5, "8", null, 8] }] },
      found,
    );
    expect(found.get("vendor/x")?.durations).toEqual([4, 8]);
  });

  it("a generate_audio field that is not literally `true` reads as false", () => {
    const found = new Map<string, MediaLimits>();
    parseVideoModels({ data: [{ id: "vendor/x", generate_audio: "yes" }] }, found);
    expect(found.get("vendor/x")?.generateAudio).toBe(false);
  });

  it("max_references is unpublished (null), not zero, when input_references is absent", () => {
    const found = new Map<string, MediaLimits>();
    parseImageModels({ data: [{ id: "vendor/x", supported_parameters: {} }] }, found);
    expect(found.get("vendor/x")?.maxReferences).toBeNull();
  });
});

// ===========================================================================
// limitsFor / mediaTableLoaded (read access)
// ===========================================================================

describe("limitsFor", () => {
  it("is undefined for a slug neither catalogue has ever named", () => {
    expect(limitsFor("vendor/never-seen")).toBeUndefined();
  });
});

// ===========================================================================
// The fetch/merge round trip, through the injected deps seam
// ===========================================================================

describe("ensureMediaLimits", () => {
  it("does nothing while the table is fresh — no fetch at all", async () => {
    const deps: MediaLimitsDeps = {
      fetchJson: async () => jsonResponse(200, { data: [{ id: "vendor/a" }] }),
    };
    await ensureMediaLimits("key", deps);
    expect(mediaTableLoaded()).toBe(true);

    const notCalled: MediaLimitsDeps = {
      fetchJson: async () => {
        throw new Error("must not be called — the table is still fresh");
      },
    };
    await expect(ensureMediaLimits("key", notCalled)).resolves.toBeUndefined();
  });

  it("sends the bearer key and both branding headers to each endpoint, with a real request order", async () => {
    const requestedPaths: string[] = [];
    const deps: MediaLimitsDeps = {
      fetchJson: async (url, init) => {
        expect(init.headers.Authorization).toBe("Bearer sk-test");
        expect(init.headers["HTTP-Referer"]).toBe("https://arcelle.app");
        expect(init.headers["X-OpenRouter-Title"]).toBe("Arcelle");
        requestedPaths.push(url.replace(OPENROUTER_BASE_URL, ""));
        return jsonResponse(200, { data: [] });
      },
    };
    await ensureMediaLimits("sk-test", deps);
    expect(requestedPaths).toEqual(["/videos/models", "/images/models"]);
  });

  it("merges both catalogues into the cache and marks both flags loaded", async () => {
    const deps: MediaLimitsDeps = {
      fetchJson: async (url) =>
        url.endsWith("/videos/models")
          ? jsonResponse(200, {
              data: [{ id: "vendor/clip", supported_durations: [4, 8], supported_frame_images: ["first_frame"] }],
            })
          : jsonResponse(200, {
              data: [{ id: "vendor/still", supported_parameters: { resolution: { values: ["1K"] } } }],
            }),
    };
    await ensureMediaLimits("key", deps);
    expect(mediaTableLoaded()).toBe(true);
    expect(limitsFor("vendor/clip")?.durations).toEqual([4, 8]);
    expect(limitsFor("vendor/still")?.resolutions).toEqual(["1K"]);
  });

  it("a non-2xx endpoint logs and leaves that half unloaded, without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps: MediaLimitsDeps = {
        fetchJson: async (url) =>
          url.endsWith("/videos/models")
            ? jsonResponse(200, { data: [{ id: "vendor/ok" }] })
            : jsonResponse(503, { error: "down" }),
      };
      await expect(ensureMediaLimits("key", deps)).resolves.toBeUndefined();
      expect(mediaTableLoaded()).toBe(false);
      expect(limitsFor("vendor/ok")).toBeDefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("/images/models answered 503"));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("a network failure on both endpoints is not fatal and stamps nothing", async () => {
    const deps: MediaLimitsDeps = {
      fetchJson: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    };
    await expect(ensureMediaLimits("key", deps)).resolves.toBeUndefined();
    expect(mediaTableLoaded()).toBe(false);
  });

  it("an unparseable body reads as no data, not as a thrown error", async () => {
    const deps: MediaLimitsDeps = {
      fetchJson: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
      }),
    };
    await expect(ensureMediaLimits("key", deps)).resolves.toBeUndefined();
    expect(mediaTableLoaded()).toBe(false);
  });
});

// ===========================================================================
// Staleness / refresh policy, with a controlled clock
// ===========================================================================

describe("ensureMediaLimits (staleness policy)", () => {
  it("REFRESH_AFTER_MS / RETRY_HALF_AFTER_MS match the values recorded live in the Rust source", () => {
    // Pinned as literals, not against the exports themselves: an assertion
    // that reads the constant it is checking can never fail.
    expect(REFRESH_AFTER_MS).toBe(60 * 60 * 1000);
    expect(RETRY_HALF_AFTER_MS).toBe(5 * 60 * 1000);
  });

  it("a full table is refetched only after REFRESH_AFTER_MS, not sooner", async () => {
    let fetches = 0;
    const deps: MediaLimitsDeps = {
      fetchJson: async () => {
        fetches += 1;
        return jsonResponse(200, { data: [{ id: "vendor/a" }] });
      },
    };
    await ensureMediaLimits("key", deps);
    expect(fetches).toBe(2); // one per endpoint

    let spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + REFRESH_AFTER_MS - 1);
    try {
      await ensureMediaLimits("key", deps);
    } finally {
      spy.mockRestore();
    }
    expect(fetches, "still inside the one-hour window").toBe(2);

    spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + REFRESH_AFTER_MS + 1);
    try {
      await ensureMediaLimits("key", deps);
    } finally {
      spy.mockRestore();
    }
    expect(fetches, "past the window, a refresh is attempted").toBe(4);
  });

  it("a HALF table is retried after RETRY_HALF_AFTER_MS, well before the full-hour window", async () => {
    let videoFetches = 0;
    const deps: MediaLimitsDeps = {
      fetchJson: async (url) => {
        if (url.endsWith("/videos/models")) {
          videoFetches += 1;
          return jsonResponse(200, { data: [{ id: "vendor/a" }] });
        }
        return jsonResponse(500, {});
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await ensureMediaLimits("key", deps);
      expect(videoFetches).toBe(1);
      expect(mediaTableLoaded(), "the images half never arrived").toBe(false);

      const spy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + RETRY_HALF_AFTER_MS + 1);
      try {
        await ensureMediaLimits("key", deps);
      } finally {
        spy.mockRestore();
      }
      expect(videoFetches, "a half table is not trusted for the full hour").toBe(2);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ===========================================================================
// Single-flight lock — the two branches of the Rust source's
// `try_lock()` / `Err(_) if media_table_loaded()` / `Err(_) => lock().await`.
// ===========================================================================

describe("ensureMediaLimits (single-flight lock)", () => {
  it("concurrent callers with nothing to serve make exactly one fetch of each endpoint", async () => {
    let videoRequests = 0;
    let imageRequests = 0;
    const deps: MediaLimitsDeps = {
      fetchJson: async (url) => {
        if (url.endsWith("/videos/models")) videoRequests += 1;
        else imageRequests += 1;
        return jsonResponse(200, { data: [{ id: "vendor/solo" }] });
      },
    };
    await Promise.all([
      ensureMediaLimits("key", deps),
      ensureMediaLimits("key", deps),
      ensureMediaLimits("key", deps),
    ]);
    expect(videoRequests).toBe(1);
    expect(imageRequests).toBe(1);
    expect(mediaTableLoaded()).toBe(true);
  });

  it("a caller with NOTHING loaded yet waits for the in-flight fetch rather than returning early", async () => {
    const order: string[] = [];
    let releaseVideos: (() => void) | undefined;
    const stuck = new Promise<void>((resolve) => {
      releaseVideos = resolve;
    });
    const deps: MediaLimitsDeps = {
      fetchJson: async (url) => {
        if (url.endsWith("/videos/models")) {
          order.push("videos-start");
          await stuck;
          order.push("videos-end");
        }
        return jsonResponse(200, { data: [{ id: "vendor/only", supported_durations: [4] }] });
      },
    };

    const firstCall = ensureMediaLimits("key", deps);
    await flushMicrotasks();
    expect(order).toEqual(["videos-start"]);

    const secondCall = ensureMediaLimits("key", deps);
    const raced = await Promise.race([
      secondCall.then(() => "resolved" as const),
      flushMicrotasks().then(() => "still-pending" as const),
    ]);
    expect(raced, "with nothing loaded yet, the second caller must wait rather than return early").toBe(
      "still-pending",
    );

    releaseVideos?.();
    await Promise.all([firstCall, secondCall]);
    expect(order).toContain("videos-end");
    // Both endpoints answer with the same fixture body here, so both halves
    // load — the point of this test is the WAIT, not the resulting flags.
    expect(mediaTableLoaded()).toBe(true);
    expect(limitsFor("vendor/only")).toBeDefined();
  });

  it("a caller with a FULL table in hand does not wait for someone else's refresh", async () => {
    // Prime a fully loaded table first.
    await ensureMediaLimits("key", {
      fetchJson: async (url) =>
        url.endsWith("/videos/models")
          ? jsonResponse(200, { data: [{ id: "vendor/v", supported_durations: [4] }] })
          : jsonResponse(200, { data: [{ id: "vendor/i", supported_parameters: {} }] }),
    });
    expect(mediaTableLoaded()).toBe(true);

    // Force staleness so the next call attempts a background refresh.
    const clockSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + REFRESH_AFTER_MS + 1);
    try {
      const order: string[] = [];
      let releaseVideos: (() => void) | undefined;
      const stuck = new Promise<void>((resolve) => {
        releaseVideos = resolve;
      });
      const slowDeps: MediaLimitsDeps = {
        fetchJson: async (url) => {
          if (url.endsWith("/videos/models")) {
            order.push("videos-start");
            await stuck;
            order.push("videos-end");
          }
          return jsonResponse(200, { data: [] });
        },
      };
      const firstCall = ensureMediaLimits("key", slowDeps);
      await flushMicrotasks();
      expect(order).toEqual(["videos-start"]);

      // A table is already in hand, so this call must return WITHOUT ever
      // touching the network — proven by a `fetchJson` that throws.
      const secondCall = ensureMediaLimits("key", {
        fetchJson: async () => {
          throw new Error("must not be called — a full table is already in hand");
        },
      });
      await expect(secondCall).resolves.toBeUndefined();

      releaseVideos?.();
      await firstCall;
      expect(order).toEqual(["videos-start", "videos-end"]);
    } finally {
      clockSpy.mockRestore();
    }
  });
});

// ===========================================================================
// End-to-end against a REAL local HTTP server, through the REAL global fetch.
// ===========================================================================

describe("ensureMediaLimits over real HTTP", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) {
      await close();
      close = undefined;
    }
  });

  async function startServer(handler: (url: string) => { status: number; body: unknown }): Promise<MediaLimitsDeps> {
    const server = http.createServer((req, res) => {
      const { status, body } = handler(req.url ?? "");
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise((r) => server.close(() => r()));
    const base = `http://127.0.0.1:${port}`;
    return {
      fetchJson: (url, init) =>
        fetch(url.replace(OPENROUTER_BASE_URL, base), init) as unknown as Promise<HttpJsonResponseLike>,
    };
  }

  it("fetches both catalogues off the wire and fills the cache", async () => {
    const deps = await startServer((url) => {
      if (url === "/videos/models") {
        return {
          status: 200,
          body: { data: [{ id: "vendor/clip", supported_durations: [4, 6, 8], generate_audio: true }] },
        };
      }
      if (url === "/images/models") {
        return {
          status: 200,
          body: {
            data: [
              {
                id: "vendor/still",
                supported_parameters: { resolution: { values: ["1K", "2K"] }, input_references: { max: 2 } },
              },
            ],
          },
        };
      }
      return { status: 404, body: {} };
    });

    await ensureMediaLimits("sk-live", deps);
    expect(mediaTableLoaded()).toBe(true);
    const clip = limitsFor("vendor/clip");
    expect(clip?.durations).toEqual([4, 6, 8]);
    expect(clip?.generateAudio).toBe(true);
    const still = limitsFor("vendor/still");
    expect(still?.resolutions).toEqual(["1K", "2K"]);
    expect(still?.maxReferences).toBe(2);
  });

  it("a real 500 on one endpoint leaves that half unloaded without throwing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const deps = await startServer((url) =>
        url === "/videos/models"
          ? { status: 200, body: { data: [{ id: "vendor/ok" }] } }
          : { status: 500, body: { error: "down" } },
      );
      await expect(ensureMediaLimits("sk-live", deps)).resolves.toBeUndefined();
      expect(mediaTableLoaded()).toBe(false);
      expect(limitsFor("vendor/ok")).toBeDefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
