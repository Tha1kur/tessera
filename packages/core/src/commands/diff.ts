import { promises as fs } from "node:fs";
import * as path from "node:path";

import { DEFAULT_CONTEXT_LINES, countChanges, diffLines, formatUnifiedDiff, isBinary, splitLines } from "./../diff.js";
import { idFor } from "./../objects/store.js";
import type { FileMode, ObjectId } from "./../objects/types.js";
import { RefStore } from "./../refs.js";
import type { Repository } from "./../repository.js";
import { Index } from "./../staging.js";
import { readCommitFilesOrEmpty } from "./../trees.js";
import { scanWorktree } from "./../worktree.js";

export type FileChangeKind = "added" | "modified" | "deleted";

export interface FileDiff {
  readonly path: string;
  readonly kind: FileChangeKind;
  readonly added: number;
  readonly removed: number;
  readonly binary: boolean;
  /** Unified diff text, empty for binary files. */
  readonly patch: string;
}

/** One side of a comparison: a path pointing at either an id or raw bytes. */
interface Side {
  readonly mode: FileMode;
  readonly id?: ObjectId;
  readonly contents?: Buffer;
}

export interface DiffOptions {
  readonly context?: number;
  /** Restrict the comparison to these repo-relative paths or prefixes. */
  readonly paths?: readonly string[];
}

/**
 * Compare two sets of files and produce a patch per changed path.
 *
 * Files whose ids match are skipped before their contents are ever read. On a
 * large repository that check eliminates almost every path immediately, so the
 * expensive line-by-line work only ever runs on files that genuinely differ.
 */
async function compare(
  repository: Repository,
  before: ReadonlyMap<string, Side>,
  after: ReadonlyMap<string, Side>,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  const context = options.context ?? DEFAULT_CONTEXT_LINES;
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const diffs: FileDiff[] = [];

  for (const filePath of paths) {
    if (options.paths && options.paths.length > 0) {
      const included = options.paths.some(
        (prefix) => filePath === prefix || filePath.startsWith(`${prefix}/`),
      );
      if (!included) continue;
    }

    const oldSide = before.get(filePath);
    const newSide = after.get(filePath);

    if (oldSide && newSide) {
      const oldId = oldSide.id ?? idFor("blob", oldSide.contents ?? Buffer.alloc(0));
      const newId = newSide.id ?? idFor("blob", newSide.contents ?? Buffer.alloc(0));
      if (oldId === newId && oldSide.mode === newSide.mode) continue;
    }

    const oldContents = oldSide ? await resolve(repository, oldSide) : Buffer.alloc(0);
    const newContents = newSide ? await resolve(repository, newSide) : Buffer.alloc(0);
    const kind: FileChangeKind = !oldSide ? "added" : !newSide ? "deleted" : "modified";

    if (isBinary(oldContents) || isBinary(newContents)) {
      diffs.push({ path: filePath, kind, added: 0, removed: 0, binary: true, patch: "" });
      continue;
    }

    const oldText = oldContents.toString("utf8");
    const newText = newContents.toString("utf8");
    const { added, removed } = countChanges(diffLines(splitLines(oldText), splitLines(newText)));

    diffs.push({
      path: filePath,
      kind,
      added,
      removed,
      binary: false,
      patch: formatUnifiedDiff(oldText, newText, {
        oldLabel: oldSide ? `a/${filePath}` : "/dev/null",
        newLabel: newSide ? `b/${filePath}` : "/dev/null",
        context,
      }),
    });
  }

  return diffs;
}

async function resolve(repository: Repository, side: Side): Promise<Buffer> {
  if (side.contents) return side.contents;
  if (side.id) return repository.objects.readBlob(side.id);
  /* c8 ignore next - a Side always carries one or the other. */
  return Buffer.alloc(0);
}

/** What you have changed but not yet staged: index versus working tree. */
export async function diffUnstaged(
  repository: Repository,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  const index = await Index.load(repository);
  const worktree = await scanWorktree(repository);

  const before = new Map<string, Side>(
    index.all().map((entry) => [entry.path, { mode: entry.mode, id: entry.id }]),
  );

  const after = new Map<string, Side>();
  for (const file of worktree) {
    // Untracked files are reported by status, not by diff; a diff against
    // nothing is noise.
    if (!index.has(file.path)) continue;
    const contents = await fs.readFile(path.join(repository.workingDirectory, ...file.path.split("/")));
    after.set(file.path, { mode: file.mode, contents });
  }

  return compare(repository, before, after, options);
}

/** What the next commit would contain: last commit versus index. */
export async function diffStaged(repository: Repository, options: DiffOptions = {}): Promise<FileDiff[]> {
  const refs = new RefStore(repository);
  const committed = await readCommitFilesOrEmpty(repository, await refs.headCommit());
  const index = await Index.load(repository);

  const before = new Map<string, Side>(
    [...committed.values()].map((file) => [file.path, { mode: file.mode, id: file.id }]),
  );
  const after = new Map<string, Side>(
    index.all().map((entry) => [entry.path, { mode: entry.mode, id: entry.id }]),
  );

  return compare(repository, before, after, options);
}

/** What changed between two points in history. */
export async function diffCommits(
  repository: Repository,
  from: string,
  to: string,
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  const refs = new RefStore(repository);

  const beforeFiles = await readCommitFilesOrEmpty(repository, await refs.resolve(from));
  const afterFiles = await readCommitFilesOrEmpty(repository, await refs.resolve(to));

  const before = new Map<string, Side>(
    [...beforeFiles.values()].map((file) => [file.path, { mode: file.mode, id: file.id }]),
  );
  const after = new Map<string, Side>(
    [...afterFiles.values()].map((file) => [file.path, { mode: file.mode, id: file.id }]),
  );

  return compare(repository, before, after, options);
}

/** What a single commit introduced, compared against its first parent. */
export async function diffCommit(
  repository: Repository,
  revision = "HEAD",
  options: DiffOptions = {},
): Promise<FileDiff[]> {
  const refs = new RefStore(repository);
  const id = await refs.resolve(revision);
  const commit = await repository.objects.readCommit(id);
  const parent = commit.parents[0];

  const afterFiles = await readCommitFilesOrEmpty(repository, id);
  const beforeFiles = await readCommitFilesOrEmpty(repository, parent ?? null);

  const before = new Map<string, Side>(
    [...beforeFiles.values()].map((file) => [file.path, { mode: file.mode, id: file.id }]),
  );
  const after = new Map<string, Side>(
    [...afterFiles.values()].map((file) => [file.path, { mode: file.mode, id: file.id }]),
  );

  return compare(repository, before, after, options);
}

/** Aggregate line counts across a set of file diffs. */
export function summarise(diffs: readonly FileDiff[]): { files: number; added: number; removed: number } {
  return diffs.reduce(
    (total, diff) => ({
      files: total.files + 1,
      added: total.added + diff.added,
      removed: total.removed + diff.removed,
    }),
    { files: 0, added: 0, removed: 0 },
  );
}
