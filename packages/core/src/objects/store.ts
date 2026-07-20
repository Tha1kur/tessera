import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import {
  CorruptObjectError,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  frame,
  unframe,
} from "./codec.js";
import type { CommitObject, ObjectId, ObjectType, TreeEntry } from "./types.js";

export class ObjectNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`object not found: ${id}`);
    this.name = "ObjectNotFoundError";
  }
}

export class AmbiguousObjectIdError extends Error {
  constructor(
    public readonly prefix: string,
    public readonly matches: readonly ObjectId[],
  ) {
    super(`object id "${prefix}" is ambiguous - it matches ${matches.length} objects`);
    this.name = "AmbiguousObjectIdError";
  }
}

/** The SHA-256 of some bytes, as lowercase hex. */
export function hash(data: Buffer): ObjectId {
  return createHash("sha256").update(data).digest("hex");
}

/** The id an object *would* have, without writing anything. */
export function idFor(type: ObjectType, payload: Buffer): ObjectId {
  return hash(frame(type, payload));
}

const MIN_ABBREVIATION = 4;

/**
 * The content-addressed object database.
 *
 * Objects live at `objects/<first 2 hex chars>/<remaining 62>`, deflated. The
 * two-character fan-out keeps any single directory from collecting hundreds of
 * thousands of entries, which is where most filesystems start to struggle.
 *
 * Two properties fall out of addressing objects by their own hash, and both
 * matter more than they first appear:
 *
 *   - Writes are idempotent. Committing an unchanged file re-derives the same
 *     id and the existing object is left alone, so storage grows with the
 *     amount of *distinct* content, not with the number of commits.
 *   - Storage is tamper-evident. If a stored object's bytes ever stop hashing
 *     to the name they are filed under, the corruption is detectable, which is
 *     exactly what `verify` checks.
 */
export class ObjectStore {
  constructor(private readonly root: string) {}

  /** Absolute path at which a given id is (or would be) stored. */
  pathFor(id: ObjectId): string {
    return path.join(this.root, id.slice(0, 2), id.slice(2));
  }

  async has(id: ObjectId): Promise<boolean> {
    try {
      await fs.access(this.pathFor(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Store a payload and return its id.
   *
   * The write goes to a temporary file first and is then renamed into place.
   * Rename is atomic on POSIX filesystems, so a reader can never observe a
   * half-written object - it either does not exist yet or is complete.
   */
  async write(type: ObjectType, payload: Buffer): Promise<ObjectId> {
    const framed = frame(type, payload);
    const id = hash(framed);
    const destination = this.pathFor(id);

    // Identical content is already stored under this exact name. Nothing to do.
    if (await this.has(id)) return id;

    await fs.mkdir(path.dirname(destination), { recursive: true });

    const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, deflateSync(framed), { flag: "wx" });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }

    return id;
  }

  /** Read an object back, verifying it hashes to the id it is filed under. */
  async read(id: ObjectId): Promise<{ type: ObjectType; payload: Buffer }> {
    let compressed: Buffer;
    try {
      compressed = await fs.readFile(this.pathFor(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectNotFoundError(id);
      throw error;
    }

    let framed: Buffer;
    try {
      framed = inflateSync(compressed);
    } catch {
      throw new CorruptObjectError(`object ${id} could not be decompressed`);
    }

    if (hash(framed) !== id) {
      throw new CorruptObjectError(`object ${id} does not hash to its own name - the store is corrupt`);
    }

    return unframe(framed);
  }

  private async readAs<T extends ObjectType>(id: ObjectId, expected: T): Promise<Buffer> {
    const { type, payload } = await this.read(id);
    if (type !== expected) {
      throw new CorruptObjectError(`expected ${id} to be a ${expected}, but it is a ${type}`);
    }
    return payload;
  }

  writeBlob(contents: Buffer): Promise<ObjectId> {
    return this.write("blob", contents);
  }

  readBlob(id: ObjectId): Promise<Buffer> {
    return this.readAs(id, "blob");
  }

  writeTree(entries: readonly TreeEntry[]): Promise<ObjectId> {
    return this.write("tree", encodeTree(entries));
  }

  async readTree(id: ObjectId): Promise<TreeEntry[]> {
    return decodeTree(await this.readAs(id, "tree"));
  }

  writeCommit(commit: CommitObject): Promise<ObjectId> {
    return this.write("commit", encodeCommit(commit));
  }

  async readCommit(id: ObjectId): Promise<CommitObject> {
    return decodeCommit(await this.readAs(id, "commit"));
  }

  /** Every object id currently in the store. */
  async list(): Promise<ObjectId[]> {
    let fanout: string[];
    try {
      fanout = await fs.readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const ids: ObjectId[] = [];
    for (const prefix of fanout) {
      if (prefix.length !== 2) continue;
      const rest = await fs.readdir(path.join(this.root, prefix));
      for (const suffix of rest) {
        if (suffix.endsWith(".tmp")) continue;
        ids.push(prefix + suffix);
      }
    }
    return ids;
  }

  /**
   * Expand a shortened id, so a human can type the first few characters of a
   * commit instead of all sixty-four. Refuses to guess when the prefix matches
   * more than one object.
   */
  async resolvePrefix(prefix: string): Promise<ObjectId> {
    const normalised = prefix.toLowerCase();

    if (!/^[0-9a-f]+$/.test(normalised) || normalised.length < MIN_ABBREVIATION) {
      throw new ObjectNotFoundError(prefix);
    }
    if (normalised.length === 64) {
      if (!(await this.has(normalised))) throw new ObjectNotFoundError(prefix);
      return normalised;
    }

    const matches = (await this.list()).filter((id) => id.startsWith(normalised));
    if (matches.length === 0) throw new ObjectNotFoundError(prefix);
    if (matches.length > 1) throw new AmbiguousObjectIdError(prefix, matches);
    return matches[0] as ObjectId;
  }

  /** Re-hash every stored object and report the ones that no longer match. */
  async verify(): Promise<{ checked: number; corrupt: ObjectId[] }> {
    const ids = await this.list();
    const corrupt: ObjectId[] = [];

    for (const id of ids) {
      try {
        await this.read(id);
      } catch {
        corrupt.push(id);
      }
    }

    return { checked: ids.length, corrupt };
  }
}
