import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { add } from "../src/commands/add.js";
import { createBranch } from "../src/commands/branch.js";
import { checkout } from "../src/commands/checkout.js";
import { commit } from "../src/commands/commit.js";
import { abortMerge, merge } from "../src/commands/merge.js";
import { log } from "../src/commands/log.js";
import { CONFLICT_MARKERS, mergeLines, mergeText } from "../src/merge.js";
import { readMergeHead } from "../src/mergestate.js";
import { RefStore } from "../src/refs.js";
import { status } from "../src/status.js";
import { authorAt, createTestRepository } from "./helpers.js";
import type { TestRepository } from "./helpers.js";

describe("three-way line merging", () => {
  const lines = (text: string) => text.split("\n");

  it("keeps the base when neither side changed anything", () => {
    const result = mergeLines(lines("a\nb\nc"), lines("a\nb\nc"), lines("a\nb\nc"));

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["a", "b", "c"]);
  });

  it("takes our change when only we edited", () => {
    const result = mergeLines(lines("a\nb\nc"), lines("a\nOURS\nc"), lines("a\nb\nc"));

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["a", "OURS", "c"]);
  });

  it("takes their change when only they edited", () => {
    const result = mergeLines(lines("a\nb\nc"), lines("a\nb\nc"), lines("a\nb\nTHEIRS"));

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["a", "b", "THEIRS"]);
  });

  it("combines edits to different parts of the same file", () => {
    // This is the case that makes collaboration possible at all: two people
    // working in one file, in different places, with no conflict.
    const base = lines("one\ntwo\nthree\nfour\nfive");
    const ours = lines("ONE\ntwo\nthree\nfour\nfive");
    const theirs = lines("one\ntwo\nthree\nfour\nFIVE");

    const result = mergeLines(base, ours, theirs);

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["ONE", "two", "three", "four", "FIVE"]);
  });

  it("does not treat an identical edit on both sides as a conflict", () => {
    const result = mergeLines(lines("a\nb\nc"), lines("a\nSAME\nc"), lines("a\nSAME\nc"));

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["a", "SAME", "c"]);
  });

  it("reports a conflict when both sides changed the same line differently", () => {
    const result = mergeLines(lines("a\nb\nc"), lines("a\nOURS\nc"), lines("a\nTHEIRS\nc"));

    expect(result.clean).toBe(false);
    expect(result.conflicts).toBe(1);

    const conflict = result.regions.find((region) => region.kind === "conflict");
    expect(conflict?.ours).toEqual(["OURS"]);
    expect(conflict?.theirs).toEqual(["THEIRS"]);
    expect(conflict?.base).toEqual(["b"]);
  });

  it("merges insertions at opposite ends of a file", () => {
    const result = mergeLines(lines("middle"), lines("top\nmiddle"), lines("middle\nbottom"));

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["top", "middle", "bottom"]);
  });

  it("conflicts when both sides insert different text at the same point", () => {
    const result = mergeLines(lines("a\nb"), lines("a\nOURS\nb"), lines("a\nTHEIRS\nb"));

    expect(result.clean).toBe(false);
  });

  it("handles one side deleting a region the other left alone", () => {
    const result = mergeLines(lines("a\nb\nc\nd"), lines("a\nd"), lines("a\nb\nc\nd"));

    expect(result.clean).toBe(true);
    expect(result.regions.flatMap((region) => region.lines)).toEqual(["a", "d"]);
  });

  it("counts multiple independent conflicts separately", () => {
    const base = lines("a\nb\nc\nd\ne\nf\ng\nh\ni\nj");
    const ours = lines("a\nOURS1\nc\nd\ne\nf\ng\nh\nOURS2\nj");
    const theirs = lines("a\nTHEIRS1\nc\nd\ne\nf\ng\nh\nTHEIRS2\nj");

    expect(mergeLines(base, ours, theirs).conflicts).toBe(2);
  });
});

describe("rendering a merge", () => {
  it("writes conflict markers a human can resolve", () => {
    const { text, conflicts } = mergeText("a\nb\nc\n", "a\nOURS\nc\n", "a\nTHEIRS\nc\n", {
      ourLabel: "main",
      theirLabel: "feature",
    });

    expect(conflicts).toBe(1);
    expect(text).toContain(`${CONFLICT_MARKERS.ours} main`);
    expect(text).toContain("OURS");
    expect(text).toContain(CONFLICT_MARKERS.divider);
    expect(text).toContain("THEIRS");
    expect(text).toContain(`${CONFLICT_MARKERS.theirs} feature`);
  });

  it("renders a clean merge as plain text with no markers", () => {
    const { text, conflicts } = mergeText("a\nb\n", "A\nb\n", "a\nB\n");

    expect(conflicts).toBe(0);
    expect(text).toBe("A\nB\n");
    expect(text).not.toContain(CONFLICT_MARKERS.divider);
  });
});

describe("merging branches", () => {
  let context: TestRepository;
  let clock = 0;

  const stageAndCommit = async (message: string) => {
    clock += 10;
    await add(context.repository, ["."]);
    return commit(context.repository, { message, author: authorAt(clock) });
  };

  beforeEach(async () => {
    context = await createTestRepository();
    clock = 0;
    await context.write("shared.txt", "one\ntwo\nthree\n");
    await stageAndCommit("Base commit");
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it("reports up-to-date when the target is already an ancestor", async () => {
    await createBranch(context.repository, "behind");
    await context.write("new.txt", "x\n");
    await stageAndCommit("Move ahead");

    const report = await merge(context.repository, "behind");
    expect(report.outcome).toBe("up-to-date");
  });

  it("fast-forwards when our history is contained in theirs", async () => {
    await createBranch(context.repository, "feature");
    await checkout(context.repository, "feature");
    await context.write("feature.txt", "f\n");
    const ahead = await stageAndCommit("Feature work");

    await checkout(context.repository, "main");
    const report = await merge(context.repository, "feature");

    expect(report.outcome).toBe("fast-forward");
    expect(report.commit).toBe(ahead.id);
    expect(await context.exists("feature.txt")).toBe(true);
    // A fast-forward creates no merge commit; the pointer simply moved.
    expect((await log(context.repository)).map((entry) => entry.message)).toEqual([
      "Feature work",
      "Base commit",
    ]);
  });

  it("merges non-overlapping work from both branches", async () => {
    await createBranch(context.repository, "feature");

    await context.write("from-main.txt", "m\n");
    const onMain = await stageAndCommit("Work on main");

    await checkout(context.repository, "feature");
    await context.write("from-feature.txt", "f\n");
    const onFeature = await stageAndCommit("Work on feature");

    await checkout(context.repository, "main");
    const report = await merge(context.repository, "feature");

    expect(report.outcome).toBe("merged");
    expect(report.conflicts).toHaveLength(0);
    // Both branches' files are present afterwards.
    expect(await context.exists("from-main.txt")).toBe(true);
    expect(await context.exists("from-feature.txt")).toBe(true);

    const merged = await context.repository.objects.readCommit(report.commit!);
    expect(merged.parents).toEqual([onMain.id, onFeature.id]);
  });

  it("merges edits to different parts of the same file", async () => {
    await createBranch(context.repository, "feature");

    await context.write("shared.txt", "ONE\ntwo\nthree\n");
    await stageAndCommit("Edit the top");

    await checkout(context.repository, "feature");
    await context.write("shared.txt", "one\ntwo\nTHREE\n");
    await stageAndCommit("Edit the bottom");

    await checkout(context.repository, "main");
    const report = await merge(context.repository, "feature");

    expect(report.outcome).toBe("merged");
    expect(await context.read("shared.txt")).toBe("ONE\ntwo\nTHREE\n");
  });

  it("stops with conflict markers when both sides changed the same line", async () => {
    await createBranch(context.repository, "feature");

    await context.write("shared.txt", "one\nMAIN\nthree\n");
    await stageAndCommit("Main's version");

    await checkout(context.repository, "feature");
    await context.write("shared.txt", "one\nFEATURE\nthree\n");
    const featureTip = await stageAndCommit("Feature's version");

    await checkout(context.repository, "main");
    const report = await merge(context.repository, "feature");

    expect(report.outcome).toBe("conflicted");
    expect(report.conflicts).toEqual([{ path: "shared.txt", reason: "content" }]);

    const contents = await context.read("shared.txt");
    expect(contents).toContain("MAIN");
    expect(contents).toContain("FEATURE");
    expect(contents).toContain(CONFLICT_MARKERS.divider);

    // The other parent is remembered so the resolving commit becomes a merge.
    expect(await readMergeHead(context.repository)).toBe(featureTip.id);
    // The conflicted file is left unstaged, so status points the user at it.
    expect((await status(context.repository)).unstaged.map((c) => c.path)).toContain("shared.txt");
  });

  it("produces a two-parent commit once conflicts are resolved", async () => {
    await createBranch(context.repository, "feature");

    await context.write("shared.txt", "one\nMAIN\nthree\n");
    const mainTip = await stageAndCommit("Main's version");

    await checkout(context.repository, "feature");
    await context.write("shared.txt", "one\nFEATURE\nthree\n");
    const featureTip = await stageAndCommit("Feature's version");

    await checkout(context.repository, "main");
    await merge(context.repository, "feature");

    // The human resolves by hand, then stages and commits.
    await context.write("shared.txt", "one\nRESOLVED\nthree\n");
    await add(context.repository, ["shared.txt"]);
    const resolved = await commit(context.repository, {
      message: "Merge feature",
      author: authorAt(100),
    });

    expect(resolved.parents).toEqual([mainTip.id, featureTip.id]);
    expect(await readMergeHead(context.repository)).toBeNull();
    expect(await context.read("shared.txt")).toBe("one\nRESOLVED\nthree\n");
  });

  it("conflicts when one side edits a file the other deleted", async () => {
    await createBranch(context.repository, "feature");

    await context.write("shared.txt", "one\ntwo\nEDITED\n");
    await stageAndCommit("Edit it");

    await checkout(context.repository, "feature");
    await context.remove("shared.txt");
    await stageAndCommit("Delete it");

    await checkout(context.repository, "main");
    const report = await merge(context.repository, "feature");

    expect(report.outcome).toBe("conflicted");
    expect(report.conflicts).toEqual([{ path: "shared.txt", reason: "modified-and-deleted" }]);
  });

  it("refuses to merge on top of uncommitted work", async () => {
    await createBranch(context.repository, "feature");
    await checkout(context.repository, "feature");
    await context.write("feature.txt", "f\n");
    await stageAndCommit("Feature work");

    await checkout(context.repository, "main");
    await context.write("shared.txt", "uncommitted edit\n");

    await expect(merge(context.repository, "feature")).rejects.toThrow(/commit or discard/);
  });

  it("aborts a conflicted merge and restores the previous state", async () => {
    await createBranch(context.repository, "feature");

    await context.write("shared.txt", "one\nMAIN\nthree\n");
    const mainTip = await stageAndCommit("Main's version");

    await checkout(context.repository, "feature");
    await context.write("shared.txt", "one\nFEATURE\nthree\n");
    await stageAndCommit("Feature's version");

    await checkout(context.repository, "main");
    await merge(context.repository, "feature");

    await abortMerge(context.repository);

    expect(await readMergeHead(context.repository)).toBeNull();
    expect(await context.read("shared.txt")).toBe("one\nMAIN\nthree\n");
    expect(await new RefStore(context.repository).headCommit()).toBe(mainTip.id);
  });

  it("refuses to start a second merge while one is in progress", async () => {
    await createBranch(context.repository, "feature");

    await context.write("shared.txt", "one\nMAIN\nthree\n");
    await stageAndCommit("Main's version");

    await checkout(context.repository, "feature");
    await context.write("shared.txt", "one\nFEATURE\nthree\n");
    await stageAndCommit("Feature's version");

    await checkout(context.repository, "main");
    await merge(context.repository, "feature");

    await expect(merge(context.repository, "feature")).rejects.toThrow(/already in progress/);
  });
});
