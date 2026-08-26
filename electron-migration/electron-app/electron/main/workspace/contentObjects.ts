import type Database from "better-sqlite3-multiple-ciphers";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getMeta, setMeta } from "../db-host/meta.js";
import type { ContentObjectRef } from "./types.js";

const KEY_META = "workspace_object_key_v1";
const MAGIC = Buffer.from("ARCOBJ01", "ascii");
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

interface ObjectRow {
  id: string;
  sha256: string;
  size_bytes: number;
  nonce: Buffer;
  relative_object_path: string;
}

function objectKey(db: Database.Database): Buffer {
  const existing = getMeta(db, KEY_META);
  if (existing !== null) {
    const decoded = Buffer.from(existing, "base64");
    if (decoded.length !== 32) throw new Error("The workspace object key is invalid.");
    return decoded;
  }
  const key = randomBytes(32);
  setMeta(db, KEY_META, key.toString("base64"));
  return key;
}

function rowRef(row: ObjectRow): ContentObjectRef {
  return { id: row.id, sha256: row.sha256, sizeBytes: row.size_bytes };
}

/** Immutable, authenticated and streaming private history storage. */
export class ContentObjectStore {
  private readonly objectsRoot: string;
  private readonly tempRoot: string;

  constructor(private readonly db: Database.Database, private readonly privateRoot: string) {
    this.objectsRoot = path.join(privateRoot, "objects");
    this.tempRoot = path.join(privateRoot, "tmp");
  }

  async putFile(sourcePath: string): Promise<ContentObjectRef> {
    await mkdir(this.objectsRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) throw new Error("Only regular files can be snapshotted.");

    const id = randomUUID();
    const nonce = randomBytes(NONCE_BYTES);
    const tempPath = path.join(this.tempRoot, `${id}.partial`);
    const relativeObjectPath = path.posix.join("objects", `${id}.aobj`);
    const finalPath = path.join(this.privateRoot, ...relativeObjectPath.split("/"));
    const cipher = createCipheriv("aes-256-gcm", objectKey(this.db), nonce);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const observe = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });

    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(Buffer.concat([MAGIC, nonce]));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await pipeline(
        createReadStream(sourcePath),
        observe,
        cipher,
        createWriteStream(tempPath, { flags: "a", mode: 0o600 }),
      );
      await appendFile(tempPath, cipher.getAuthTag());
      const finished = await open(tempPath, "r+");
      try { await finished.sync(); } finally { await finished.close(); }
      const sha256 = hash.digest("hex");
      const duplicate = this.db
        .prepare("SELECT id, sha256, size_bytes, nonce, relative_object_path FROM content_objects WHERE sha256 = ? AND size_bytes = ?")
        .get(sha256, sizeBytes) as ObjectRow | undefined;
      if (duplicate !== undefined) {
        await rm(tempPath, { force: true });
        return rowRef(duplicate);
      }
      await rename(tempPath, finalPath);
      this.db.prepare(
        `INSERT INTO content_objects(id, sha256, size_bytes, encryption_version, nonce, relative_object_path)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run(id, sha256, sizeBytes, nonce, relativeObjectPath);
      return { id, sha256, sizeBytes };
    } catch (error) {
      await rm(tempPath, { force: true });
      await rm(finalPath, { force: true });
      throw error;
    }
  }

  async restoreTo(objectId: string, destinationPath: string): Promise<ContentObjectRef> {
    const row = this.db
      .prepare("SELECT id, sha256, size_bytes, nonce, relative_object_path FROM content_objects WHERE id = ?")
      .get(objectId) as ObjectRow | undefined;
    if (row === undefined) throw new Error("The saved content object no longer exists.");
    const objectPath = path.join(this.privateRoot, ...row.relative_object_path.split("/"));
    await mkdir(path.dirname(destinationPath), { recursive: true });
    const tempPath = `${destinationPath}.${randomUUID()}.partial`;
    const objectStat = await stat(objectPath);
    const headerBytes = MAGIC.length + NONCE_BYTES;
    if (objectStat.size < headerBytes + TAG_BYTES) throw new Error("The saved content object is damaged.");
    const source = await open(objectPath, "r");
    const header = Buffer.alloc(headerBytes);
    const tag = Buffer.alloc(TAG_BYTES);
    try {
      await source.read(header, 0, header.length, 0);
      await source.read(tag, 0, tag.length, objectStat.size - TAG_BYTES);
    } finally {
      await source.close();
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("The saved content object is damaged.");
    const nonce = header.subarray(MAGIC.length);
    if (!nonce.equals(row.nonce)) throw new Error("The saved content object nonce does not match its record.");
    const decipher = createDecipheriv("aes-256-gcm", objectKey(this.db), nonce);
    decipher.setAuthTag(tag);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const observe = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
    });
    try {
      await pipeline(
        createReadStream(objectPath, { start: headerBytes, end: objectStat.size - TAG_BYTES - 1 }),
        decipher,
        observe,
        createWriteStream(tempPath, { flags: "wx", mode: 0o600 }),
      );
      const digest = hash.digest("hex");
      if (digest !== row.sha256 || sizeBytes !== row.size_bytes) {
        throw new Error("The saved content object failed its integrity check.");
      }
      const finished = await open(tempPath, "r+");
      try { await finished.sync(); } finally { await finished.close(); }
      await rename(tempPath, destinationPath);
      return rowRef(row);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
  }

  /** Open a verified plaintext stream without exposing the object key or path. */
  async readStream(objectId: string): Promise<{ stream: Readable; ref: ContentObjectRef }> {
    const row = this.db
      .prepare("SELECT id, sha256, size_bytes, nonce, relative_object_path FROM content_objects WHERE id = ?")
      .get(objectId) as ObjectRow | undefined;
    if (row === undefined) throw new Error("The saved content object no longer exists.");
    const objectPath = path.join(this.privateRoot, ...row.relative_object_path.split("/"));
    const objectStat = await stat(objectPath);
    const headerBytes = MAGIC.length + NONCE_BYTES;
    if (objectStat.size < headerBytes + TAG_BYTES) throw new Error("The saved content object is damaged.");
    const source = await open(objectPath, "r");
    const header = Buffer.alloc(headerBytes);
    const tag = Buffer.alloc(TAG_BYTES);
    try {
      await source.read(header, 0, header.length, 0);
      await source.read(tag, 0, tag.length, objectStat.size - TAG_BYTES);
    } finally {
      await source.close();
    }
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("The saved content object is damaged.");
    const nonce = header.subarray(MAGIC.length);
    if (!nonce.equals(row.nonce)) throw new Error("The saved content object nonce does not match its record.");

    const decipher = createDecipheriv("aes-256-gcm", objectKey(this.db), nonce);
    decipher.setAuthTag(tag);
    const hash = createHash("sha256");
    let sizeBytes = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        sizeBytes += chunk.length;
        callback(null, chunk);
      },
      flush(callback) {
        const valid = sizeBytes === row.size_bytes && hash.digest("hex") === row.sha256;
        callback(valid ? undefined : new Error("The saved content object failed its integrity check."));
      },
    });
    const output = new PassThrough();
    void pipeline(
      createReadStream(objectPath, { start: headerBytes, end: objectStat.size - TAG_BYTES - 1 }),
      decipher,
      verify,
      output,
    ).catch((error: unknown) => output.destroy(error instanceof Error ? error : new Error(String(error))));
    return { stream: output, ref: rowRef(row) };
  }

  async readBuffer(objectId: string): Promise<Buffer> {
    const opened = await this.readStream(objectId);
    const chunks: Buffer[] = [];
    for await (const chunk of opened.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  addReference(ownerType: string, ownerId: string, objectId: string, role: string): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO content_object_refs(owner_type, owner_id, object_id, role)
       VALUES (?, ?, ?, ?)`,
    ).run(ownerType, ownerId, objectId, role);
  }

  async collectGarbage(): Promise<number> {
    const rows = this.db.prepare(
      `SELECT id, relative_object_path FROM content_objects
       WHERE NOT EXISTS (SELECT 1 FROM content_object_refs r WHERE r.object_id = content_objects.id)
         AND NOT EXISTS (SELECT 1 FROM agent_run_files f WHERE f.baseline_object_id = content_objects.id)`,
    ).all() as Array<{ id: string; relative_object_path: string }>;
    let removed = 0;
    for (const row of rows) {
      await rm(path.join(this.privateRoot, ...row.relative_object_path.split("/")), { force: true });
      this.db.prepare("DELETE FROM content_objects WHERE id = ?").run(row.id);
      removed += 1;
    }
    return removed;
  }
}
