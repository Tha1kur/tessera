/**
 * Line diffing, via Myers' algorithm.
 *
 * The naive way to compare two files is a longest-common-subsequence table,
 * which costs O(N*M) time *and* memory - on two 10,000-line files that is a
 * hundred million cells, and it is why a hand-rolled diff falls over on real
 * input.
 *
 * Myers reframes the problem: model the two files as axes of a grid, where
 * moving right deletes a line, moving down inserts one, and moving diagonally
 * keeps a matching line. The best diff is then the shortest path from the top
 * left to the bottom right. Because a good diff is usually a *small* one, the
 * search can be ordered by edit distance and stopped the moment the far corner
 * is reached, giving O((N+M)*D) where D is the number of edits actually needed.
 * For the typical case - a few changed lines in a large file - D is tiny.
 */

export type EditKind = "equal" | "insert" | "delete";

export interface Edit {
  readonly kind: EditKind;
  readonly text: string;
  /** Zero-based line number in the old file, or null for an insertion. */
  readonly oldLine: number | null;
  /** Zero-based line number in the new file, or null for a deletion. */
  readonly newLine: number | null;
}

/**
 * Split text into lines for diffing.
 *
 * A trailing newline terminates the last line rather than starting an empty
 * one, so a three-line file yields three entries and not four.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The shortest edit script turning `before` into `after`. */
export function diffLines(before: readonly string[], after: readonly string[]): Edit[] {
  const n = before.length;
  const m = after.length;

  // Fast paths that also keep the trace array from being allocated needlessly.
  if (n === 0 && m === 0) return [];
  if (n === 0) return after.map((text, i) => ({ kind: "insert", text, oldLine: null, newLine: i }) as const);
  if (m === 0) return before.map((text, i) => ({ kind: "delete", text, oldLine: i, newLine: null }) as const);

  const max = n + m;
  const offset = max;
  // furthest[k + offset] is how far right the path on diagonal k has reached.
  let furthest = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(furthest.slice());

    for (let k = -d; k <= d; k += 2) {
      // Choose whether to arrive on this diagonal by inserting (from k+1) or
      // deleting (from k-1), preferring whichever has travelled further.
      const goDown =
        k === -d || (k !== d && (furthest[k - 1 + offset] as number) < (furthest[k + 1 + offset] as number));

      let x = goDown ? (furthest[k + 1 + offset] as number) : (furthest[k - 1 + offset] as number) + 1;
      let y = x - k;

      // Slide along the diagonal for free while the lines match. This "snake"
      // is what makes long unchanged regions cost almost nothing.
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }

      furthest[k + offset] = x;

      if (x >= n && y >= m) return backtrack(before, after, trace, offset);
    }

    furthest = furthest.slice();
  }

  /* c8 ignore next - unreachable: a path always exists within n + m edits. */
  throw new Error("diff failed to converge");
}

function backtrack(
  before: readonly string[],
  after: readonly string[],
  trace: readonly Int32Array[],
  offset: number,
): Edit[] {
  const edits: Edit[] = [];
  let x = before.length;
  let y = after.length;

  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d -= 1) {
    const furthest = trace[d] as Int32Array;
    const k = x - y;

    const cameFromDown =
      k === -d || (k !== d && (furthest[k - 1 + offset] as number) < (furthest[k + 1 + offset] as number));
    const previousK = cameFromDown ? k + 1 : k - 1;
    const previousX = furthest[previousK + offset] as number;
    const previousY = previousX - previousK;

    // Unwind the free diagonal moves first: these are the matching lines.
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: "equal", text: before[x] as string, oldLine: x, newLine: y });
    }

    if (d === 0) break;

    if (x === previousX) {
      y -= 1;
      edits.push({ kind: "insert", text: after[y] as string, oldLine: null, newLine: y });
    } else {
      x -= 1;
      edits.push({ kind: "delete", text: before[x] as string, oldLine: x, newLine: null });
    }
  }

  return edits.reverse();
}

/* -------------------------------------------------------------------------- */
/* Unified format                                                             */
/* -------------------------------------------------------------------------- */

export interface Hunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly edits: readonly Edit[];
}

export const DEFAULT_CONTEXT_LINES = 3;

/**
 * Group edits into hunks, keeping a few unchanged lines around each change.
 *
 * The context is not decoration - it is what lets a diff be read, reviewed and
 * applied to a file that has drifted slightly since the diff was produced.
 */
export function toHunks(edits: readonly Edit[], context = DEFAULT_CONTEXT_LINES): Hunk[] {
  const changed = edits
    .map((edit, index) => (edit.kind === "equal" ? -1 : index))
    .filter((index) => index !== -1);

  if (changed.length === 0) return [];

  // Merge nearby changes into a single hunk when their context windows would
  // otherwise overlap or abut.
  const groups: { start: number; end: number }[] = [];
  for (const index of changed) {
    const last = groups[groups.length - 1];
    if (last && index - last.end <= context * 2) {
      last.end = index;
    } else {
      groups.push({ start: index, end: index });
    }
  }

  return groups.map((group) => {
    const from = Math.max(0, group.start - context);
    const to = Math.min(edits.length - 1, group.end + context);
    const slice = edits.slice(from, to + 1);

    const oldCount = slice.filter((edit) => edit.kind !== "insert").length;
    const newCount = slice.filter((edit) => edit.kind !== "delete").length;

    return {
      // Unified diff line numbers are one-based; an empty side starts at 0.
      oldStart: (slice.find((edit) => edit.oldLine !== null)?.oldLine ?? -1) + 1,
      oldCount,
      newStart: (slice.find((edit) => edit.newLine !== null)?.newLine ?? -1) + 1,
      newCount,
      edits: slice,
    };
  });
}

export interface UnifiedDiffOptions {
  readonly oldLabel?: string;
  readonly newLabel?: string;
  readonly context?: number;
}

/** Render a diff in the unified format every code review tool understands. */
export function formatUnifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const { oldLabel = "a", newLabel = "b", context = DEFAULT_CONTEXT_LINES } = options;

  const edits = diffLines(splitLines(before), splitLines(after));
  const hunks = toHunks(edits, context);
  if (hunks.length === 0) return "";

  const lines = [`--- ${oldLabel}`, `+++ ${newLabel}`];

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const edit of hunk.edits) {
      const marker = edit.kind === "insert" ? "+" : edit.kind === "delete" ? "-" : " ";
      lines.push(`${marker}${edit.text}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Added and removed line counts, for summaries and stat lines. */
export function countChanges(edits: readonly Edit[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const edit of edits) {
    if (edit.kind === "insert") added += 1;
    else if (edit.kind === "delete") removed += 1;
  }
  return { added, removed };
}

/**
 * Guess whether a buffer holds text.
 *
 * A NUL byte in the first few kilobytes is the same heuristic Git uses: real
 * text files essentially never contain one, and compiled binaries almost
 * always do within the first block.
 */
export function isBinary(contents: Buffer): boolean {
  const window = contents.subarray(0, Math.min(contents.byteLength, 8000));
  return window.includes(0x00);
}
