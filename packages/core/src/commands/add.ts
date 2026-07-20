import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Repository } from "./../repository.js";
import { Index } from "./../staging.js";
import { loadIgnoreList, scanWorktree } from "./../worktree.js";

export interface AddResult {
  /** Paths newly staged or updated in the index. */
  readonly staged: readonly string[];
  /** Paths dropped from the index because they no longer exist on disk. */
  readonly removed: readonly string[];
  /** Paths that matched nothing, so the caller can complain usefully. */
  readonly unmatched: readonly string[];
}

export interface AddOptions {
  /** Stage files even when `.tessignore` excludes them. */
  readonly force?: boolean;
}

/**
 * Stage paths: hash their current contents into the object store and record
 * the resulting ids in the index.
 *
 * The contents are captured *now*. Editing a file after staging it leaves the
 * staged version untouched - which is exactly why the index exists, and why
 * `status` reports the same file as both staged and unstaged when that happens.
 */
export async function add(
  repository: Repository,
  pathspecs: readonly string[],
  options: AddOptions = {},
): Promise<AddResult> {
  const index = await Index.load(repository);
  const ignore = options.force ? undefined : await loadIgnoreList(repository);

  const staged: string[] = [];
  const removed: string[] = [];
  const unmatched: string[] = [];

  for (const pathspec of pathspecs) {
    const relative = pathspec === "." ? "" : repository.relative(pathspec);

    if (repository.isInternal(repository.absolute(relative || "."))) {
      throw new Error(`refusing to stage paths inside ${pathspec}`);
    }

    const exists = await fs
      .stat(repository.absolute(relative || "."))
      .then(() => true)
      .catch(() => false);

    if (!exists) {
      // A path that is gone from disk but present in the index is a deletion
      // the user is asking us to record, not a mistake.
      const dropped = index.remove(relative) ? [relative] : index.removeUnder(relative);
      if (dropped.length === 0) {
        unmatched.push(pathspec);
      } else {
        removed.push(...dropped);
      }
      continue;
    }

    const scanOptions = {
      ...(relative ? { under: relative } : {}),
      ...(ignore ? { ignore } : { includeIgnored: true }),
    };
    const files = await scanWorktree(repository, scanOptions);

    if (files.length === 0) {
      unmatched.push(pathspec);
      continue;
    }

    for (const file of files) {
      const contents = await fs.readFile(path.join(repository.workingDirectory, ...file.path.split("/")));
      const id = await repository.objects.writeBlob(contents);

      index.add({
        path: file.path,
        id,
        mode: file.mode,
        size: file.size,
        modifiedAt: file.modifiedAt,
      });
      staged.push(file.path);
    }

    // Staging a directory should also notice files deleted from inside it.
    for (const entry of index.all()) {
      const insideScope = relative === "" || entry.path === relative || entry.path.startsWith(`${relative}/`);
      if (!insideScope) continue;

      const stillThere = await fs
        .stat(path.join(repository.workingDirectory, ...entry.path.split("/")))
        .then(() => true)
        .catch(() => false);

      if (!stillThere) {
        index.remove(entry.path);
        removed.push(entry.path);
      }
    }
  }

  await index.save();

  return {
    staged: [...new Set(staged)].sort(),
    removed: [...new Set(removed)].sort(),
    unmatched,
  };
}
