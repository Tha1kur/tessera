import { promises as fs } from "node:fs";
import * as path from "node:path";

import { isBinary } from "./../diff.js";
import { clearMergeHead, readMergeHead, writeConflicts, writeMergeHead } from "./../mergestate.js";
import { mergeLines, renderMerge } from "./../merge.js";
import type { ObjectId } from "./../objects/types.js";
import { RefStore } from "./../refs.js";
import type { Repository } from "./../repository.js";
import { Index } from "./../staging.js";
import { status } from "./../status.js";
import { readCommitFiles, readCommitFilesOrEmpty } from "./../trees.js";
import type { FlatEntry } from "./../trees.js";
import { removeFileAndEmptyParents, writeWorktreeFile } from "./../worktree.js";
import { checkout } from "./checkout.js";
import { commit } from "./commit.js";
import { mergeBase } from "./log.js";

export { clearMergeHead, isMerging, readMergeHead, writeMergeHead } from "./../mergestate.js";

export class MergeInProgressError extends Error {
  constructor() {
    super("a merge is already in progress - resolve the conflicts and commit, or abort it");
    this.name = "MergeInProgressError";
  }
}

export class UnrelatedHistoriesError extends Error {
  constructor() {
    super("these branches share no common ancestor, so there is nothing to merge against");
    this.name = "UnrelatedHistoriesError";
  }
}

export type MergeOutcome = "up-to-date" | "fast-forward" | "merged" | "conflicted";

export interface ConflictedFile {
  readonly path: string;
  /** How the conflict arose, so the message can be specific. */
  readonly reason: "content" | "binary" | "modified-and-deleted";
}

export interface MergeReport {
  readonly outcome: MergeOutcome;
  readonly target: ObjectId;
  readonly base: ObjectId | null;
  readonly commit: ObjectId | null;
  readonly merged: readonly string[];
  readonly conflicts: readonly ConflictedFile[];
}

/** Abandon an in-progress merge and return to the pre-merge commit. */
export async function abortMerge(repository: Repository): Promise<void> {
  const mergeHead = await readMergeHead(repository);
  if (!mergeHead) throw new Error("there is no merge in progress");

  const refs = new RefStore(repository);
  const head = await refs.headCommit();
  /* c8 ignore next - a merge cannot start without a HEAD commit. */
  if (!head) throw new Error("cannot abort: this repository has no commits");

  await clearMergeHead(repository);
  await checkout(repository, head, { force: true });
}

/* -------------------------------------------------------------------------- */
/* The merge itself                                                           */
/* -------------------------------------------------------------------------- */

export interface MergeOptions {
  /** Record a merge commit even when a fast-forward would do. */
  readonly noFastForward?: boolean;
  readonly message?: string;
}

/**
 * Merge another branch or commit into the current one.
 *
 * Three cases, and telling them apart is most of the work:
 *
 *   1. The target is already an ancestor of HEAD - nothing to do.
 *   2. HEAD is an ancestor of the target - no merge is needed at all, the
 *      branch pointer just moves forward. This is a fast-forward, and it is
 *      why a tidy history often has no merge commits in it.
 *   3. Both sides moved since they diverged - a real three-way merge.
 */
export async function merge(
  repository: Repository,
  target: string,
  options: MergeOptions = {},
): Promise<MergeReport> {
  if (await readMergeHead(repository)) throw new MergeInProgressError();

  const refs = new RefStore(repository);
  const head = await refs.headCommit();
  if (!head) throw new Error("cannot merge: this repository has no commits yet");

  const report = await status(repository);
  if (report.staged.length > 0 || report.unstaged.length > 0) {
    throw new Error("commit or discard your changes before merging");
  }

  const targetCommit = await refs.resolve(target);
  const base = await mergeBase(repository, head, targetCommit);
  if (!base) throw new UnrelatedHistoriesError();

  if (targetCommit === head || base === targetCommit) {
    return { outcome: "up-to-date", target: targetCommit, base, commit: head, merged: [], conflicts: [] };
  }

  if (base === head && !options.noFastForward) {
    // Our history is entirely contained in theirs. Moving the pointer is not a
    // shortcut - it is the complete and correct answer.
    await checkout(repository, target, { force: true });
    return {
      outcome: "fast-forward",
      target: targetCommit,
      base,
      commit: targetCommit,
      merged: [],
      conflicts: [],
    };
  }

  return threeWayMerge(repository, {
    head,
    targetCommit,
    base,
    targetLabel: target,
    ...(options.message ? { message: options.message } : {}),
  });
}

interface ThreeWayContext {
  readonly head: ObjectId;
  readonly targetCommit: ObjectId;
  readonly base: ObjectId;
  readonly targetLabel: string;
  readonly message?: string;
}

async function threeWayMerge(repository: Repository, context: ThreeWayContext): Promise<MergeReport> {
  const baseFiles = await readCommitFilesOrEmpty(repository, context.base);
  const ourFiles = await readCommitFiles(repository, context.head);
  const theirFiles = await readCommitFiles(repository, context.targetCommit);

  const index = await Index.load(repository);
  const allPaths = [...new Set([...baseFiles.keys(), ...ourFiles.keys(), ...theirFiles.keys()])].sort();

  const merged: string[] = [];
  const conflicts: ConflictedFile[] = [];

  for (const filePath of allPaths) {
    const ancestor = baseFiles.get(filePath);
    const ours = ourFiles.get(filePath);
    const theirs = theirFiles.get(filePath);

    // Both sides agree, whether that means the same content or both deleting.
    if (ours?.id === theirs?.id && ours?.mode === theirs?.mode) continue;

    // Only they touched it. Take their version wholesale.
    if (sameEntry(ancestor, ours)) {
      await applySide(repository, index, filePath, theirs);
      merged.push(filePath);
      continue;
    }

    // Only we touched it. Ours already stands; nothing to write.
    if (sameEntry(ancestor, theirs)) continue;

    // Both changed it. One side deleting while the other edits is not something
    // a machine should silently resolve - deleting someone's work is a decision.
    if (!ours || !theirs) {
      conflicts.push({ path: filePath, reason: "modified-and-deleted" });
      if (ours) await stageNothing(repository, filePath, ours);
      continue;
    }

    const ourContents = await repository.objects.readBlob(ours.id);
    const theirContents = await repository.objects.readBlob(theirs.id);
    const baseContents = ancestor ? await repository.objects.readBlob(ancestor.id) : Buffer.alloc(0);

    if (isBinary(ourContents) || isBinary(theirContents)) {
      // There are no lines to merge, so there is no sensible automatic answer.
      conflicts.push({ path: filePath, reason: "binary" });
      continue;
    }

    const result = mergeLines(
      splitPreservingShape(baseContents.toString("utf8")),
      splitPreservingShape(ourContents.toString("utf8")),
      splitPreservingShape(theirContents.toString("utf8")),
    );

    const text = renderMerge(result, { ourLabel: "ours", theirLabel: context.targetLabel });
    await writeWorktreeFile(repository, filePath, Buffer.from(text, "utf8"), ours.mode);

    if (result.clean) {
      const id = await repository.objects.writeBlob(Buffer.from(text, "utf8"));
      await stage(repository, index, filePath, id, ours.mode);
      merged.push(filePath);
    } else {
      // The file stays tracked, staged at our version, while the working copy
      // carries the markers. That combination is what makes `status` report it
      // as modified-but-unstaged - pointing the user straight at the work left
      // to do - instead of it vanishing into the untracked pile.
      await stageConflicted(repository, index, filePath, ours, ourContents.byteLength);
      conflicts.push({ path: filePath, reason: "content" });
    }
  }

  await index.save();

  if (conflicts.length > 0) {
    await writeMergeHead(repository, context.targetCommit);
    await writeConflicts(repository, conflicts.map((conflict) => conflict.path));
    return {
      outcome: "conflicted",
      target: context.targetCommit,
      base: context.base,
      commit: null,
      merged: merged.sort(),
      conflicts,
    };
  }

  const created = await commit(repository, {
    message: context.message ?? `Merge ${context.targetLabel}`,
    allowEmpty: true,
    extraParents: [context.targetCommit],
  });

  return {
    outcome: "merged",
    target: context.targetCommit,
    base: context.base,
    commit: created.id,
    merged: merged.sort(),
    conflicts: [],
  };
}

function sameEntry(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.mode === b.mode;
}

function splitPreservingShape(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function applySide(
  repository: Repository,
  index: Index,
  filePath: string,
  side: FlatEntry | undefined,
): Promise<void> {
  if (!side) {
    await removeFileAndEmptyParents(repository, filePath);
    index.remove(filePath);
    return;
  }

  const contents = await repository.objects.readBlob(side.id);
  await writeWorktreeFile(repository, filePath, contents, side.mode);
  await stage(repository, index, filePath, side.id, side.mode);
}

async function stage(
  repository: Repository,
  index: Index,
  filePath: string,
  id: ObjectId,
  mode: FlatEntry["mode"],
): Promise<void> {
  const stats = await fs.stat(path.join(repository.workingDirectory, ...filePath.split("/")));
  index.add({ path: filePath, id, mode, size: stats.size, modifiedAt: Math.floor(stats.mtimeMs) });
}

/**
 * Stage our side of a conflicted file without claiming the working copy matches.
 *
 * The usual `stage` records the size and mtime of the file on disk, which is a
 * cache meaning "the working copy is identical to this entry". For a conflicted
 * file that would be a lie - the working copy holds conflict markers, not our
 * blob. Recording the blob's own length and a zero mtime keeps the entry
 * honest, so `status` reports the file as modified and a forced checkout knows
 * it must actually rewrite it.
 */
async function stageConflicted(
  repository: Repository,
  index: Index,
  filePath: string,
  ours: FlatEntry,
  blobLength: number,
): Promise<void> {
  void repository;
  index.add({ path: filePath, id: ours.id, mode: ours.mode, size: blobLength, modifiedAt: 0 });
}

/** Leave our version on disk for a modify/delete conflict, but unstaged. */
async function stageNothing(repository: Repository, filePath: string, ours: FlatEntry): Promise<void> {
  const contents = await repository.objects.readBlob(ours.id);
  await writeWorktreeFile(repository, filePath, contents, ours.mode);
}
