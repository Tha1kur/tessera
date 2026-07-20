/**
 * The three kinds of object Tessera stores. Everything in a repository's
 * history is one of these, addressed by the SHA-256 of its own bytes.
 *
 *   blob   - the raw contents of a single file
 *   tree   - a directory listing: names pointing at blobs and other trees
 *   commit - a snapshot: one root tree, plus who/when/why and what came before
 */
export type ObjectType = "blob" | "tree" | "commit";

/** A 64-character lowercase hex SHA-256 digest. */
export type ObjectId = string;

/**
 * File modes. Tessera only needs to distinguish the three cases that change
 * how an entry is restored to disk, so it keeps the POSIX-ish octal strings
 * rather than inventing its own vocabulary.
 */
export const FileMode = {
  Directory: "040000",
  Regular: "100644",
  Executable: "100755",
} as const;

export type FileMode = (typeof FileMode)[keyof typeof FileMode];

/** One line of a tree object: a single child, file or directory. */
export interface TreeEntry {
  readonly mode: FileMode;
  readonly type: Exclude<ObjectType, "commit">;
  readonly id: ObjectId;
  /** Bare name of the child - never a path, never contains a separator. */
  readonly name: string;
}

/** Who did a thing, and when. */
export interface Identity {
  readonly name: string;
  readonly email: string;
  /** Milliseconds since the Unix epoch. */
  readonly timestamp: number;
  /** Minutes offset from UTC, matching Date#getTimezoneOffset's sign. */
  readonly timezoneOffset: number;
}

/** A commit: the immutable record of one snapshot of the project. */
export interface CommitObject {
  readonly tree: ObjectId;
  /**
   * Parent commits. Empty for the very first commit in a repository, one for
   * an ordinary commit, two or more for a merge.
   */
  readonly parents: readonly ObjectId[];
  readonly author: Identity;
  readonly committer: Identity;
  readonly message: string;
}

/** A commit paired with its own id, for when callers need both. */
export interface Commit extends CommitObject {
  readonly id: ObjectId;
}
