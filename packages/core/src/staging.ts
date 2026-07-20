import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { FileMode, ObjectId } from "./objects/types.js";
import type { Repository } from "./repository.js";

/** One staged path: which blob it points at, and how it looked when staged. */
export interface IndexEntry {
  /** Repo-relative, forward-slashed. */
  readonly path: string;
  readonly id: ObjectId;
  readonly mode: FileMode;
  readonly size: number;
  /** Modification time when staged, used to skip re-hashing unchanged files. */
  readonly modifiedAt: number;
}

interface IndexFile {
  version: number;
  entries: IndexEntry[];
}

const INDEX_VERSION = 1;

/**
 * The staging area - the thing that makes a commit a deliberate act.
 *
 * Without it, a commit could only ever mean "everything currently on disk".
 * The index is a third state sitting between the last commit and the working
 * directory, which is what lets you stage two of the five files you touched and
 * commit only those.
 *
 * Each entry caches the size and mtime the file had when it was staged. That
 * cache is purely an optimisation: if neither has changed, the file's contents
 * almost certainly have not either, and hashing it again can be skipped. When
 * the cache is wrong the worst outcome is that Tessera re-hashes a file it did
 * not need to - never that it records the wrong contents, because the id it
 * stores is always derived from bytes actually read.
 */
export class Index {
  private entries: Map<string, IndexEntry>;

  private constructor(
    private readonly repository: Repository,
    entries: IndexEntry[],
  ) {
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
  }

  static async load(repository: Repository): Promise<Index> {
    try {
      const raw = await fs.readFile(repository.internal("index"), "utf8");
      const parsed = JSON.parse(raw) as IndexFile;

      if (parsed.version !== INDEX_VERSION) {
        throw new Error(`unsupported index version ${parsed.version}; expected ${INDEX_VERSION}`);
      }

      return new Index(repository, parsed.entries ?? []);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Index(repository, []);
      throw error;
    }
  }

  async save(): Promise<void> {
    const file: IndexFile = { version: INDEX_VERSION, entries: this.all() };
    const destination = this.repository.internal("index");
    const temporary = `${destination}.${process.pid}.tmp`;

    try {
      await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, "utf8");
      await fs.rename(temporary, destination);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get(entryPath: string): IndexEntry | undefined {
    return this.entries.get(entryPath);
  }

  has(entryPath: string): boolean {
    return this.entries.has(entryPath);
  }

  /** Every entry, sorted by path so the index file has a stable diff. */
  all(): IndexEntry[] {
    return [...this.entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  paths(): string[] {
    return this.all().map((entry) => entry.path);
  }

  add(entry: IndexEntry): void {
    this.entries.set(entry.path, entry);
  }

  remove(entryPath: string): boolean {
    return this.entries.delete(entryPath);
  }

  /**
   * Drop every entry under a directory prefix, for `remove src/` and friends.
   * Returns the paths that were removed.
   */
  removeUnder(prefix: string): string[] {
    const normalised = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const removed: string[] = [];

    for (const entryPath of this.entries.keys()) {
      if (entryPath === prefix || entryPath.startsWith(normalised)) {
        this.entries.delete(entryPath);
        removed.push(entryPath);
      }
    }

    return removed.sort();
  }

  clear(): void {
    this.entries.clear();
  }

  /** Replace the whole index, used when checking out a different commit. */
  replaceWith(entries: readonly IndexEntry[]): void {
    this.entries = new Map(entries.map((entry) => [entry.path, entry]));
  }
}

/** Delete the index file entirely. */
export async function discardIndex(repository: Repository): Promise<void> {
  await fs.rm(repository.internal("index"), { force: true });
}

/** True when a file on disk looks unchanged since it was staged. */
export function looksUnchanged(entry: IndexEntry, stats: { size: number; mtimeMs: number }): boolean {
  return entry.size === stats.size && entry.modifiedAt === Math.floor(stats.mtimeMs);
}

/** Directory portion of a repo-relative path, or "" for a top-level file. */
export function parentOf(entryPath: string): string {
  const slash = entryPath.lastIndexOf("/");
  return slash === -1 ? "" : entryPath.slice(0, slash);
}

/** Absolute location of a staged path in the working tree. */
export function absolutePathOf(repository: Repository, entry: IndexEntry): string {
  return path.join(repository.workingDirectory, ...entry.path.split("/"));
}
