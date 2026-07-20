import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { AppError, badRequest, conflict, notFound } from "../../lib/errors.js";

/**
 * The single place a failure becomes a response.
 *
 * Two rules, and both exist because the alternative leaks:
 *
 *   1. Expected failures (AppError) answer with their own status and code.
 *   2. Everything else is a bug, and answers with a bare 500. The real message
 *      and stack go to the log, never to the client - a stack trace tells an
 *      attacker your file layout, library versions and query shapes.
 */

/** Translate Prisma's error codes into the API's own vocabulary. */
function fromPrisma(error: Prisma.PrismaClientKnownRequestError): AppError | null {
  switch (error.code) {
    case "P2002": {
      // Unique constraint violation. The database is the only thing that can
      // decide this reliably: a "check then insert" in application code has a
      // race between the check and the insert.
      const target = error.meta?.["target"];
      const fields = Array.isArray(target) ? target.join(", ") : String(target ?? "value");
      return conflict(`that ${fields} is already taken`);
    }
    case "P2025":
      return notFound("record");
    case "P2003":
      return badRequest("that reference points at something which does not exist");
    default:
      return null;
  }
}

export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  // Express requires the four-argument shape to recognise an error handler,
  // and delegates to its default if headers are already on the wire.
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AppError) {
    response.status(error.status).json(error.toJSON());
    return;
  }

  if (error instanceof ZodError) {
    response.status(400).json(
      badRequest(
        "the request body is not valid",
        error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      ).toJSON(),
    );
    return;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const translated = fromPrisma(error);
    if (translated) {
      response.status(translated.status).json(translated.toJSON());
      return;
    }
  }

  // Anything reaching here is unexpected. Log everything, return nothing.
  console.error("[unhandled]", {
    method: request.method,
    path: request.path,
    requestId: response.getHeader("x-request-id"),
    error,
  });

  response.status(500).json({
    error: { code: "INTERNAL", message: "something went wrong on our end" },
  });
}

/** Terminal 404 for unmatched routes, so they are JSON like every other error. */
export function notFoundHandler(request: Request, response: Response): void {
  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `no route for ${request.method} ${request.path}`,
      // Point the caller somewhere useful instead of leaving them guessing.
      hint: "see / for a list of available endpoints",
    },
  });
}

/**
 * Wrap an async handler so a rejected promise reaches the error handler.
 *
 * Express 4 does not await handlers: an async function that throws rejects a
 * promise nobody is watching, the request hangs until it times out, and no
 * error is ever reported. This is the standard fix, and forgetting it is one of
 * the most common bugs in Express codebases.
 */
export function asyncHandler<T extends Request = Request>(
  handler: (request: T, response: Response, next: NextFunction) => Promise<unknown>,
) {
  return (request: T, response: Response, next: NextFunction): void => {
    handler(request, response, next).catch(next);
  };
}
