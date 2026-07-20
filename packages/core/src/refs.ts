import { promises as fs } from "node:fs";
import * as path from "node:path";

import { ObjectNotFoundError } from "./objects/store.js";
import type { ObjectId } from "./objects/types.js";
import type { Repository } from "./repository.js";

export class InvalidRefNameError extends Error {
  constructor(name: string) {
    super(`invalid branch name: ${JSON.stringify(name)}`);
    this.name = "InvalidRefNameError";
  }
}

export class BranchNotFoundError extends Error {
  constructor(public readonly branch: string) {
    super(`no such branch: ${branch}`);
    this.name = "BranchNotFoundError";
  }
}

export class BranchExistsError extends Error {
  constructor(public readonly branch: string) {
    super(`branch already exists: ${branch}`);
    this.name = "BranchExistsError";
  }
}

export class RevisionNotFoundError extends Error {
  constructor(public readonly revision: string) {
    super(`cannot resolve revision: ${revision}`);
    this.name = "RevisionNotFoundError";
  }
}

/**
 * Where HEAD is pointing.
 *
 * Attached: HEAD names a branch, and committing moves that branch forward.
 * Detached: HEAD names a commit directly - you are looking at a point in
 * history rather than standing on a branch, so committing would move nothing.
 */
export type HeadState =
  | { readonly kind: "attached"; readonly branch: string }
  | { readonly kind: "detached"; readonly commit: ObjectId };

const SYMBOLIC_PREFIX = "ref: ";
const HEADS_PREFIX = "refs/heads/";

/**
 * Branch names are just filenames under `refs/heads`, so they are validated
 * strictly. Rejecting `..`, leading dots and absolute-looking names is what
 * keeps `tess branch ../../etc/passwd` from writing outside the repository.
 */
export function isValidBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.startsWith(".") || name.endsWith(".")) return false;
  if (name.startsWith("/") || name.endsWith("/")) return false;
  if (name.includes("..") || name.includes("//")) return false;
  if (name === "HEAD") return false;
  return /^[A-Za-z0-9._/-]+$/.test(name);
}

/**
 * Named pointers into history.
 *
 * A branch is not a container of commits - it is a single line of text holding
 * one commit id. "Creating a branch" writes 65 bytes; the history it appears to
 * contain is just whatever is reachable by following parent links from there.
 * That is why branching is instant no matter how large the project is.
 */
export class RefStore {
  constructor(private readonly repository: Repository) {}

  /* ---------------------------------------------------------------------- */
  /* HEAD                                                                   */
  /* ---------------------------------------------------------------------- */

  async readHead(): Promise<HeadState> {
    const raw = (await fs.readFile(this.repository.internal("HEAD"), "utf8")).trim();

    if (raw.startsWith(SYMBOLIC_PREFIX)) {
      const target = raw.slice(SYMBOLIC_PREFIX.length).trim();
      if (!target.startsWith(HEADS_PREFIX)) {
        throw new Error(`HEAD points at an unsupported ref: ${target}`);
      }
      return { kind: "attached", branch: target.slice(HEADS_PREFIX.length) };
    }

    return { kind: "detached", commit: raw };
  }

  async attachHead(branch: string): Promise<void> {
    if (!isValidBranchName(branch)) throw new InvalidRefNameError(branch);
    await writeFileAtomically(this.repository.internal("HEAD"), `${SYMBOLIC_PREFIX}${HEADS_PREFIX}${branch}\n`);
  }

  async detachHead(commit: ObjectId): Promise<void> {
    await writeFileAtomically(this.repository.internal("HEAD"), `${commit}\n`);
  }

  /** The commit HEAD currently resolves to, or null in a fresh repository. */
  async headCommit(): Promise<ObjectId | null> {
    const head = await this.readHead();
    return head.kind === "detached" ? head.commit : this.readBranch(head.branch);
  }

  /** Move whatever HEAD is attached to onto a new commit. */
  async updateHead(commit: ObjectId): Promise<void> {
    const head = await this.readHead();
    if (head.kind === "attached") {
      await this.writeBranch(head.branch, commit);
    } else {
      await this.detachHead(commit);
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Branches                                                               */
  /* ---------------------------------------------------------------------- */

  private branchPath(name: string): string {
    if (!isValidBranchName(name)) throw new InvalidRefNameError(name);
    return this.repository.internal("refs", "heads", ...name.split("/"));
  }

  async readBranch(name: string): Promise<ObjectId | null> {
    try {
      return (await fs.readFile(this.branchPath(name), "utf8")).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeBranch(name: string, commit: ObjectId): Promise<void> {
    const destination = this.branchPath(name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await writeFileAtomically(destination, `${commit}\n`);
  }

  async createBranch(name: string, commit: ObjectId): Promise<void> {
    if (await this.readBranch(name)) throw new BranchExistsError(name);
    await this.writeBranch(name, commit);
  }

  async deleteBranch(name: string): Promise<void> {
    const head = await this.readHead();
    if (head.kind === "attached" && head.branch === name) {
      throw new Error(`cannot delete ${name}: it is the branch you are currently on`);
    }
    if (!(await this.readBranch(name))) throw new BranchNotFoundError(name);
    await fs.rm(this.branchPath(name));
  }

  /** Every branch, sorted by name, with the commit each one points at. */
  async listBranches(): Promise<{ name: string; commit: ObjectId }[]> {
    const root = this.repository.internal("refs", "heads");
    const names: string[] = [];

    const walk = async (directory: string, prefix: string): Promise<void> => {
      let entries;
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }

      for (const entry of entries) {
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(path.join(directory, entry.name), name);
        } else if (entry.isFile()) {
          names.push(name);
        }
      }
    };

    await walk(root, "");
    names.sort();

    const branches: { name: string; commit: ObjectId }[] = [];
    for (const name of names) {
      const commit = await this.readBranch(name);
      if (commit) branches.push({ name, commit });
    }
    return branches;
  }

  /* ---------------------------------------------------------------------- */
  /* Revisions                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * Turn something a human typed into a concrete commit id.
   *
   * Accepts, in order of precedence:
   *   HEAD              the current commit
   *   <branch>          the commit a branch points at
   *   <hex prefix>      an object id, abbreviated to at least four characters
   *
   * Any of those may be followed by `~n` or a run of `^`, each step walking to
   * the first parent - so `main~3` means "three commits before the tip of main".
   */
  async resolve(revision: string): Promise<ObjectId> {
    const trimmed = revision.trim();
    if (trimmed.length === 0) throw new RevisionNotFoundError(revision);

    const suffix = /(?:(\^+)|~(\d+))$/;
    let base = trimmed;
    let steps = 0;

    // Peel ancestry operators off the end, right to left.
    for (;;) {
      const match = suffix.exec(base);
      if (!match) break;
      steps += match[1] ? match[1].length : Number(match[2]);
      base = base.slice(0, match.index);
    }

    let commit = await this.resolveBase(base, revision);

    for (let step = 0; step < steps; step += 1) {
      const parents = (await this.repository.objects.readCommit(commit)).parents;
      const first = parents[0];
      if (!first) {
        throw new RevisionNotFoundError(`${revision} (reached the first commit after ${step} step(s))`);
      }
      commit = first;
    }

    return commit;
  }

  private async resolveBase(base: string, original: string): Promise<ObjectId> {
    if (base === "HEAD" || base === "") {
      const head = await this.headCommit();
      if (!head) throw new RevisionNotFoundError(`${original} (this repository has no commits yet)`);
      return head;
    }

    if (isValidBranchName(base)) {
      const branch = await this.readBranch(base);
      if (branch) return branch;
    }

    try {
      return await this.repository.objects.resolvePrefix(base);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw new RevisionNotFoundError(original);
      throw error;
    }
  }
}

/**
 * Refs are read constantly and must never be observed half-written, so every
 * update lands via a temporary file and a rename rather than a direct write.
 */
async function writeFileAtomically(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.writeFile(temporary, contents, "utf8");
    await fs.rename(temporary, destination);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}
