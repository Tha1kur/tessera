import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetEnv } from "../src/env.js";
import { AppError } from "../src/lib/errors.js";
import { hashRefreshToken } from "../src/lib/tokens.js";
import {
  createSession,
  revokeAllSessions,
  rotateSession,
} from "../src/modules/auth/sessions.js";

/**
 * Integration tests for refresh token rotation.
 *
 * These need a real database, because the behaviour under test *is* database
 * behaviour - specifically that a revocation survives the transaction rollback
 * that rejecting a reused token causes. A mocked Prisma client would have
 * happily reported success for a write that a real transaction discards, which
 * is exactly how the bug these tests now cover reached a running server.
 *
 * Skipped rather than failed when no TEST_DATABASE_URL is configured, so a
 * checkout without Postgres still runs the rest of the suite.
 */

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://tessera:tessera@localhost:5432/tessera_test?schema=public";

let prisma: PrismaClient;
let reachable = false;

beforeAll(async () => {
  Object.assign(process.env, {
    DATABASE_URL: TEST_DATABASE_URL,
    ACCESS_TOKEN_SECRET: "a".repeat(48),
    REFRESH_TOKEN_SECRET: "b".repeat(48),
    NODE_ENV: "test",
  });
  resetEnv();

  prisma = new PrismaClient({ datasources: { db: { url: TEST_DATABASE_URL } } });

  try {
    await prisma.$queryRaw`SELECT 1`;
    reachable = true;
  } catch {
    reachable = false;
  }
});

afterAll(async () => {
  await prisma?.$disconnect();
});

beforeEach(async () => {
  if (!reachable) return;
  // Sessions cascade from users, so removing users clears both.
  await prisma.user.deleteMany({});
});

async function makeUser(suffix = "1") {
  return prisma.user.create({
    data: {
      username: `tester${suffix}`,
      email: `tester${suffix}@example.com`,
      passwordHash: "$argon2id$placeholder",
    },
  });
}

describe.runIf(process.env.SKIP_DB !== "1")("refresh token rotation", () => {
  it("issues a working token pair on login", async () => {
    if (!reachable) return;
    const user = await makeUser();

    const tokens = await createSession(prisma, user.id);

    expect(tokens.accessToken).toBeTruthy();
    expect(tokens.refreshToken).toHaveLength(43);
    expect(tokens.userId).toBe(user.id);

    // Only the hash is persisted - never the token itself.
    const stored = await prisma.session.findUnique({ where: { id: tokens.sessionId } });
    expect(stored?.tokenHash).toBe(hashRefreshToken(tokens.refreshToken));
    expect(JSON.stringify(stored)).not.toContain(tokens.refreshToken);
  });

  it("hands back a different token on every refresh", async () => {
    if (!reachable) return;
    const user = await makeUser();

    const first = await createSession(prisma, user.id);
    const second = await rotateSession(prisma, first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.userId).toBe(user.id);

    // Both belong to the same login, which is what makes family revocation work.
    const [before, after] = await Promise.all([
      prisma.session.findUnique({ where: { id: first.sessionId } }),
      prisma.session.findUnique({ where: { id: second.sessionId } }),
    ]);
    expect(before?.familyId).toBe(after?.familyId);
    expect(before?.replacedById).toBe(second.sessionId);
    expect(before?.revokedAt).not.toBeNull();
  });

  it("refuses a token that has already been spent", async () => {
    if (!reachable) return;
    const user = await makeUser();

    const first = await createSession(prisma, user.id);
    await rotateSession(prisma, first.refreshToken);

    await expect(rotateSession(prisma, first.refreshToken)).rejects.toThrow(/reused/);
  });

  it("revokes the whole family when a spent token is replayed", async () => {
    if (!reachable) return;
    // The regression test for the bug this suite was written after: the
    // revocation used to run inside the transaction that the rejection rolled
    // back, so the theft was detected and then silently undone.
    const user = await makeUser();

    const stolen = await createSession(prisma, user.id);
    const live = await rotateSession(prisma, stolen.refreshToken);

    // The attacker replays the old token.
    await expect(rotateSession(prisma, stolen.refreshToken)).rejects.toThrow(/reused/);

    // The victim's still-current token must now be dead too. There is no way to
    // tell victim from thief, so both are cut off.
    await expect(rotateSession(prisma, live.refreshToken)).rejects.toThrow(AppError);

    const remaining = await prisma.session.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(remaining).toBe(0);
  });

  it("leaves other logins alone when one family is compromised", async () => {
    if (!reachable) return;
    // Revoking a family must not sign the user out of their phone because their
    // laptop was compromised - those are separate logins, and separate families.
    const user = await makeUser();

    const laptop = await createSession(prisma, user.id);
    const phone = await createSession(prisma, user.id);

    const laptopRotated = await rotateSession(prisma, laptop.refreshToken);
    await expect(rotateSession(prisma, laptop.refreshToken)).rejects.toThrow(/reused/);

    // Laptop family is dead...
    await expect(rotateSession(prisma, laptopRotated.refreshToken)).rejects.toThrow(AppError);
    // ...but the phone still works.
    const phoneRotated = await rotateSession(prisma, phone.refreshToken);
    expect(phoneRotated.userId).toBe(user.id);
  });

  it("rejects an expired token and marks it revoked", async () => {
    if (!reachable) return;
    const user = await makeUser();
    const tokens = await createSession(prisma, user.id);

    await prisma.session.update({
      where: { id: tokens.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(rotateSession(prisma, tokens.refreshToken)).rejects.toThrow(/expired/);
  });

  it("rejects a token that was never issued", async () => {
    if (!reachable) return;
    await expect(rotateSession(prisma, "completely-made-up-token")).rejects.toThrow(/not valid/);
  });

  it("signs out everywhere when asked", async () => {
    if (!reachable) return;
    const user = await makeUser();

    const one = await createSession(prisma, user.id);
    const two = await createSession(prisma, user.id);

    expect(await revokeAllSessions(prisma, user.id)).toBe(2);

    await expect(rotateSession(prisma, one.refreshToken)).rejects.toThrow(AppError);
    await expect(rotateSession(prisma, two.refreshToken)).rejects.toThrow(AppError);
  });

  it("takes every session with it when the account is deleted", async () => {
    if (!reachable) return;
    // Sessions carry onDelete: Cascade. Without it, deleting a user would
    // leave live refresh tokens pointing at an account that no longer exists.
    const user = await makeUser("d");
    const tokens = await createSession(prisma, user.id);

    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(1);

    await prisma.user.delete({ where: { id: user.id } });

    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    await expect(rotateSession(prisma, tokens.refreshToken)).rejects.toThrow(AppError);
  });

  it("keeps one user's sessions out of another's revocation", async () => {
    if (!reachable) return;
    const [alice, bob] = await Promise.all([makeUser("a"), makeUser("b")]);

    const aliceTokens = await createSession(prisma, alice.id);
    const bobTokens = await createSession(prisma, bob.id);

    await revokeAllSessions(prisma, alice.id);

    await expect(rotateSession(prisma, aliceTokens.refreshToken)).rejects.toThrow(AppError);
    // Bob is unaffected.
    expect((await rotateSession(prisma, bobTokens.refreshToken)).userId).toBe(bob.id);
  });
});
