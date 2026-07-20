import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

import { FilesystemBackend } from "./backend.js";
import type { ObjectBackend } from "./backend.js";

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
  private readonly backend: ObjectBackend;

  /**
   * Accepts either a directory path - the ordinary local case - or any backend
   * implementing the same contract, which is how the server keeps objects in
   * Postgres without a second copy of this logic.
   */
  constructor(backendOrRoot: ObjectBackend | string) {
    this.backend =
      typeof backendOrRoot === "string" ? new FilesystemBackend(backendOrRoot) : backendOrRoot;
  }

  /** Where a filesystem-backed store keeps a given id. Tests use this. */
  pathFor(id: ObjectId): string {
    if (!(this.backend instanceof FilesystemBackend)) {
      throw new Error("pathFor is only meaningful for a filesystem-backed store");
    }
    return this.backend.pathFor(id);
  }

  async has(id: ObjectId): Promise<boolean> {
    return this.backend.has(id);
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

    // Identical content is already stored under this exact name. Nothing to do.
    if (await this.has(id)) return id;

    await this.backend.write(id, deflateSync(framed));
    return id;
  }

  /**
   * Store bytes that are already framed and compressed.
   *
   * Used when receiving a push: the sender has the framed bytes, and re-framing
   * them would be wasted work. The id is still verified against the content, so
   * a client cannot file an object under a name that does not match it.
   */
  async writeRaw(id: ObjectId, compressed: Buffer): Promise<void> {
    if (await this.has(id)) return;

    let framed: Buffer;
    try {
      framed = inflateSync(compressed);
    } catch {
      throw new CorruptObjectError(`object ${id} could not be decompressed`);
    }

    if (hash(framed) !== id) {
      throw new CorruptObjectError(`object does not hash to ${id} - refusing to store it`);
    }

    // Validates the header too, so a malformed object is rejected on arrival
    // rather than discovered later by whoever tries to read it.
    unframe(framed);

    await this.backend.write(id, compressed);
  }

  /** The stored bytes exactly as held, for sending during a push. */
  async readRaw(id: ObjectId): Promise<Buffer> {
    const bytes = await this.backend.read(id);
    if (!bytes) throw new ObjectNotFoundError(id);
    return bytes;
  }

  /** Read an object back, verifying it hashes to the id it is filed under. */
  async read(id: ObjectId): Promise<{ type: ObjectType; payload: Buffer }> {
    const compressed = await this.backend.read(id);
    if (!compressed) throw new ObjectNotFoundError(id);

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
    return this.backend.list();
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
