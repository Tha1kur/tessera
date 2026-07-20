import type { ObjectId } from "./../objects/types.js";
import { BranchNotFoundError, RefStore } from "./../refs.js";
import type { Repository } from "./../repository.js";

export interface BranchSummary {
  readonly name: string;
  readonly commit: ObjectId;
  readonly isCurrent: boolean;
  readonly subject: string;
}

/** Every branch, with the subject line of its tip commit for context. */
export async function listBranches(repository: Repository): Promise<BranchSummary[]> {
  const refs = new RefStore(repository);
  const head = await refs.readHead();
  const branches = await refs.listBranches();

  const summaries: BranchSummary[] = [];
  for (const branch of branches) {
    const commit = await repository.objects.readCommit(branch.commit);
    summaries.push({
      name: branch.name,
      commit: branch.commit,
      isCurrent: head.kind === "attached" && head.branch === branch.name,
      subject: commit.message.split("\n")[0] ?? "",
    });
  }

  return summaries;
}

/**
 * Create a branch at a given starting point, defaulting to where you are now.
 *
 * Note what this does *not* do: it does not switch to the new branch, and it
 * does not copy anything. It writes one commit id to one file. Checkout is a
 * separate, explicit step.
 */
export async function createBranch(
  repository: Repository,
  name: string,
  startPoint = "HEAD",
): Promise<{ name: string; commit: ObjectId }> {
  const refs = new RefStore(repository);
  const commit = await refs.resolve(startPoint);
  await refs.createBranch(name, commit);
  return { name, commit };
}

export async function deleteBranch(repository: Repository, name: string): Promise<void> {
  const refs = new RefStore(repository);
  await refs.deleteBranch(name);
}

/** Move an existing branch to a different commit. */
export async function moveBranch(
  repository: Repository,
  name: string,
  target: string,
): Promise<{ name: string; commit: ObjectId }> {
  const refs = new RefStore(repository);
  if (!(await refs.readBranch(name))) throw new BranchNotFoundError(name);

  const commit = await refs.resolve(target);
  await refs.writeBranch(name, commit);
  return { name, commit };
}
