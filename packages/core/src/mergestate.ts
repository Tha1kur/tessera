import { promises as fs } from "node:fs";

import type { ObjectId } from "./objects/types.js";
import type { Repository } from "./repository.js";

/**
 * The record of a merge that has started but not finished.
 *
 * When a merge conflicts, the second parent must survive across however many
 * commands the user runs while resolving. It lives in `MERGE_HEAD`, and the
 * next commit picks it up - which is what makes the result a genuine merge
 * commit with two parents, rather than an ordinary commit that quietly drops
 * one side's history from the graph.
 *
 * This lives in its own module so that `commit` can consult it without
 * importing the merge command, and the merge command can write it without
 * importing itself back through `commit`.
 */

const MERGE_HEAD = "MERGE_HEAD";

export async function readMergeHead(repository: Repository): Promise<ObjectId | null> {
  try {
    const raw = (await fs.readFile(repository.internal(MERGE_HEAD), "utf8")).trim();
    return raw.length > 0 ? raw : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeMergeHead(repository: Repository, commitId: ObjectId): Promise<void> {
  await fs.writeFile(repository.internal(MERGE_HEAD), `${commitId}\n`, "utf8");
}

export async function clearMergeHead(repository: Repository): Promise<void> {
  await fs.rm(repository.internal(MERGE_HEAD), { force: true });
  await fs.rm(repository.internal(MERGE_CONFLICTS), { force: true });
}

export async function isMerging(repository: Repository): Promise<boolean> {
  return (await readMergeHead(repository)) !== null;
}

/* -------------------------------------------------------------------------- */
/* Unresolved paths                                                           */
/* -------------------------------------------------------------------------- */

const MERGE_CONFLICTS = "MERGE_CONFLICTS";

/**
 * The paths a merge could not resolve on its own.
 *
 * Recording them is what lets `commit` refuse to finish a merge while conflict
 * markers are still sitting in the files. Without that guard the markers would
 * sail into history as ordinary source code, and the first anyone hears of it
 * is a syntax error on someone else's machine.
 */
export async function readConflicts(repository: Repository): Promise<string[]> {
  try {
    const raw = await fs.readFile(repository.internal(MERGE_CONFLICTS), "utf8");
    return raw.split("\n").filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function writeConflicts(repository: Repository, paths: readonly string[]): Promise<void> {
  await fs.writeFile(repository.internal(MERGE_CONFLICTS), `${[...paths].sort().join("\n")}\n`, "utf8");
}

/** Marker lines that must not survive into a commit. */
const MARKER = /^(<<<<<<<|=======|>>>>>>>)/m;

/** Paths still containing conflict markers in the working tree. */
export async function unresolvedConflicts(repository: Repository): Promise<string[]> {
  const recorded = await readConflicts(repository);
  const unresolved: string[] = [];

  for (const relativePath of recorded) {
    const contents = await fs
      .readFile(repository.absolute(relativePath), "utf8")
      .catch(() => null);

    // A deleted file is a legitimate resolution of a modify/delete conflict.
    if (contents !== null && MARKER.test(contents)) unresolved.push(relativePath);
  }

  return unresolved;
}
