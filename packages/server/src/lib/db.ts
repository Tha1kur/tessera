import { PrismaClient } from "@prisma/client";

/**
 * The database client.
 *
 * One instance for the whole process. Each `new PrismaClient()` opens its own
 * connection pool, so constructing them per-request exhausts Postgres'
 * connection limit almost immediately - a failure that only shows up under
 * load, which is the worst time to discover it.
 *
 * In development the instance is cached on `globalThis` so that hot reload
 * reusing the module does not leak a new pool on every file save.
 */

const globalForPrisma = globalThis as typeof globalThis & { prisma?: PrismaClient };

export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

/** Close the pool. Called on shutdown so in-flight queries can finish. */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

/** Cheap liveness probe for the health endpoint. */
export async function checkDatabase(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
