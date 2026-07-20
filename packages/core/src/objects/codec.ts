import { FileMode } from "./types.js";
import type { CommitObject, Identity, ObjectType, TreeEntry } from "./types.js";

/**
 * Object serialisation.
 *
 * Every object is stored as a header followed by a NUL byte and a payload:
 *
 *     <type> <byte-length-of-payload>\0<payload>
 *
 * The header is what makes the hash meaningful. Without it a blob containing
 * the bytes of a tree would hash identically to that tree, and the store would
 * happily conflate the two. Including the type and length makes every object
 * self-describing and makes accidental collisions between kinds impossible.
 */

const NUL = 0x00;

export class CorruptObjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptObjectError";
  }
}

/** Wrap a payload in its object header, producing the bytes that get hashed. */
export function frame(type: ObjectType, payload: Buffer): Buffer {
  const header = Buffer.from(`${type} ${payload.byteLength}\0`, "utf8");
  return Buffer.concat([header, payload]);
}

/** Split framed bytes back into their type and payload, validating the length. */
export function unframe(framed: Buffer): { type: ObjectType; payload: Buffer } {
  const nul = framed.indexOf(NUL);
  if (nul === -1) {
    throw new CorruptObjectError("object header is missing its NUL terminator");
  }

  const header = framed.subarray(0, nul).toString("utf8");
  const space = header.indexOf(" ");
  if (space === -1) {
    throw new CorruptObjectError(`malformed object header: ${header}`);
  }

  const type = header.slice(0, space);
  if (type !== "blob" && type !== "tree" && type !== "commit") {
    throw new CorruptObjectError(`unknown object type: ${type}`);
  }

  const declaredLength = Number(header.slice(space + 1));
  const payload = framed.subarray(nul + 1);
  if (!Number.isInteger(declaredLength) || declaredLength !== payload.byteLength) {
    throw new CorruptObjectError(
      `object length mismatch: header claims ${header.slice(space + 1)}, found ${payload.byteLength}`,
    );
  }

  return { type, payload };
}

/* -------------------------------------------------------------------------- */
/* Trees                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Tree payload: one entry per line, sorted by name.
 *
 *     <mode> <type> <id>\t<name>\n
 *
 * Sorting is not cosmetic. Two directories with the same children must produce
 * byte-identical payloads so they hash to the same id - that identity is what
 * lets an unchanged subdirectory be skipped entirely when comparing commits.
 *
 * The tab separator means names may contain spaces. Names containing a tab or
 * newline are rejected at write time rather than silently corrupting the tree.
 */
export function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const seen = new Set<string>();
  const lines: string[] = [];

  for (const entry of sorted) {
    if (entry.name.length === 0) {
      throw new CorruptObjectError("tree entry has an empty name");
    }
    if (/[\t\n/]/.test(entry.name)) {
      throw new CorruptObjectError(
        `tree entry name may not contain a tab, newline or slash: ${JSON.stringify(entry.name)}`,
      );
    }
    if (seen.has(entry.name)) {
      throw new CorruptObjectError(`duplicate tree entry: ${entry.name}`);
    }
    seen.add(entry.name);

    lines.push(`${entry.mode} ${entry.type} ${entry.id}\t${entry.name}`);
  }

  return Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8");
}

const TREE_LINE = /^(\d{6}) (blob|tree) ([0-9a-f]{64})\t(.+)$/;

export function decodeTree(payload: Buffer): TreeEntry[] {
  const text = payload.toString("utf8");
  if (text.length === 0) return [];

  const lines = text.split("\n");
  // A well-formed payload ends in a newline, so the final split yields "".
  if (lines.pop() !== "") {
    throw new CorruptObjectError("tree payload does not end with a newline");
  }

  return lines.map((line) => {
    const match = TREE_LINE.exec(line);
    if (!match) {
      throw new CorruptObjectError(`malformed tree entry: ${JSON.stringify(line)}`);
    }
    const [, mode, type, id, name] = match as unknown as [string, string, "blob" | "tree", string, string];

    if (mode !== FileMode.Directory && mode !== FileMode.Regular && mode !== FileMode.Executable) {
      throw new CorruptObjectError(`unsupported file mode: ${mode}`);
    }

    return { mode, type, id, name } satisfies TreeEntry;
  });
}

/* -------------------------------------------------------------------------- */
/* Commits                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Commit payload: RFC-822-ish headers, a blank line, then the message.
 *
 *     tree <id>
 *     parent <id>          (zero or more)
 *     author <name> <email> <ms-since-epoch> <utc-offset-minutes>
 *     committer <...>
 *
 *     <message>
 *
 * The parent lines are what turn a pile of snapshots into a history: each
 * commit names the state it was built from, so the whole graph is reachable
 * by walking backwards from a single id.
 */
export function encodeCommit(commit: CommitObject): Buffer {
  const lines = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${encodeIdentity(commit.author)}`);
  lines.push(`committer ${encodeIdentity(commit.committer)}`);
  lines.push("");
  lines.push(commit.message);

  return Buffer.from(lines.join("\n"), "utf8");
}

export function decodeCommit(payload: Buffer): CommitObject {
  const text = payload.toString("utf8");
  const blank = text.indexOf("\n\n");
  if (blank === -1) {
    throw new CorruptObjectError("commit has no blank line separating headers from message");
  }

  const headerLines = text.slice(0, blank).split("\n");
  const message = text.slice(blank + 2);

  let tree: string | undefined;
  const parents: string[] = [];
  let author: Identity | undefined;
  let committer: Identity | undefined;

  for (const line of headerLines) {
    const space = line.indexOf(" ");
    if (space === -1) {
      throw new CorruptObjectError(`malformed commit header: ${JSON.stringify(line)}`);
    }
    const key = line.slice(0, space);
    const value = line.slice(space + 1);

    switch (key) {
      case "tree":
        tree = value;
        break;
      case "parent":
        parents.push(value);
        break;
      case "author":
        author = decodeIdentity(value);
        break;
      case "committer":
        committer = decodeIdentity(value);
        break;
      default:
        // Unknown headers are ignored rather than fatal, so a repository
        // written by a newer Tessera stays readable by an older one.
        break;
    }
  }

  if (!tree) throw new CorruptObjectError("commit is missing its tree header");
  if (!author) throw new CorruptObjectError("commit is missing its author header");

  return { tree, parents, author, committer: committer ?? author, message };
}

/* -------------------------------------------------------------------------- */
/* Identities                                                                 */
/* -------------------------------------------------------------------------- */

const IDENTITY = /^(.*) <([^<>]*)> (\d+) (-?\d+)$/;

export function encodeIdentity(identity: Identity): string {
  if (/[\n<>]/.test(identity.name)) {
    throw new CorruptObjectError(`identity name may not contain <, > or a newline: ${identity.name}`);
  }
  if (/[\n<>]/.test(identity.email)) {
    throw new CorruptObjectError(`identity email may not contain <, > or a newline: ${identity.email}`);
  }
  return `${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezoneOffset}`;
}

export function decodeIdentity(raw: string): Identity {
  const match = IDENTITY.exec(raw);
  if (!match) {
    throw new CorruptObjectError(`malformed identity: ${JSON.stringify(raw)}`);
  }
  const [, name, email, timestamp, timezoneOffset] = match as unknown as [string, string, string, string, string];
  return {
    name,
    email,
    timestamp: Number(timestamp),
    timezoneOffset: Number(timezoneOffset),
  };
}
