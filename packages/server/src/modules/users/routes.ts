import { Router } from "express";
import { z } from "zod";

import { currentUser, optionalAuth, requireAuth } from "../../http/middleware/auth.js";
import { asyncHandler } from "../../http/middleware/error.js";
import { parsed, validate } from "../../http/validate.js";
import { prisma } from "../../lib/db.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { visibleToViewer } from "../repositories/access.js";
import { privateUser, publicRepository, publicUser } from "./serialise.js";

export const userRouter: Router = Router();

const usernameParam = z.object({ username: z.string().trim().min(1).max(39) });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(20),
});

const updateProfileSchema = z
  .object({
    displayName: z.string().trim().max(100).nullable().optional(),
    bio: z.string().trim().max(500).nullable().optional(),
    avatarUrl: z.string().url().max(500).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "provide at least one field to update");

/* -------------------------------------------------------------------------- */
/* GET /api/users/:username                                                   */
/* -------------------------------------------------------------------------- */

userRouter.get(
  "/:username",
  optionalAuth,
  validate({ params: usernameParam }),
  asyncHandler(async (request, response) => {
    const { username } = parsed(request.params, usernameParam);
    const viewerId = request.auth?.id;

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) throw notFound("user");

    // The counts are filtered by what the viewer may see, so a stranger reading
    // a profile is not told how many private repositories it has.
    const [repositoryCount, followerCount, followingCount] = await prisma.$transaction([
      prisma.repository.count({ where: { AND: [{ ownerId: user.id }, visibleToViewer(viewerId)] } }),
      prisma.follow.count({ where: { followingId: user.id } }),
      prisma.follow.count({ where: { followerId: user.id } }),
    ]);

    const viewerFollows = viewerId
      ? (await prisma.follow.findUnique({
          where: { followerId_followingId: { followerId: viewerId, followingId: user.id } },
          select: { followerId: true },
        })) !== null
      : false;

    response.json({
      // Your own profile includes your email; nobody else's does.
      user: viewerId === user.id ? privateUser(user) : publicUser(user),
      counts: { repositories: repositoryCount, followers: followerCount, following: followingCount },
      viewerFollows,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET /api/users/:username/repositories                                      */
/* -------------------------------------------------------------------------- */

userRouter.get(
  "/:username/repositories",
  optionalAuth,
  validate({ params: usernameParam, query: listQuery }),
  asyncHandler(async (request, response) => {
    const { username } = parsed(request.params, usernameParam);
    const { page, perPage } = parsed(request.query, listQuery);
    const viewerId = request.auth?.id;

    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!user) throw notFound("user");

    const where = { AND: [{ ownerId: user.id }, visibleToViewer(viewerId)] };

    const [total, repositories] = await prisma.$transaction([
      prisma.repository.count({ where }),
      prisma.repository.findMany({
        where,
        include: { owner: true, _count: { select: { stars: true, issues: true } } },
        orderBy: { updatedAt: "desc" },
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
/* PATCH /api/users/me                                                        */
/* -------------------------------------------------------------------------- */

userRouter.patch(
  "/me",
  requireAuth,
  validate({ body: updateProfileSchema }),
  asyncHandler(async (request, response) => {
    const { id } = currentUser(request);

    // Only these three keys are writable. Zod has already stripped anything
    // else, so a request carrying `{ "username": "admin" }` cannot rename an
    // account and a `{ "passwordHash": ... }` cannot reach the database.
    const data: { displayName?: string | null; bio?: string | null; avatarUrl?: string | null } = {};
    if ("displayName" in request.body) data.displayName = request.body.displayName ?? null;
    if ("bio" in request.body) data.bio = request.body.bio ?? null;
    if ("avatarUrl" in request.body) data.avatarUrl = request.body.avatarUrl ?? null;

    const user = await prisma.user.update({ where: { id }, data });
    response.json({ user: privateUser(user) });
  }),
);

/* -------------------------------------------------------------------------- */
/* Following                                                                  */
/* -------------------------------------------------------------------------- */

userRouter.put(
  "/:username/follow",
  requireAuth,
  validate({ params: usernameParam }),
  asyncHandler(async (request, response) => {
    const { username } = parsed(request.params, usernameParam);
    const { id: followerId } = currentUser(request);

    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!target) throw notFound("user");
    if (target.id === followerId) throw badRequest("you cannot follow yourself");

    await prisma.follow.upsert({
      where: { followerId_followingId: { followerId, followingId: target.id } },
      create: { followerId, followingId: target.id },
      update: {},
    });

    const followers = await prisma.follow.count({ where: { followingId: target.id } });
    response.json({ following: true, followerCount: followers });
  }),
);

userRouter.delete(
  "/:username/follow",
  requireAuth,
  validate({ params: usernameParam }),
  asyncHandler(async (request, response) => {
    const { username } = parsed(request.params, usernameParam);
    const { id: followerId } = currentUser(request);

    const target = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!target) throw notFound("user");

    await prisma.follow.deleteMany({ where: { followerId, followingId: target.id } });

    const followers = await prisma.follow.count({ where: { followingId: target.id } });
    response.json({ following: false, followerCount: followers });
  }),
);
