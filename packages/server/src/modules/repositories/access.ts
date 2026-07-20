import type { Prisma, Repository } from "@prisma/client";

import { forbidden, notFound } from "../../lib/errors.js";
import { prisma } from "../../lib/db.js";

/**
 * Who may see and change a repository.
 *
 * Kept in one module on purpose. The original project checked permissions
 * nowhere, and the usual next mistake is to check them in *most* handlers - the
 * one that gets forgotten is the vulnerability. Every route funnels through
 * these three functions instead.
 */

/**
 * A Prisma filter for "repositories this viewer is allowed to see".
 *
 * Applied inside the query rather than filtered out afterwards. Fetching
 * everything and discarding the private rows in JavaScript is how private data
 * leaks through pagination counts, and it makes the database do needless work.
 */
export function visibleToViewer(viewerId: string | undefined): Prisma.RepositoryWhereInput {
  if (!viewerId) return { visibility: "PUBLIC" };
  return { OR: [{ visibility: "PUBLIC" }, { ownerId: viewerId }] };
}

/** May this viewer read the repository? */
export function canRead(repository: Repository, viewerId: string | undefined): boolean {
  return repository.visibility === "PUBLIC" || repository.ownerId === viewerId;
}

/** May this viewer change it? Only the owner, for now. */
export function canWrite(repository: Repository, viewerId: string | undefined): boolean {
  return viewerId !== undefined && repository.ownerId === viewerId;
}

/**
 * Load a repository by owner and name, enforcing read access.
 *
 * A private repository the viewer cannot see answers **404, not 403**. A 403
 * would confirm that `someone/secret-project` exists, which is information the
 * owner marked private. The two cases are made indistinguishable deliberately.
 */
export async function findReadable(
  username: string,
  name: string,
  viewerId: string | undefined,
): Promise<Repository> {
  const repository = await prisma.repository.findFirst({
    where: { name, owner: { username } },
  });

  if (!repository || !canRead(repository, viewerId)) throw notFound("repository");
  return repository;
}

/**
 * Load a repository for modification.
 *
 * The order matters: a viewer who cannot even *read* it gets 404, preserving
 * the secrecy above. Only someone who can see it - but does not own it - is
 * told 403, which reveals nothing they did not already know.
 */
export async function findWritable(
  username: string,
  name: string,
  viewerId: string | undefined,
): Promise<Repository> {
  const repository = await findReadable(username, name, viewerId);
  if (!canWrite(repository, viewerId)) throw forbidden("only the owner can change this repository");
  return repository;
}
