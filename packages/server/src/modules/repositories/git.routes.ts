import { Router } from "express";
import { z } from "zod";
import { ObjectNotFoundError, diffCommitIds, flattenTree, isBinary, logFrom } from "@tessera/core";
import type { Commit, FlatEntry, HasObjects } from "@tessera/core";

import { currentUser, optionalAuth, requireAuth } from "../../http/middleware/auth.js";
import { asyncHandler } from "../../http/middleware/error.js";
import { writeLimiter } from "../../http/middleware/rateLimit.js";
import { parsed, validate } from "../../http/validate.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { findReadable, findWritable } from "./access.js";
import { PostgresBackend, listRefs, readRef, storeFor, writeRef } from "./storage.js";

/**
 * Serving version control history over HTTP.
 *
 * Every handler here reads through the engine rather than reimplementing any of
 * it: commit walking, tree flattening and diffing are the same code the CLI
 * runs, pointed at a Postgres-backed object store instead of a directory.
 */
export const gitRouter: Router = Router({ mergeParams: true });

const repoParams = z.object({ username: z.string(), name: z.string() });

/* -------------------------------------------------------------------------- */
/* POST .../push - receive objects and move a branch                          */
/* -------------------------------------------------------------------------- */

const pushSchema = z.object({
  branch: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[A-Za-z0-9._/-]+$/, "is not a valid branch name"),
  commit: z.string().regex(/^[0-9a-f]{64}$/, "must be a SHA-256 id"),
  objects: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9a-f]{64}$/),
        // Base64 because JSON has no byte type. Bounded so one request cannot
        // be used to exhaust memory.
        bytes: z.string().max(4_000_000),
      }),
    )
    .max(2000),
});

gitRouter.post(
  "/push",
  requireAuth,
  writeLimiter,
  validate({ params: repoParams, body: pushSchema }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repoParams);
    const repository = await findWritable(username, name, currentUser(request).id);

    const { branch, commit, objects } = request.body as z.infer<typeof pushSchema>;

    const backend = new PostgresBackend(repository.id);
    const store = storeFor(repository.id);

    // Each object is verified against the id it claims before anything is
    // stored: writeRaw re-hashes the bytes and rejects a mismatch, so a client
    // cannot file arbitrary content under a name of its choosing.
    let stored = 0;
    for (const object of objects) {
      const bytes = Buffer.from(object.bytes, "base64");
      if (await backend.has(object.id)) continue;
      await store.writeRaw(object.id, bytes);
      stored += 1;
    }

    // The ref moves only once every object is durable. The reverse order would
    // leave a branch pointing at a commit whose contents were never stored.
    try {
      await store.readCommit(commit);
    } catch {
      throw badRequest("that commit is not among the objects stored for this repository");
    }

    await writeRef(repository.id, branch, commit);

    response.json({ stored, skipped: objects.length - stored, branch, commit });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../objects/missing - which objects does the server still need?        */
/* -------------------------------------------------------------------------- */

gitRouter.post(
  "/objects/missing",
  requireAuth,
  validate({
    params: repoParams,
    body: z.object({ ids: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(5000) }),
  }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repoParams);
    const repository = await findWritable(username, name, currentUser(request).id);

    // Lets a client send only what is genuinely new. Re-uploading a whole
    // history on every push would make the object store's deduplication
    // pointless over the wire.
    const backend = new PostgresBackend(repository.id);
    const present = new Set(await backend.list());
    const ids = (request.body as { ids: string[] }).ids;

    response.json({ missing: ids.filter((id) => !present.has(id)) });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../branches                                                           */
/* -------------------------------------------------------------------------- */

gitRouter.get(
  "/branches",
  optionalAuth,
  validate({ params: repoParams }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repoParams);
    const repository = await findReadable(username, name, request.auth?.id);

    response.json({
      branches: await listRefs(repository.id),
      defaultBranch: repository.defaultBranch,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../commits                                                            */
/* -------------------------------------------------------------------------- */

gitRouter.get(
  "/commits",
  optionalAuth,
  validate({
    params: repoParams,
    query: z.object({
      branch: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(30),
    }),
  }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repoParams);
    const { branch, limit } = request.query as unknown as { branch?: string; limit: number };
    const repository = await findReadable(username, name, request.auth?.id);

    const ref = branch ?? repository.defaultBranch;
    const tip = await readRef(repository.id, ref);

    // An empty repository is a normal state, not an error - it just has no
    // history to show yet.
    if (!tip) {
      response.json({ commits: [], branch: ref, empty: true });
      return;
    }

    // The same walk the CLI's `log` performs: a frontier ordered by commit
    // time, so a merged history reads in a sensible order.
    const commits = await logFrom(engineRepository(repository.id), tip, { limit });

    response.json({
      branch: ref,
      empty: false,
      commits: commits.map((entry: Commit) => ({
        id: entry.id,
        message: entry.message,
        subject: entry.message.split("\n")[0] ?? "",
        author: entry.author,
        parents: entry.parents,
      })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../commits/:id                                                        */
/* -------------------------------------------------------------------------- */

gitRouter.get(
  "/commits/:id",
  optionalAuth,
  validate({ params: repoParams.extend({ id: z.string().regex(/^[0-9a-f]{6,64}$/) }) }),
  asyncHandler(async (request, response) => {
    const { username, name, id } = parsed(
      request.params,
      repoParams.extend({ id: z.string() }),
    ) as { username: string; name: string; id: string };

    const repository = await findReadable(username, name, request.auth?.id);
    const engine = engineRepository(repository.id);

    let commitId: string;
    try {
      commitId = await engine.objects.resolvePrefix(id);
    } catch {
      throw notFound("commit");
    }

    const commit = await engine.objects.readCommit(commitId);
    const parent = commit.parents[0];

    // Compared against the first parent, which is what "what did this commit
    // change" means for an ordinary commit.
    const diffs = await diffCommitIds(engine, parent ?? null, commitId);

    // A root commit has no parent to compare against, so every file in it is
    // new. diffCommitIds already reports that correctly; this keeps the shape
    // identical either way.
    const files = parent
      ? diffs
      : (await flattenTree(engine, commit.tree)).map((file: FlatEntry) => ({
          path: file.path,
          kind: "added" as const,
          added: 0,
          removed: 0,
          binary: false,
          patch: "",
        }));

    response.json({
      commit: { id: commitId, ...commit, subject: commit.message.split("\n")[0] ?? "" },
      files,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../tree - the files at a commit                                       */
/* -------------------------------------------------------------------------- */

gitRouter.get(
  "/tree",
  optionalAuth,
  validate({
    params: repoParams,
    query: z.object({ branch: z.string().optional(), commit: z.string().optional() }),
  }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repoParams);
    const query = request.query as unknown as { branch?: string; commit?: string };
    const repository = await findReadable(username, name, request.auth?.id);
    const engine = engineRepository(repository.id);

    const tip = query.commit ?? (await readRef(repository.id, query.branch ?? repository.defaultBranch));
    if (!tip) {
      response.json({ files: [], empty: true });
      return;
    }

    const commit = await engine.objects.readCommit(tip);
    const files = await flattenTree(engine, commit.tree);

    response.json({
      empty: false,
      commit: tip,
      files: files.map((file) => ({ path: file.path, id: file.id, mode: file.mode })),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../blob/:id - one file's contents                                     */
/* -------------------------------------------------------------------------- */

gitRouter.get(
  "/blob/:id",
  optionalAuth,
  validate({ params: repoParams.extend({ id: z.string().regex(/^[0-9a-f]{64}$/) }) }),
  asyncHandler(async (request, response) => {
    const { username, name, id } = parsed(
      request.params,
      repoParams.extend({ id: z.string() }),
    ) as { username: string; name: string; id: string };

    const repository = await findReadable(username, name, request.auth?.id);
    const engine = engineRepository(repository.id);

    let contents: Buffer;
    try {
      contents = await engine.objects.readBlob(id);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) throw notFound("file");
      throw error;
    }

    // Binary content is reported rather than returned as mangled UTF-8.
    if (isBinary(contents)) {
      response.json({ binary: true, size: contents.byteLength, content: null });
      return;
    }

    response.json({ binary: false, size: contents.byteLength, content: contents.toString("utf8") });
  }),
);

/* -------------------------------------------------------------------------- */

/**
 * The engine reading from Postgres.
 *
 * `HasObjects` is the engine's own declaration that reading history needs an
 * object store and nothing else - no working directory, no index, no refs.
 * Commits here are addressed by full id, so nothing ever asks for a checkout
 * the server does not have.
 */
function engineRepository(repositoryId: string): HasObjects {
  return { objects: storeFor(repositoryId) };
}
