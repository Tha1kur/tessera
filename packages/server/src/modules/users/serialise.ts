import type { Issue, Repository, User } from "@prisma/client";

/**
 * Turning database rows into API responses.
 *
 * This module exists because of a specific bug in the project it replaces:
 * `GET /allUsers` returned raw user documents straight from the database -
 * password hashes included - to anyone who asked, without authentication.
 *
 * The fix is not "remember to delete the field". It is to make responses
 * *allow-lists*: every field is named explicitly, so a column added later is
 * invisible until someone deliberately exposes it. Forgetting to hide a new
 * secret is easy; forgetting to reveal a new field is harmless.
 */

export interface PublicUser {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  createdAt: Date;
}

/** A user as anyone may see them. Never includes email or password hash. */
export function publicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
  };
}

export interface PrivateUser extends PublicUser {
  email: string;
  updatedAt: Date;
}

/**
 * A user as they may see themselves. Adds the email - and nothing else.
 *
 * `passwordHash` is absent here too. There is no caller who needs it, and the
 * only way to be certain it never ships is for no serialiser to name it.
 */
export function privateUser(user: User): PrivateUser {
  return { ...publicUser(user), email: user.email, updatedAt: user.updatedAt };
}

export interface PublicRepository {
  id: string;
  name: string;
  description: string | null;
  visibility: "PUBLIC" | "PRIVATE";
  ownerId: string;
  owner?: PublicUser;
  starCount?: number;
  issueCount?: number;
  createdAt: Date;
  updatedAt: Date;
}

type RepositoryWithRelations = Repository & {
  owner?: User;
  _count?: { stars?: number; issues?: number };
};

export function publicRepository(repository: RepositoryWithRelations): PublicRepository {
  return {
    id: repository.id,
    name: repository.name,
    description: repository.description,
    visibility: repository.visibility,
    ownerId: repository.ownerId,
    // Relations are only included when the query actually loaded them, so a
    // response never implies "zero stars" when it simply did not count them.
    ...(repository.owner ? { owner: publicUser(repository.owner) } : {}),
    ...(repository._count?.stars === undefined ? {} : { starCount: repository._count.stars }),
    ...(repository._count?.issues === undefined ? {} : { issueCount: repository._count.issues }),
    createdAt: repository.createdAt,
    updatedAt: repository.updatedAt,
  };
}

export interface PublicIssue {
  id: string;
  number: number;
  title: string;
  body: string | null;
  status: "OPEN" | "CLOSED";
  repositoryId: string;
  author?: PublicUser;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export function publicIssue(issue: Issue & { author?: User }): PublicIssue {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    status: issue.status,
    repositoryId: issue.repositoryId,
    ...(issue.author ? { author: publicUser(issue.author) } : {}),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    closedAt: issue.closedAt,
  };
}
