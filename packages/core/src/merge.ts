import { diffLines } from "./diff.js";

/**
 * Three-way line merging.
 *
 * A two-way comparison cannot merge anything. Given "this line says A" and
 * "this line says B", there is no way to tell whether A is a change to be kept
 * or the original that B replaced. The missing information is the *base*: the
 * common ancestor both sides started from.
 *
 * With the base, every region of the file answers a simple question - which
 * sides changed it?
 *
 *   neither          keep the base text
 *   only ours        take ours
 *   only theirs      take theirs
 *   both, identically   take it once
 *   both, differently   a genuine conflict; only a human can decide
 *
 * This is why `mergeBase` matters and why merging without it degenerates into
 * "pick a winner and lose work".
 */

/** A replacement of `base[start, end)` with `lines`. */
interface Change {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

export interface MergeRegion {
  readonly kind: "clean" | "conflict";
  readonly lines: readonly string[];
  /** Populated only for conflicts, so callers can render markers themselves. */
  readonly ours?: readonly string[];
  readonly theirs?: readonly string[];
  readonly base?: readonly string[];
}

export interface MergeResult {
  readonly regions: readonly MergeRegion[];
  readonly conflicts: number;
  get clean(): boolean;
}

export const CONFLICT_MARKERS = {
  ours: "<<<<<<<",
  divider: "=======",
  theirs: ">>>>>>>",
} as const;

/**
 * Express one side as a list of edits against the base.
 *
 * Consecutive insertions and deletions collapse into a single change covering
 * the base lines they replace, which is the unit a merge reasons about.
 */
function changesAgainstBase(base: readonly string[], side: readonly string[]): Change[] {
  const changes: Change[] = [];
  let baseIndex = 0;
  let start = -1;
  let end = -1;
  let lines: string[] = [];

  const flush = () => {
    if (start === -1) return;
    changes.push({ start, end, lines });
    start = -1;
    end = -1;
    lines = [];
  };

  for (const edit of diffLines(base, side)) {
    if (edit.kind === "equal") {
      flush();
      baseIndex += 1;
      continue;
    }

    if (start === -1) {
      start = baseIndex;
      end = baseIndex;
    }

    if (edit.kind === "delete") {
      baseIndex += 1;
      end = baseIndex;
    } else {
      lines.push(edit.text);
    }
  }

  flush();
  return changes;
}

/** Rebuild a slice of the base with a set of changes applied to it. */
function applyChanges(
  base: readonly string[],
  start: number,
  end: number,
  changes: readonly Change[],
): string[] {
  const out: string[] = [];
  let cursor = start;

  for (const change of changes) {
    while (cursor < change.start) out.push(base[cursor++] as string);
    out.push(...change.lines);
    cursor = Math.max(cursor, change.end);
  }

  while (cursor < end) out.push(base[cursor++] as string);
  return out;
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * Merge two versions of a file that share a common ancestor.
 *
 * Regions touched by only one side are taken from that side automatically -
 * that is the whole point, and it is why two people can edit opposite ends of
 * a file all day without ever conflicting. Only overlapping, differing edits
 * are escalated to the human.
 */
export function mergeLines(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
): MergeResult {
  const ourChanges = changesAgainstBase(base, ours);
  const theirChanges = changesAgainstBase(base, theirs);

  const regions: MergeRegion[] = [];
  let conflicts = 0;

  let baseIndex = 0;
  let a = 0;
  let b = 0;
  let pending: string[] = [];

  const flushPending = () => {
    if (pending.length === 0) return;
    regions.push({ kind: "clean", lines: pending });
    pending = [];
  };

  while (baseIndex < base.length || a < ourChanges.length || b < theirChanges.length) {
    const nextOurs = ourChanges[a];
    const nextTheirs = theirChanges[b];

    const oursHere = nextOurs !== undefined && nextOurs.start <= baseIndex;
    const theirsHere = nextTheirs !== undefined && nextTheirs.start <= baseIndex;

    if (!oursHere && !theirsHere) {
      if (baseIndex < base.length) {
        pending.push(base[baseIndex] as string);
        baseIndex += 1;
        continue;
      }
      /* c8 ignore next 2 - the loop condition guarantees progress. */
      break;
    }

    // Grow the region until it covers every change from either side that
    // genuinely overlaps it. Two edits touching the same lines must be judged
    // together; two edits that merely sit next to each other must not be, or
    // every pair of nearby edits would be reported as a false conflict.
    //
    // Seeding uses `<= baseIndex` because the region starts empty, but growth
    // uses a strict `< end`: a change beginning exactly where the region ends
    // covers different lines and belongs to the next region.
    const start = baseIndex;
    let end = baseIndex;
    const mine: Change[] = [];
    const yours: Change[] = [];

    if (oursHere) {
      const change = nextOurs as Change;
      end = Math.max(end, change.end);
      mine.push(change);
      a += 1;
    }

    if (theirsHere) {
      const change = nextTheirs as Change;
      end = Math.max(end, change.end);
      yours.push(change);
      b += 1;
    }

    for (let grew = true; grew; ) {
      grew = false;

      while (ourChanges[a] !== undefined && (ourChanges[a] as Change).start < end) {
        const change = ourChanges[a] as Change;
        end = Math.max(end, change.end);
        mine.push(change);
        a += 1;
        grew = true;
      }

      while (theirChanges[b] !== undefined && (theirChanges[b] as Change).start < end) {
        const change = theirChanges[b] as Change;
        end = Math.max(end, change.end);
        yours.push(change);
        b += 1;
        grew = true;
      }
    }

    const ourLines = applyChanges(base, start, end, mine);
    const theirLines = applyChanges(base, start, end, yours);

    if (yours.length === 0) {
      pending.push(...ourLines);
    } else if (mine.length === 0) {
      pending.push(...theirLines);
    } else if (sameLines(ourLines, theirLines)) {
      // Both sides made the identical edit. Agreement is not a conflict.
      pending.push(...ourLines);
    } else {
      flushPending();
      conflicts += 1;
      regions.push({
        kind: "conflict",
        lines: [],
        ours: ourLines,
        theirs: theirLines,
        base: base.slice(start, end),
      });
    }

    baseIndex = end;
  }

  flushPending();

  return {
    regions,
    conflicts,
    get clean() {
      return conflicts === 0;
    },
  };
}

export interface RenderOptions {
  readonly ourLabel?: string;
  readonly theirLabel?: string;
}

/**
 * Render a merge to text, writing conflict markers where the sides disagree.
 *
 * A conflicted file is deliberately left in a state that will not compile or
 * run. That is the point: it makes an unresolved conflict impossible to commit
 * by accident.
 */
export function renderMerge(result: MergeResult, options: RenderOptions = {}): string {
  const ourLabel = options.ourLabel ?? "ours";
  const theirLabel = options.theirLabel ?? "theirs";
  const out: string[] = [];

  for (const region of result.regions) {
    if (region.kind === "clean") {
      out.push(...region.lines);
      continue;
    }

    out.push(`${CONFLICT_MARKERS.ours} ${ourLabel}`);
    out.push(...(region.ours ?? []));
    out.push(CONFLICT_MARKERS.divider);
    out.push(...(region.theirs ?? []));
    out.push(`${CONFLICT_MARKERS.theirs} ${theirLabel}`);
  }

  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/** Convenience: merge three texts and render the outcome in one step. */
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  options: RenderOptions = {},
): { text: string; conflicts: number } {
  const split = (text: string) => {
    if (text.length === 0) return [];
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
  };

  const result = mergeLines(split(base), split(ours), split(theirs));
  return { text: renderMerge(result, options), conflicts: result.conflicts };
}
