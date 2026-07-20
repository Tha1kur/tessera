import type { Commit, ObjectId } from "./../objects/types.js";
import { RefStore } from "./../refs.js";
import type { Repository } from "./../repository.js";
import type { HasObjects } from "./../trees.js";

export interface LogOptions {
  /** Where to start walking. Defaults to HEAD. */
  readonly from?: string;
  /** Stop after this many commits. */
  readonly limit?: number;
  /** Stop when this commit is reached, so a range can be listed. */
  readonly until?: ObjectId;
}

/**
 * Walk history backwards from a starting commit.
 *
 * History is a directed acyclic graph, not a list: a merge commit has two
 * parents and the branches behind them rejoin further back. So the walk keeps a
 * frontier ordered by commit time and always expands the newest commit next,
 * which yields a sensible reverse-chronological order across branches. A `seen`
 * set stops commits reachable by more than one route from being emitted twice
 * and, more importantly, stops the walk from doing exponential work.
 */
export async function* walkHistory(
  repository: Repository,
  options: LogOptions = {},
): AsyncGenerator<Commit> {
  const refs = new RefStore(repository);
  const start = await refs.resolve(options.from ?? "HEAD");

  yield* walkCommits(repository, start, options);
}

/**
 * The same walk, starting from a commit id that is already resolved.
 *
 * Separated from `walkHistory` because resolving a revision needs refs, and
 * refs live in a working directory. A server addressing commits by full id has
 * no such directory and should not have to invent one to read history.
 */
export async function* walkCommits(
  repository: HasObjects,
  start: ObjectId,
  options: { readonly limit?: number; readonly until?: ObjectId } = {},
): AsyncGenerator<Commit> {
  const seen = new Set<ObjectId>([start]);
  const frontier: Commit[] = [{ id: start, ...(await repository.objects.readCommit(start)) }];

  let emitted = 0;

  while (frontier.length > 0) {
    // Newest first. A linear array is the right shape here: histories being
    // walked interactively have a frontier of a handful of commits, where a
    // heap's constant factor would cost more than it saves.
    frontier.sort((a, b) => b.committer.timestamp - a.committer.timestamp);

    const current = frontier.shift() as Commit;
    yield current;

    emitted += 1;
    if (options.limit !== undefined && emitted >= options.limit) return;
    if (options.until && current.id === options.until) return;

    for (const parentId of current.parents) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      frontier.push({ id: parentId, ...(await repository.objects.readCommit(parentId)) });
    }
  }
}

/** The same walk, collected into an array. */
export async function log(repository: Repository, options: LogOptions = {}): Promise<Commit[]> {
  const commits: Commit[] = [];
  for await (const entry of walkHistory(repository, options)) commits.push(entry);
  return commits;
}

/** Collected history from a resolved id, for callers without a working tree. */
export async function logFrom(
  repository: HasObjects,
  start: ObjectId,
  options: { readonly limit?: number } = {},
): Promise<Commit[]> {
  const commits: Commit[] = [];
  for await (const entry of walkCommits(repository, start, options)) commits.push(entry);
  return commits;
}

/**
 * The best common ancestor of two commits - the point where they diverged.
 *
 * This is what a three-way merge needs: knowing the shared starting state is
 * the difference between "both sides changed this line, ask the human" and
 * "one side changed it, take that change".
 */
export async function mergeBase(
  repository: HasObjects,
  left: ObjectId,
  right: ObjectId,
): Promise<ObjectId | null> {
  const ancestorsOf = async (start: ObjectId): Promise<Set<ObjectId>> => {
    const reachable = new Set<ObjectId>();
    const pending = [start];

    while (pending.length > 0) {
      const id = pending.pop() as ObjectId;
      if (reachable.has(id)) continue;
      reachable.add(id);
      pending.push(...(await repository.objects.readCommit(id)).parents);
    }

    return reachable;
  };

  const leftAncestors = await ancestorsOf(left);
  if (leftAncestors.has(right)) return right;

  // Walk right's history newest-first and take the first commit that left can
  // also reach; that is the most recent shared ancestor.
  const seen = new Set<ObjectId>([right]);
  const frontier: Commit[] = [{ id: right, ...(await repository.objects.readCommit(right)) }];

  while (frontier.length > 0) {
    frontier.sort((a, b) => b.committer.timestamp - a.committer.timestamp);
    const current = frontier.shift() as Commit;

    if (leftAncestors.has(current.id)) return current.id;

    for (const parentId of current.parents) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      frontier.push({ id: parentId, ...(await repository.objects.readCommit(parentId)) });
    }
  }

  return null;
}
