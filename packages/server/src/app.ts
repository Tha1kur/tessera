import { randomUUID } from "node:crypto";

import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import type { Express } from "express";
import helmet from "helmet";

import { env } from "./env.js";
import { errorHandler, notFoundHandler } from "./http/middleware/error.js";
import { generalLimiter } from "./http/middleware/rateLimit.js";
import { checkDatabase } from "./lib/db.js";
import { authRouter } from "./modules/auth/routes.js";
import { issueRouter } from "./modules/issues/routes.js";
import { gitRouter } from "./modules/repositories/git.routes.js";
import { repositoryRouter } from "./modules/repositories/routes.js";
import { userRouter } from "./modules/users/routes.js";

/**
 * Assembling the application.
 *
 * Middleware order is behaviour, not decoration. Security headers go on before
 * anything can respond, the rate limiter runs before handlers do work, and the
 * error handler is registered last because Express only reaches it by falling
 * through everything above.
 *
 * Building the app separately from starting it means tests can mount it with
 * supertest and never open a port.
 */
export function createApp(): Express {
  const app = express();
  const config = env();

  /**
   * Trust exactly one proxy hop.
   *
   * Required for `request.ip` to be the client rather than the load balancer,
   * which the rate limiter keys on. `true` would be wrong: it trusts the whole
   * X-Forwarded-For chain, letting anyone forge a header and get a fresh rate
   * limit bucket per request.
   */
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    cors({
      // A function, not a wildcard. `origin: "*"` cannot be combined with
      // credentials, and the original project used it while also issuing
      // tokens - so either CORS was doing nothing or cookies never worked.
      origin(origin, callback) {
        // Same-origin and server-to-server requests send no Origin header.
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error("origin not allowed"));
      },
      credentials: true,
    }),
  );

  // Bounded on purpose: the default is 100kb, and an unbounded body is a
  // trivially cheap way to exhaust server memory.
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  /** A per-request id, echoed back so a user's report can find its log line. */
  app.use((request, response, next) => {
    const id = request.get("x-request-id") ?? randomUUID();
    response.setHeader("x-request-id", id);
    next();
  });

  /**
   * An index of the API at its root.
   *
   * Landing on `/` and being told "no route" is technically correct and
   * completely unhelpful - it looks identical to a broken deployment. A short
   * directory of what exists costs nothing and answers the first question
   * anyone has when they point a browser at a running service.
   */
  app.get("/", (_request, response) => {
    response.json({
      name: "Tessera API",
      version: "0.1.0",
      documentation: "https://github.com/Tha1kur/tessera#the-api",
      health: "/api/health",
      endpoints: {
        auth: {
          "POST /api/auth/signup": "create an account",
          "POST /api/auth/login": "sign in",
          "POST /api/auth/refresh": "exchange the refresh cookie for a new token pair",
          "POST /api/auth/logout": "end the current session",
          "GET  /api/auth/me": "the signed-in account",
          "GET  /api/auth/sessions": "list your active sessions",
          "DELETE /api/auth/me": "delete your account and everything in it",
        },
        users: {
          "GET   /api/users/:username": "a profile",
          "GET   /api/users/:username/repositories": "their repositories",
          "PATCH /api/users/me": "update your profile",
          "PUT   /api/users/:username/follow": "follow someone",
        },
        repositories: {
          "GET    /api/repositories": "browse (paginated, ?q= to search)",
          "POST   /api/repositories": "create one",
          "GET    /api/repositories/:username/:name": "a single repository",
          "PATCH  /api/repositories/:username/:name": "update it",
          "DELETE /api/repositories/:username/:name": "delete it",
          "PUT    /api/repositories/:username/:name/star": "star it",
        },
        git: {
          "POST /api/repositories/:u/:n/git/push": "upload objects and move a branch",
          "GET  /api/repositories/:u/:n/git/branches": "list branches",
          "GET  /api/repositories/:u/:n/git/commits": "commit history",
          "GET  /api/repositories/:u/:n/git/commits/:id": "one commit and its diff",
          "GET  /api/repositories/:u/:n/git/tree": "files at a commit",
          "GET  /api/repositories/:u/:n/git/blob/:id": "one file's contents",
        },
        issues: {
          "GET   /api/repositories/:username/:name/issues": "list (?status=OPEN|CLOSED|ALL)",
          "POST  /api/repositories/:username/:name/issues": "open one",
          "PATCH /api/repositories/:username/:name/issues/:number": "edit or close one",
        },
      },
    });
  });

  app.get("/api/health", async (_request, response) => {
    const database = await checkDatabase();
    // Reports the dependency honestly: a process that is up but cannot reach
    // its database is not healthy, and saying "ok" would hide an outage.
    response.status(database ? 200 : 503).json({
      status: database ? "ok" : "degraded",
      database: database ? "up" : "down",
      uptime: Math.floor(process.uptime()),
    });
  });

  app.use("/api", generalLimiter);

  app.use("/api/auth", authRouter);
  app.use("/api/users", userRouter);
  app.use("/api/repositories", repositoryRouter);
  // Nested so an issue is always addressed through the repository that owns it,
  // which is also what makes the access check impossible to skip.
  app.use("/api/repositories/:username/:name/issues", issueRouter);
  // Version control history, served by the same engine the CLI uses.
  app.use("/api/repositories/:username/:name/git", gitRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
