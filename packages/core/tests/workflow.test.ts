import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { add } from "../src/commands/add.js";
import { createBranch, listBranches } from "../src/commands/branch.js";
import { UncommittedChangesError, checkout, restore } from "../src/commands/checkout.js";
import { NothingToCommitError, commit } from "../src/commands/commit.js";
import { diffCommit, diffStaged, diffUnstaged } from "../src/commands/diff.js";
import { log, mergeBase } from "../src/commands/log.js";
import { RefStore, RevisionNotFoundError } from "../src/refs.js";
import { Repository, RepositoryExistsError } from "../src/repository.js";
import { isClean, status } from "../src/status.js";
import { authorAt, createTestRepository, TEST_AUTHOR } from "./helpers.js";
import type { TestRepository } from "./helpers.js";

describe("repository lifecycle", () => {
  let context: TestRepository;

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it("creates the on-disk layout and starts with no commits", async () => {
    expect(await context.exists(".tess/objects")).toBe(true);
    expect(await context.exists(".tess/refs/heads")).toBe(true);
    expect(await context.exists(".tess/HEAD")).toBe(true);
    expect(await context.exists(".tessignore")).toBe(true);

    const refs = new RefStore(context.repository);
    const head = await refs.readHead();

    expect(head).toEqual({ kind: "attached", branch: "main" });
    // HEAD names a branch that does not exist yet - the first commit creates it.
    expect(await refs.headCommit()).toBeNull();
  });

  it("refuses to initialise over an existing repository", async () => {
    await expect(Repository.initialise(context.directory)).rejects.toThrow(RepositoryExistsError);
  });

  it("finds the repository from a nested subdirectory", async () => {
    await context.write("deep/nested/file.txt", "hi");
    const found = await Repository.discover(`${context.directory}/deep/nested`);

    expect(found.workingDirectory).toBe(context.directory);
  });
});

describe("staging and committing", () => {
  let context: TestRepository;

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it("walks a file from untracked to staged to committed", async () => {
    await context.write("readme.md", "hello\n");

    let report = await status(context.repository);
    expect(report.untracked).toContain("readme.md");
    expect(report.staged).toHaveLength(0);

    await add(context.repository, ["readme.md"]);

    report = await status(context.repository);
    expect(report.untracked).not.toContain("readme.md");
    expect(report.staged).toEqual([{ path: "readme.md", kind: "added" }]);

    await commit(context.repository, { message: "Add readme", author: TEST_AUTHOR });

    report = await status(context.repository);
    expect(report.staged).toHaveLength(0);
    expect(report.unstaged).toHaveLength(0);
    expect(report.headCommit).toBeTruthy();
    // The .tessignore written by `init` is a real file the user may or may not
    // want tracked, so it stays untracked until they say otherwise.
    expect(report.untracked).toEqual([".tessignore"]);

    await add(context.repository, [".tessignore"]);
    await commit(context.repository, { message: "Track ignore rules", author: authorAt(1) });
    expect(isClean(await status(context.repository))).toBe(true);
  });

  it("creates the branch on the first commit", async () => {
    await context.write("a.txt", "a\n");
    await add(context.repository, ["a.txt"]);
    const created = await commit(context.repository, { message: "First", author: TEST_AUTHOR });

    const refs = new RefStore(context.repository);
    expect(await refs.readBranch("main")).toBe(created.id);
  });

  it("captures contents at stage time, not at commit time", async () => {
    await context.write("f.txt", "staged version\n");
    await add(context.repository, ["f.txt"]);
    await context.write("f.txt", "later edit\n");

    const report = await status(context.repository);
    // The same file is legitimately both staged and modified.
    expect(report.staged).toEqual([{ path: "f.txt", kind: "added" }]);
    expect(report.unstaged).toEqual([{ path: "f.txt", kind: "modified" }]);

    const created = await commit(context.repository, { message: "Snapshot", author: TEST_AUTHOR });
    const files = await import("../src/trees.js").then((m) => m.readCommitFiles(context.repository, created.id));
    const blob = await context.repository.objects.readBlob(files.get("f.txt")!.id);

    expect(blob.toString("utf8")).toBe("staged version\n");
  });

  it("refuses an empty commit message", async () => {
    await context.write("a.txt", "a\n");
    await add(context.repository, ["a.txt"]);

    await expect(commit(context.repository, { message: "   " })).rejects.toThrow(/message is required/);
  });

  it("refuses to commit when nothing changed", async () => {
    await context.write("a.txt", "a\n");
    await add(context.repository, ["a.txt"]);
    await commit(context.repository, { message: "First", author: TEST_AUTHOR });

    await expect(commit(context.repository, { message: "Again", author: TEST_AUTHOR })).rejects.toThrow(
      NothingToCommitError,
    );
  });

  it("records a deletion when a tracked file is staged after removal", async () => {
    await context.write("gone.txt", "here\n");
    await add(context.repository, ["gone.txt"]);
    await commit(context.repository, { message: "Add", author: TEST_AUTHOR });

    await context.remove("gone.txt");
    const result = await add(context.repository, ["gone.txt"]);

    expect(result.removed).toEqual(["gone.txt"]);
    expect((await status(context.repository)).staged).toEqual([{ path: "gone.txt", kind: "deleted" }]);
  });

  it("stages a whole directory recursively", async () => {
    await context.write("src/a.ts", "a\n");
    await context.write("src/nested/b.ts", "b\n");
    await context.write("outside.txt", "x\n");

    const result = await add(context.repository, ["src"]);

    expect(result.staged).toEqual(["src/a.ts", "src/nested/b.ts"]);
    expect(result.staged).not.toContain("outside.txt");
  });

  it("stores identical content once, however many files hold it", async () => {
    await context.write("one.txt", "duplicate\n");
    await context.write("two.txt", "duplicate\n");
    await add(context.repository, ["."]);

    const blobs = await context.repository.objects.list();
    // One blob for the shared content, plus the .tessignore blob.
    const contents = await Promise.all(
      blobs.map(async (id) => (await context.repository.objects.read(id)).type),
    );
    expect(contents.filter((type) => type === "blob")).toHaveLength(2);
  });

  it("reuses the tree object of an unchanged directory", async () => {
    await context.write("stable/a.txt", "unchanged\n");
    await context.write("volatile/b.txt", "first\n");
    await add(context.repository, ["."]);
    const first = await commit(context.repository, { message: "One", author: authorAt(0) });

    await context.write("volatile/b.txt", "second\n");
    await add(context.repository, ["."]);
    const second = await commit(context.repository, { message: "Two", author: authorAt(1) });

    const treeOf = async (id: string, name: string) => {
      const commitObject = await context.repository.objects.readCommit(id);
      const entries = await context.repository.objects.readTree(commitObject.tree);
      return entries.find((entry) => entry.name === name)?.id;
    };

    // The untouched directory keeps its exact identity across commits.
    expect(await treeOf(first.id, "stable")).toBe(await treeOf(second.id, "stable"));
    expect(await treeOf(first.id, "volatile")).not.toBe(await treeOf(second.id, "volatile"));
  });

  it("honours .tessignore", async () => {
    await context.write(".tessignore", "*.log\nsecret/\n");
    await context.write("app.log", "noise\n");
    await context.write("secret/key.txt", "shhh\n");
    await context.write("keep.txt", "yes\n");

    await add(context.repository, ["."]);
    const report = await status(context.repository);
    const staged = report.staged.map((change) => change.path);

    expect(staged).toContain("keep.txt");
    expect(staged).not.toContain("app.log");
    expect(staged).not.toContain("secret/key.txt");
  });
});

describe("history", () => {
  let context: TestRepository;

  const commitFile = async (name: string, contents: string, message: string, seconds: number) => {
    await context.write(name, contents);
    await add(context.repository, [name]);
    return commit(context.repository, { message, author: authorAt(seconds) });
  };

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it("lists commits newest first", async () => {
    await commitFile("a.txt", "a\n", "First", 0);
    await commitFile("b.txt", "b\n", "Second", 10);
    await commitFile("c.txt", "c\n", "Third", 20);

    const history = await log(context.repository);
    expect(history.map((entry) => entry.message)).toEqual(["Third", "Second", "First"]);
  });

  it("links each commit to the one before it", async () => {
    const first = await commitFile("a.txt", "a\n", "First", 0);
    const second = await commitFile("b.txt", "b\n", "Second", 10);

    expect(second.parents).toEqual([first.id]);
    expect(first.parents).toEqual([]);
  });

  it("respects a limit", async () => {
    await commitFile("a.txt", "a\n", "First", 0);
    await commitFile("b.txt", "b\n", "Second", 10);
    await commitFile("c.txt", "c\n", "Third", 20);

    expect(await log(context.repository, { limit: 2 })).toHaveLength(2);
  });

  it("resolves HEAD~n to an ancestor", async () => {
    const first = await commitFile("a.txt", "a\n", "First", 0);
    await commitFile("b.txt", "b\n", "Second", 10);
    await commitFile("c.txt", "c\n", "Third", 20);

    const refs = new RefStore(context.repository);
    expect(await refs.resolve("HEAD~2")).toBe(first.id);
    expect(await refs.resolve("HEAD^^")).toBe(first.id);
  });

  it("rejects a revision that does not exist", async () => {
    await commitFile("a.txt", "a\n", "First", 0);
    const refs = new RefStore(context.repository);

    await expect(refs.resolve("nope")).rejects.toThrow(RevisionNotFoundError);
    await expect(refs.resolve("HEAD~5")).rejects.toThrow(RevisionNotFoundError);
  });

  it("finds where two branches diverged", async () => {
    const shared = await commitFile("a.txt", "a\n", "Shared", 0);

    await createBranch(context.repository, "feature", shared.id);
    const onMain = await commitFile("main.txt", "m\n", "On main", 10);

    await checkout(context.repository, "feature");
    const onFeature = await commitFile("feature.txt", "f\n", "On feature", 20);

    expect(await mergeBase(context.repository, onMain.id, onFeature.id)).toBe(shared.id);
  });
});

describe("branching and checkout", () => {
  let context: TestRepository;

  beforeEach(async () => {
    context = await createTestRepository();
    await context.write("a.txt", "original\n");
    await add(context.repository, ["a.txt"]);
    await commit(context.repository, { message: "First", author: authorAt(0) });
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it("creates a branch without switching to it", async () => {
    await createBranch(context.repository, "feature");

    const branches = await listBranches(context.repository);
    expect(branches.map((b) => b.name).sort()).toEqual(["feature", "main"]);
    expect(branches.find((b) => b.name === "main")?.isCurrent).toBe(true);
    expect(branches.find((b) => b.name === "feature")?.isCurrent).toBe(false);
  });

  it("isolates work on separate branches", async () => {
    await createBranch(context.repository, "feature");
    await checkout(context.repository, "feature");

    await context.write("feature-only.txt", "new\n");
    await add(context.repository, ["feature-only.txt"]);
    await commit(context.repository, { message: "Feature work", author: authorAt(10) });

    expect(await context.exists("feature-only.txt")).toBe(true);

    await checkout(context.repository, "main");
    // Switching back removes the file that only exists on the other branch.
    expect(await context.exists("feature-only.txt")).toBe(false);

    await checkout(context.repository, "feature");
    expect(await context.exists("feature-only.txt")).toBe(true);
    expect(await context.read("feature-only.txt")).toBe("new\n");
  });

  it("refuses to switch away from uncommitted work", async () => {
    await createBranch(context.repository, "feature");
    await context.write("a.txt", "edited but not committed\n");

    await expect(checkout(context.repository, "feature")).rejects.toThrow(UncommittedChangesError);
    expect(await context.read("a.txt")).toBe("edited but not committed\n");
  });

  it("discards uncommitted work when forced", async () => {
    await createBranch(context.repository, "feature");
    await context.write("a.txt", "edited\n");

    await checkout(context.repository, "feature", { force: true });
    expect(await context.read("a.txt")).toBe("original\n");
  });

  it("detaches HEAD when checking out a commit id", async () => {
    const refs = new RefStore(context.repository);
    const first = await refs.resolve("HEAD");

    await context.write("b.txt", "b\n");
    await add(context.repository, ["b.txt"]);
    await commit(context.repository, { message: "Second", author: authorAt(10) });

    await checkout(context.repository, first.slice(0, 10));

    expect(await refs.readHead()).toEqual({ kind: "detached", commit: first });
    expect(await context.exists("b.txt")).toBe(false);
  });

  it("restores a single file without moving HEAD", async () => {
    await context.write("a.txt", "broken\n");
    const before = await new RefStore(context.repository).readHead();

    await restore(context.repository, ["a.txt"]);

    expect(await context.read("a.txt")).toBe("original\n");
    expect(await new RefStore(context.repository).readHead()).toEqual(before);
  });

  it("refuses to delete the branch you are standing on", async () => {
    const refs = new RefStore(context.repository);
    await expect(refs.deleteBranch("main")).rejects.toThrow(/currently on/);
  });

  it("rejects branch names that could escape the refs directory", async () => {
    await expect(createBranch(context.repository, "../../escape")).rejects.toThrow(/invalid branch name/);
    await expect(createBranch(context.repository, "HEAD")).rejects.toThrow(/invalid branch name/);
  });
});

describe("diffing", () => {
  let context: TestRepository;

  beforeEach(async () => {
    context = await createTestRepository();
  });

  afterEach(async () => {
    await context.cleanup();
  });

  it("shows unstaged edits", async () => {
    await context.write("f.txt", "one\ntwo\nthree\n");
    await add(context.repository, ["f.txt"]);
    await commit(context.repository, { message: "First", author: authorAt(0) });

    await context.write("f.txt", "one\nTWO\nthree\n");

    const diffs = await diffUnstaged(context.repository);
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.kind).toBe("modified");
    expect(diffs[0]?.added).toBe(1);
    expect(diffs[0]?.removed).toBe(1);
    expect(diffs[0]?.patch).toContain("+TWO");
  });

  it("shows staged changes separately from unstaged ones", async () => {
    await context.write("f.txt", "original\n");
    await add(context.repository, ["f.txt"]);
    await commit(context.repository, { message: "First", author: authorAt(0) });

    await context.write("f.txt", "staged\n");
    await add(context.repository, ["f.txt"]);
    await context.write("f.txt", "unstaged\n");

    expect((await diffStaged(context.repository))[0]?.patch).toContain("+staged");
    expect((await diffUnstaged(context.repository))[0]?.patch).toContain("+unstaged");
  });

  it("reports what a commit introduced", async () => {
    await context.write("f.txt", "a\n");
    await add(context.repository, ["f.txt"]);
    await commit(context.repository, { message: "First", author: authorAt(0) });

    await context.write("g.txt", "b\n");
    await add(context.repository, ["g.txt"]);
    await commit(context.repository, { message: "Second", author: authorAt(10) });

    const diffs = await diffCommit(context.repository, "HEAD");
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.path).toBe("g.txt");
    expect(diffs[0]?.kind).toBe("added");
  });

  it("marks binary files instead of printing them", async () => {
    const { promises: fs } = await import("node:fs");
    await fs.writeFile(`${context.directory}/logo.bin`, Buffer.from([0x00, 0x01, 0x02]));
    await add(context.repository, ["logo.bin"]);

    const diffs = await diffStaged(context.repository);
    const binary = diffs.find((diff) => diff.path === "logo.bin");

    expect(binary?.binary).toBe(true);
    expect(binary?.patch).toBe("");
  });
});
