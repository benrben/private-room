import type Database from "better-sqlite3-multiple-ciphers";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ContentObjectStore } from "./contentObjects.js";

interface ObjectRow {
  id: string;
  nonce: Buffer;
  relative_object_path: string;
  sha256: string;
  size_bytes: number;
}

class FakeObjectDatabase {
  private readonly meta = new Map<string, string>();
  private readonly objects = new Map<string, ObjectRow>();
  failObjectInsert = false;

  prepare(sql: string): { get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => void } {
    if (sql.includes("SELECT value FROM meta")) {
      return { get: (key) => this.meta.has(key as string) ? { value: this.meta.get(key as string) } : undefined, run: () => {} };
    }
    if (sql.includes("INSERT INTO meta")) {
      return { get: () => undefined, run: (key, value) => this.meta.set(key as string, value as string) };
    }
    if (sql.includes("WHERE sha256 = ?")) {
      return {
        get: (sha256, sizeBytes) => [...this.objects.values()].find(
          (row) => row.sha256 === sha256 && row.size_bytes === sizeBytes,
        ),
        run: () => {},
      };
    }
    if (sql.includes("WHERE id = ?")) {
      return { get: (id) => this.objects.get(id as string), run: () => {} };
    }
    if (sql.includes("INSERT INTO content_objects")) {
      return {
        get: () => undefined,
        run: (id, sha256, sizeBytes, nonce, relativeObjectPath) => {
          if (this.failObjectInsert) throw new Error("simulated object row refusal");
          this.objects.set(id as string, {
            id: id as string,
            nonce: Buffer.from(nonce as Buffer),
            relative_object_path: relativeObjectPath as string,
            sha256: sha256 as string,
            size_bytes: sizeBytes as number,
          });
        },
      };
    }
    throw new Error(`Unexpected fixture database query: ${sql}`);
  }

  corruptHash(id: string): void {
    const row = this.objects.get(id);
    if (!row) throw new Error(`Unknown fixture object: ${id}`);
    row.sha256 = "0".repeat(64);
  }
}

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureStore(): Promise<{ db: FakeObjectDatabase; root: string; store: ContentObjectStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "arcelle-content-object-"));
  roots.push(root);
  const db = new FakeObjectDatabase();
  return { db, root, store: new ContentObjectStore(db as unknown as Database.Database, root) };
}

describe("ContentObjectStore.restoreTo", () => {
  it("restores a non-sensitive fixture through encrypted storage", async () => {
    const { root, store } = await fixtureStore();
    const sourcePath = path.join(root, "fixture.txt");
    const destinationPath = path.join(root, "restored", "fixture.txt");
    await writeFile(sourcePath, "fixture content only", "utf8");
    const stored = await store.putFile(sourcePath);

    await expect(store.restoreTo(stored.id, destinationPath)).resolves.toEqual(stored);
    await expect(readFile(destinationPath, "utf8")).resolves.toBe("fixture content only");
  });

  it("rejects an integrity mismatch without publishing a destination or partial file", async () => {
    const { db, root, store } = await fixtureStore();
    const sourcePath = path.join(root, "fixture.txt");
    const destinationDir = path.join(root, "restored");
    const destinationPath = path.join(destinationDir, "fixture.txt");
    await writeFile(sourcePath, "fixture content only", "utf8");
    const stored = await store.putFile(sourcePath);
    db.corruptHash(stored.id);

    await expect(store.restoreTo(stored.id, destinationPath)).rejects.toThrow("failed its integrity check");
    await expect(readFile(destinationPath, "utf8")).rejects.toThrow();
    await expect(readdir(destinationDir)).resolves.toEqual([]);
  });
});

describe("ContentObjectStore.putFile cleanup", () => {
  it("removes both partial and published ciphertext when the metadata insert fails", async () => {
    const { db, root, store } = await fixtureStore();
    const sourcePath = path.join(root, "fixture.txt");
    await writeFile(sourcePath, "fixture content only", "utf8");
    db.failObjectInsert = true;

    await expect(store.putFile(sourcePath)).rejects.toThrow("simulated object row refusal");

    await expect(readdir(path.join(root, "objects"))).resolves.toEqual([]);
    await expect(readdir(path.join(root, "tmp"))).resolves.toEqual([]);
  });
});
