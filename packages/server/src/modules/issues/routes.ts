import { Router } from "express";
import { z } from "zod";

import { currentUser, optionalAuth, requireAuth } from "../../http/middleware/auth.js";
import { asyncHandler } from "../../http/middleware/error.js";
import { writeLimiter } from "../../http/middleware/rateLimit.js";
import { parsed, validate } from "../../http/validate.js";
import { prisma } from "../../lib/db.js";
import { forbidden, notFound } from "../../lib/errors.js";
import { canWrite, findReadable } from "../repositories/access.js";
import { publicIssue } from "../users/serialise.js";

// mergeParams lets this router read :username and :name from the repository
// router it is mounted inside, so issue routes stay nested under their
// repository rather than needing ids in the URL.
export const issueRouter: Router = Router({ mergeParams: true });

const repositoryParams = z.object({ username: z.string(), name: z.string() });

const issueParams = repositoryParams.extend({
  number: z.coerce.number().int().positive(),
});

const createSchema = z.object({
  title: z.string().trim().min(1, "is required").max(200),
  body: z.string().max(50_000).optional(),
});

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().max(50_000).nullable().optional(),
    status: z.enum(["OPEN", "CLOSED"]).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "provide at least one field to update");

const listQuery = z.object({
  status: z.enum(["OPEN", "CLOSED", "ALL"]).default("OPEN"),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

/* -------------------------------------------------------------------------- */
/* GET .../issues                                                             */
/* -------------------------------------------------------------------------- */

issueRouter.get(
  "/",
  optionalAuth,
  validate({ params: repositoryParams, query: listQuery }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repositoryParams);
    const { status, page, perPage } = parsed(request.query, listQuery);

    // Access is decided by the repository. An issue is never more visible than
    // the project it belongs to.
    const repository = await findReadable(username, name, request.auth?.id);

    const where = {
      repositoryId: repository.id,
      ...(status === "ALL" ? {} : { status }),
    };

    const [total, issues] = await prisma.$transaction([
      prisma.issue.count({ where }),
      prisma.issue.findMany({
        where,
        include: { author: true },
        orderBy: { number: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    response.json({
      issues: issues.map(publicIssue),
      pagination: { page, perPage, total, pages: Math.ceil(total / perPage) },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* POST .../issues                                                            */
/* -------------------------------------------------------------------------- */

issueRouter.post(
  "/",
  requireAuth,
  writeLimiter,
  validate({ params: repositoryParams, body: createSchema }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, repositoryParams);
    const { id: authorId } = currentUser(request);
    const { title, body } = request.body;

    // Anyone who can see a repository may report a problem with it - that is
    // the point of an issue tracker. Writing to the repository itself is a
    // separate, stricter permission.
    const repository = await findReadable(username, name, authorId);

    /**
     * Issue numbers are allocated by incrementing a counter on the repository
     * inside a transaction, and the increment happens in the database.
     *
     * The obvious alternative - count the existing issues and add one - is
     * wrong under concurrency: two simultaneous creates both read the same
     * count and both try to claim the same number, and one fails on the unique
     * constraint. `increment` makes the read-and-write a single atomic
     * operation, so concurrent creates get distinct numbers.
     */
    const issue = await prisma.$transaction(async (tx) => {
      const updated = await tx.repository.update({
        where: { id: repository.id },
        data: { issueCounter: { increment: 1 } },
        select: { issueCounter: true },
      });

      return tx.issue.create({
        data: {
          number: updated.issueCounter,
          title,
          body: body ?? null,
          repositoryId: repository.id,
          authorId,
        },
        include: { author: true },
      });
    });

    response.status(201).json({ issue: publicIssue(issue) });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET .../issues/:number                                                     */
/* -------------------------------------------------------------------------- */

issueRouter.get(
  "/:number",
  optionalAuth,
  validate({ params: issueParams }),
  asyncHandler(async (request, response) => {
    const { username, name, number } = parsed(request.params, issueParams);
    const repository = await findReadable(username, name, request.auth?.id);

    const issue = await prisma.issue.findUnique({
      where: { repositoryId_number: { repositoryId: repository.id, number } },
      include: { author: true },
    });
    if (!issue) throw notFound("issue");

    response.json({ issue: publicIssue(issue) });
  }),
);

/* -------------------------------------------------------------------------- */
/* PATCH .../issues/:number                                                   */
/* -------------------------------------------------------------------------- */

issueRouter.patch(
  "/:number",
  requireAuth,
  validate({ params: issueParams, body: updateSchema }),
  asyncHandler(async (request, response) => {
    const { username, name, number } = parsed(request.params, issueParams);
    const viewerId = currentUser(request).id;
    const repository = await findReadable(username, name, viewerId);

    const existing = await prisma.issue.findUnique({
      where: { repositoryId_number: { repositoryId: repository.id, number } },
    });
    if (!existing) throw notFound("issue");

    // Two people may legitimately edit an issue: whoever raised it, and whoever
    // owns the repository. Everyone else may read it and nothing more.
    const isAuthor = existing.authorId === viewerId;
    if (!isAuthor && !canWrite(repository, viewerId)) {
      throw forbidden("only the issue author or the repository owner can change this");
    }

    const data: {
      title?: string;
      body?: string | null;
      status?: "OPEN" | "CLOSED";
      closedAt?: Date | null;
    } = {};

    if (request.body.title !== undefined) data.title = request.body.title;
    if ("body" in request.body) data.body = request.body.body ?? null;

    if (request.body.status && request.body.status !== existing.status) {
      data.status = request.body.status;
      // Derived from the transition rather than trusted from the client, so
      // closedAt can never disagree with status.
      data.closedAt = request.body.status === "CLOSED" ? new Date() : null;
    }

    const issue = await prisma.issue.update({
      where: { id: existing.id },
      data,
      include: { author: true },
    });

    response.json({ issue: publicIssue(issue) });
  }),
);

/* -------------------------------------------------------------------------- */
/* DELETE .../issues/:number                                                  */
/* -------------------------------------------------------------------------- */

issueRouter.delete(
  "/:number",
  requireAuth,
  validate({ params: issueParams }),
  asyncHandler(async (request, response) => {
    const { username, name, number } = parsed(request.params, issueParams);
    const viewerId = currentUser(request).id;
    const repository = await findReadable(username, name, viewerId);

    const existing = await prisma.issue.findUnique({
      where: { repositoryId_number: { repositoryId: repository.id, number } },
    });
    if (!existing) throw notFound("issue");

    // Deletion is the owner's call alone - an author removing an inconvenient
    // report from someone else's project is not their decision to make.
    if (!canWrite(repository, viewerId)) {
      throw forbidden("only the repository owner can delete issues");
    }

    await prisma.issue.delete({ where: { id: existing.id } });
    response.status(204).end();
  }),
);
