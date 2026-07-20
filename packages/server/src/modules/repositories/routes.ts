import { Router } from "express";
import { z } from "zod";

import { currentUser, optionalAuth, requireAuth } from "../../http/middleware/auth.js";
import { asyncHandler } from "../../http/middleware/error.js";
import { writeLimiter } from "../../http/middleware/rateLimit.js";
import { parsed, validate } from "../../http/validate.js";
import { prisma } from "../../lib/db.js";
import { conflict, notFound } from "../../lib/errors.js";
import { publicRepository } from "../users/serialise.js";
import { findReadable, findWritable, visibleToViewer } from "./access.js";

export const repositoryRouter: Router = Router();

/**
 * Repository names appear in URLs and, eventually, on disk. The character set
 * is restricted accordingly, and `.` / `..` are rejected outright so a name can
 * never be used to walk out of the directory it belongs in.
 */
const repositoryName = z
  .string()
  .trim()
  .min(1, "is required")
  .max(100, "must be 100 characters or fewer")
  .regex(/^[a-zA-Z0-9._-]+$/, "may contain letters, numbers, dots, hyphens and underscores")
  .refine((value) => value !== "." && value !== "..", "is not a valid name");

const createSchema = z.object({
  name: repositoryName,
  description: z.string().trim().max(500).optional(),
  visibility: z.enum(["PUBLIC", "PRIVATE"]).default("PUBLIC"),
});

const updateSchema = z
  .object({
    description: z.string().trim().max(500).nullable().optional(),
    visibility: z.enum(["PUBLIC", "PRIVATE"]).optional(),
  })
  // Prisma treats an empty update as a no-op write; rejecting it here turns a
  // pointless round trip into a clear message.
  .refine((value) => Object.keys(value).length > 0, "provide at least one field to update");

const ownerAndName = z.object({ username: z.string(), name: z.string() });

/**
 * Pagination.
 *
 * Bounded on purpose. An unbounded list endpoint is a denial-of-service vector
 * the moment the table grows, and the original project's `/repo/all` returned
 * every repository with every relation populated.
 */
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
  q: z.string().trim().max(100).optional(),
});

/* -------------------------------------------------------------------------- */
/* GET /api/repositories - browse                                             */
/* -------------------------------------------------------------------------- */

repositoryRouter.get(
  "/",
  optionalAuth,
  validate({ query: listQuery }),
  asyncHandler(async (request, response) => {
    const { page, perPage, q } = parsed(request.query, listQuery);
    const viewerId = request.auth?.id;

    const where = {
      AND: [
        visibleToViewer(viewerId),
        ...(q ? [{ name: { contains: q, mode: "insensitive" as const } }] : []),
      ],
    };

    // Counted and fetched together so the total reflects the same filter the
    // rows do - two sequential queries could disagree under concurrent writes.
    const [total, repositories] = await prisma.$transaction([
      prisma.repository.count({ where }),
      prisma.repository.findMany({
        where,
        include: { owner: true, _count: { select: { stars: true, issues: true } } },
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * perPage,
        take: perPage,
      }),
    ]);

    response.json({
      repositories: repositories.map(publicRepository),
      pagination: { page, perPage, total, pages: Math.ceil(total / perPage) },
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* POST /api/repositories - create                                            */
/* -------------------------------------------------------------------------- */

repositoryRouter.post(
  "/",
  requireAuth,
  writeLimiter,
  validate({ body: createSchema }),
  asyncHandler(async (request, response) => {
    const { id: ownerId } = currentUser(request);
    const { name, description, visibility } = request.body;

    // Scoped to this owner. Two different people may both have "portfolio";
    // the original project's globally unique name made that impossible.
    const existing = await prisma.repository.findUnique({
      where: { ownerId_name: { ownerId, name } },
      select: { id: true },
    });
    if (existing) throw conflict(`you already have a repository called "${name}"`);

    const repository = await prisma.repository.create({
      data: { name, description: description ?? null, visibility, ownerId },
      include: { owner: true, _count: { select: { stars: true, issues: true } } },
    });

    response.status(201).json({ repository: publicRepository(repository) });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET /api/repositories/:username/:name                                      */
/* -------------------------------------------------------------------------- */

repositoryRouter.get(
  "/:username/:name",
  optionalAuth,
  validate({ params: ownerAndName }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, ownerAndName);
    // Enforces read access, and answers 404 for a private repository the
    // viewer may not see rather than admitting it exists.
    await findReadable(username, name, request.auth?.id);

    const repository = await prisma.repository.findFirst({
      where: { name, owner: { username } },
      include: { owner: true, _count: { select: { stars: true, issues: true } } },
    });
    if (!repository) throw notFound("repository");

    const starred = request.auth
      ? (await prisma.star.findUnique({
          where: { userId_repositoryId: { userId: request.auth.id, repositoryId: repository.id } },
          select: { userId: true },
        })) !== null
      : false;

    response.json({ repository: publicRepository(repository), viewerHasStarred: starred });
  }),
);

/* -------------------------------------------------------------------------- */
/* PATCH /api/repositories/:username/:name                                    */
/* -------------------------------------------------------------------------- */

repositoryRouter.patch(
  "/:username/:name",
  requireAuth,
  validate({ params: ownerAndName, body: updateSchema }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, ownerAndName);
    const existing = await findWritable(username, name, currentUser(request).id);

    // PATCH is partial: only the keys actually sent are written. Spreading the
    // whole body would blank out fields the caller never mentioned - the bug
    // the original `updateRepositoryById` had, which overwrote the description
    // with undefined on every content update.
    const data: { description?: string | null; visibility?: "PUBLIC" | "PRIVATE" } = {};
    if ("description" in request.body) data.description = request.body.description ?? null;
    if (request.body.visibility) data.visibility = request.body.visibility;

    const repository = await prisma.repository.update({
      where: { id: existing.id },
      data,
      include: { owner: true, _count: { select: { stars: true, issues: true } } },
    });

    response.json({ repository: publicRepository(repository) });
  }),
);

/* -------------------------------------------------------------------------- */
/* DELETE /api/repositories/:username/:name                                   */
/* -------------------------------------------------------------------------- */

repositoryRouter.delete(
  "/:username/:name",
  requireAuth,
  validate({ params: ownerAndName }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, ownerAndName);
    const repository = await findWritable(username, name, currentUser(request).id);

    // Issues and stars go with it, via onDelete: Cascade in the schema. Letting
    // the database enforce that is what keeps orphaned rows from accumulating
    // when application-level cleanup is forgotten.
    await prisma.repository.delete({ where: { id: repository.id } });
    response.status(204).end();
  }),
);

/* -------------------------------------------------------------------------- */
/* Stars                                                                      */
/* -------------------------------------------------------------------------- */

repositoryRouter.put(
  "/:username/:name/star",
  requireAuth,
  validate({ params: ownerAndName }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, ownerAndName);
    const { id: userId } = currentUser(request);
    const repository = await findReadable(username, name, userId);

    // Idempotent: starring twice is not an error, it is the same outcome.
    // `upsert` expresses that in one statement and avoids a check-then-insert
    // race between concurrent clicks.
    await prisma.star.upsert({
      where: { userId_repositoryId: { userId, repositoryId: repository.id } },
      create: { userId, repositoryId: repository.id },
      update: {},
    });

    const stars = await prisma.star.count({ where: { repositoryId: repository.id } });
    response.json({ starred: true, starCount: stars });
  }),
);

repositoryRouter.delete(
  "/:username/:name/star",
  requireAuth,
  validate({ params: ownerAndName }),
  asyncHandler(async (request, response) => {
    const { username, name } = parsed(request.params, ownerAndName);
    const { id: userId } = currentUser(request);
    const repository = await findReadable(username, name, userId);

    // deleteMany rather than delete: removing a star that is not there should
    // succeed quietly, not throw the "record not found" that `delete` raises.
    await prisma.star.deleteMany({ where: { userId, repositoryId: repository.id } });

    const stars = await prisma.star.count({ where: { repositoryId: repository.id } });
    response.json({ starred: false, starCount: stars });
  }),
);
