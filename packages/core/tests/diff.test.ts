import { describe, expect, it } from "vitest";

import { countChanges, diffLines, formatUnifiedDiff, isBinary, splitLines, toHunks } from "../src/diff.js";

const render = (before: string[], after: string[]) =>
  diffLines(before, after).map((edit) => `${edit.kind[0]}:${edit.text}`);

describe("splitLines", () => {
  it("treats a trailing newline as a terminator, not a new line", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  it("returns nothing for empty text", () => {
    expect(splitLines("")).toEqual([]);
  });

  it("preserves genuinely blank lines in the middle", () => {
    expect(splitLines("a\n\nb\n")).toEqual(["a", "", "b"]);
  });
});

describe("diffLines", () => {
  it("reports no edits for identical input", () => {
    const edits = diffLines(["a", "b", "c"], ["a", "b", "c"]);
    expect(edits.every((edit) => edit.kind === "equal")).toBe(true);
  });

  it("finds a single insertion", () => {
    expect(render(["a", "c"], ["a", "b", "c"])).toEqual(["e:a", "i:b", "e:c"]);
  });

  it("finds a single deletion", () => {
    expect(render(["a", "b", "c"], ["a", "c"])).toEqual(["e:a", "d:b", "e:c"]);
  });

  it("handles a file created from nothing", () => {
    expect(render([], ["x", "y"])).toEqual(["i:x", "i:y"]);
  });

  it("handles a file deleted entirely", () => {
    expect(render(["x", "y"], [])).toEqual(["d:x", "d:y"]);
  });

  it("produces a minimal script for a classic case", () => {
    // The textbook Myers example. The optimal script is five edits; a greedy
    // line-by-line comparison would report far more.
    const before = ["A", "B", "C", "A", "B", "B", "A"];
    const after = ["C", "B", "A", "B", "A", "C"];

    const edits = diffLines(before, after);
    const { added, removed } = countChanges(edits);

    expect(added + removed).toBe(5);
  });

  it("reconstructs the new file exactly from the edit script", () => {
    const before = ["one", "two", "three", "four", "five"];
    const after = ["one", "TWO", "three", "five", "six"];

    const rebuilt = diffLines(before, after)
      .filter((edit) => edit.kind !== "delete")
      .map((edit) => edit.text);

    expect(rebuilt).toEqual(after);
  });

  it("reconstructs the old file by ignoring insertions", () => {
    const before = ["alpha", "beta", "gamma"];
    const after = ["alpha", "delta"];

    const rebuilt = diffLines(before, after)
      .filter((edit) => edit.kind !== "insert")
      .map((edit) => edit.text);

    expect(rebuilt).toEqual(before);
  });

  it("numbers lines correctly on both sides", () => {
    const edits = diffLines(["a", "b"], ["a", "x", "b"]);
    const inserted = edits.find((edit) => edit.kind === "insert");

    expect(inserted?.newLine).toBe(1);
    expect(inserted?.oldLine).toBeNull();
  });

  it("stays fast on large inputs with few changes", () => {
    // 20,000 lines. A quadratic implementation would allocate 400 million
    // cells here; Myers only pays for the two edits that actually exist.
    const before = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10_000] = "changed";

    const started = Date.now();
    const { added, removed } = countChanges(diffLines(before, after));

    expect(added).toBe(1);
    expect(removed).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("toHunks", () => {
  it("returns nothing when there are no changes", () => {
    expect(toHunks(diffLines(["a"], ["a"]))).toEqual([]);
  });

  it("surrounds a change with context lines", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = "changed";

    const hunks = toHunks(diffLines(before, after), 3);

    expect(hunks).toHaveLength(1);
    // Three lines of context either side, plus the deletion and insertion.
    expect(hunks[0]?.edits).toHaveLength(8);
  });

  it("merges nearby changes into one hunk", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[10] = "first";
    after[12] = "second";

    expect(toHunks(diffLines(before, after), 3)).toHaveLength(1);
  });

  it("keeps distant changes in separate hunks", () => {
    const before = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const after = [...before];
    after[5] = "first";
    after[50] = "second";

    expect(toHunks(diffLines(before, after), 3)).toHaveLength(2);
  });
});

describe("formatUnifiedDiff", () => {
  it("produces a readable unified patch", () => {
    const patch = formatUnifiedDiff("a\nb\nc\n", "a\nB\nc\n", { oldLabel: "a/f.txt", newLabel: "b/f.txt" });

    expect(patch).toContain("--- a/f.txt");
    expect(patch).toContain("+++ b/f.txt");
    expect(patch).toContain("@@");
    expect(patch).toContain("-b");
    expect(patch).toContain("+B");
    expect(patch).toContain(" a");
  });

  it("returns an empty string for identical input", () => {
    expect(formatUnifiedDiff("same\n", "same\n")).toBe("");
  });

  it("uses one-based line numbers", () => {
    const patch = formatUnifiedDiff("a\nb\n", "a\nB\n");
    expect(patch).toMatch(/@@ -1,2 \+1,2 @@/);
  });
});

describe("isBinary", () => {
  it("treats text as text", () => {
    expect(isBinary(Buffer.from("plain text\nwith lines\n", "utf8"))).toBe(false);
  });

  it("treats a NUL byte as the binary signal", () => {
    expect(isBinary(Buffer.from([0x89, 0x50, 0x00, 0x47]))).toBe(true);
  });

  it("only inspects the first block, so huge files stay cheap", () => {
    const buffer = Buffer.alloc(100_000, 0x41);
    buffer[50_000] = 0x00;
    expect(isBinary(buffer)).toBe(false);
  });
});
