import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CorruptObjectError,
  decodeCommit,
  decodeTree,
  encodeCommit,
  encodeTree,
  frame,
  unframe,
} from "../src/objects/codec.js";
import { AmbiguousObjectIdError, ObjectNotFoundError, ObjectStore, hash, idFor } from "../src/objects/store.js";
import { FileMode } from "../src/objects/types.js";
import { TEST_AUTHOR } from "./helpers.js";

describe("object framing", () => {
  it("round-trips a payload with its type and length", () => {
    const payload = Buffer.from("hello world", "utf8");
    const { type, payload: recovered } = unframe(frame("blob", payload));

    expect(type).toBe("blob");
    expect(recovered.toString("utf8")).toBe("hello world");
  });

  it("gives different ids to identical bytes stored as different types", () => {
    // Without the type in the header these would collide, and the store would
    // hand back a tree when asked for a blob.
    const payload = Buffer.alloc(0);
    expect(idFor("blob", payload)).not.toBe(idFor("tree", payload));
  });

  it("rejects a header whose length disagrees with the payload", () => {
    const tampered = Buffer.concat([Buffer.from("blob 99\0", "utf8"), Buffer.from("short", "utf8")]);
    expect(() => unframe(tampered)).toThrow(CorruptObjectError);
  });

  it("rejects an unknown object type", () => {
    const bogus = Buffer.concat([Buffer.from("banana 3\0", "utf8"), Buffer.from("abc", "utf8")]);
    expect(() => unframe(bogus)).toThrow(/unknown object type/);
  });
});

describe("tree encoding", () => {
  const entry = (name: string, id = "a".repeat(64)) =>
    ({ name, id, mode: FileMode.Regular, type: "blob" }) as const;

  it("sorts entries so equal directories hash equally", () => {
    const forward = encodeTree([entry("b.txt"), entry("a.txt")]);
    const backward = encodeTree([entry("a.txt"), entry("b.txt")]);

    expect(forward.equals(backward)).toBe(true);
  });

  it("round-trips entries including names containing spaces", () => {
    const entries = [
      entry("my notes.md"),
      { name: "src", id: "b".repeat(64), mode: FileMode.Directory, type: "tree" } as const,
      { name: "run.sh", id: "c".repeat(64), mode: FileMode.Executable, type: "blob" } as const,
    ];

    const decoded = decodeTree(encodeTree(entries));

    expect(decoded).toHaveLength(3);
    expect(decoded.map((e) => e.name)).toEqual(["my notes.md", "run.sh", "src"]);
    expect(decoded.find((e) => e.name === "run.sh")?.mode).toBe(FileMode.Executable);
    expect(decoded.find((e) => e.name === "src")?.type).toBe("tree");
  });

  it("refuses names that would corrupt the format", () => {
    expect(() => encodeTree([entry("bad\tname")])).toThrow(CorruptObjectError);
    expect(() => encodeTree([entry("bad\nname")])).toThrow(CorruptObjectError);
    expect(() => encodeTree([entry("nested/path")])).toThrow(CorruptObjectError);
  });

  it("refuses duplicate names", () => {
    expect(() => encodeTree([entry("a.txt"), entry("a.txt", "b".repeat(64))])).toThrow(/duplicate/);
  });

  it("encodes and decodes an empty tree", () => {
    expect(decodeTree(encodeTree([]))).toEqual([]);
  });
});

describe("commit encoding", () => {
  const base = {
    tree: "a".repeat(64),
    parents: [],
    author: TEST_AUTHOR,
    committer: TEST_AUTHOR,
    message: "Initial commit",
  };

  it("round-trips a root commit", () => {
    const decoded = decodeCommit(encodeCommit(base));

    expect(decoded.tree).toBe(base.tree);
    expect(decoded.parents).toEqual([]);
    expect(decoded.author).toEqual(TEST_AUTHOR);
    expect(decoded.message).toBe("Initial commit");
  });

  it("round-trips multiple parents, preserving their order", () => {
    const parents = ["b".repeat(64), "c".repeat(64)];
    expect(decodeCommit(encodeCommit({ ...base, parents })).parents).toEqual(parents);
  });

  it("preserves a multi-line message verbatim", () => {
    const message = "Short subject\n\nA longer body.\nWith two lines.";
    expect(decodeCommit(encodeCommit({ ...base, message })).message).toBe(message);
  });

  it("rejects a commit with no header separator", () => {
    expect(() => decodeCommit(Buffer.from("tree abc", "utf8"))).toThrow(CorruptObjectError);
  });
});

describe("ObjectStore", () => {
  let root: string;
  let store: ObjectStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-objects-"));
    store = new ObjectStore(path.join(root, "objects"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores and reads back a blob", async () => {
    const id = await store.writeBlob(Buffer.from("contents", "utf8"));

    expect(id).toHaveLength(64);
    expect((await store.readBlob(id)).toString("utf8")).toBe("contents");
  });

  it("deduplicates identical content", async () => {
    const first = await store.writeBlob(Buffer.from("same", "utf8"));
    const second = await store.writeBlob(Buffer.from("same", "utf8"));

    expect(first).toBe(second);
    expect(await store.list()).toHaveLength(1);
  });

  it("throws a typed error for a missing object", async () => {
    await expect(store.read("f".repeat(64))).rejects.toThrow(ObjectNotFoundError);
  });

  it("refuses to read an object whose bytes were tampered with", async () => {
    const id = await store.writeBlob(Buffer.from("trustworthy", "utf8"));
    await fs.writeFile(store.pathFor(id), Buffer.from("not even valid zlib", "utf8"));

    await expect(store.read(id)).rejects.toThrow(CorruptObjectError);
  });

  it("detects corruption during verification", async () => {
    const good = await store.writeBlob(Buffer.from("intact", "utf8"));
    const bad = await store.writeBlob(Buffer.from("doomed", "utf8"));
    await fs.writeFile(store.pathFor(bad), Buffer.from("garbage", "utf8"));

    const result = await store.verify();

    expect(result.checked).toBe(2);
    expect(result.corrupt).toEqual([bad]);
    expect(result.corrupt).not.toContain(good);
  });

  it("expands an unambiguous id prefix", async () => {
    const id = await store.writeBlob(Buffer.from("abbreviate me", "utf8"));
    expect(await store.resolvePrefix(id.slice(0, 8))).toBe(id);
  });

  it("refuses to guess when a prefix is ambiguous", async () => {
    // Fabricate two objects sharing a prefix by writing them directly.
    const ids = ["abcd" + "1".repeat(60), "abcd" + "2".repeat(60)];
    for (const id of ids) {
      await fs.mkdir(path.dirname(store.pathFor(id)), { recursive: true });
      await fs.writeFile(store.pathFor(id), "placeholder");
    }

    await expect(store.resolvePrefix("abcd")).rejects.toThrow(AmbiguousObjectIdError);
  });

  it("rejects a prefix that is too short to be meaningful", async () => {
    await expect(store.resolvePrefix("ab")).rejects.toThrow(ObjectNotFoundError);
  });

  it("refuses to hand back an object of the wrong type", async () => {
    const treeId = await store.writeTree([]);
    await expect(store.readBlob(treeId)).rejects.toThrow(/expected .* to be a blob/);
  });

  it("hashes bytes the same way every time", () => {
    const bytes = Buffer.from("stability matters", "utf8");
    expect(hash(bytes)).toBe(hash(Buffer.from("stability matters", "utf8")));
  });
});
