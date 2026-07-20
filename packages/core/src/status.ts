import { promises as fs } from "node:fs";
import * as path from "node:path";

import { readMergeHead } from "./mergestate.js";
import { idFor } from "./objects/store.js";
import type { ObjectId } from "./objects/types.js";
import { RefStore } from "./refs.js";
import type { HeadState } from "./refs.js";
import type { Repository } from "./repository.js";
import { Index, looksUnchanged } from "./staging.js";
import { readCommitFilesOrEmpty } from "./trees.js";
import { scanWorktree } from "./worktree.js";

export type ChangeKind = "added" | "modified" | "deleted";

export interface Change {
  readonly path: string;
  readonly kind: ChangeKind;
}

export interface StatusReport {
  readonly head: HeadState;
  readonly headCommit: ObjectId | null;
  /** Differences between the last commit and the index: what would be committed. */
  readonly staged: readonly Change[];
  /** Differences between the index and the working tree: edits not yet staged. */
  readonly unstaged: readonly Change[];
  /** Files present on disk that are neither ignored nor staged. */
  readonly untracked: readonly string[];
  /** The commit being merged in, when a merge stopped for conflicts. */
  readonly mergingWith: ObjectId | null;
}

export function isClean(report: StatusReport): boolean {
  return report.staged.length === 0 && report.unstaged.length === 0 && report.untracked.length === 0;
}

/**
 * Compare the three states a file can be in - committed, staged, on disk - and
 * report where they disagree.
 *
 * Splitting the answer into "staged" and "unstaged" is not presentation. They
 * answer genuinely different questions: staged is *what the next commit will
 * contain*, unstaged is *what you would lose if you committed right now*.
 */
export async function status(repository: Repository): Promise<StatusReport> {
  const refs = new RefStore(repository);
  const head = await refs.readHead();
  const headCommit = await refs.headCommit();

  const mergingWith = await readMergeHead(repository);
  const committed = await readCommitFilesOrEmpty(repository, headCommit);
  const index = await Index.load(repository);
  const worktree = new Map((await scanWorktree(repository)).map((file) => [file.path, file]));

  const staged: Change[] = [];
  const unstaged: Change[] = [];
  const untracked: string[] = [];

  /* Committed vs index. */
  for (const entry of index.all()) {
    const previous = committed.get(entry.path);
    if (!previous) {
      staged.push({ path: entry.path, kind: "added" });
    } else if (previous.id !== entry.id || previous.mode !== entry.mode) {
      staged.push({ path: entry.path, kind: "modified" });
    }
  }
  for (const committedPath of committed.keys()) {
    if (!index.has(committedPath)) staged.push({ path: committedPath, kind: "deleted" });
  }

  /* Index vs working tree. */
  for (const entry of index.all()) {
    const onDisk = worktree.get(entry.path);

    if (!onDisk) {
      unstaged.push({ path: entry.path, kind: "deleted" });
      continue;
    }

    // The size/mtime cache lets an unchanged file skip being read entirely.
    if (looksUnchanged(entry, { size: onDisk.size, mtimeMs: onDisk.modifiedAt })) {
      if (onDisk.mode !== entry.mode) unstaged.push({ path: entry.path, kind: "modified" });
      continue;
    }

    const contents = await fs.readFile(path.join(repository.workingDirectory, ...entry.path.split("/")));
    if (idFor("blob", contents) !== entry.id || onDisk.mode !== entry.mode) {
      unstaged.push({ path: entry.path, kind: "modified" });
    }
  }

  /* Anything on disk we have never been told about. */
  for (const filePath of worktree.keys()) {
    if (!index.has(filePath)) untracked.push(filePath);
  }

  const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  return {
    head,
    headCommit,
    mergingWith,
    staged: staged.sort(byPath),
    unstaged: unstaged.sort(byPath),
    untracked: untracked.sort(),
  };
}
