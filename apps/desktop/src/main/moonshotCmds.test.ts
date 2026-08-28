/**
 * Tests for `moonshotCmds.ts`, ported from `src-tauri/src/commands/moonshot.rs`.
 *
 * `recommendedModels` mirrors the Rust suite's own
 * `recommended_models_are_populated` test one-for-one. `resolveStructuredModel`
 * and `ensureEmbedModel` have no Rust `#[cfg(test)]` counterpart (they need a
 * live `State<'_, AppState>`/Tokio runtime) — this adds direct coverage against
 * REAL FIXTURE ROOMS via `db-host/open.ts`'s `createRoom`, this directory's
 * established convention, with every network/background seam (`listModels`,
 * `pullCancellable`, `spawnEmbeddingBackfill`) driven by injected fakes rather
 * than a live sidecar.
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3-multiple-ciphers";
import { createRoom } from "./db-host/open.js";
import { getSetting, setSetting } from "./db-host/settings.js";
import { getMeta } from "./db-host/meta.js";
import { CancelFlag } from "./cancel.js";
import type { PullOutcome, PullProgressListener } from "./ollamaModels.js";
import type { OpenRoom } from "./turnEngine.js";
import {
  ensureEmbedModel,
  recommendedModels,
  registerMoonshotIpc,
  resolveStructuredModel,
  type EnsureEmbedModelDeps,
  type MoonshotIpcDeps,
  type ResolveStructuredModelDeps,
  type RoomSource,
} from "./moonshotCmds.js";

const tmpDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function freshRoom(): OpenRoom {
  const dir = mkdtempSync(path.join(os.tmpdir(), "moonshot-cmds-"));
  tmpDirs.push(dir);
  const roomPath = path.join(dir, `t-${randomUUID()}.roomai`);
  const db = createRoom(roomPath, "correct horse battery staple", "Test Room");
  return { db, path: roomPath };
}

function fakeRooms(room: OpenRoom | null): RoomSource {
  return { currentRoom: () => room };
}

const noRoom: RoomSource = fakeRooms(null);

// ============================================================================
// recommendedModels — ported from `recommended_models_are_populated`
// ============================================================================

describe("recommendedModels", () => {
  it("D1: names the two SPECIAL models Settings offers to pull, and nothing else", () => {
    const r = recommendedModels();
    expect(r.embed).toBe("nomic-embed-text");
    expect(r.vision).toBe("qwen2.5vl");
    // The chat roster is the frontend's own (RECOMMENDED_MODELS); a re-added
    // `chat` field would be dead weight on every Settings open, exactly as
    // the Rust test guards.
    expect(Object.keys(r)).toEqual(["embed", "vision"]);
  });
});

// ============================================================================
// resolveStructuredModel
// ============================================================================

describe("resolveStructuredModel", () => {
  it("returns an external engine immediately, without ever calling listModels", async () => {
    const room = freshRoom();
    setSetting(room.db, "model", "claude-cli");
    const listModels = vi.fn(async () => ["qwen3.5:4b"]);
    const model = await resolveStructuredModel(fakeRooms(room), { listModels });
    expect(model).toBe("claude-cli");
    expect(listModels).not.toHaveBeenCalled();
  });

  it("returns an Ollama :cloud relay immediately too — is_external_engine covers it", async () => {
    const room = freshRoom();
    setSetting(room.db, "model", "openrouter::anthropic/claude-3.5-sonnet");
    const listModels = vi.fn(async () => []);
    const model = await resolveStructuredModel(fakeRooms(room), { listModels });
    expect(model).toBe("openrouter::anthropic/claude-3.5-sonnet");
    expect(listModels).not.toHaveBeenCalled();
  });

  it("falls back to bestLocalDefault when no model setting is stored", async () => {
    const room = freshRoom();
    expect(getSetting(room.db, "model")).toBeNull();
    const deps: ResolveStructuredModelDeps = { listModels: async () => ["qwen3.5:4b-mlx"] };
    const model = await resolveStructuredModel(fakeRooms(room), deps);
    expect(model).toBe("qwen3.5:4b-mlx");
  });

  it("trusts an explicit LOCAL model setting verbatim when Ollama has any models installed", async () => {
    // Rust: `explicit.unwrap_or_else(|| best_local_default(&models))` — an
    // explicit non-external model is returned AS-IS, never re-derived through
    // bestLocalDefault, as long as `models` is non-empty.
    const room = freshRoom();
    setSetting(room.db, "model", "some-unlisted-model");
    const deps: ResolveStructuredModelDeps = { listModels: async () => ["qwen3.5:4b"] };
    const model = await resolveStructuredModel(fakeRooms(room), deps);
    expect(model).toBe("some-unlisted-model");
  });

  it("returns undefined when Ollama has no models installed, even with an explicit local setting", async () => {
    // Rust checks `models.is_empty()` BEFORE consulting `explicit` — an
    // unreachable/empty Ollama beats a stored local model name.
    const room = freshRoom();
    setSetting(room.db, "model", "some-unlisted-model");
    const deps: ResolveStructuredModelDeps = { listModels: async () => [] };
    const model = await resolveStructuredModel(fakeRooms(room), deps);
    expect(model).toBeUndefined();
  });

  it("returns undefined when no room is open and Ollama has nothing installed", async () => {
    const deps: ResolveStructuredModelDeps = { listModels: async () => [] };
    const model = await resolveStructuredModel(noRoom, deps);
    expect(model).toBeUndefined();
  });

  it("still resolves a local default with no room open, if Ollama has models", async () => {
    const deps: ResolveStructuredModelDeps = { listModels: async () => ["qwen3.5:4b"] };
    const model = await resolveStructuredModel(noRoom, deps);
    expect(model).toBe("qwen3.5:4b");
  });
});

// ============================================================================
// ensureEmbedModel
// ============================================================================

function pullOutcome(outcome: PullOutcome): NonNullable<EnsureEmbedModelDeps["pullCancellable"]> {
  return vi.fn(async (_model: string, _cancel: CancelFlag, _onProgress: PullProgressListener) => outcome);
}

describe("ensureEmbedModel", () => {
  it("skips the pull and stamps meta when the embed model is already installed", async () => {
    const room = freshRoom();
    const pullCancellable = pullOutcome({ kind: "ok" });
    const spawnEmbeddingBackfill = vi.fn();
    await ensureEmbedModel(fakeRooms(room), () => {}, {
      listModels: async () => ["nomic-embed-text", "qwen3.5:4b"],
      pullCancellable,
      spawnEmbeddingBackfill,
    });
    expect(pullCancellable).not.toHaveBeenCalled();
    expect(getMeta(room.db, "embed_model")).toBe("nomic-embed-text");
    expect(getMeta(room.db, "embed_dim")).toBe("768");
    expect(spawnEmbeddingBackfill).toHaveBeenCalledOnce();
  });

  it("matches a build-suffixed install by prefix (models.iter().any(starts_with))", async () => {
    const room = freshRoom();
    const pullCancellable = pullOutcome({ kind: "ok" });
    await ensureEmbedModel(fakeRooms(room), () => {}, {
      listModels: async () => ["nomic-embed-text-v1.5"],
      pullCancellable,
    });
    expect(pullCancellable).not.toHaveBeenCalled();
    expect(getMeta(room.db, "embed_model")).toBe("nomic-embed-text");
  });

  it("pulls the model, forwards progress, and stamps meta on a successful pull", async () => {
    const room = freshRoom();
    const progress: Array<{ status: string; percent: number | null }> = [];
    const pullCancellable: NonNullable<EnsureEmbedModelDeps["pullCancellable"]> = vi.fn(
      async (model: string, _cancel: CancelFlag, onProgress: PullProgressListener): Promise<PullOutcome> => {
        expect(model).toBe("nomic-embed-text");
        onProgress("downloading", 50);
        return { kind: "ok" };
      }
    );
    await ensureEmbedModel(
      fakeRooms(room),
      (status, percent) => progress.push({ status, percent }),
      { listModels: async () => [], pullCancellable }
    );
    expect(progress).toEqual([{ status: "downloading", percent: 50 }]);
    expect(getMeta(room.db, "embed_model")).toBe("nomic-embed-text");
    expect(getMeta(room.db, "embed_dim")).toBe("768");
  });

  it("never throws on a failed pull, and does not stamp meta", async () => {
    const room = freshRoom();
    const pullCancellable = pullOutcome({ kind: "error", message: "boom" });
    await expect(
      ensureEmbedModel(fakeRooms(room), () => {}, { listModels: async () => [], pullCancellable })
    ).resolves.toBeUndefined();
    expect(getMeta(room.db, "embed_model")).toBeNull();
  });

  it("still calls spawnEmbeddingBackfill even when the pull failed (Rust: unconditional)", async () => {
    const room = freshRoom();
    const pullCancellable = pullOutcome({ kind: "cancelled" });
    const spawnEmbeddingBackfill = vi.fn();
    await ensureEmbedModel(fakeRooms(room), () => {}, {
      listModels: async () => [],
      pullCancellable,
      spawnEmbeddingBackfill,
    });
    expect(spawnEmbeddingBackfill).toHaveBeenCalledOnce();
  });

  it("skips the meta stamp (never throws) when no room is open", async () => {
    const pullCancellable = pullOutcome({ kind: "ok" });
    await expect(
      ensureEmbedModel(noRoom, () => {}, { listModels: async () => [], pullCancellable })
    ).resolves.toBeUndefined();
  });

  it("swallows a set_meta failure instead of rejecting, matching Rust's `let _ =`", async () => {
    const room = freshRoom();
    room.db.close(); // any subsequent write throws "database connection is not open"
    const pullCancellable = pullOutcome({ kind: "ok" });
    await expect(
      ensureEmbedModel(fakeRooms(room), () => {}, { listModels: async () => [], pullCancellable })
    ).resolves.toBeUndefined();
  });

  it("logs SKIPPED (not NOT_IMPLEMENTED) when no spawnEmbeddingBackfill is injected", async () => {
    const room = freshRoom();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await ensureEmbedModel(fakeRooms(room), () => {}, {
      listModels: async () => ["nomic-embed-text"],
    });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("SKIPPED: spawn_embedding_backfill"));
  });
});

// ============================================================================
// registerMoonshotIpc
// ============================================================================

describe("registerMoonshotIpc", () => {
  function fakeIpcMain(): { handle: ReturnType<typeof vi.fn>; handlers: Map<string, (...a: unknown[]) => unknown> } {
    const handlers = new Map<string, (...a: unknown[]) => unknown>();
    const handle = vi.fn((channel: string, fn: (...a: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    });
    return { handle, handlers };
  }

  it("registers recommended_models and answers the static payload", async () => {
    const { handle, handlers } = fakeIpcMain();
    registerMoonshotIpc({ handle }, { rooms: noRoom });
    expect(handle).toHaveBeenCalledWith("recommended_models", expect.any(Function));
    const result = await handlers.get("recommended_models")!();
    expect(result).toEqual({ embed: "nomic-embed-text", vision: "qwen2.5vl" });
  });

  it("registers ensure_embed_model and forwards progress on the invoking window", async () => {
    const room = freshRoom();
    const { handle, handlers } = fakeIpcMain();
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const pullCancellable: NonNullable<EnsureEmbedModelDeps["pullCancellable"]> = vi.fn(
      async (_model: string, _cancel: CancelFlag, onProgress: PullProgressListener): Promise<PullOutcome> => {
        onProgress("downloading", 10);
        return { kind: "ok" };
      }
    );
    const deps: MoonshotIpcDeps = {
      rooms: fakeRooms(room),
      ensureEmbedModelDeps: { listModels: async () => [], pullCancellable },
    };
    registerMoonshotIpc({ handle }, deps);
    expect(handle).toHaveBeenCalledWith("ensure_embed_model", expect.any(Function));

    const fakeEvent = {
      sender: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
    };
    await handlers.get("ensure_embed_model")!(fakeEvent);
    expect(sent).toEqual([{ channel: "pull-progress", payload: { status: "downloading", percent: 10 } }]);
    expect(getMeta(room.db, "embed_model")).toBe("nomic-embed-text");
  });
});

// ============================================================================
// ADVERSARIAL — `starts_with`, not `contains`
// ============================================================================

describe("ensureEmbedModel — adversarial", () => {
  it("a model that merely CONTAINS nomic-embed-text is not the embed model", async () => {
    // Rust: `models.iter().any(|m| m.starts_with(ollama::EMBED_MODEL))`. A
    // `.includes()` here would read someone's fine-tune (or a namespaced
    // registry copy) as "already installed", skip the pull, and then stamp
    // `embed_model = nomic-embed-text` into `meta` — a room recording that it
    // was indexed by a model it has never had. Every embedding written
    // afterwards would be filed under the wrong dimension claim.
    const room = freshRoom();
    const pullCancellable = vi.fn(
      async (
        _model: string,
        _cancel: CancelFlag,
        _onProgress: PullProgressListener
      ): Promise<PullOutcome> => ({ kind: "ok" })
    );
    await ensureEmbedModel(fakeRooms(room), () => {}, {
      listModels: async () => [
        "hf.co/someone/nomic-embed-text-v2:Q4",
        "my-nomic-embed-text:latest",
        "qwen3.5:4b",
      ],
      pullCancellable,
      spawnEmbeddingBackfill: () => {},
    });
    expect(pullCancellable).toHaveBeenCalledTimes(1);
    expect(pullCancellable.mock.calls[0]![0]).toBe("nomic-embed-text");
    // …while a genuine prefix match (`nomic-embed-text:v1.5`) still skips it.
    const pull2 = vi.fn(async (): Promise<PullOutcome> => ({ kind: "ok" }));
    await ensureEmbedModel(fakeRooms(room), () => {}, {
      listModels: async () => ["nomic-embed-text:v1.5"],
      pullCancellable: pull2,
      spawnEmbeddingBackfill: () => {},
    });
    expect(pull2).not.toHaveBeenCalled();
    expect(getMeta(room.db, "embed_model")).toBe("nomic-embed-text");
    expect(getMeta(room.db, "embed_dim")).toBe("768");
  });
});

describe("resolveStructuredModel — adversarial", () => {
  it("an explicit local model is trusted verbatim and never re-validated", async () => {
    // Rust: `Some(explicit.unwrap_or_else(|| best_local_default(&models)))` —
    // `explicit` is returned as-is; `models` is only ever consulted for the
    // EMPTINESS gate and for the fallback pick. A port that "helpfully"
    // checked membership would silently swap the user's chosen model for the
    // tuned default the moment their tag was spelled differently from the
    // registry listing.
    const room = freshRoom();
    setSetting(room.db, "model", "not-installed-anywhere:70b");
    await expect(
      resolveStructuredModel(fakeRooms(room), { listModels: async () => ["qwen3.5:4b"] })
    ).resolves.toBe("not-installed-anywhere:70b");
    // …but an EMPTY list still refuses, even with an explicit setting stored,
    // because Rust's `if models.is_empty() { return None; }` runs first.
    await expect(
      resolveStructuredModel(fakeRooms(room), { listModels: async () => [] })
    ).resolves.toBeUndefined();
  });
});
