import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { ObjectId } from "./../objects/types.js";
import { RefStore, isValidBranchName } from "./../refs.js";
import type { Repository } from "./../repository.js";
import { Index, looksUnchanged } from "./../staging.js";
import type { IndexEntry } from "./../staging.js";
import { status } from "./../status.js";
import { readCommitFiles } from "./../trees.js";
import { removeFileAndEmptyParents, writeWorktreeFile } from "./../worktree.js";

export class UncommittedChangesError extends Error {
  constructor(public readonly paths: readonly string[]) {
    super(
      `you have local changes that would be overwritten:\n  ${paths.join("\n  ")}\n` +
        "commit them, or pass force to discard them",
    );
    this.name = "UncommittedChangesError";
  }
}

export interface CheckoutResult {
  readonly commit: ObjectId;
  readonly branch: string | null;
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

export interface CheckoutOptions {
  /** Throw away uncommitted work rather than refusing to switch. */
  readonly force?: boolean;
}

/**
 * Move the working tree to a different commit.
 *
 * Unless forced, this refuses to run when there is uncommitted work, because
 * checkout overwrites files in place and there is no undo for work that was
 * never committed. Refusing is the whole safety story of the command.
 *
 * Naming a branch attaches HEAD to it, so later commits extend that branch.
 * Naming a commit directly detaches HEAD: you can look around and build on
 * that point in history, but no branch is following you.
 */
export async function checkout(
  repository: Repository,
  target: string,
  options: CheckoutOptions = {},
): Promise<CheckoutResult> {
  const refs = new RefStore(repository);

  if (!options.force) {
    const report = await status(repository);
    const risky = [...report.staged, ...report.unstaged].map((change) => change.path);
    if (risky.length > 0) throw new UncommittedChangesError([...new Set(risky)].sort());
  }

  const branch = isValidBranchName(target) && (await refs.readBranch(target)) ? target : null;
  const commit = await refs.resolve(target);

  const desired = await readCommitFiles(repository, commit);
  const index = await Index.load(repository);

  const removed: string[] = [];
  const updated: string[] = [];

  // Remove tracked files that the target commit does not have. Untracked files
  // are left alone - they were never ours to delete.
  for (const entry of index.all()) {
    if (desired.has(entry.path)) continue;
    await removeFileAndEmptyParents(repository, entry.path);
    removed.push(entry.path);
  }

  const nextEntries: IndexEntry[] = [];

  for (const [filePath, file] of desired) {
    const existing = index.get(filePath);
    const absolutePath = path.join(repository.workingDirectory, ...filePath.split("/"));

    // Skip rewriting a file that is already exactly right. Matching the index
    // is not enough on its own: under `force` the file on disk may have been
    // edited since it was staged, and skipping it then would silently keep the
    // very changes the caller asked to discard. The staged size and mtime are
    // what confirm the working copy still matches what the index describes.
    const current = await fs.stat(absolutePath).catch(() => null);
    const alreadyCorrect =
      existing?.id === file.id &&
      existing.mode === file.mode &&
      current !== null &&
      looksUnchanged(existing, { size: current.size, mtimeMs: current.mtimeMs });

    if (!alreadyCorrect) {
      const contents = await repository.objects.readBlob(file.id);
      await writeWorktreeFile(repository, filePath, contents, file.mode);
      updated.push(filePath);
    }

    const stats = await fs.stat(absolutePath);
    nextEntries.push({
      path: filePath,
      id: file.id,
      mode: file.mode,
      size: stats.size,
      modifiedAt: Math.floor(stats.mtimeMs),
    });
  }

  index.replaceWith(nextEntries);
  await index.save();

  if (branch) {
    await refs.attachHead(branch);
  } else {
    await refs.detachHead(commit);
  }

  return { commit, branch, updated: updated.sort(), removed: removed.sort() };
}

/**
 * Restore specific paths from a commit without moving HEAD.
 *
 * This is the everyday "undo my edits to this file" operation, and it is
 * intentionally separate from switching branches: it touches only the paths
 * named, and it always discards, so there is no ambiguity about what it does.
 */
export async function restore(
  repository: Repository,
  pathspecs: readonly string[],
  source = "HEAD",
): Promise<{ restored: string[]; missing: string[] }> {
  const refs = new RefStore(repository);
  const commit = await refs.resolve(source);
  const files = await readCommitFiles(repository, commit);
  const index = await Index.load(repository);

  const restored: string[] = [];
  const missing: string[] = [];

  for (const pathspec of pathspecs) {
    const relative = repository.relative(pathspec);
    const matches = [...files.keys()].filter(
      (filePath) => filePath === relative || filePath.startsWith(`${relative}/`),
    );

    if (matches.length === 0) {
      missing.push(pathspec);
      continue;
    }

    for (const filePath of matches) {
      const file = files.get(filePath);
      /* c8 ignore next - filtered from the same map above. */
      if (!file) continue;

      const contents = await repository.objects.readBlob(file.id);
      await writeWorktreeFile(repository, filePath, contents, file.mode);

      const stats = await fs.stat(path.join(repository.workingDirectory, ...filePath.split("/")));
      index.add({
        path: filePath,
        id: file.id,
        mode: file.mode,
        size: stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
      });
      restored.push(filePath);
    }
  }

  await index.save();
  return { restored: restored.sort(), missing };
}
