import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import type { ObjectId } from "./types.js";

/**
 * Where object bytes physically live.
 *
 * The store above this deals in hashing, framing and verification - none of
 * which care whether the bytes end up in a file or a database row. Separating
 * the two is what lets the same engine run as a local CLI writing into `.tess`
 * and as a hosted service writing into Postgres, with one implementation of the
 * actual version control logic rather than two that drift apart.
 *
 * A backend stores opaque bytes under a name and hands them back. It performs
 * no compression, no hashing and no validation: those belong to the layer that
 * knows what the bytes mean.
 */
export interface ObjectBackend {
  has(id: ObjectId): Promise<boolean>;
  /** Stored bytes, or null when nothing is filed under that id. */
  read(id: ObjectId): Promise<Buffer | null>;
  /** Store bytes. Must be idempotent: the id already determines the content. */
  write(id: ObjectId, bytes: Buffer): Promise<void>;
  /** Every id currently stored. */
  list(): Promise<ObjectId[]>;
}

/**
 * Objects as files, at `<root>/<first 2 chars>/<remaining 62>`.
 *
 * The two-character fan-out keeps any one directory from collecting hundreds of
 * thousands of entries, which is where most filesystems begin to struggle.
 */
export class FilesystemBackend implements ObjectBackend {
  constructor(private readonly root: string) {}

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

  async read(id: ObjectId): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.pathFor(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /**
   * Write via a temporary file and a rename.
   *
   * Rename is atomic on POSIX filesystems, so a reader can never observe a
   * half-written object: it either does not exist yet or is complete.
   */
  async write(id: ObjectId, bytes: Buffer): Promise<void> {
    const destination = this.pathFor(id);
    if (await this.has(id)) return;

    await fs.mkdir(path.dirname(destination), { recursive: true });

    const temporary = `${destination}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(temporary, bytes, { flag: "wx" });
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

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
}

/** Objects held in memory. Useful for tests and for streaming a push. */
export class MemoryBackend implements ObjectBackend {
  private readonly objects = new Map<ObjectId, Buffer>();

  async has(id: ObjectId): Promise<boolean> {
    return this.objects.has(id);
  }

  async read(id: ObjectId): Promise<Buffer | null> {
    return this.objects.get(id) ?? null;
  }

  async write(id: ObjectId, bytes: Buffer): Promise<void> {
    this.objects.set(id, bytes);
  }

  async list(): Promise<ObjectId[]> {
    return [...this.objects.keys()];
  }

  get size(): number {
    return this.objects.size;
  }
}
