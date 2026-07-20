import { clearMergeHead, readMergeHead, unresolvedConflicts } from "./../mergestate.js";
import type { Commit, Identity, ObjectId } from "./../objects/types.js";
import { RefStore } from "./../refs.js";
import type { Repository } from "./../repository.js";
import { Index } from "./../staging.js";
import { buildTreeFromIndex } from "./../trees.js";

export class NothingToCommitError extends Error {
  constructor(message = "nothing to commit - the staging area matches the last commit") {
    super(message);
    this.name = "NothingToCommitError";
  }
}

export class UnresolvedConflictsError extends Error {
  constructor(public readonly paths: readonly string[]) {
    super(
      `these files still contain conflict markers:\n  ${paths.join("\n  ")}\n` +
        "resolve them, then stage them and commit again",
    );
    this.name = "UnresolvedConflictsError";
  }
}

export class EmptyCommitMessageError extends Error {
  constructor() {
    super("a commit message is required");
    this.name = "EmptyCommitMessageError";
  }
}

export interface CommitOptions {
  readonly message: string;
  /** Overrides the repository's configured identity, mainly for tests. */
  readonly author?: Identity;
  /** Record a commit even when it changes nothing. */
  readonly allowEmpty?: boolean;
  /** Additional parents, for merges. */
  readonly extraParents?: readonly ObjectId[];
}

/**
 * Record the staged snapshot as a new commit and move the current branch onto it.
 *
 * The order here is deliberate and is what makes the operation safe to
 * interrupt. Objects are written first, and only once every one of them is
 * durably stored does the ref move. A crash midway leaves some unreferenced
 * objects behind - wasted bytes, nothing more. The reverse order would leave a
 * branch pointing at a commit whose contents were never written, which is an
 * unrecoverably broken repository.
 */
export async function commit(repository: Repository, options: CommitOptions): Promise<Commit> {
  const message = options.message.trim();
  if (message.length === 0) throw new EmptyCommitMessageError();

  const refs = new RefStore(repository);
  const index = await Index.load(repository);
  const parent = await refs.headCommit();

  if (index.size === 0 && !parent && !options.allowEmpty) {
    throw new NothingToCommitError("nothing to commit - stage some files first");
  }

  // A merge that stopped for conflicts left its second parent in MERGE_HEAD.
  // Picking it up here is what turns the user's resolving commit into a real
  // merge commit; without it, the other branch's history would silently vanish
  // from the graph and later merges would redo work that was already done.
  const mergeHead = await readMergeHead(repository);

  if (mergeHead) {
    // Committing markers would put text that cannot compile into history, and
    // the mistake would only surface on someone else's machine.
    const unresolved = await unresolvedConflicts(repository);
    if (unresolved.length > 0) throw new UnresolvedConflictsError(unresolved);
  }

  const tree = await buildTreeFromIndex(repository, index.all());

  // A conflict resolution can legitimately reproduce one parent's tree exactly,
  // so the "nothing changed" guard must not apply while finishing a merge.
  if (parent && !options.allowEmpty && !mergeHead) {
    const parentTree = (await repository.objects.readCommit(parent)).tree;
    // Identical trees hash identically, so this one comparison is a complete
    // check that nothing changed - no file-by-file walk required.
    if (parentTree === tree) throw new NothingToCommitError();
  }

  const identity = options.author ?? (await repository.identity());
  const parents = [
    ...(parent ? [parent] : []),
    ...(options.extraParents ?? []),
    ...(mergeHead && !(options.extraParents ?? []).includes(mergeHead) ? [mergeHead] : []),
  ];

  const commitObject = {
    tree,
    parents,
    author: identity,
    committer: identity,
    message,
  };

  const id = await repository.objects.writeCommit(commitObject);
  await refs.updateHead(id);

  // The merge is only over once its result is recorded.
  if (mergeHead) await clearMergeHead(repository);

  return { id, ...commitObject };
}
