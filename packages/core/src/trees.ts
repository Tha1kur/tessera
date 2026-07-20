import { FileMode } from "./objects/types.js";
import type { ObjectId, TreeEntry } from "./objects/types.js";
import type { ObjectStore } from "./objects/store.js";
import type { Repository } from "./repository.js";

import type { IndexEntry } from "./staging.js";

/**
 * The only thing these helpers actually need.
 *
 * Reading history requires an object store and nothing else - no working
 * directory, no index, no refs. Saying so in the type is what lets the server
 * reuse this code against a database-backed store, instead of having to
 * fabricate a Repository around a filesystem that does not exist there.
 */
export interface HasObjects {
  readonly objects: ObjectStore;
}


/** A single file as recorded in a commit's tree. */
export interface FlatEntry {
  readonly path: string;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface DirectoryNode {
  readonly files: Map<string, { id: ObjectId; mode: FileMode }>;
  readonly directories: Map<string, DirectoryNode>;
}

function emptyNode(): DirectoryNode {
  return { files: new Map(), directories: new Map() };
}

/**
 * Turn the flat list of staged paths into a nested tree of objects, and write
 * every level of it.
 *
 * This is where a snapshot actually becomes cheap. Trees are written bottom-up,
 * so a directory whose contents did not change re-derives the identical id and
 * the existing object is reused untouched. Committing a one-line fix in a
 * project with fifty thousand files writes one blob, one tree per directory on
 * the path to it, and one commit - not fifty thousand of anything.
 */
export async function buildTreeFromIndex(
  repository: HasObjects,
  entries: readonly IndexEntry[],
): Promise<ObjectId> {
  const root = emptyNode();

  for (const entry of entries) {
    const segments = entry.path.split("/");
    const fileName = segments.pop();
    if (!fileName) throw new Error(`index entry has no filename: ${entry.path}`);

    let node = root;
    for (const segment of segments) {
      let child = node.directories.get(segment);
      if (!child) {
        child = emptyNode();
        node.directories.set(segment, child);
      }
      node = child;
    }

    node.files.set(fileName, { id: entry.id, mode: entry.mode });
  }

  return writeNode(repository, root);
}

async function writeNode(repository: HasObjects, node: DirectoryNode): Promise<ObjectId> {
  const entries: TreeEntry[] = [];

  for (const [name, file] of node.files) {
    entries.push({ name, id: file.id, mode: file.mode, type: "blob" });
  }

  for (const [name, directory] of node.directories) {
    // An empty directory produces no entry at all. Tessera tracks file
    // contents, and a directory with nothing in it has no contents to track -
    // the same reason Git will not let you commit one.
    const id = await writeNode(repository, directory);
    if (id === null) continue;
    entries.push({ name, id, mode: FileMode.Directory, type: "tree" });
  }

  return repository.objects.writeTree(entries);
}

/**
 * Flatten a tree into the list of files it represents, walking subtrees.
 * Returned in path order so two trees can be compared by a single merge walk.
 */
export async function flattenTree(
  repository: HasObjects,
  treeId: ObjectId,
  prefix = "",
): Promise<FlatEntry[]> {
  const entries = await repository.objects.readTree(treeId);
  const flattened: FlatEntry[] = [];

  for (const entry of entries) {
    const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.type === "tree") {
      flattened.push(...(await flattenTree(repository, entry.id, entryPath)));
    } else {
      flattened.push({ path: entryPath, id: entry.id, mode: entry.mode });
    }
  }

  return flattened.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The files of a commit, keyed by path. */
export async function readCommitFiles(
  repository: HasObjects,
  commitId: ObjectId,
): Promise<Map<string, FlatEntry>> {
  const commit = await repository.objects.readCommit(commitId);
  const files = await flattenTree(repository, commit.tree);
  return new Map(files.map((file) => [file.path, file]));
}

/** The files of a commit, or an empty map for a repository with no commits. */
export async function readCommitFilesOrEmpty(
  repository: HasObjects,
  commitId: ObjectId | null,
): Promise<Map<string, FlatEntry>> {
  return commitId ? readCommitFiles(repository, commitId) : new Map();
}

/** Look up a single path inside a tree without flattening the whole thing. */
export async function findInTree(
  repository: HasObjects,
  treeId: ObjectId,
  targetPath: string,
): Promise<TreeEntry | null> {
  const segments = targetPath.split("/");
  let currentTree = treeId;

  for (let depth = 0; depth < segments.length; depth += 1) {
    const name = segments[depth] as string;
    const entries = await repository.objects.readTree(currentTree);
    const match = entries.find((entry) => entry.name === name);

    if (!match) return null;
    if (depth === segments.length - 1) return match;
    if (match.type !== "tree") return null;

    currentTree = match.id;
  }

  return null;
}
