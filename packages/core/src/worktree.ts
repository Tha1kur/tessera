import { promises as fs } from "node:fs";
import * as path from "node:path";

import { IgnoreList } from "./ignore.js";
import { FileMode } from "./objects/types.js";
import { IGNORE_FILE, REPOSITORY_DIRECTORY } from "./repository.js";
import type { Repository } from "./repository.js";

/** A file found in the working directory. */
export interface WorktreeFile {
  /** Repo-relative, forward-slashed. */
  readonly path: string;
  readonly mode: FileMode;
  readonly size: number;
  readonly modifiedAt: number;
}

/** Load `.tessignore` from the repository root, if it has one. */
export async function loadIgnoreList(repository: Repository): Promise<IgnoreList> {
  try {
    const contents = await fs.readFile(path.join(repository.workingDirectory, IGNORE_FILE), "utf8");
    return IgnoreList.parse(contents);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return IgnoreList.empty();
    throw error;
  }
}

/** Whether a file is executable by its owner, which is the bit worth keeping. */
export function modeFor(fileMode: number): FileMode {
  return (fileMode & 0o100) !== 0 ? FileMode.Executable : FileMode.Regular;
}

export interface ScanOptions {
  /** Defaults to the repository's own `.tessignore`. */
  readonly ignore?: IgnoreList;
  /** Limit the scan to a subtree, given as a repo-relative path. */
  readonly under?: string;
  /** Include files that `.tessignore` excludes. */
  readonly includeIgnored?: boolean;
}

/**
 * Walk the working directory and return every tracked-eligible file.
 *
 * Ignored *directories* are pruned rather than walked into. That single check
 * is the difference between a scan that finishes instantly and one that
 * descends into `node_modules` and reads a hundred thousand files it will
 * immediately discard.
 *
 * Symbolic links are skipped entirely. Following them would let a link into
 * `/` turn a repository scan into a walk of the whole filesystem, and would
 * make it possible to commit files from outside the project.
 */
export async function scanWorktree(repository: Repository, options: ScanOptions = {}): Promise<WorktreeFile[]> {
  const ignore = options.ignore ?? (await loadIgnoreList(repository));
  const includeIgnored = options.includeIgnored ?? false;
  const found: WorktreeFile[] = [];

  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === REPOSITORY_DIRECTORY) continue;

      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (!includeIgnored && ignore.ignores(relativePath, true)) continue;
        await walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (!includeIgnored && ignore.ignores(relativePath, false)) continue;

      const stats = await fs.stat(absolutePath);
      found.push({
        path: relativePath,
        mode: modeFor(stats.mode),
        size: stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
      });
    }
  };

  const startPrefix = options.under ? repository.relative(options.under) : "";
  const startDirectory = startPrefix
    ? path.join(repository.workingDirectory, ...startPrefix.split("/"))
    : repository.workingDirectory;

  const stats = await fs.stat(startDirectory);
  if (stats.isFile()) {
    return [
      {
        path: startPrefix,
        mode: modeFor(stats.mode),
        size: stats.size,
        modifiedAt: Math.floor(stats.mtimeMs),
      },
    ];
  }

  await walk(startDirectory, startPrefix);
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return found;
}

/** Remove a file and any directories it leaves empty, stopping at the root. */
export async function removeFileAndEmptyParents(repository: Repository, relativePath: string): Promise<void> {
  const absolutePath = path.join(repository.workingDirectory, ...relativePath.split("/"));
  await fs.rm(absolutePath, { force: true });

  let directory = path.dirname(absolutePath);
  while (directory !== repository.workingDirectory && directory.startsWith(repository.workingDirectory)) {
    const remaining = await fs.readdir(directory).catch(() => null);
    if (remaining === null || remaining.length > 0) break;
    await fs.rmdir(directory).catch(() => undefined);
    directory = path.dirname(directory);
  }
}

/** Write a blob's contents into the working tree, creating parent directories. */
export async function writeWorktreeFile(
  repository: Repository,
  relativePath: string,
  contents: Buffer,
  mode: FileMode,
): Promise<void> {
  // Re-validate through the repository so a hostile tree entry cannot escape.
  const safePath = repository.relative(path.join(repository.workingDirectory, ...relativePath.split("/")));
  const absolutePath = path.join(repository.workingDirectory, ...safePath.split("/"));

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, contents);
  await fs.chmod(absolutePath, mode === FileMode.Executable ? 0o755 : 0o644);
}
