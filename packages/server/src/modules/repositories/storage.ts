import type { ObjectBackend, ObjectId } from "@tessera/core";
import { ObjectStore } from "@tessera/core";

import { prisma } from "../../lib/db.js";

/**
 * Object storage backed by Postgres.
 *
 * The engine was written against a filesystem, and nothing about it has changed
 * to support this: it asks an `ObjectBackend` for bytes by name, and this is
 * one. Blobs, trees, commits, hashing, verification and diffing all remain in
 * the engine, with no second implementation to keep in step.
 *
 * The database rather than a disk, because the API runs on containers whose
 * filesystem is wiped on every deploy. Storing history there would mean losing
 * every repository the next time the service restarted.
 */
export class PostgresBackend implements ObjectBackend {
  constructor(private readonly repositoryId: string) {}

  async has(id: ObjectId): Promise<boolean> {
    const found = await prisma.gitObject.findUnique({
      where: { repositoryId_id: { repositoryId: this.repositoryId, id } },
      // Only the key is selected: this asks "does it exist", and pulling the
      // bytes back to answer that would be wasteful on large blobs.
      select: { id: true },
    });
    return found !== null;
  }

  async read(id: ObjectId): Promise<Buffer | null> {
    const row = await prisma.gitObject.findUnique({
      where: { repositoryId_id: { repositoryId: this.repositoryId, id } },
      select: { bytes: true },
    });
    return row ? Buffer.from(row.bytes) : null;
  }

  async write(id: ObjectId, bytes: Buffer): Promise<void> {
    // The id is the hash of the content, so a repeated write is the identical
    // object. `skipDuplicates` turns a re-push into a no-op instead of an
    // error, which is what makes pushing idempotent.
    await prisma.gitObject.createMany({
      // Prisma's Bytes maps to Uint8Array; a Buffer is one, but its backing
      // ArrayBufferLike is wider than the type Prisma declares.
      data: [{ repositoryId: this.repositoryId, id, bytes: new Uint8Array(bytes) }],
      skipDuplicates: true,
    });
  }

  async list(): Promise<ObjectId[]> {
    const rows = await prisma.gitObject.findMany({
      where: { repositoryId: this.repositoryId },
      select: { id: true },
    });
    return rows.map((row) => row.id);
  }

  /** Store many objects at once, for receiving a push. */
  async writeMany(objects: readonly { id: ObjectId; bytes: Buffer }[]): Promise<number> {
    if (objects.length === 0) return 0;

    const result = await prisma.gitObject.createMany({
      data: objects.map((object) => ({
        repositoryId: this.repositoryId,
        id: object.id,
        bytes: new Uint8Array(object.bytes),
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}

/** An engine object store reading and writing one repository's rows. */
export function storeFor(repositoryId: string): ObjectStore {
  return new ObjectStore(new PostgresBackend(repositoryId));
}

/** Where a branch points, or null if the repository has no such branch. */
export async function readRef(repositoryId: string, name: string): Promise<ObjectId | null> {
  const ref = await prisma.gitRef.findUnique({
    where: { repositoryId_name: { repositoryId, name } },
    select: { commitId: true },
  });
  return ref?.commitId ?? null;
}

export async function listRefs(repositoryId: string): Promise<{ name: string; commitId: string }[]> {
  return prisma.gitRef.findMany({
    where: { repositoryId },
    select: { name: true, commitId: true },
    orderBy: { name: "asc" },
  });
}

export async function writeRef(repositoryId: string, name: string, commitId: string): Promise<void> {
  await prisma.gitRef.upsert({
    where: { repositoryId_name: { repositoryId, name } },
    create: { repositoryId, name, commitId },
    update: { commitId },
  });
}
