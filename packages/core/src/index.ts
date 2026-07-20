/**
 * Tessera - a version control engine built from first principles.
 *
 * The whole system rests on one idea: name every piece of content by the
 * SHA-256 of its own bytes. From that single decision everything else follows -
 * deduplication, integrity checking, cheap branching, and the ability to tell
 * whether two directories are identical by comparing sixty-four characters
 * instead of walking them.
 *
 * The layers, bottom to top:
 *
 *   objects/   blobs, trees and commits, and the store they live in
 *   refs       named pointers into history: branches and HEAD
 *   staging    the index, the deliberate space between edits and commits
 *   trees      turning a flat file list into nested tree objects, and back
 *   diff       Myers' shortest-edit-script algorithm and unified output
 *   commands/  the operations a user actually performs
 */

/* Objects and storage. */
export {
  AmbiguousObjectIdError,
  ObjectNotFoundError,
  ObjectStore,
  hash,
  idFor,
} from "./objects/store.js";
export {
  CorruptObjectError,
  decodeCommit,
  decodeIdentity,
  decodeTree,
  encodeCommit,
  encodeIdentity,
  encodeTree,
  frame,
  unframe,
} from "./objects/codec.js";
export { FileMode } from "./objects/types.js";
export type { Commit, CommitObject, Identity, ObjectId, ObjectType, TreeEntry } from "./objects/types.js";

/* Repository. */
export {
  DEFAULT_BRANCH,
  IGNORE_FILE,
  NotARepositoryError,
  REPOSITORY_DIRECTORY,
  Repository,
  RepositoryExistsError,
} from "./repository.js";
export type { RepositoryConfig } from "./repository.js";

/* Refs. */
export {
  BranchExistsError,
  BranchNotFoundError,
  InvalidRefNameError,
  RefStore,
  RevisionNotFoundError,
  isValidBranchName,
} from "./refs.js";
export type { HeadState } from "./refs.js";

/* Staging. */
export { Index, absolutePathOf, discardIndex, looksUnchanged, parentOf } from "./staging.js";
export type { IndexEntry } from "./staging.js";

/* Trees. */
export {
  buildTreeFromIndex,
  findInTree,
  flattenTree,
  readCommitFiles,
  readCommitFilesOrEmpty,
} from "./trees.js";
export type { FlatEntry } from "./trees.js";

/* Working tree and ignore rules. */
export { IgnoreList } from "./ignore.js";
export {
  loadIgnoreList,
  modeFor,
  removeFileAndEmptyParents,
  scanWorktree,
  writeWorktreeFile,
} from "./worktree.js";
export type { ScanOptions, WorktreeFile } from "./worktree.js";

/* Diffing. */
export {
  DEFAULT_CONTEXT_LINES,
  countChanges,
  diffLines,
  formatUnifiedDiff,
  isBinary,
  splitLines,
  toHunks,
} from "./diff.js";
export type { Edit, EditKind, Hunk, UnifiedDiffOptions } from "./diff.js";

/* Status. */
export { isClean, status } from "./status.js";
export type { Change, ChangeKind, StatusReport } from "./status.js";

/* Commands. */
export { add } from "./commands/add.js";
export type { AddOptions, AddResult } from "./commands/add.js";

export {
  EmptyCommitMessageError,
  NothingToCommitError,
  UnresolvedConflictsError,
  commit,
} from "./commands/commit.js";
export type { CommitOptions } from "./commands/commit.js";

export { log, mergeBase, walkHistory } from "./commands/log.js";
export type { LogOptions } from "./commands/log.js";

export { createBranch, deleteBranch, listBranches, moveBranch } from "./commands/branch.js";
export type { BranchSummary } from "./commands/branch.js";

export { UncommittedChangesError, checkout, restore } from "./commands/checkout.js";
export type { CheckoutOptions, CheckoutResult } from "./commands/checkout.js";

export { diffCommit, diffCommits, diffStaged, diffUnstaged, summarise } from "./commands/diff.js";
export type { DiffOptions, FileChangeKind, FileDiff } from "./commands/diff.js";

/* Merging. */
export { CONFLICT_MARKERS, mergeLines, mergeText, renderMerge } from "./merge.js";
export type { MergeRegion, MergeResult, RenderOptions } from "./merge.js";

export {
  clearMergeHead,
  isMerging,
  readConflicts,
  readMergeHead,
  unresolvedConflicts,
  writeConflicts,
  writeMergeHead,
} from "./mergestate.js";

export { MergeInProgressError, UnrelatedHistoriesError, abortMerge, merge } from "./commands/merge.js";
export type { ConflictedFile, MergeOptions, MergeOutcome, MergeReport } from "./commands/merge.js";
